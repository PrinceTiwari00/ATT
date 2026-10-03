/**
 * ATT — ZKTeco Attendance Tracking System · API server entrypoint
 *
 * Boot order: migrate DB → seed demo data (first run) → wire device manager →
 * start background poller → serve REST API (+ built frontend if present).
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const config = require('./config');
const { migrate } = require('./db/migrate');
const { seedIfEmpty } = require('./db/seed');
const { initManager } = require('./zk/manager');
const { startPoller } = require('./services/poller');
const { getDb } = require('./db/connection');

if (config.zk.mode === 'bridge' && !config.bridge.token) {
  throw new Error('DEVICE_BRIDGE_TOKEN must be configured when ZK_MODE=bridge');
}
if (config.env === 'production' && !process.env.APP_PASSWORD) {
  console.warn('[security] APP_PASSWORD is unset; public API/UI access is not protected');
}

migrate();
seedIfEmpty();

// Roster provider feeds the mock simulator (real mode ignores it).
initManager(() =>
  getDb()
    .prepare(
      `SELECT t.zk_user_id, t.full_name,
              COALESCE(s.start_time, d.start_time) AS start_time,
              COALESCE(s.end_time,   d.end_time)   AS end_time
       FROM teachers t
       LEFT JOIN shifts s ON s.id = t.shift_id
       LEFT JOIN shifts d ON d.is_default = 1
       WHERE t.status = 'active'`
    )
    .all()
    .map((r) => ({
      zk_user_id: r.zk_user_id,
      full_name: r.full_name,
      shift: r.start_time ? { start_time: r.start_time, end_time: r.end_time } : null,
    }))
);

const app = express();
app.use(cors());

// request log (compact)
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api'))
      console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
// Machine-to-machine route checks its own secret before parsing larger
// attendance batches, and does not use the interactive APP_PASSWORD token.
app.use('/api/bridge', require('./routes/bridge'));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', require('./routes/auth').router);
app.use('/api', require('./middleware/auth')); // active only when APP_PASSWORD set
app.use('/api/teachers', require('./routes/teachers'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/device', require('./routes/device'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api] error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Serve the built SPA when available (single-port production mode).
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.listen(config.port, config.host, () => {
  console.log('────────────────────────────────────────────────');
  console.log(` ATT API listening on http://${config.host}:${config.port}`);
  console.log(` ZKTeco mode: ${config.zk.mode} @ ${config.zk.ip}:${config.zk.port}`);
  console.log(` DB: ${config.dbPath}`);
  console.log('────────────────────────────────────────────────');
  startPoller();
});
