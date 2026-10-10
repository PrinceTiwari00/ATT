/**
 * END-TO-END against a fake ZKTeco terminal on a real TCP socket.
 *
 * Everything else in this suite stubs the library. This file implements the
 * device side of the protocol — the 0x50 0x50 0x82 0x7d framing, the
 * CMD_CONNECT → CMD_ACK_UNAUTH → CMD_AUTH handshake, option reads/writes and
 * the attendance dump — so the whole stack is exercised for real:
 *
 *   node-zklib → RealZKDevice → device lock → manager → poller → SQLite
 *
 * It is the proof for the two things the school reported:
 *   • a Comm Key can be set on the terminal and ATT still works (and any other
 *     client that does not know the key is refused — "previous devices that
 *     tried to connect get cancelled");
 *   • ATT never opens two sessions at once, so it cannot knock itself off the
 *     device (the fake terminal counts concurrent sockets server-side).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ATT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'att-faketerm-'));
process.env.ZK_MODE = 'real';
process.env.ZK_SESSION_GAP_MS = '0';
process.env.ZK_LOCK_STALE_MS = '20000';
delete process.env.ZK_COMM_KEY;

const config = require('../src/config');
const { CMD, ACK, makeCommKey } = require('../src/zk/commKey');
const { RealZKDevice } = require('../src/zk/realDevice');
const { DeviceLock, resetDeviceLock, isBusyError } = require('../src/zk/deviceLock');
const { migrate } = require('../src/db/migrate');
const { getDb } = require('../src/db/connection');
const { initManager, getManager, probeDevice } = require('../src/zk/manager');
const commKeyService = require('../src/services/commKey');
const { syncOnce } = require('../src/services/poller');

migrate();

/* ── the fake terminal ───────────────────────────────────────────────────── */

const PREFIX = Buffer.from([0x50, 0x50, 0x82, 0x7d, 0x00, 0x00, 0x00, 0x00]);

/** ZKTeco record time encoding (the inverse of node-zklib's parseTimeToDate). */
function encodeTime(d) {
  const days = ((d.getFullYear() - 2000) * 12 + d.getMonth()) * 31 + (d.getDate() - 1);
  const hours = days * 24 + d.getHours();
  const minutes = hours * 60 + d.getMinutes();
  return minutes * 60 + d.getSeconds();
}

/** One 40-byte attendance record, exactly what decodeRecordData40 expects. */
function record({ userSn, userId, at }) {
  const buf = Buffer.alloc(40);
  buf.writeUIntLE(userSn, 0, 2);
  buf.write(String(userId).padEnd(9, '\0').slice(0, 9), 2, 9, 'ascii');
  buf.writeUInt32LE(encodeTime(at), 27);
  return buf;
}

function send(socket, command, sessionId, replyId, payload = Buffer.alloc(0)) {
  const inner = Buffer.alloc(8 + payload.length);
  inner.writeUInt16LE(command, 0);
  inner.writeUInt16LE(0, 2); // checksum — node-zklib never verifies it
  inner.writeUInt16LE(sessionId, 4);
  inner.writeUInt16LE(replyId, 6);
  payload.copy(inner, 8);
  const prefix = Buffer.from(PREFIX);
  prefix.writeUInt16LE(inner.length, 4);
  socket.write(Buffer.concat([prefix, inner]));
}

/**
 * @param {{commKey?:number, users?:Array, records?:Array, options?:object}} opts
 */
function startFakeTerminal({ commKey = 0, users = [], records = [], options = {} } = {}) {
  const state = {
    commKey,
    options: { COMKey: String(commKey), '~DeviceName': 'ZKTeco K14 (fake)', '~SerialNumber': 'FAKE0001', ...options },
    connections: 0,
    concurrent: 0,
    maxConcurrent: 0,
    authAttempts: 0,
    authFailures: 0,
    unauthenticatedCommands: 0,
    commands: [],
    writes: [],
  };

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    state.connections++;
    state.concurrent++;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
    if (state.concurrent > 1) state.overlaps = (state.overlaps || 0) + 1;

    const session = { id: 0, authed: state.commKey === 0 };
    let buffer = Buffer.alloc(0);
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      state.concurrent--;
    };
    socket.on('close', finish);
    socket.on('error', () => { finish(); socket.destroy(); });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 8) return;
        const innerLength = buffer.readUInt16LE(4);
        if (buffer.length < 8 + innerLength) return;
        const packet = buffer.subarray(8, 8 + innerLength);
        buffer = buffer.subarray(8 + innerLength);
        handle(packet);
      }
    });

    function handle(packet) {
      const command = packet.readUInt16LE(0);
      const replyId = packet.readUInt16LE(6);
      const payload = packet.subarray(8);
      state.commands.push(command);
      const sid = () => session.id;

      if (command === CMD.CONNECT) {
        // A real terminal hands out a fresh session id per connection.
        session.id = (40000 + state.connections) & 0xffff;
        session.authed = state.commKey === 0;
        send(socket, session.authed ? ACK.OK : ACK.UNAUTH, session.id, replyId);
        return;
      }

      if (command === CMD.AUTH) {
        state.authAttempts++;
        const expected = makeCommKey(state.commKey, session.id);
        if (Buffer.compare(Buffer.from(payload.subarray(0, 4)), expected) === 0) {
          session.authed = true;
          send(socket, ACK.OK, sid(), replyId);
        } else {
          state.authFailures++;
          send(socket, ACK.UNAUTH, sid(), replyId);
        }
        return;
      }

      // Everything else needs an authenticated session — exactly like firmware.
      if (!session.authed) {
        state.unauthenticatedCommands++;
        send(socket, ACK.UNAUTH, sid(), replyId);
        return;
      }

      switch (command) {
        case CMD.OPTIONS_RRQ: {
          const name = payload.toString('ascii').replace(/\0+$/g, '');
          const value = state.options[name];
          if (value === undefined) return send(socket, ACK.ERROR, sid(), replyId);
          return send(socket, ACK.OK, sid(), replyId, Buffer.from(`${name}=${value}\0`, 'ascii'));
        }
        case CMD.OPTIONS_WRQ: {
          const text = payload.toString('ascii').replace(/\0+$/g, '');
          const eq = text.indexOf('=');
          const name = text.slice(0, eq);
          const value = text.slice(eq + 1);
          state.writes.push(text);
          if (name !== 'COMKey') return send(socket, ACK.ERROR, sid(), replyId);
          state.commKey = Number(value) || 0;
          state.options.COMKey = String(state.commKey);
          // The session that changed the key stays authenticated (real devices
          // keep it); only NEW connections must prove the new key.
          return send(socket, ACK.OK, sid(), replyId);
        }
        case CMD.GET_FREE_SIZES: {
          const body = Buffer.alloc(96);
          body.writeUIntLE(users.length, 16, 4); // → userCounts
          body.writeUIntLE(records.length, 32, 4); // → logCounts
          body.writeUIntLE(10000, 64, 4); // → logCapacity
          return send(socket, ACK.OK, sid(), replyId, body);
        }
        case 1503 /* CMD_DATA_WRRQ — attendance / user dump */: {
          // REQUEST_DATA.GET_USERS = [0x01, 0x09, …], GET_ATTENDANCE_LOGS = [0x01, 0x0d, …]
          const wantUsers = payload.length > 1 && payload[1] === 0x09;
          const body = wantUsers ? encodeUsers(users) : encodeRecords(records);
          return send(socket, CMD_DATA, sid(), replyId, body);
        }
        case CMD.EXIT:
          // Firmware releases the management slot as soon as it processes the
          // exit, before the socket finishes closing — model that, otherwise a
          // perfectly serialised client looks like an overlap on the server.
          finish();
          send(socket, ACK.OK, sid(), replyId);
          return setTimeout(() => socket.end(), 5);
        default:
          return send(socket, ACK.OK, sid(), replyId);
      }
    }
  });

  const CMD_DATA = 1501;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        state,
        port: server.address().port,
        // Destroy any socket a client leaked, or server.close() would wait
        // for it forever (and take the test suite with it).
        close: () =>
          new Promise((r) => {
            for (const s of sockets) { try { s.destroy(); } catch (_) {} }
            sockets.clear();
            server.close(() => r());
          }),
      });
    });
  });
}

/** 4-byte header + 72-byte user records (decodeUserData72). */
function encodeUsers(users) {
  const head = Buffer.alloc(4);
  head.writeUIntLE(users.length, 0, 4);
  const body = Buffer.concat(
    users.map((u, i) => {
      const b = Buffer.alloc(72);
      b.writeUIntLE(i + 1, 0, 2); // uid
      b.writeUIntLE(0, 2, 1); // role
      b.write(String(u.name || '').padEnd(8, '\0').slice(0, 8), 11, 8, 'ascii');
      b.writeUIntLE(0, 35, 4); // cardno
      b.write(String(u.userId).padEnd(9, '\0').slice(0, 9), 48, 9, 'ascii');
      return b;
    })
  );
  return Buffer.concat([head, body]);
}

/** 4-byte header + 40-byte attendance records (decodeRecordData40). */
function encodeRecords(records) {
  const head = Buffer.alloc(4);
  head.writeUIntLE(records.length, 0, 4);
  return Buffer.concat([head, ...records.map((r) => record(r))]);
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const makeDevice = (port, { commKey = 0, lockWaitMs = 0, timeoutMs = 4000 } = {}) =>
  new RealZKDevice({
    ip: '127.0.0.1',
    port,
    timeoutMs,
    inPort: 0,
    commKey,
    lockWaitMs,
    deviceLock: new DeviceLock({ name: 'fake-terminal', gapMs: 0, staleMs: 20_000 }),
  });

const PUNCH_DAY = new Date();
PUNCH_DAY.setHours(8, 45, 0, 0);
const PUNCH_OUT = new Date();
PUNCH_OUT.setHours(17, 15, 0, 0);

const SAMPLE_RECORDS = [
  { userSn: 1, userId: '101', at: PUNCH_DAY },
  { userSn: 1, userId: '101', at: PUNCH_OUT },
];

/* ── the handshake, for real ─────────────────────────────────────────────── */

test('an unkeyed terminal works exactly as before', async () => {
  const fake = await startFakeTerminal({ commKey: 0, records: SAMPLE_RECORDS });
  try {
    const device = makeDevice(fake.port, { commKey: 0 });
    const test = await device.testConnection();
    assert.equal(test.ok, true, test.error);
    assert.equal(test.commKey.required, false);
    assert.equal(test.commKey.authenticated, false);
    assert.equal(fake.state.authAttempts, 0, 'no key → no CMD_AUTH on the wire');

    const logs = await device.getAttendance();
    assert.equal(logs.length, 2);
    assert.equal(logs[0].userId, '101');
    assert.match(logs[0].timestamp, /^\d{4}-\d{2}-\d{2}T08:45:00$/);
  } finally {
    await fake.close();
  }
});

test('a keyed terminal refuses a client with no key — and says why', async () => {
  const fake = await startFakeTerminal({ commKey: 1 });
  try {
    const device = makeDevice(fake.port, { commKey: 0 });
    const result = await device.testConnection();
    assert.equal(result.ok, false);
    assert.match(result.error, /requires a Comm Key/);
    assert.match(result.error, /Menu → COMM → Comm Key = 0/);
    assert.equal(result.retryable, false, 'no amount of retrying fixes a missing password');
    assert.equal(fake.state.authAttempts, 0);
  } finally {
    await fake.close();
  }
});

test('a keyed terminal accepts ATT when the key matches', async () => {
  const fake = await startFakeTerminal({ commKey: 1, records: SAMPLE_RECORDS });
  try {
    const device = makeDevice(fake.port, { commKey: 1 });
    const result = await device.testConnection();
    assert.equal(result.ok, true, result.error);
    assert.equal(result.commKey.required, true);
    assert.equal(result.commKey.authenticated, true);
    assert.equal(fake.state.authAttempts, 1);
    assert.equal(fake.state.authFailures, 0);
    assert.equal(fake.state.unauthenticatedCommands, 0, 'every command ran inside the authed session');

    const logs = await device.getAttendance();
    assert.equal(logs.length, 2, 'a keyed device returns data like any other');
  } finally {
    await fake.close();
  }
});

test('the wrong key is rejected by the terminal, and ATT explains it', async () => {
  const fake = await startFakeTerminal({ commKey: 1 });
  try {
    const device = makeDevice(fake.port, { commKey: 2 });
    const result = await device.testConnection();
    assert.equal(result.ok, false);
    assert.match(result.error, /REJECTED Comm Key 2/);
    assert.equal(fake.state.authFailures, 1);
  } finally {
    await fake.close();
  }
});

/* ── the collision fix, measured on the device side ──────────────────────── */

test('five simultaneous operations never put two sockets on the terminal', async () => {
  const fake = await startFakeTerminal({ commKey: 1, records: SAMPLE_RECORDS });
  try {
    const device = makeDevice(fake.port, { commKey: 1 });
    const results = await Promise.allSettled([
      device.getAttendance(),
      device.getAttendance(),
      device.getUsers(),
      device.testConnection(),
      device.getAttendance(),
    ]);

    assert.equal(fake.state.maxConcurrent, 1, 'the terminal saw ONE session at a time');
    assert.equal(fake.state.overlaps || 0, 0);
    assert.equal(fake.state.connections, 1, 'the others were refused before dialling');

    const refused = results.filter((r) => r.status === 'rejected' && isBusyError(r.reason));
    // Whichever call won the lock is not deterministic; what IS deterministic is
    // that only one reached the terminal and the rest were refused as busy
    // (testConnection reports busy instead of throwing, so it counts as settled).
    assert.ok(refused.length >= 3, `expected most calls to be refused, got ${refused.length}`);
    assert.equal(refused.length + results.filter((r) => r.status === 'fulfilled').length, 5);
  } finally {
    await fake.close();
  }
});

test('callers that wait get the terminal one at a time', async () => {
  const fake = await startFakeTerminal({ commKey: 0, records: SAMPLE_RECORDS });
  try {
    const device = makeDevice(fake.port, { commKey: 0, lockWaitMs: 8000 });
    const results = await Promise.all([
      device.getAttendance(),
      device.getAttendance(),
      device.getAttendance(),
    ]);
    assert.equal(results.every((r) => Array.isArray(r)), true);
    assert.equal(fake.state.maxConcurrent, 1);
    assert.equal(fake.state.connections, 3, 'three sessions — strictly in series');
  } finally {
    await fake.close();
  }
});

/* ── reading and changing the key ON the terminal ────────────────────────── */

test('ATT can read the key the terminal has', async () => {
  const fake = await startFakeTerminal({ commKey: 4 });
  try {
    const device = makeDevice(fake.port, { commKey: 4 });
    const info = await device.readCommKey();
    assert.equal(info.supported, true);
    assert.equal(info.name, 'COMKey');
    assert.equal(info.deviceValue, '4');
    assert.equal(info.matches, true);
  } finally {
    await fake.close();
  }
});

test('the whole change-over: write a new key, verify it, and lock out the old one', async () => {
  const fake = await startFakeTerminal({ commKey: 1, records: SAMPLE_RECORDS });
  try {
    // Point the app at the fake terminal and bring the manager up on key 1.
    config.zk.mode = 'real';
    config.zk.ip = '127.0.0.1';
    config.zk.port = fake.port;
    config.zk.commKey = 1;
    resetDeviceLock(new DeviceLock({ name: 'integration', gapMs: 0, staleMs: 20_000 }));
    initManager(() => []);

    const before = await getManager().getAttendance();
    assert.equal(before.length, 2, 'syncing works with the current key');

    const change = await commKeyService.changeCommKey({ key: 7, writeToDevice: true });
    assert.equal(change.ok, true, JSON.stringify(change.steps));
    assert.equal(change.verified, true);
    assert.equal(fake.state.commKey, 7, 'the terminal now demands 7');
    assert.deepEqual(fake.state.writes, ['COMKey=7']);
    assert.equal(config.zk.commKey, 7, 'ATT followed it');

    // ATT keeps working …
    const after = await syncOnce('manual');
    assert.equal(after.ok, true, after.error || after.reason);
    assert.ok(after.fetched >= 2);

    // … and the punch made it into the ledger.
    const rows = getDb().prepare('SELECT COUNT(*) c FROM attendance_logs').get();
    assert.ok(rows.c >= 2, 'raw punches were stored');

    // … while any client still using the OLD key is now refused. This is the
    // "previous devices that tried to connect get cancelled" behaviour.
    const stale = makeDevice(fake.port, { commKey: 1 });
    const rejected = await stale.testConnection();
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /REJECTED Comm Key 1/);
    assert.ok(fake.state.authFailures >= 1);

    // Removing the key again (0) reopens the terminal to everyone.
    const reopen = await commKeyService.changeCommKey({ key: 0, writeToDevice: true });
    assert.equal(reopen.ok, true);
    assert.equal(fake.state.commKey, 0);
    const open = makeDevice(fake.port, { commKey: 0 });
    assert.equal((await open.testConnection()).ok, true);
  } finally {
    resetDeviceLock(null);
    await fake.close();
  }
});

test('a probe of the live terminal is refused while a sync owns it', async () => {
  const fake = await startFakeTerminal({ commKey: 0, records: SAMPLE_RECORDS });
  try {
    config.zk.ip = '127.0.0.1';
    config.zk.port = fake.port;
    config.zk.commKey = 0;
    const lock = new DeviceLock({ name: 'probe-test', gapMs: 0, staleMs: 20_000 });
    resetDeviceLock(lock);
    initManager(() => []);

    const holder = await lock.acquire('poller:getAttendance', { origin: 'poller:poll' });
    const probe = await probeDevice({ ip: '127.0.0.1', port: fake.port, timeoutMs: 2000 });
    assert.equal(probe.ok, false);
    assert.match(probe.error, /terminal is busy/);
    assert.equal(fake.state.connections, 0, 'the probe never dialled the device');
    lock.release(holder);

    const after = await probeDevice({ ip: '127.0.0.1', port: fake.port, timeoutMs: 2000 });
    assert.equal(after.ok, true, after.error);
  } finally {
    resetDeviceLock(null);
    await fake.close();
  }
});
