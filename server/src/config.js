const path = require('path');

const root = path.resolve(__dirname, '..');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'attendance.db'),

  zk: {
    // 'mock' ships the built-in hardware simulator so the whole pipeline is
    // runnable without a device. Set ZK_MODE=real on the school LAN to talk
    // to the actual ZKTeco terminal.
    mode: (process.env.ZK_MODE || 'mock').toLowerCase(), // 'real' | 'mock'
    ip: process.env.ZK_IP || '192.168.1.201',
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
    demoData: process.env.SEED_DEMO !== 'false',
    historyDays: parseInt(process.env.SEED_HISTORY_DAYS || '9', 10),
  },
};

module.exports = config;
