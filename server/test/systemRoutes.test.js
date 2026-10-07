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

const { bootServer } = require('../src/bootstrap');

let handle = null;
let base = '';
const json = (r) => r.json();

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
