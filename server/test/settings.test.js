/**
 * Settings store: persistence, validation, env precedence, secret masking.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ATT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'att-settings-'));
delete process.env.ZK_IP; // this test owns the device IP
delete process.env.POLL_INTERVAL_MINUTES;

const settings = require('../src/settings');

test('persists nested and dotted patches and normalises values', () => {
  const { saved, savedKeys } = settings.saveSettings({
    'device.ip': '10.0.0.42',
    device: { port: '4371' },
    'poll.intervalMinutes': '7.5',
    'desktop.autostart': false,
  });
  assert.deepEqual(saved.device, { ip: '10.0.0.42', port: 4371 });
  assert.equal(saved.poll.intervalMinutes, 7.5);
  assert.equal(saved.desktop.autostart, false);
  assert.ok(savedKeys.includes('device.ip'));

  const file = JSON.parse(fs.readFileSync(settings.getPaths().settingsFile, 'utf8'));
  assert.equal(file.device.ip, '10.0.0.42');
  assert.equal(file.device.port, 4371);

  // process.env is the single runtime source of truth
  assert.equal(process.env.ZK_IP, '10.0.0.42');
  assert.equal(process.env.ZK_PORT, '4371');
});

test('describeSettings reflects env > file > defaults and masks secrets', () => {
  const view = settings.describeSettings();
  assert.equal(view.device.ip, '10.0.0.42');
  assert.equal(view.poll.intervalMinutes, 7.5);
  assert.equal(view.security.appPassword, '');

  settings.saveSettings({ 'security.appPassword': 'hunter2-secret' });
  const masked = settings.describeSettings();
  assert.equal(masked.security.appPassword, settings.MASK);
  const raw = settings.describeSettings({ maskSecrets: false });
  assert.equal(raw.security.appPassword, 'hunter2-secret');

  // masking echo: saving the mask back must NOT wipe the secret
  settings.saveSettings({ 'security.appPassword': settings.MASK });
  assert.equal(settings.describeSettings({ maskSecrets: false }).security.appPassword, 'hunter2-secret');

  settings.saveSettings({ 'security.appPassword': null });
  assert.equal(settings.describeSettings({ maskSecrets: false }).security?.appPassword, undefined);
  // …but the masked view still exposes the (empty) field for the UI
  assert.equal(settings.describeSettings().security.appPassword, '');
});

test('rejects invalid values without writing them', () => {
  const cases = [
    [{ 'device.port': 99999 }, /must be ≤ 65535/],
    [{ 'device.port': -1 }, /must be ≥ 1/],
    [{ 'device.ip': '999.1.1.1' }, /not a valid IPv4/],
    [{ 'device.ip': 'not a host!' }, /IP address or hostname/],
    [{ 'device.mode': 'telepathy' }, /must be one of/],
    [{ 'poll.intervalMinutes': 0.01 }, /must be ≥/],
    [{ 'nope.deep': 1 }, /Unknown setting/],
    [{ 'poll.enabled': 'sometimes' }, /true or false/],
  ];
  const before = settings.describeSettings({ maskSecrets: false }).device.port;
  for (const [patch, re] of cases) {
    assert.throws(() => settings.saveSettings(patch), (err) => {
      assert.equal(err.name, 'SettingsError');
      assert.match(err.message, re);
      return true;
    }, JSON.stringify(patch));
  }
  assert.equal(settings.describeSettings({ maskSecrets: false }).device.port, before);
});

test('the Comm Key is stored as a number, exposed in the schema, and range-checked', () => {
  // A FOREIGN ZK_COMM_KEY (an operator's env var, never written by the store)
  // owns the value: the UI must say so instead of failing on Save.
  process.env.ZK_COMM_KEY = '777';
  assert.equal(settings.describeSchema().find((f) => f.key === 'device.commKey').editable, false);
  assert.throws(() => settings.saveSettings({ 'device.commKey': 1 }), /fixed by the ZK_COMM_KEY environment variable/);
  delete process.env.ZK_COMM_KEY;

  // The keypad gives you digits; the UI may post a string. Normalise.
  const { saved } = settings.saveSettings({ 'device.commKey': '2468' });
  assert.equal(saved.device.commKey, 2468);
  assert.equal(settings.describeSettings({ maskSecrets: false }).device.commKey, 2468);
  const onDisk = JSON.parse(fs.readFileSync(settings.getPaths().settingsFile, 'utf8'));
  assert.equal(onDisk.device.commKey, 2468, 'survives a restart');
  assert.equal(process.env.ZK_COMM_KEY, '2468', 'config reads it from the environment');

  // The Settings page renders this field from the schema.
  const field = settings.describeSchema().find((f) => f.key === 'device.commKey');
  assert.ok(field, 'device.commKey is part of the published schema');
  assert.equal(field.env, 'ZK_COMM_KEY');
  assert.equal(field.min, 0);
  assert.equal(field.secret, false, 'operators must be able to read the key back to type it on the keypad');
  // Saving puts ZK_COMM_KEY into the environment, so `persisted` flips to false
  // — but the store owns that var, so the field must stay editable. (`editable`
  // exists precisely because `persisted` alone would grey the input out here.)
  assert.equal(field.persisted, false);
  assert.equal(field.editable, true, 'a store-owned env var does not lock the field');

  for (const bad of [-1, 'abc', NaN]) {
    assert.throws(() => settings.saveSettings({ 'device.commKey': bad }), /device\.commKey/, String(bad));
  }
  assert.equal(settings.describeSettings({ maskSecrets: false }).device.commKey, 2468, 'a rejected save changes nothing');

  // 0 is a real value, not "unset": it removes the password.
  assert.equal(settings.saveSettings({ 'device.commKey': 0 }).saved.device.commKey, 0);
});

test('a foreign env var locks the setting; store-owned env does not', () => {
  // HOST was never written by the store → it counts as an operator decision.
  process.env.HOST = '192.0.2.7';
  assert.throws(() => settings.saveSettings({ 'server.host': '10.9.9.9' }), /fixed by the HOST environment variable/);

  // env vars the store itself wrote stay editable (otherwise one save locks it)
  delete process.env.ZK_PORT;
  settings.saveSettings({ 'device.port': 4370 });
  assert.doesNotThrow(() => settings.saveSettings({ 'device.port': 4370 }));
  delete process.env.HOST;
});

test('hydrate fills only undefined env vars (env wins over file)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'att-hydrate-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ device: { ip: '172.16.5.5', port: 4400 }, poll: { intervalMinutes: 3 } })
  );
  process.env.ATT_HOME = home;
  delete process.env.ZK_IP; // let the file win for this key
  delete process.env.POLL_INTERVAL_MINUTES;
  process.env.ZK_PORT = '5555'; // operator-set: must win over the file
  const applied = settings.hydrateEnvFromSettings();
  assert.deepEqual(applied.sort(), ['device.ip', 'poll.intervalMinutes']);
  assert.equal(process.env.ZK_IP, '172.16.5.5');
  assert.equal(process.env.ZK_PORT, '5555'); // untouched — operator decided
  delete process.env.ZK_PORT;
});

test('a corrupt settings file is quarantined, never fatal', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'att-corrupt-'));
  fs.writeFileSync(path.join(home, 'config.json'), '{ not json');
  process.env.ATT_HOME = home;
  assert.deepEqual(settings.readRaw(), {});
  const backups = fs.readdirSync(home).filter((f) => f.startsWith('config.json.corrupt-'));
  assert.equal(backups.length, 1);
});
