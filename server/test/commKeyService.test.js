/**
 * COMM KEY SERVICE — changing the terminal's connection password safely.
 *
 * This is the one device operation that can lock ATT out of its own terminal,
 * so the tests below are all about the safety net: persist first, verify with a
 * fresh session, and put everything back when the device does not behave.
 *
 * Runs against the simulator, whose module-level device key stands in for the
 * value stored in real firmware (it survives an adapter rebuild, just like the
 * terminal's own setting survives a client restart).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ATT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'att-commkey-'));
process.env.ZK_MODE = 'mock';
process.env.ZK_SESSION_GAP_MS = '0';
delete process.env.ZK_COMM_KEY;

const config = require('../src/config');
const settings = require('../src/settings');
const { migrate } = require('../src/db/migrate');
const { initManager, getManager } = require('../src/zk/manager');
const { MockZKDevice, setSimulatedCommKey, getSimulatedCommKey } = require('../src/zk/mockDevice');
const { resetDeviceLock, getDeviceLock, DeviceLock } = require('../src/zk/deviceLock');
const commKeyService = require('../src/services/commKey');
const { syncOnce } = require('../src/services/poller');

migrate();
resetDeviceLock(new DeviceLock({ name: 'commkey-test', gapMs: 0, staleMs: 20_000 }));
initManager(() => []);

/** Restore a pristine state between tests. */
function reset({ key = 0 } = {}) {
  setSimulatedCommKey(key);
  settings.saveSettings({ 'device.commKey': key });
  config.applySettings({ device: { commKey: key } });
  getManager().reconfigure('test-reset');
}

/** Patch a MockZKDevice method for one test. */
function patchDevice(method, impl) {
  const original = MockZKDevice.prototype[method];
  MockZKDevice.prototype[method] = impl;
  return () => { MockZKDevice.prototype[method] = original; };
}

test('getState reports what ATT uses and what the terminal has', async () => {
  reset({ key: 0 });
  const state = await commKeyService.getState();
  assert.equal(state.configured, 0);
  assert.equal(state.set, false);
  assert.equal(state.mode, 'mock');
  assert.equal(state.supportedByLibrary, true);
  assert.equal(state.device.supported, true);
  assert.equal(state.device.deviceValue, '0');
  assert.equal(state.device.matches, true);
});

test('a terminal keyed behind ATT\'s back is reported, not silently unreachable', async () => {
  reset({ key: 0 });
  setSimulatedCommKey(4); // somebody set it on the keypad

  const state = await commKeyService.getState();
  assert.equal(state.configured, 0);
  // Reading the key needs a session, and the session needs the key — so this
  // surfaces as a failed read that NAMES the cause.
  assert.equal(state.device.ok, false);
  assert.equal(state.device.keyMismatchLikely, true);
  assert.match(state.device.error, /Comm Key 4/);
  assert.match(state.device.hint, /Menu → COMM → Comm Key/);

  // The recovery path the hint describes actually works:
  const fixed = await commKeyService.changeCommKey({ key: 4, writeToDevice: false });
  assert.equal(fixed.ok, true);
  const after = await commKeyService.getState();
  assert.equal(after.device.matches, true);
  reset({ key: 0 });
});

test('changing the key on the device: read → write → verify → apply', async () => {
  reset({ key: 0 });
  const out = await commKeyService.changeCommKey({ key: 1, writeToDevice: true });

  assert.equal(out.ok, true);
  assert.equal(out.key, 1);
  assert.equal(out.previousKey, 0);
  assert.equal(out.verified, true);
  assert.equal(getSimulatedCommKey(), 1, 'the terminal now demands the key');
  assert.equal(config.zk.commKey, 1, 'and ATT is using it');
  assert.equal(settings.readRaw().device.commKey, 1, 'persisted, so it survives a restart');

  const steps = out.steps.map((s) => s.step);
  assert.deepEqual(steps, ['persist', 'read-device', 'write-device', 'verify', 'apply']);

  // The whole thing still syncs afterwards — the point of the exercise.
  const sync = await syncOnce('manual');
  assert.equal(sync.ok, true, sync.error || sync.reason);
  reset({ key: 0 });
});

test('a device that does not accept the new key is rolled back to the old one', async () => {
  reset({ key: 0 });

  // Firmware that ACKs the write but stores something else (a real failure mode
  // on locked-down devices): the verify step must catch it and undo everything.
  const script = [999, 0]; // first write "sticks" as 999, the rollback restores 0
  const restore = patchDevice('writeCommKey', async function writeCommKey() {
    setSimulatedCommKey(script.shift());
    return { ok: true, name: 'COMKey', simulated: true };
  });

  try {
    const err = await commKeyService.changeCommKey({ key: 7, writeToDevice: true }).then(
      () => null,
      (e) => e
    );
    assert.ok(err, 'the change must fail loudly');
    assert.match(err.message, /could not reconnect with it/);
    assert.match(err.message, /set back to 0/);

    const steps = err.steps.map((s) => s.step);
    assert.ok(steps.includes('verify'), 'it must have tried to log in with the new key');
    assert.ok(steps.includes('rollback'), '…and put the device back');
    assert.equal(err.steps.find((s) => s.step === 'rollback').to, 0);

    assert.equal(getSimulatedCommKey(), 0, 'terminal restored');
    assert.equal(config.zk.commKey, 0, 'ATT restored');
    assert.equal(settings.readRaw().device.commKey, 0, 'settings restored');

    const sync = await syncOnce('manual');
    assert.equal(sync.ok, true, 'and the link still works');
  } finally {
    restore();
    reset({ key: 0 });
  }
});

test('firmware that will not expose the option is told to use the keypad', async () => {
  reset({ key: 0 });
  const restore = patchDevice('readCommKey', async () => ({
    supported: false, name: null, value: null, tried: [{ name: 'COMKey', error: 'no reply' }],
  }));

  try {
    const err = await commKeyService.changeCommKey({ key: 3, writeToDevice: true }).then(
      () => null,
      (e) => e
    );
    assert.ok(err);
    assert.match(err.message, /does not expose its Comm Key/);
    assert.match(err.message, /Menu → COMM → Comm Key/);
    assert.equal(config.zk.commKey, 0, 'ATT must not be left holding a key the device does not have');
    assert.equal(settings.readRaw().device.commKey, 0);
    assert.equal(getSimulatedCommKey(), 0, 'the terminal was never written to');
  } finally {
    restore();
    reset({ key: 0 });
  }
});

test('"update ATT only" saves the key without touching the terminal', async () => {
  reset({ key: 0 });
  setSimulatedCommKey(8); // the school already typed 8 on the keypad

  const out = await commKeyService.changeCommKey({ key: 8, writeToDevice: false });
  assert.equal(out.ok, true);
  assert.equal(out.writeToDevice, false);
  assert.equal(config.zk.commKey, 8);
  assert.equal(getSimulatedCommKey(), 8);
  assert.deepEqual(out.steps.map((s) => s.step), ['persist', 'apply']);

  const sync = await syncOnce('manual');
  assert.equal(sync.ok, true, 'ATT now speaks the key the device already had');
  reset({ key: 0 });
});

test('saving a key ATT cannot remember is refused BEFORE the device is changed', async () => {
  reset({ key: 0 });
  // An environment variable owned by the operator (systemd/Render) blocks a UI
  // edit — changing the terminal anyway would lose the key on the next restart.
  const saved = process.env.ZK_COMM_KEY;
  process.env.ZK_COMM_KEY = '5';
  const originalSave = settings.saveSettings;
  settings.saveSettings = () => {
    const err = new settings.SettingsError('device.commKey is fixed by the ZK_COMM_KEY environment variable');
    throw err;
  };
  try {
    const err = await commKeyService.changeCommKey({ key: 2, writeToDevice: true }).then(
      () => null,
      (e) => e
    );
    assert.ok(err);
    assert.match(err.message, /cannot remember the new Comm Key/);
    assert.match(err.message, /Nothing was written to the terminal/);
    assert.equal(getSimulatedCommKey(), 0, 'the terminal was left alone');
    assert.equal(err.steps[0].step, 'persist');
    assert.equal(err.steps[0].ok, false);
  } finally {
    settings.saveSettings = originalSave;
    if (saved === undefined) delete process.env.ZK_COMM_KEY;
    else process.env.ZK_COMM_KEY = saved;
    reset({ key: 0 });
  }
});

test('absurd keys are rejected before anything is attempted', async () => {
  reset({ key: 0 });
  await assert.rejects(
    () => commKeyService.changeCommKey({ key: 1234567, writeToDevice: true }),
    /too large/
  );
  await assert.rejects(
    () => commKeyService.changeCommKey({ key: -1, writeToDevice: true }),
    /must be a number/
  );
  assert.equal(config.zk.commKey, 0);
});

test('the change runs inside ONE device session — no poll can slip in', async () => {
  reset({ key: 0 });
  const lock = getDeviceLock();
  const seen = [];
  const restore = patchDevice('writeCommKey', async function writeCommKey(key) {
    seen.push({ duringWrite: lock.locked, owner: lock.status().owner && lock.status().owner.label });
    setSimulatedCommKey(Number(key) || 0);
    return { ok: true, name: 'COMKey' };
  });

  try {
    const pending = commKeyService.changeCommKey({ key: 2, writeToDevice: true });
    // A poll that fires mid-change must be refused rather than interleaved.
    await new Promise((r) => setTimeout(r, 5));
    const poll = await syncOnce('poll');
    const out = await pending;

    assert.equal(out.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].duringWrite, true, 'the lock was held while the device was written');
    assert.match(seen[0].owner, /comm-key/, 'and it was held by the comm-key change');
    assert.equal(poll.skipped, true, 'the poll was skipped, not failed');
    assert.equal(poll.ok, false);
  } finally {
    restore();
    reset({ key: 0 });
  }
});
