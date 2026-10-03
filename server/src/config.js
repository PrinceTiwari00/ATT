const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');

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

const zkMode = (process.env.ZK_MODE || 'real').toLowerCase();
if (!['real', 'mock', 'bridge'].includes(zkMode)) {
  throw new Error(`Unsupported ZK_MODE "${zkMode}" (expected real, mock, or bridge)`);
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'attendance.db'),

  zk: {
    // 'real'   = server connects directly to the ZKTeco terminal over TCP/IP.
    // 'bridge' = cloud server talks to an authenticated agent on the device LAN.
    // 'mock'   = development-only hardware simulator.
    mode: zkMode,
    ip: process.env.ZK_IP || '192.168.1.110',
    port: parseInt(process.env.ZK_PORT || '4370', 10),
    timeoutMs: parseInt(process.env.ZK_TIMEOUT_MS || '10000', 10),
    // node-zklib reply port used for the UDP keep-alive channel on some firmware
    inPort: parseInt(process.env.ZK_INPORT || '5200', 10),
    // Simulate intermittent connection drops in mock mode (0..1). 0 = never.
    mockFailureRate: parseFloat(process.env.ZK_MOCK_FAILURE_RATE || '0'),
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
    intervalMinutes: parseFloat(process.env.POLL_INTERVAL_MINUTES || '1'),
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
};

module.exports = config;
