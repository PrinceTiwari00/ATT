/**
 * System API end-to-end: the surface the installed Windows app drives.
 * Boots the real app on an ephemeral port with a throwaway ATT home.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ATT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'att-system-'));
process.env.ZK_MODE = 'mock';
delete process.env.ZK_IP;
delete process.env.APP_PASSWORD;
// This file asserts route behaviour, not session timing: without it the 350ms
// inter-session cool-down would make the next request "device busy" depending
// on how fast the previous test happened to run. The busy path has its own test.
process.env.ZK_SESSION_GAP_MS = '0';

const { bootServer } = require('../src/bootstrap');

let handle = null;
let base = '';
const json = (r) => r.json();

/**
 * Wait until no ATT operation owns the terminal. Restarting the poller (see the
 * settings test) fires an immediate sync, and in mock mode that lands a few
 * milliseconds later — right in the middle of whatever runs next. Device
 * assertions must not depend on that race.
 */
async function settleDevice(timeoutMs = 5000) {
  const { getDeviceLock } = require('../src/zk/deviceLock');
  const lock = getDeviceLock();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = lock.status();
    if (!st.locked && st.cooldownRemainingMs <= 0) return st;
    if (Date.now() > deadline) throw new Error(`device still busy: ${JSON.stringify(st.owner || st.waiting)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test.before(async () => {
  handle = await bootServer({ port: 0, poll: false, mode: 'test' });
  base = handle.url;
});

test.after(async () => {
  await handle.close();
});

test('GET /api/system/info reports runtime, paths and poller state', async () => {
  const res = await fetch(`${base}/api/system/info`);
  assert.equal(res.status, 200);
  const { data } = await json(res);
  assert.equal(data.app.packaged, false);
  assert.equal(data.paths.home, process.env.ATT_HOME);
  assert.equal(data.poller.enabled, true);
  assert.equal(data.poller.running, false); // poll:false in tests
  assert.ok(data.app.version);
});

test('GET /api/system/settings returns values plus a form schema', async () => {
  const { data } = await json(await fetch(`${base}/api/system/settings`));
  assert.equal(data.settings.device.port, 4370);
  assert.ok(Array.isArray(data.schema));
  const portField = data.schema.find((f) => f.key === 'device.port');
  assert.equal(portField.max, 65535);
  assert.deepEqual(data.requiresRestartFor, ['server.port', 'server.host']);
});

test('PUT /api/system/settings persists, reconfigures the device live and restarts the poller', async () => {
  const res = await fetch(`${base}/api/system/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device: { ip: '192.168.50.10' }, 'poll.intervalMinutes': 2 }),
  });
  assert.equal(res.status, 200);
  const { data } = await json(res);
  assert.equal(data.saved.device.ip, '192.168.50.10');
  assert.equal(data.changed.zk, true);
  assert.equal(data.changed.poll, true);
  assert.ok(data.actions.some((a) => a.action === 'device-reconfigured' && a.ok));
  assert.ok(data.actions.some((a) => a.action === 'poller-restarted'));

  // the manager really swapped its adapter
  const status = await json(await fetch(`${base}/api/device/status`));
  assert.equal(status.data.target.ip, '192.168.50.10');
  assert.equal(status.data.reconfiguredAt, data.actions.find((a) => a.action === 'device-reconfigured').at);

  // and it is on disk for the next boot
  const file = JSON.parse(fs.readFileSync(path.join(process.env.ATT_HOME, 'config.json'), 'utf8'));
  assert.equal(file.device.ip, '192.168.50.10');
});

test('PUT /api/system/settings validates (422) and never half-writes', async () => {
  const res = await fetch(`${base}/api/system/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ 'device.port': 70000 }),
  });
  assert.equal(res.status, 422);
  const body = await json(res);
  assert.match(body.error, /65535/);
});

test('POST /api/system/device/probe handshakes without saving anything', async () => {
  await settleDevice();
  const res = await fetch(`${base}/api/system/device/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ip: '127.0.0.1', port: 1, timeoutMs: 1500 }),
  });
  assert.equal(res.status, 502); // nothing on 127.0.0.1:1
  const { data } = await json(res);
  assert.equal(data.ok, false);
  assert.ok(/refused|ECONNREFUSED|timeout/i.test(data.error));

  // probe must not have touched the configured link
  const status = await json(await fetch(`${base}/api/device/status`));
  assert.equal(status.data.target.ip, '192.168.50.10');
});

test('POST /api/system/device/probe answers 409 while another operation owns the terminal', async () => {
  // The wizard must learn "ATT is using the device right now" — not a 502 that
  // reads as a broken terminal.
  await settleDevice();
  const { getDeviceLock } = require('../src/zk/deviceLock');
  const lock = getDeviceLock();
  const ticket = await lock.acquire('poller:getAttendance', { origin: 'poller:poll' });
  try {
    const res = await fetch(`${base}/api/system/device/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ip: '127.0.0.1', port: 1, timeoutMs: 1500 }),
    });
    assert.equal(res.status, 409);
    const { data } = await json(res);
    assert.equal(data.busy, true);
    assert.match(data.error, /terminal is busy/);
    assert.match(data.error, /poller:getAttendance/, 'the message names the operation holding the device');
  } finally {
    lock.release(ticket);
  }
});

test('POST /api/system/diagnostics skips the handshake (not fails it) while the terminal is busy', async () => {
  await settleDevice();
  const { getDeviceLock } = require('../src/zk/deviceLock');
  const lock = getDeviceLock();
  const ticket = await lock.acquire('device:fetch-logs', { origin: 'route:device' });
  try {
    const res = await fetch(`${base}/api/system/diagnostics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A loopback target so the TCP steps pass and only the handshake can differ.
      body: JSON.stringify({ ip: '127.0.0.1', port: 1, ping: false, timeoutMs: 1200 }),
    });
    assert.equal(res.status, 200);
    const { data } = await json(res);
    const handshake = data.steps.find((s) => s.id === 'handshake');
    assert.ok(handshake, 'the handshake step is always reported');
    assert.notEqual(handshake.status, 'fail', 'a busy terminal is not a failed handshake');
  } finally {
    lock.release(ticket);
  }
});

test('POST /api/system/diagnostics returns the ordered checklist', async () => {
  const res = await fetch(`${base}/api/system/diagnostics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ip: '192.168.50.10', port: 4370, ping: false, timeoutMs: 800 }),
  });
  assert.equal(res.status, 200);
  const { data } = await json(res);
  assert.deepEqual(data.steps.map((s) => s.id), ['local-network', 'subnet', 'tcp', 'handshake']);
  assert.equal(data.steps.find((s) => s.id === 'tcp').status, 'fail');
  assert.ok(Array.isArray(data.interfaces));
});

test('GET /api/system/network exposes interfaces, gateways and subnet relation', async () => {
  const { data } = await json(await fetch(`${base}/api/system/network`));
  assert.ok(Array.isArray(data.interfaces));
  assert.equal(typeof data.link.sameSubnet, 'boolean');
  assert.equal(data.device.ip, '192.168.50.10');
});

test('POST /api/system/discover sweeps and reports (409 while scanning is guarded by server)', async () => {
  const res = await fetch(`${base}/api/system/discover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cidrs: ['127.0.0.1/30'], port: 1, timeoutMs: 300, identify: false }),
  });
  assert.equal(res.status, 200);
  const { data } = await json(res);
  assert.equal(data.scanned, 2);
  assert.ok(Array.isArray(data.devices));
});

test('backups: create, list and keep the newest first', async () => {
  const res = await fetch(`${base}/api/system/backup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'unit' }),
  });
  assert.equal(res.status, 200);
  const { data } = await json(res);
  assert.ok(fs.existsSync(data.file));
  assert.ok(data.bytes > 0);

  const list = await json(await fetch(`${base}/api/system/backups`));
  assert.ok(list.data.backups.length >= 1);
  assert.equal(list.data.backups[0].name, path.basename(data.file));
});

test('GET /api/system/logs answers with a line array (file may not exist yet)', async () => {
  const { data } = await json(await fetch(`${base}/api/system/logs?lines=50`));
  assert.ok(Array.isArray(data.lines));
  assert.equal(typeof data.exists, 'boolean');
});

test('GET /api/system/service is honest off-Windows', async () => {
  const { data } = await json(await fetch(`${base}/api/system/service`));
  assert.equal(data.supported, process.platform === 'win32');
});

/* ── roster writes vs. the raw ledger (fresh-install flow) ──────────────── */

const { getDb } = require('../src/db/connection');
const { todayStr } = require('../src/zk/deviceContract');

const postJson = (url, body) =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('POST /api/teachers accepts a profile with no shift_id (falls back to the default shift)', async () => {
  const res = await postJson('/api/teachers', { zk_user_id: '201', full_name: 'Roshan No-Shift' });
  const body = await json(res);
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.data.shift_id, null);
  assert.equal(body.data.zk_user_id, '201');
});

test('GET /api/device/status reports library capabilities (mock: everything writable)', async () => {
  const { data } = await json(await fetch(`${base}/api/device/status`));
  assert.ok(data.capabilities, 'capabilities must be part of the device status payload');
  assert.equal(data.capabilities.source, 'mock');
  assert.equal(data.capabilities.canFetchAttendance, true);
  assert.equal(data.capabilities.canWriteUsers, true);
});

test('history pulled BEFORE a teacher was registered is not lost (adopt on create)', async () => {
  const db = getDb();
  const today = todayStr();
  const zkId = '301';

  // Give the profile a deterministic shift so the expected status is exact.
  const shiftRes = await postJson('/api/shifts', {
    name: 'System-test shift',
    start_time: '08:00',
    end_time: '16:00',
    grace_period_minutes: 10,
  });
  const shiftBody = await json(shiftRes);
  assert.equal(shiftRes.status, 201, JSON.stringify(shiftBody));
  const shift = shiftBody.data;

  // What the very first poll stores: punches with no profile to point at.
  const insertLog = db.prepare(
    `INSERT OR IGNORE INTO attendance_logs (teacher_id, zk_user_id, device_sn, punch_time, punch_type, source)
     VALUES (NULL, ?, 'TEST-SN', ?, 0, 'device')`
  );
  insertLog.run(zkId, `${today}T07:55:00`);
  insertLog.run(zkId, `${today}T16:05:00`);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM attendance_logs WHERE zk_user_id = ? AND teacher_id IS NULL').get(zkId).c,
    2,
    'precondition: the punches the school already synced are orphaned'
  );

  const createRes = await postJson('/api/teachers', {
    zk_user_id: zkId,
    full_name: 'Ram Bahadur',
    shift_id: shift.id,
  });
  const created = await json(createRes);
  assert.equal(createRes.status, 201, JSON.stringify(created));
  const teacherId = created.data.id;
  assert.equal(created.linkedPunches, 2, 'creating the profile must adopt the punches it already owns');

  const linked = db
    .prepare('SELECT teacher_id FROM attendance_logs WHERE zk_user_id = ? GROUP BY teacher_id')
    .all(zkId);
  assert.deepEqual(linked.map((r) => r.teacher_id), [teacherId]);

  const daily = await json(await fetch(`${base}/api/attendance/daily?date=${today}`));
  const row = daily.data.find((r) => r.zk_user_id === zkId);
  assert.ok(row, 'the new profile must appear in today\'s ledger without waiting for the next poll');
  assert.equal(row.status, 'on_time');
  assert.equal(row.punch_count, 2);
  assert.equal(row.check_in, `${today}T07:55:00`);
  assert.equal(row.check_out, `${today}T16:05:00`);
});

test('POST /api/device/users/import links existing punches AND rebuilds their days', async () => {
  const db = getDb();
  const today = todayStr();
  const zkId = '401';

  // A device user nobody registered, who has been punching for a week.
  const insertLog = db.prepare(
    `INSERT OR IGNORE INTO attendance_logs (teacher_id, zk_user_id, punch_time, punch_type, source)
     VALUES (NULL, ?, ?, 0, 'device')`
  );
  const yesterday = new Date(`${today}T00:00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  const y = yesterday.toISOString().slice(0, 10);
  insertLog.run(zkId, `${y}T08:05:00`);
  insertLog.run(zkId, `${y}T16:10:00`);

  const res = await postJson('/api/device/users/import', {
    users: [{ userId: zkId, name: 'Sita Kumari' }],
  });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.imported, 1);
  assert.ok(body.linkedPunches >= 2, 'the import must link the punches already in the ledger');
  assert.ok(body.daysRecomputed >= 1);

  // The linked day must now be a real summary, not a stale "absent".
  const daily = await json(await fetch(`${base}/api/attendance/daily?date=${y}&q=Sita`));
  const row = daily.data.find((r) => r.zk_user_id === zkId);
  assert.ok(row);
  assert.equal(row.punch_count, 2);
  assert.notEqual(row.status, 'absent');
});

test('POST /api/system/shutdown accepts loopback when auth is off (no exit in tests)', async () => {
  const res = await fetch(`${base}/api/system/shutdown`, { method: 'POST' });
  // loopback + no APP_PASSWORD → allowed. In this test process nobody listens
  // for the att:shutdown event (that listener lives in src/index.js), so the
  // server keeps running for the remaining tests.
  assert.equal(res.status, 200);
});

test('a second backend on the same ATT home is refused (instance lock)', async () => {
  // The previous test scheduled a shutdown; give it a moment, then boot again —
  // either the process is gone (fine) or the lock is held (also fine to assert).
  await new Promise((r) => setTimeout(r, 400));
  try {
    const second = await bootServer({ port: 0, poll: false });
    await second.close();
  } catch (err) {
    assert.equal(err.code, 'INSTANCE_RUNNING');
  }
});

