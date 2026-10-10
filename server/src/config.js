/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  RUNTIME CONFIGURATION
 * ─────────────────────────────────────────────────────────────────────────────
 *  Resolution order (highest first):
 *      1. real environment variables   (systemd, Render, service wrapper)
 *      2. server/.env                  (developer / operator convenience)
 *      3. <ATT_HOME>/config.json       (what the Windows app's UI writes)
 *      4. production-safe defaults
 *
 *  The exported `config` object is MUTATED IN PLACE by `applySettings()` so
 *  every module that captured a reference (device manager, poller, routes)
 *  immediately sees a reconfigured device link — no restart required when the
 *  user points the app at a different ZKTeco terminal.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const path = require('path');
const fs = require('fs');
const settings = require('./settings');

const root = settings.appRoot();

/* Zero-dependency .env loader — `cp .env.example .env` just works.
   Real environment variables always win over the file. */
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '');
  }
}

/* Installed app settings — only fills env vars nobody else defined. */
const settingsApplied = settings.hydrateEnvFromSettings();
if (settingsApplied.length) {
  console.log(`[settings] loaded from ${settings.getPaths().settingsFile}: ${settingsApplied.join(', ')}`);
}

const paths = settings.getPaths();

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0';
  } catch (_) {
    return process.env.ATT_APP_VERSION || '0.0.0';
  }
}

const num = (value, fallback) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

function readZkMode() {
  const zkMode = (process.env.ZK_MODE || 'real').toLowerCase();
  if (!['real', 'mock', 'bridge'].includes(zkMode)) {
    throw new Error(`Unsupported ZK_MODE "${zkMode}" (expected real, mock, or bridge)`);
  }
  return zkMode;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  version: process.env.ATT_APP_VERSION || readVersion(),
  name: 'ATT',
  port: parseInt(process.env.PORT || '4000', 10),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : paths.dbFile,
  paths,

  zk: {
    // 'real'   = this computer connects directly to the ZKTeco terminal (LAN).
    // 'bridge' = cloud server talks to an authenticated agent on the device LAN.
    // 'mock'   = development-only hardware simulator.
    mode: readZkMode(),
    ip: process.env.ZK_IP || '192.168.1.110',
    port: parseInt(process.env.ZK_PORT || '4370', 10),
    timeoutMs: parseInt(process.env.ZK_TIMEOUT_MS || '10000', 10),
    // node-zklib reply port used for the UDP keep-alive channel on some firmware
    inPort: parseInt(process.env.ZK_INPORT || '5200', 10),
    /**
     * Comm Key = the terminal's connection password (Menu → COMM → Comm Key).
     * 0 (the default) = the device answers any client on the LAN. A non-zero
     * key makes ATT authenticate and makes every OTHER client fail the
     * handshake — the clean way to stop ZKTime / a second install from
     * stealing the terminal's single management session.
     */
    commKey: normalizeCommKeyEnv(process.env.ZK_COMM_KEY),
    /**
     * Run our own CMD_CONNECT so a keyed terminal is detected and
     * authenticated instead of silently ignoring every command.
     */
    explicitHandshake: process.env.ZK_EXPLICIT_HANDSHAKE !== 'false',
    /* One session at a time — see zk/deviceLock.js. */
    lock: {
      // 0 (default) = refuse a second device operation immediately with a
      // clear "terminal is busy" 409 instead of letting requests pile up.
      // >0 = wait that long for the running operation to finish first.
      waitMs: Math.max(0, parseInt(process.env.ZK_LOCK_WAIT_MS || '0', 10) || 0),
      // Force-release the lock if an operation outlives this (a wedged socket
      // must never disable device access for good).
      staleMs: Math.max(5000, parseInt(process.env.ZK_LOCK_STALE_MS || '120000', 10) || 120000),
      // Pause between sessions so the terminal can release the previous one —
      // back-to-back connects are a classic ECONNRESET source.
      gapMs: Math.max(0, parseInt(process.env.ZK_SESSION_GAP_MS || '350', 10) || 0),
    },
    // Simulate intermittent connection drops in mock mode (0..1). 0 = never.
    mockFailureRate: num(process.env.ZK_MOCK_FAILURE_RATE, 0),
    // Mock sim visibility for the current day:
    //   'complete' → the device already holds today's full day (great for demos)
    //   'live'     → only punches made up to the current wall-clock time
    mockDayMode: (process.env.ZK_MOCK_DAY_MODE || 'complete').toLowerCase(),
  },

  bridge: {
    // Shared only between the cloud app and its trusted on-site device agent.
    token: process.env.DEVICE_BRIDGE_TOKEN || '',
    commandTimeoutMs: parseInt(process.env.DEVICE_BRIDGE_COMMAND_TIMEOUT_MS || '60000', 10),
    agentOnlineWindowMs: parseInt(process.env.DEVICE_BRIDGE_ONLINE_WINDOW_MS || '30000', 10),
    agentPollIntervalMs: parseInt(process.env.DEVICE_BRIDGE_POLL_INTERVAL_MS || '2000', 10),
    agentHeartbeatIntervalMs: parseInt(process.env.DEVICE_BRIDGE_HEARTBEAT_INTERVAL_MS || '8000', 10),
  },

  poll: {
    intervalMinutes: num(process.env.POLL_INTERVAL_MINUTES, 1),
    enabled: process.env.POLL_ENABLED !== 'false',
    // Recompute today's processed rows even when no new logs arrived, so a
    // teacher who was briefly "absent" flips to present as soon as they punch.
    alwaysReprocessToday: true,
  },

  retry: {
    attempts: parseInt(process.env.ZK_RETRY_ATTEMPTS || '3', 10),
    baseDelayMs: parseInt(process.env.ZK_RETRY_BASE_DELAY_MS || '750', 10),
    // Circuit breaker: after N consecutive failures, cool down before retrying.
    breakerThreshold: parseInt(process.env.ZK_BREAKER_THRESHOLD || '5', 10),
    breakerCooldownMs: parseInt(process.env.ZK_BREAKER_COOLDOWN_MS || '60000', 10),
  },

  seed: {
    // NEVER seeds anything in production — demo data is created only when
    // explicitly requested (SEED_DEMO=true) or via `npm run seed:demo`.
    demoData: process.env.SEED_DEMO === 'true',
    historyDays: parseInt(process.env.SEED_HISTORY_DAYS || '9', 10),
  },

  /* Desktop / installed-app concerns. Read by the Electron shell via the API. */
  desktop: {
    packaged: paths.packaged,
    autostart: process.env.ATT_AUTOSTART !== 'false',
    closeToTray: process.env.ATT_CLOSE_TO_TRAY !== 'false',
    minimizeToTray: process.env.ATT_MINIMIZE_TO_TRAY === 'true',
    serviceEnabled: process.env.ATT_SERVICE_ENABLED === 'true',
    serviceName: process.env.ATT_SERVICE_NAME || 'ATTAttendance',
    installDir: process.env.ATT_INSTALL_DIR || null,
  },

  /* Where the built React SPA lives (single-port production mode). In the
     packaged app it ships beside the bundle; in dev it is ../web/dist. */
  web: {
    dist: process.env.WEB_DIST
      ? path.resolve(process.env.WEB_DIST)
      : paths.packaged
        ? path.join(root, 'web')
        : path.resolve(root, '../web/dist'),
  },
};

/**
 * Push a (already persisted) settings patch into the live config object.
 * Returns the sections that changed so callers can react — e.g. rebuild the
 * device adapter or restart the poller.
 */
function applySettings(patch = {}) {
  const changed = { zk: false, poll: false, server: false, desktop: false, security: false };

  const map = [
    ['server.port', (v) => { config.port = parseInt(v, 10); changed.server = true; }],
    ['server.host', (v) => { config.host = String(v); changed.server = true; }],
    ['device.mode', (v) => { config.zk.mode = readZkMode(); changed.zk = true; }],
    ['device.ip', (v) => { config.zk.ip = String(v); changed.zk = true; }],
    ['device.port', (v) => { config.zk.port = parseInt(v, 10); changed.zk = true; }],
    ['device.timeoutMs', (v) => { config.zk.timeoutMs = parseInt(v, 10); changed.zk = true; }],
    ['device.inPort', (v) => { config.zk.inPort = parseInt(v, 10); changed.zk = true; }],
    ['poll.enabled', (v) => { config.poll.enabled = v !== false && v !== 'false'; changed.poll = true; }],
    ['poll.intervalMinutes', (v) => { config.poll.intervalMinutes = num(v, config.poll.intervalMinutes); changed.poll = true; }],
    ['desktop.autostart', (v) => { config.desktop.autostart = v === true || v === 'true'; changed.desktop = true; }],
    ['desktop.closeToTray', (v) => { config.desktop.closeToTray = v === true || v === 'true'; changed.desktop = true; }],
    ['desktop.minimizeToTray', (v) => { config.desktop.minimizeToTray = v === true || v === 'true'; changed.desktop = true; }],
    ['desktop.serviceEnabled', (v) => { config.desktop.serviceEnabled = v === true || v === 'true'; changed.desktop = true; }],
    ['security.appPassword', () => { changed.security = true; }],
    ['security.appTokenSalt', () => { changed.security = true; }],
  ];

  for (const [key, apply] of map) {
    const value = key.split('.').reduce((acc, p) => (acc == null ? undefined : acc[p]), patch);
    if (value !== undefined) apply(value);
  }

  config.paths = settings.getPaths();
  return changed;
}

module.exports = config;
module.exports.applySettings = applySettings;
module.exports.settingsApplied = settingsApplied;
