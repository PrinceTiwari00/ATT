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

/* ── the fake terminal (shared harness) ─────────────────────────────────── */

const { startFakeTerminal, PREFIX, record } = require('./support/fakeTerminal');

/* ── helpers ─────────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const makeDevice = (port, { commKey = 0, lockWaitMs = 0, timeoutMs = 4000, lock = null } = {}) =>
  new RealZKDevice({
    ip: '127.0.0.1',
    port,
    timeoutMs,
    inPort: 0,
    commKey,
    lockWaitMs,
    deviceLock: lock || new DeviceLock({ name: 'fake-terminal', gapMs: 0, staleMs: 20_000 }),
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

/* ── timeouts, queueing and the terminal being held ──────────────────────── */

test('a timed-out operation keeps the terminal until it has really ended', async () => {
  const fake = await startFakeTerminal({ commKey: 0, records: SAMPLE_RECORDS });
  try {
    const device = makeDevice(fake.port, { timeoutMs: 200 });
    let opEnded = false;
    let endedBeforeRelease = null;
    await assert.rejects(
      device.withConnection(async () => {
        await sleep(700);
        opEnded = true;
      }, 'slow-op'),
      () => {
        endedBeforeRelease = opEnded;
        return true;
      }
    );
    assert.equal(endedBeforeRelease, true, 'the terminal was released while the operation was still running');
  } finally {
    await fake.close();
  }
});

test('Fetch logs now waits for a running download; the background poll never queues', async () => {
  const fake = await startFakeTerminal({ commKey: 0, records: SAMPLE_RECORDS, logDelayMs: 800 });
  const saved = { ip: config.zk.ip, port: config.zk.port, commKey: config.zk.commKey, mode: config.zk.mode, wait: config.zk.lock.waitMs };
  try {
    config.zk.mode = 'real';
    config.zk.ip = '127.0.0.1';
    config.zk.port = fake.port;
    config.zk.commKey = 0;
    config.zk.lock.waitMs = 8000;
    resetDeviceLock(new DeviceLock({ name: 'sync-wait', gapMs: 0, staleMs: 20_000 }));
    initManager(() => []);

    const poll = syncOnce('poll'); // starts a download that holds the terminal for ~0.8s
    await sleep(100);
    const manual = syncOnce('manual'); // queued behind the download
    const background = await syncOnce('poll'); // must not queue — skipped at once

    assert.equal(background.skipped, true, 'the poll should yield, not queue');
    const [p, m] = await Promise.all([poll, manual]);
    assert.equal(p.ok, true, p.error || p.reason);
    assert.equal(m.ok, true, `manual fetch was refused: ${m.error || m.reason}`);
    assert.equal(fake.state.overlaps || 0, 0);
  } finally {
    config.zk.ip = saved.ip;
    config.zk.port = saved.port;
    config.zk.commKey = saved.commKey;
    config.zk.mode = saved.mode;
    config.zk.lock.waitMs = saved.wait;
    resetDeviceLock(null);
    await fake.close();
  }
});
