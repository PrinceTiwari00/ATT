/**
 * REGRESSION GUARD — ATT must never open two sessions to the terminal at once.
 *
 * The reported field failure, verbatim:
 *
 *   getAttendance: Cannot reach ZKTeco device at 192.168.1.110:4370 —
 *                  TIMEOUT_ON_WRITING_MESSAGE
 *   ✕ Cannot reach ZKTeco device at 192.168.1.110:4370 — Another device is
 *     connecting to the device so the connection is interrupted (ECONNRESET)
 *
 * Both are what a ZKTeco terminal does when a SECOND client grabs its single
 * management session — and the second client was ATT itself: the background
 * poller overlapping a manual "Fetch logs now", a "Test link" during a sync, or
 * the LAN sweep identifying hosts mid-poll.
 *
 * The stub library below counts concurrent sockets. If any test ever sees
 * maxConcurrent > 1, the collision is back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Before config.js is first required: the DB and settings live in a temp home.
process.env.ATT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'att-serial-'));
process.env.ZK_MODE = 'real';
process.env.ZK_SESSION_GAP_MS = '0'; // tested on its own in deviceLock.test.js
delete process.env.ZK_COMM_KEY;

const { RealZKDevice } = require('../src/zk/realDevice');
const { DeviceLock, DeviceBusyError, isBusyError, resetDeviceLock, getDeviceLock } = require('../src/zk/deviceLock');
const { CMD, ACK } = require('../src/zk/commKey');
const { migrate } = require('../src/db/migrate');
const config = require('../src/config');

migrate();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Swap node-zklib for a terminal that counts how many sessions it is serving. */
async function withTrackingDevice({ sessionMs = 30, records = [], commKey = 0, lockWaitMs = 0 } = {}, fn) {
  const state = {
    open: 0,
    maxConcurrent: 0,
    collisions: 0,
    sessions: 0,
    authAttempts: 0,
    order: [],
  };

  function reply(code, payload = '') {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'ascii');
    const buf = Buffer.alloc(8 + body.length);
    buf.writeUInt16LE(code, 0);
    buf.writeUInt16LE(0, 2);
    buf.writeUInt16LE(4321, 4);
    buf.writeUInt16LE(0, 6);
    body.copy(buf, 8);
    return buf;
  }

  function StubZKLib(ip, port, timeoutMs, inPort) {
    this.ip = ip;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.inPort = inPort;
    this.connectionType = null;
    const self = this;
    // node-zklib's real instance shape — the adapter uses these internals to
    // run the Comm Key handshake the library does not implement.
    this.zklibTcp = {
      sessionId: 0,
      socket: null,
      async createSocket() {
        state.sessions++;
        state.open++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.open);
        if (state.open > 1) state.collisions++;
        self.zklibTcp.socket = { removeAllListeners() {}, destroy() {} };
        await sleep(2);
      },
      async executeCmd(command, data) {
        if (command === CMD.CONNECT) {
          self.zklibTcp.sessionId = 4321;
          return reply(commKey ? ACK.UNAUTH : ACK.OK);
        }
        if (command === CMD.AUTH) {
          state.authAttempts++;
          return reply(ACK.OK);
        }
        // The device is slow — this is the window a second client used to
        // squeeze into and steal the session.
        await sleep(sessionMs);
        return reply(ACK.OK);
      },
    };
    this.executeCmd = (command, data) => this.zklibTcp.executeCmd(command, data);
  }

  StubZKLib.prototype.getAttendances = async function getAttendances() {
    state.order.push('getAttendances');
    await this.zklibTcp.executeCmd(CMD.OPTIONS_RRQ); // any slow command will do
    return { data: records, err: null };
  };
  StubZKLib.prototype.getUsers = async function getUsers() {
    state.order.push('getUsers');
    await this.zklibTcp.executeCmd(CMD.OPTIONS_RRQ);
    return { data: [], err: null };
  };
  StubZKLib.prototype.getInfo = async function getInfo() {
    state.order.push('getInfo');
    await this.zklibTcp.executeCmd(CMD.OPTIONS_RRQ);
    return { data: { deviceName: 'ZKTeco K14 (stub)' } };
  };
  StubZKLib.prototype.disconnect = async function disconnect() {
    state.open--;
    state.order.push('disconnect');
  };

  const resolved = require.resolve('node-zklib');
  const saved = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: StubZKLib };

  const lock = new DeviceLock({ name: 'serialisation-test', gapMs: 0, staleMs: 10_000 });
  const device = new RealZKDevice({
    ip: '192.168.1.110',
    port: 4370,
    timeoutMs: 2000,
    inPort: 0,
    commKey,
    lockWaitMs,
    deviceLock: lock,
  });

  try {
    return await fn({ device, lock, state });
  } finally {
    if (saved) require.cache[resolved] = saved;
    else delete require.cache[resolved];
  }
}

/* ── the adapter ──────────────────────────────────────────────────────────── */

test('five simultaneous fetches produce ONE session, not five', async () => {
  await withTrackingDevice({ sessionMs: 25 }, async ({ device, state }) => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => device.getAttendance({ origin: `caller-${i}` }))
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const busy = results.filter((r) => r.status === 'rejected' && isBusyError(r.reason));

    assert.equal(ok.length, 1, 'exactly one caller may reach the terminal');
    assert.equal(busy.length, 4, 'the other four must be refused, not queued onto the device');
    assert.equal(state.maxConcurrent, 1, 'never two sockets at once');
    assert.equal(state.collisions, 0);
    assert.equal(state.sessions, 1);
    for (const r of busy) {
      assert.ok(r.reason instanceof DeviceBusyError);
      assert.equal(r.reason.status, 409);
      assert.match(r.reason.message, /getAttendance/);
    }
  });
});

test('callers that are willing to wait get the terminal one after another', async () => {
  await withTrackingDevice({ sessionMs: 20, lockWaitMs: 3000 }, async ({ device, state }) => {
    const results = await Promise.allSettled([
      device.getAttendance({ origin: 'a' }),
      device.getUsers({ origin: 'b' }),
      device.testConnection({ origin: 'c' }),
    ]);

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3, 'nobody is refused');
    assert.equal(state.maxConcurrent, 1, '…but still strictly one session at a time');
    assert.equal(state.collisions, 0);
    assert.equal(state.sessions, 3);
    // every session is closed before the next opens
    const opens = state.order.filter((x) => x === 'disconnect').length;
    assert.equal(opens, 3);
  });
});

test('a batch holds the terminal for the whole run and nobody sneaks in between', async () => {
  await withTrackingDevice({ sessionMs: 10 }, async ({ device, state, lock }) => {
    await lock.runExclusive('push-all (3)', async (ticket) => {
      for (const id of [1, 2, 3]) {
        await device.getAttendance({ ticket, origin: 'push-all' });
        // The poller firing mid-batch must be refused, not interleaved.
        const err = await lock.acquire('poller:getAttendance', { timeoutMs: 0 }).then(
          (t) => { lock.release(t); return null; },
          (e) => e
        );
        assert.ok(err instanceof DeviceBusyError, 'a mid-batch poll must be refused');
        assert.equal(state.maxConcurrent, 1, 'and it must never open a socket');
      }
    });

    assert.equal(state.sessions, 3, 'the batch still opened one session per step');
    assert.equal(state.collisions, 0);
    assert.equal(lock.locked, false, 'the batch released the terminal');

    // …and the poller may run afterwards.
    const after = await lock.acquire('poller:getAttendance', { timeoutMs: 500 });
    lock.release(after);
  });
});

test('a Comm Key handshake happens inside the same exclusive session', async () => {
  await withTrackingDevice({ sessionMs: 10, commKey: 1 }, async ({ device, state }) => {
    const results = await Promise.allSettled([
      device.getAttendance(),
      device.getAttendance(),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(state.maxConcurrent, 1);
    assert.equal(state.authAttempts, 1, 'exactly one CMD_AUTH for the one session that ran');
  });
});

/* ── the manager + poller ─────────────────────────────────────────────────── */

test('the poller skips (does not fail) while anything else owns the terminal', async () => {
  await withTrackingDevice({ sessionMs: 60 }, async ({ lock }) => {
    // The manager and poller use the process-wide singleton, so install ours.
    resetDeviceLock(lock);
    const { initManager } = require('../src/zk/manager');
    const { syncOnce } = require('../src/services/poller');
    const manager = initManager(() => []);

    const holder = await lock.acquire('route:test-connection', { origin: 'route:test' });
    const result = await syncOnce('poll');

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true, 'a skipped poll is normal, not a device fault');
    assert.equal(result.busy, true);
    assert.match(result.reason, /route:test-connection/);
    assert.equal(result.owner.label, 'route:test-connection');

    // The circuit breaker must not have been touched by a busy device.
    assert.equal(manager.consecutiveFailures, 0);
    assert.equal(manager.circuit, 'closed');
    assert.equal(manager.isBusy(), true);
    assert.match(manager.busyReason(), /route:test-connection/);

    lock.release(holder);
    assert.equal(manager.isBusy(), false);
    resetDeviceLock(null);
  });
});

test('manager status publishes the lock so the UI can show who owns the device', async () => {
  const lock = new DeviceLock({ name: 'status-test', gapMs: 0, staleMs: 5000 });
  resetDeviceLock(lock);
  const { initManager } = require('../src/zk/manager');
  const manager = initManager(() => []);

  const holder = await lock.acquire('getAttendance', { origin: 'poller:poll' });
  const status = manager.status();

  assert.equal(status.busy, true);
  assert.equal(status.deviceLock.locked, true);
  assert.equal(status.deviceLock.owner.label, 'getAttendance');
  assert.equal(status.deviceLock.owner.origin, 'poller:poll');
  assert.ok(status.commKey && typeof status.commKey.configured === 'number');
  assert.equal(status.commKey.set, false);

  lock.release(holder);
  assert.equal(manager.status().busy, false);
  assert.equal(getDeviceLock(), lock);
  resetDeviceLock(null);
});

test('the configured lock timings come from config.zk.lock', () => {
  resetDeviceLock(null);
  const lock = getDeviceLock();
  assert.equal(lock.staleMs, config.zk.lock.staleMs);
  assert.equal(lock.gapMs, config.zk.lock.gapMs);
  assert.equal(config.zk.lock.waitMs, 15000, 'default policy: a person waits up to 15 s for the terminal');
  resetDeviceLock(null);
});
