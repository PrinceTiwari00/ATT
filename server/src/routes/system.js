/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  SYSTEM API — the surface the installed Windows app drives
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET  /api/system/info            app/version/paths/runtime facts
 *  GET  /api/system/network         this computer's IPs, gateways, sweepable nets
 *  GET  /api/system/settings        effective settings (secrets masked)
 *  GET  /api/system/settings/schema field metadata for the settings form
 *  PUT  /api/system/settings        persist + apply live (device, poller, …)
 *  POST /api/system/device/probe    ZK handshake against ANY ip:port (no save)
 *  POST /api/system/diagnostics     structured "can this PC reach it?" checklist
 *  POST /api/system/discover        sweep the LAN for terminals on the ZK port
 *  GET  /api/system/logs            tail of the rotating log file
 *  GET  /api/system/service         Windows background-service state
 *  POST /api/system/service         install / start / stop / uninstall
 *  POST /api/system/backup          snapshot attendance.db into <home>/backups
 *  GET  /api/system/backups         list snapshots
 *
 *  All of it is behind the same optional APP_PASSWORD guard as the rest of
 *  /api (see middleware/auth.js).
 * ─────────────────────────────────────────────────────────────────────────────
 */
const express = require('express');
const os = require('os');
const config = require('../config');
const settings = require('../settings');
const { tailLog } = require('../log');
const { getManager, probeDevice } = require('../zk/manager');
const { restartPoller, getPollerState } = require('../services/poller');
const net = require('../net/diagnostics');
const winService = require('../services/winService');
const backups = require('../services/backup');

const router = express.Router();

const identifyFn = (ip, port) => probeDevice({ ip, port, timeoutMs: 4000 });

/* ── info ──────────────────────────────────────────────────────────────── */

router.get('/info', (req, res) => {
  res.json({
    data: {
      app: {
        name: 'ATT',
        version: config.version,
        env: config.env,
        packaged: config.desktop.packaged,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      },
      server: { port: config.port, host: config.host },
      paths: config.paths,
      poller: getPollerState(),
      device: { mode: config.zk.mode, ip: config.zk.ip, port: config.zk.port },
      desktop: config.desktop,
      cpus: os.cpus().length,
      memoryMb: Math.round(os.totalmem() / 1048576),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
});

/* ── this computer's network identity ──────────────────────────────────── */

router.get('/network', async (req, res) => {
  const interfaces = net.listInterfaces();
  const gateways = await net.readDefaultGateways();
  res.json({
    data: {
      interfaces,
      usable: interfaces.filter((i) => !i.internal && !i.address.startsWith('169.254.')),
      gateways,
      discoverable: net.discoverableCidrs(),
      device: { ip: config.zk.ip, port: config.zk.port },
      link: (() => {
        const match = interfaces.find(
          (i) => !i.internal && i.prefix != null && net.sameSubnet(i.address, config.zk.ip, i.prefix)
        );
        return match
          ? { sameSubnet: true, interface: match.name, cidr: match.cidr }
          : { sameSubnet: false, interface: null, cidr: null };
      })(),
    },
  });
});

/* ── settings ──────────────────────────────────────────────────────────── */

router.get('/settings', (req, res) => {
  res.json({
    data: {
      settings: settings.describeSettings(),
      schema: settings.describeSchema(),
      settingsFile: config.paths.settingsFile,
      requiresRestartFor: ['server.port', 'server.host'],
    },
  });
});

router.get('/settings/schema', (req, res) => {
  res.json({ data: settings.describeSchema() });
});

/**
 * Persist + apply. Device changes take effect immediately (the manager swaps
 * its adapter and the circuit breaker is reset); poll changes restart the timer.
 * A port/host change needs a process restart, which the desktop shell offers.
 */
router.put('/settings', async (req, res) => {
  const patch = req.body || {};
  try {
    const { saved } = settings.saveSettings(patch);
    const changed = config.applySettings(saved);

    const actions = [];
    if (changed.zk) {
      const reconf = getManager().reconfigure('settings');
      actions.push({ action: 'device-reconfigured', ...reconf });
    }
    if (changed.poll) {
      const state = restartPoller();
      actions.push({ action: 'poller-restarted', ...state });
    }

    res.json({
      data: {
        saved,
        settings: settings.describeSettings(),
        changed,
        actions,
        requiresRestart: Boolean(changed.server),
        device: getManager().status(),
      },
    });
  } catch (err) {
    if (err instanceof settings.SettingsError) return res.status(422).json({ error: err.message });
    throw err;
  }
});

/* ── device connection helpers ─────────────────────────────────────────── */

/** Test an arbitrary terminal BEFORE saving it (wizard step 3). */
router.post('/device/probe', async (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  if (!ip) return res.status(422).json({ error: 'ip is required' });
  const port = Number(req.body?.port || config.zk.port);
  const timeoutMs = Math.min(20000, Math.max(1000, Number(req.body?.timeoutMs || 5000)));
  const result = await probeDevice({ ip, port, timeoutMs });
  res.status(result.ok ? 200 : 502).json({ data: result });
});

/** Full checklist: interfaces → subnet → ping → TCP → ZK handshake. */
router.post('/diagnostics', async (req, res) => {
  const ip = String(req.body?.ip || config.zk.ip).trim();
  const port = Number(req.body?.port || config.zk.port);
  const timeoutMs = Math.min(20000, Math.max(1000, Number(req.body?.timeoutMs || 4000)));
  const wantHandshake = req.body?.handshake !== false;
  try {
    const report = await net.diagnose({
      ip,
      port,
      timeoutMs,
      ping: req.body?.ping !== false,
      handshakeFn: wantHandshake && port ? identifyFn : null,
    });
    res.json({ data: report });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

let scanInFlight = null;

/** Sweep the LAN for anything listening on the ZKTeco port. */
router.post('/discover', async (req, res) => {
  if (scanInFlight) {
    return res.status(409).json({ error: 'A network scan is already running', data: scanInFlight });
  }
  const port = Number(req.body?.port || config.zk.port || 4370);
  const cidrs = Array.isArray(req.body?.cidrs) ? req.body.cidrs.filter((c) => net.parseCidr(c)) : undefined;
  const timeoutMs = Math.min(6000, Math.max(300, Number(req.body?.timeoutMs || 1200)));
  const concurrency = Math.min(256, Math.max(8, Number(req.body?.concurrency || 96)));

  scanInFlight = { startedAt: new Date().toISOString(), port, cidrs: cidrs || null };
  try {
    const result = await net.discoverDevices({
      cidrs,
      port,
      timeoutMs,
      concurrency,
      identify: req.body?.identify !== false,
      identifyFn,
    });
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    scanInFlight = null;
  }
});

/* ── logs ──────────────────────────────────────────────────────────────── */

router.get('/logs', (req, res) => {
  const lines = Math.min(2000, Math.max(10, Number(req.query.lines || 300)));
  res.json({ data: tailLog(config.paths.logFile, lines) });
});

/* ── Windows background service ────────────────────────────────────────── */

router.get('/service', async (req, res) => {
  const status = await winService.queryStatus();
  res.json({
    data: {
      ...status,
      elevated: await winService.isElevated(),
      wantsEnabled: config.desktop.serviceEnabled,
      tool: winService.toolPaths(),
      command: winService.elevationCommand('install'),
    },
  });
});

router.post('/service', async (req, res) => {
  const action = String(req.body?.action || '').toLowerCase();
  if (!['install', 'uninstall', 'start', 'stop', 'status'].includes(action)) {
    return res.status(422).json({ error: 'action must be install, uninstall, start, stop or status' });
  }
  const result = await winService.control(action);
  if (result.ok && (action === 'install' || action === 'uninstall')) {
    // Remember the operator's choice so the desktop shell and the installer agree.
    try {
      const next = action === 'install';
      settings.saveSettings({ 'desktop.serviceEnabled': next });
      config.applySettings({ 'desktop.serviceEnabled': next });
    } catch (err) {
      console.warn(`[system] could not persist service preference: ${err.message}`);
    }
  }
  res.status(result.ok || action === 'status' ? 200 : result.needsElevation ? 403 : 500).json({ data: result });
});

/* ── graceful shutdown (desktop shell only) ────────────────────────────── */

/**
 * Lets the Electron shell ask the backend to close cleanly (stop poller, flush
 * WAL, release the instance lock) instead of killing the process mid-write.
 * Restricted to the local loopback token so nothing off-box can stop syncing.
 */
router.post('/shutdown', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  const authDisabled = !process.env.APP_PASSWORD;
  if (!loopback || !(req.attLocal || authDisabled)) {
    return res.status(403).json({ error: 'Shutdown is only available to the ATT app on this computer' });
  }
  res.json({ data: { ok: true } });
  setTimeout(() => process.emit('att:shutdown'), 200);
});

/* ── backups ───────────────────────────────────────────────────────────── */

router.post('/backup', (req, res) => {
  try {
    res.json({ data: backups.createBackup({ label: req.body?.label || 'manual' }) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/backups', (req, res) => {
  res.json({ data: { dir: config.paths.backupDir, backups: backups.listBackups() } });
});

module.exports = router;
