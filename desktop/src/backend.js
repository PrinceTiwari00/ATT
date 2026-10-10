/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  BACKEND LIFECYCLE (Electron main process)
 * ─────────────────────────────────────────────────────────────────────────────
 *  The desktop window is a thin client for a LOCAL Node backend that owns the
 *  ZKTeco link and the SQLite database. This module makes sure exactly one
 *  backend runs, in this order of preference:
 *
 *      1. one that is already running (background service, or a previous launch)
 *      2. the Windows service, started on demand
 *      3. a child process we spawn from the bundled Node runtime
 *
 *  It also restarts a crashed backend with backoff, and reports progress so the
 *  splash window can say what is happening instead of spinning silently.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { spawnBackend } = require('./runtime');

const DEFAULT_PORT = 4000;
const RESTART_DELAYS = [800, 2000, 5000, 15000, 30000];
const MAX_RESTARTS_PER_WINDOW = 6;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

function httpJson(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, status: res.statusCode, data: JSON.parse(body) });
        } catch (_) {
          resolve({ ok: false, status: res.statusCode, data: null, body });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
  });
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by another user (the service)
  }
}

function readRuntimeInfo(paths) {
  try {
    if (!fs.existsSync(paths.runtimeFile)) return null;
    const info = JSON.parse(fs.readFileSync(paths.runtimeFile, 'utf8'));
    return info && info.pid ? info : null;
  } catch (_) {
    return null;
  }
}

/** Preferred port from config.json (the app's own settings file). */
function preferredPort(paths) {
  try {
    const cfg = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
    const port = Number(cfg?.server?.port || DEFAULT_PORT);
    return Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
  } catch (_) {
    return DEFAULT_PORT;
  }
}

function portIsFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, host);
  });
}

async function pickPort(paths, log) {
  const wanted = preferredPort(paths);
  if (await portIsFree(wanted)) return wanted;
  // Something else holds the port. If it is ATT itself we attach; otherwise we
  // take a free ephemeral port so the app still starts on a busy office PC.
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(wanted));
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => {
        log('warn', `port ${wanted} is busy — using ${port} instead`);
        resolve(port);
      });
    });
  });
}

class Backend extends EventEmitter {
  constructor({ paths, runtime, log, serviceStatus }) {
    super();
    this.paths = paths;
    this.runtime = runtime;
    this.log = log;
    this.serviceStatus = serviceStatus || (async () => ({ installed: false, running: false }));
    this.child = null;
    this.killChild = null;
    this.info = null; // { url, port, token, mode, pid }
    this.state = 'idle'; // idle | starting | online | restarting | failed | stopped
    this.restarts = [];
    this.stopping = false;
  }

  get url() {
    return this.info?.url || null;
  }

  progress(message, detail) {
    this.log('info', `backend: ${message}${detail ? ` — ${detail}` : ''}`);
    this.emit('progress', { message, detail });
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  /** Poll /api/health until it answers. */
  async waitForHealth(url, { timeoutMs = 90000, intervalMs = 400 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'no response yet';
    while (Date.now() < deadline) {
      const res = await httpJson(`${url}/api/health`, 2000);
      if (res.ok && res.data?.ok) return { ok: true, data: res.data };
      lastError = res.error || `HTTP ${res.status}`;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { ok: false, error: lastError };
  }

  /** Look for a backend that is already serving this ATT home. */
  async findRunning() {
    const info = readRuntimeInfo(this.paths);
    if (!info || !info.url) return null;
    if (!isPidAlive(info.pid)) return null;
    const res = await httpJson(`${info.url}/api/health`, 2000);
    if (!res.ok) return null;
    return info;
  }

  async start() {
    this.stopping = false;
    this.setState('starting');

    // 1 — already running (service from a previous boot, or a second launch)
    this.progress('Looking for a running ATT backend');
    const running = await this.findRunning();
    if (running) {
      this.info = { ...running, mode: running.mode || 'external', attached: true };
      this.setState('online');
      this.progress(`Attached to the running backend (${running.mode || 'external'}, pid ${running.pid})`);
      return this.info;
    }

    // 2 — the Windows service owns the link when installed
    const svc = await this.serviceStatus();
    if (svc?.installed) {
      this.progress('Background service is installed — waiting for it to publish the API');
      if (!svc.running && typeof this.startService === 'function') {
        await this.startService().catch((err) => this.log('warn', `service start failed: ${err.message}`));
      }
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const found = await this.findRunning();
        if (found) {
          this.info = { ...found, attached: true };
          this.setState('online');
          this.progress('Connected to the background service');
          return this.info;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      this.log('warn', 'service did not come up — falling back to an in-app backend');
    }

    // 3 — spawn our own
    return this.spawn();
  }

  async spawn() {
    if (!fs.existsSync(this.paths.serverEntry)) {
      const err = new Error(`Backend bundle is missing: ${this.paths.serverEntry}`);
      this.setState('failed');
      throw err;
    }
    const port = await pickPort(this.paths, (...a) => this.log(...a));
    const url = `http://127.0.0.1:${port}`;

    this.progress('Starting the attendance engine', `port ${port}`);
    const env = {
      NODE_ENV: 'production',
      ATT_PACKAGED: '1',
      ATT_HOME: this.paths.home,
      ATT_INSTALL_DIR: this.paths.installDir,
      ATT_LOG_FILE: this.paths.serverLog,
      ATT_SERVICE_DIR: this.paths.serviceDir,
      WEB_DIST: this.paths.webDist,
      PORT: String(port),
      HOST: '127.0.0.1',
      ATT_PARENT_PID: String(process.pid),
      ATT_WATCH_PARENT: '1',
    };

    const { child, kill } = spawnBackend({
      runtime: this.runtime,
      serverEntry: this.paths.serverEntry,
      env,
      cwd: path.dirname(this.paths.serverEntry),
      log: (level, line) => this.log(level === 'info' ? 'info' : 'warn', `[server] ${line}`),
      onExit: (code, signal) => this.onChildExit(code, signal),
    });
    this.child = child;
    this.killChild = kill;
    this.spawnedPort = port;

    const health = await this.waitForHealth(url, { timeoutMs: 90000 });
    if (!health.ok) {
      // exit code 3 = another instance owns this ATT home (race with the service)
      const info = readRuntimeInfo(this.paths);
      if (info && info.url && info.url !== url && isPidAlive(info.pid)) {
        this.progress('Another ATT backend won the race — attaching to it');
        this.info = { ...info, attached: true };
        this.setState('online');
        return this.info;
      }
      kill();
      this.setState('failed');
      const err = new Error(`The attendance engine did not become healthy (${health.error}).`);
      this.emit('error', err);
      throw err;
    }

    const info = readRuntimeInfo(this.paths) || { pid: child.pid, port, url, mode: 'desktop' };
    this.info = { ...info, url, port, pid: info.pid || child.pid, attached: false };
    this.setState('online');
    this.progress('Attendance engine is online');
    return this.info;
  }

  async onChildExit(code, signal) {
    this.child = null;
    if (this.stopping) return;
    this.log('warn', `backend exited (code ${code}, signal ${signal})`);

    if (code === 3) {
      // Another instance holds the lock — attach instead of restarting.
      const info = await this.findRunning();
      if (info) {
        this.info = { ...info, attached: true };
        this.setState('online');
        this.emit('attached', this.info);
        return;
      }
    }

    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS_PER_WINDOW) {
      this.setState('failed');
      this.emit('failed', new Error(
        `The attendance engine stopped ${this.restarts.length} times in 10 minutes and will not be restarted automatically. ` +
          `Check ${this.paths.serverLog} for the cause.`
      ));
      return;
    }
    const delay = RESTART_DELAYS[Math.min(this.restarts.length, RESTART_DELAYS.length - 1)];
    this.restarts.push(now);
    this.setState('restarting');
    this.progress('Restarting the attendance engine', `attempt ${this.restarts.length} in ${Math.round(delay / 1000)}s`);
    setTimeout(() => {
      if (this.stopping) return;
      this.spawn().catch((err) => {
        this.setState('failed');
        this.emit('error', err);
      });
    }, delay);
  }

  /** Privileged loopback call using the backend's local token. */
  async api(method, apiPath, body) {
    if (!this.info?.url) throw new Error('Backend is not running');
    const res = await fetch(`${this.info.url}/api${apiPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.info.token ? { 'x-att-local-token': this.info.token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    }).catch((err) => ({ ok: false, status: 0, json: async () => ({ error: err.message }) }));
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
    return payload;
  }

  async restart() {
    if (this.info?.attached) {
      // We do not own that process (it belongs to the service) — ask politely.
      return this.api('POST', '/system/service', { action: 'restart' }).catch(() => null);
    }
    this.stopping = true;
    this.killChild?.();
    await new Promise((r) => setTimeout(r, 1200));
    this.stopping = false;
    this.restarts = [];
    return this.spawn();
  }

  async stop() {
    this.stopping = true;
    this.setState('stopped');
    if (this.killChild) {
      this.killChild();
      this.killChild = null;
    }
    this.child = null;
  }
}

module.exports = { Backend, httpJson, isPidAlive, readRuntimeInfo, preferredPort, pickPort, DEFAULT_PORT };
