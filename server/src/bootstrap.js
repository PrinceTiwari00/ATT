/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  APPLICATION BOOTSTRAP
 * ─────────────────────────────────────────────────────────────────────────────
 *  One function that assembles the whole product:
 *
 *      migrate DB → seed (only when explicitly asked) → wire device manager →
 *      build Express app (+ built SPA) → listen → start the background poller
 *
 *  It is used by:
 *    • `node src/index.js`                     (CLI / systemd / Render)
 *    • the bundled `server.cjs` inside the Windows app
 *    • the WinSW background service
 *    • the test-suite (ephemeral port, in-process)
 *
 *  Returns a handle with `close()` so the desktop shell and the service can
 *  shut down cleanly instead of being killed mid-write.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const config = require('./config');
const { migrate } = require('./db/migrate');
const { seedIfEmpty } = require('./db/seed');
const { initManager } = require('./zk/manager');
const { startPoller, stopPoller } = require('./services/poller');
const { getDb } = require('./db/connection');
const { acquireInstance, releaseInstance, findLiveInstance, InstanceConflictError } = require('./services/instance');

/** Roster rows the mock simulator needs (real mode ignores it). */
function rosterProvider() {
  return getDb()
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
    }));
}

function assertConfig() {
  if (config.zk.mode === 'bridge' && !config.bridge.token) {
    throw new Error('DEVICE_BRIDGE_TOKEN must be configured when ZK_MODE=bridge');
  }
  if (config.env === 'production' && !process.env.APP_PASSWORD) {
    console.warn('[security] APP_PASSWORD is unset; public API/UI access is not protected');
  }
}

/** Express app only — no listening, no migration. Handy for tests. */
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());

  // request log (compact)
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api') && req.path !== '/api/health') {
        console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} ${Date.now() - t0}ms`);
      }
    });
    next();
  });

  app.get('/api/health', (req, res) =>
    res.json({
      ok: true,
      ts: Date.now(),
      version: config.version,
      packaged: config.desktop.packaged,
      mode: config.zk.mode,
    })
  );

  // Machine-to-machine route checks its own secret before parsing larger
  // attendance batches, and does not use the interactive APP_PASSWORD token.
  app.use('/api/bridge', require('./routes/bridge'));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', require('./routes/auth').router);
  app.use('/api', require('./middleware/auth')); // active only when APP_PASSWORD set
  app.use('/api/teachers', require('./routes/teachers'));
  app.use('/api/shifts', require('./routes/shifts'));
  app.use('/api/calendar', require('./routes/calendar'));
  app.use('/api/attendance', require('./routes/attendance'));
  app.use('/api/reports', require('./routes/reports').router);
  app.use('/api/dashboard', require('./routes/dashboard'));
  app.use('/api/device', require('./routes/device'));
  app.use('/api/system', require('./routes/system'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[api] error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  // Serve the built SPA when available (single-port production mode).
  const webDist = config.web.dist;
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }
  return app;
}

function listenOnce(app, port, host) {
  return new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.once('error', reject);
  });
}

/**
 * An installed app must come up even when the preferred port is taken by
 * another product on that PC — it takes a free ephemeral port instead and
 * publishes the real URL in <ATT_HOME>/runtime.json, which is what the desktop
 * shell and the tray read. Source/systemd runs keep failing loudly instead.
 */
async function listenWithFallback(app, port, host) {
  try {
    return await listenOnce(app, port, host);
  } catch (err) {
    const installed = config.desktop.packaged || process.env.ATT_SERVICE_MODE === '1';
    if (err.code !== 'EADDRINUSE' || !installed) throw err;
    console.warn(`[att] port ${port} is busy — falling back to a free port`);
    return listenOnce(app, 0, host);
  }
}

/**
 * Full boot: migrate → seed → manager → listen → poller.
 * @param {{port?:number, host?:string, poll?:boolean, mode?:string, exclusive?:boolean}} [opts]
 */
async function bootServer(opts = {}) {
  assertConfig();

  // One backend per ATT home: a second poller would fight the terminal for its
  // single management session. Checked before any DB work or port binding.
  if (opts.exclusive !== false) {
    const live = await findLiveInstance();
    if (live && !live.stale && live.pid !== process.pid) throw new InstanceConflictError(live);
  }

  const startedAt = Date.now();
  migrate();
  seedIfEmpty();
  initManager(rosterProvider);

  const app = createApp();
  const port = opts.port ?? config.port;
  const host = opts.host ?? config.host;

  const server = await listenWithFallback(app, port, host);

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${boundPort}`;

  const instance = await acquireInstance({ port: boundPort, url, mode: opts.mode });
  if (opts.poll !== false) startPoller();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    stopPoller();
    releaseInstance();
    await new Promise((resolve) => server.close(resolve));
    try {
      getDb().close();
    } catch (_) { /* already closed */ }
  }

  return {
    app,
    server,
    url,
    port: boundPort,
    host,
    instance,
    startupMs: Date.now() - startedAt,
    close,
  };
}

module.exports = { bootServer, createApp, rosterProvider, assertConfig };
