/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PERSISTENT SETTINGS STORE
 * ─────────────────────────────────────────────────────────────────────────────
 *  The Windows app (and any installed deployment) must be configurable from
 *  its own UI without editing `.env` and without a restart of the machine.
 *  Settings therefore live in a JSON file inside the ATT home directory:
 *
 *      Windows (installed)   C:\ProgramData\ATT\config.json
 *      Windows (portable)    %APPDATA%\ATT\config.json
 *      Linux / macOS / repo  <repo>/server/data/config.json
 *
 *  Precedence (highest first):
 *      1. real environment variables  — systemd / Render / service wrapper
 *      2. config.json                 — what the desktop app writes
 *      3. built-in defaults           — production-safe values
 *
 *  Every persisted key maps to the SAME env var the server already reads, so
 *  there is exactly one source of truth at runtime: `process.env`. That keeps
 *  `config.js`, the tests and the cloud deployment behaviour unchanged.
 *
 *  Directory layout inside the ATT home:
 *      config.json          settings (this module)
 *      attendance.db        SQLite database
 *      logs/att.log         rotating application log
 *      backups/             on-demand database backups
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Root of the app code. In a dev checkout this is `server/`; inside the Windows
 * app the whole backend is ONE bundle file, so `__dirname` there is the payload
 * directory that also holds web/, runtime/ and packaged.json.
 */
function appRoot() {
  return hasPackagedMarker() ? __dirname : path.resolve(__dirname, '..');
}

const serverRoot = appRoot();

/** key → env mapping, validation rules and defaults. Single definition. */
const FIELDS = [
  // API server
  { key: 'server.port', env: 'PORT', type: 'int', min: 1, max: 65535, def: 4000, label: 'Local port' },
  { key: 'server.host', env: 'HOST', type: 'string', def: '0.0.0.0', label: 'Bind address' },

  // ZKTeco device link — the "connect this computer to the device" knobs
  { key: 'device.mode', env: 'ZK_MODE', type: 'enum', values: ['real', 'bridge', 'mock'], def: 'real', label: 'Connection mode' },
  { key: 'device.ip', env: 'ZK_IP', type: 'host', def: '192.168.1.110', label: 'Device IP / host' },
  { key: 'device.port', env: 'ZK_PORT', type: 'int', min: 1, max: 65535, def: 4370, label: 'Device TCP port' },
  { key: 'device.timeoutMs', env: 'ZK_TIMEOUT_MS', type: 'int', min: 1000, max: 120000, def: 10000, label: 'Device timeout (ms)' },
  { key: 'device.inPort', env: 'ZK_INPORT', type: 'int', min: 1, max: 65535, def: 5200, label: 'UDP reply port' },

  // Background poller
  { key: 'poll.enabled', env: 'POLL_ENABLED', type: 'bool', def: true, label: 'Auto-sync enabled' },
  { key: 'poll.intervalMinutes', env: 'POLL_INTERVAL_MINUTES', type: 'float', min: 0.2, max: 1440, def: 1, label: 'Sync every (minutes)' },

  // Access control (secret — masked in every API response)
  { key: 'security.appPassword', env: 'APP_PASSWORD', type: 'string', secret: true, optional: true, label: 'App password' },
  { key: 'security.appTokenSalt', env: 'APP_TOKEN_SALT', type: 'string', secret: true, optional: true, label: 'Token salt' },

  // Desktop app behaviour (read by the Electron shell through the API)
  { key: 'desktop.autostart', env: 'ATT_AUTOSTART', type: 'bool', def: true, label: 'Start with Windows' },
  { key: 'desktop.closeToTray', env: 'ATT_CLOSE_TO_TRAY', type: 'bool', def: true, label: 'Keep running when the window closes' },
  { key: 'desktop.minimizeToTray', env: 'ATT_MINIMIZE_TO_TRAY', type: 'bool', def: false, label: 'Minimise to tray' },
  { key: 'desktop.serviceEnabled', env: 'ATT_SERVICE_ENABLED', type: 'bool', def: false, label: 'Background Windows service' },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
const SECRET_KEYS = FIELDS.filter((f) => f.secret).map((f) => f.key);
/** What the API shows instead of a secret value (and accepts as "unchanged"). */
const MASK = '••••••••';

/**
 * Env vars that THIS store put into process.env. Only a *foreign* env var
 * (systemd unit, Render dashboard, server/.env) blocks a UI edit — otherwise
 * saving a setting once would permanently lock it.
 */
const ownedEnv = new Set();

/* ── paths ─────────────────────────────────────────────────────────────── */

/**
 * True when running from an installed payload. The Electron shell sets
 * ATT_PACKAGED=1; the Windows service cannot pass environment variables
 * reliably, so the bundler also drops a `packaged.json` marker next to
 * server.cjs and we look for that.
 */
function hasPackagedMarker() {
  try {
    // In the single-file bundle __dirname is the payload directory.
    return fs.existsSync(path.join(__dirname, 'packaged.json'));
  } catch (_) {
    return false;
  }
}

function isInstalledRuntime() {
  return process.env.ATT_PACKAGED === '1' || process.env.ATT_INSTALLED === '1' || hasPackagedMarker();
}

/**
 * ATT home directory. `ATT_HOME` always wins so the desktop shell and the
 * Windows service can be forced to share one directory.
 */
function getHome() {
  if (process.env.ATT_HOME) return path.resolve(process.env.ATT_HOME);
  if (isInstalledRuntime()) {
    if (process.platform === 'win32') {
      // ProgramData is machine-wide: the service (LocalSystem) and the signed-in
      // user's desktop app must see the same database.
      const base = process.env.PROGRAMDATA || process.env.ProgramData || process.env.APPDATA || 'C:\\ProgramData';
      return path.join(base, 'ATT');
    }
    // Not a shipping target, but keep an installed payload out of read-only dirs.
    return path.join(os.homedir(), '.att');
  }
  return path.join(serverRoot, 'data');
}

function getPaths() {
  const home = getHome();
  return {
    home,
    logDir: path.join(home, 'logs'),
    backupDir: path.join(home, 'backups'),
    settingsFile: path.join(home, 'config.json'),
    // dev/repo installs keep the historical <repo>/server/data/attendance.db
    dbFile: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(home, 'attendance.db'),
    logFile: process.env.ATT_LOG_FILE ? path.resolve(process.env.ATT_LOG_FILE) : path.join(home, 'logs', 'att.log'),
    serverRoot,
    hostname: os.hostname(),
    platform: process.platform,
    packaged: isInstalledRuntime(),
  };
}

/* ── validation / coercion ─────────────────────────────────────────────── */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

function isValidIpv4(value) {
  const m = IPV4_RE.exec(String(value).trim());
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

function coerce(field, raw) {
  if (raw === undefined || raw === null || raw === '') {
    if (field.optional) return undefined;
    throw new SettingsError(`${field.key} is required`);
  }
  switch (field.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'off'].includes(s)) return false;
      throw new SettingsError(`${field.key} must be true or false`);
    }
    case 'int':
    case 'float': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new SettingsError(`${field.key} must be a number`);
      const value = field.type === 'int' ? Math.trunc(n) : n;
      if (field.min !== undefined && value < field.min) throw new SettingsError(`${field.key} must be ≥ ${field.min}`);
      if (field.max !== undefined && value > field.max) throw new SettingsError(`${field.key} must be ≤ ${field.max}`);
      return value;
    }
    case 'enum': {
      const s = String(raw).trim().toLowerCase();
      if (!field.values.includes(s)) throw new SettingsError(`${field.key} must be one of: ${field.values.join(', ')}`);
      return s;
    }
    case 'host': {
      const s = String(raw).trim();
      // A dotted quad must really be a valid IPv4 address — "999.1.1.1" would
      // otherwise slip through as a "hostname" and cost an hour of debugging.
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
        if (!isValidIpv4(s)) throw new SettingsError(`${field.key} is not a valid IPv4 address (got "${s}")`);
        return s;
      }
      if (!HOST_RE.test(s)) throw new SettingsError(`${field.key} must be an IP address or hostname (got "${s}")`);
      return s;
    }
    default: {
      const s = String(raw).trim();
      if (!field.optional && s === '') throw new SettingsError(`${field.key} must not be empty`);
      if (s.length > 512) throw new SettingsError(`${field.key} is too long`);
      return s;
    }
  }
}

class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsError';
    this.status = 422;
  }
}

/* ── nested object helpers ─────────────────────────────────────────────── */

function getPath(obj, key) {
  return key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  if (value === undefined) delete node[parts[parts.length - 1]];
  else node[parts[parts.length - 1]] = value;
  return obj;
}

/* ── file IO (atomic) ──────────────────────────────────────────────────── */

function ensureHome() {
  const paths = getPaths();
  for (const dir of [paths.home, paths.logDir, paths.backupDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

function readRaw() {
  const file = getPaths().settingsFile;
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    // A corrupt settings file must never stop the app from booting: back it up
    // and start from defaults.
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (_) { /* best effort */ }
    console.error(`[settings] ${file} is unreadable (${err.message}) — using defaults`);
    return {};
  }
}

function writeRaw(next) {
  const paths = ensureHome();
  const file = paths.settingsFile;
  const payload = { ...next, _meta: { updatedAt: new Date().toISOString(), updatedBy: os.hostname() } };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return payload;
}

/* ── public API ────────────────────────────────────────────────────────── */

/** Fill missing env vars from config.json. Called once, before config.js reads env. */
function hydrateEnvFromSettings() {
  const stored = readRaw();
  const applied = [];
  for (const field of FIELDS) {
    if (process.env[field.env] !== undefined) continue;
    const value = getPath(stored, field.key);
    if (value === undefined || value === null || value === '') continue;
    process.env[field.env] = String(value);
    ownedEnv.add(field.env);
    applied.push(field.key);
  }
  return applied;
}

/** Current effective settings (env > file > default), secrets masked. */
function describeSettings({ maskSecrets = true } = {}) {
  const file = readRaw();
  const out = {};
  for (const field of FIELDS) {
    let value;
    const fromEnv = process.env[field.env];
    if (fromEnv !== undefined && fromEnv !== '') {
      value = fromEnv;
      try { value = coerce(field, fromEnv); } catch (_) { value = fromEnv; }
    } else {
      const fromFile = getPath(file, field.key);
      value = fromFile === undefined ? field.def : fromFile;
      try { value = coerce(field, value); } catch (_) { /* keep raw */ }
    }
    if (field.secret && maskSecrets) value = value ? MASK : '';
    if (value !== undefined) setPath(out, field.key, value);
  }
  return out;
}

/** Field metadata for the UI (labels, ranges, whether a value is secret). */
function describeSchema() {
  return FIELDS.map((f) => ({
    key: f.key,
    env: f.env,
    type: f.type,
    label: f.label,
    values: f.values,
    min: f.min,
    max: f.max,
    default: f.def,
    secret: Boolean(f.secret),
    persisted: process.env[f.env] === undefined, // env overrides cannot be saved from the UI
  }));
}

/** Accept either {'device.ip': x} or {device:{ip:x}} — normalise to dotted keys. */
function flattenPatch(patch, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('_')) continue; // _meta and friends are never user input
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenPatch(value, full));
    } else {
      out[full] = value;
    }
  }
  return out;
}

/**
 * Validate + persist a partial settings object (dotted or nested keys).
 * Returns the normalised values, both as a nested object (`saved`, what
 * config.applySettings consumes) and as a flat key list.
 */
function saveSettings(patch) {
  if (!patch || typeof patch !== 'object') throw new SettingsError('A settings object is required');
  const stored = readRaw();
  const nested = {};
  const flat = {};

  for (const [key, raw] of Object.entries(flattenPatch(patch))) {
    const field = BY_KEY.get(key);
    if (!field) throw new SettingsError(`Unknown setting "${key}"`);
    const locked = process.env[field.env] !== undefined && !ownedEnv.has(field.env);
    if (locked && !isInstalledRuntime()) {
      // In cloud/systemd deployments an explicit env var is the operator's
      // decision — refuse to silently shadow it. The installed Windows app sets
      // ATT_PACKAGED=1 and owns its environment, so it may always write.
      throw new SettingsError(
        `${key} is fixed by the ${field.env} environment variable on this host and cannot be changed from the UI`
      );
    }
    if (field.secret && (raw === '' || raw === null)) {
      setPath(stored, key, undefined);
      delete process.env[field.env];
      ownedEnv.delete(field.env);
      setPath(nested, key, null);
      flat[key] = null;
      continue;
    }
    if (field.secret && raw === MASK) continue; // UI echo of a masked value → no change
    const value = coerce(field, raw);
    if (value === undefined) continue;
    setPath(stored, key, value);
    process.env[field.env] = String(value);
    ownedEnv.add(field.env);
    setPath(nested, key, field.secret ? MASK : value);
    flat[key] = field.secret ? MASK : value;
  }

  writeRaw(stored);
  return { saved: nested, savedKeys: Object.keys(flat), flat, settings: describeSettings() };
}

function getSetting(key) {
  const field = BY_KEY.get(key);
  if (!field) throw new SettingsError(`Unknown setting "${key}"`);
  return getPath(describeSettings({ maskSecrets: false }), key);
}

module.exports = {
  FIELDS,
  SECRET_KEYS,
  MASK,
  SettingsError,
  appRoot,
  getHome,
  getPaths,
  ensureHome,
  readRaw,
  writeRaw,
  hydrateEnvFromSettings,
  describeSettings,
  describeSchema,
  saveSettings,
  getSetting,
  isValidIpv4,
  isInstalledRuntime,
};
