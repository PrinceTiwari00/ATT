/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  RUNTIME INSTANCE LOCK  (one backend per ATT home)
 * ─────────────────────────────────────────────────────────────────────────────
 *  ZKTeco terminals accept a single management session, and two pollers would
 *  fight for it (and double-process the same punches). On a school PC both the
 *  desktop app and the background service can start at boot, so the backend
 *  that gets there first writes <ATT_HOME>/runtime.json and every later start
 *  refuses to boot, pointing the newcomer at the running instance.
 *
 *  The file also carries a per-boot LOCAL TOKEN. The Electron shell (and only a
 *  process on this machine that can read ATT_HOME) uses it to call privileged
 *  loopback APIs without knowing the staff password. It never leaves the box:
 *  the auth middleware only honours it for connections from 127.0.0.1/::1.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const config = require('../config');

const RUNTIME_FILE = () => process.env.ATT_RUNTIME_FILE || path.join(config.paths.home, 'runtime.json');
let localToken = process.env.ATT_LOCAL_TOKEN || crypto.randomBytes(24).toString('hex');

class InstanceConflictError extends Error {
  constructor(info) {
    super(
      `ATT is already running on this computer (${info.url}, pid ${info.pid}, started ${info.startedAt}). ` +
        'Close the other instance, or stop the "ATT Attendance Sync" Windows service.'
    );
    this.name = 'InstanceConflictError';
    this.code = 'INSTANCE_RUNNING';
    this.status = 409;
    this.instance = info;
  }
}

function getLocalToken() {
  return localToken;
}

function readRuntimeInfo(file = RUNTIME_FILE()) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.pid ? parsed : null;
  } catch (_) {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user (e.g. LocalSystem service)
    return err.code === 'EPERM';
  }
}

function httpGet(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
  });
}

/** Is the recorded instance still serving? (pid alive AND /api/health answers) */
async function findLiveInstance(file = RUNTIME_FILE()) {
  const info = readRuntimeInfo(file);
  if (!info) return null;
  if (!isPidAlive(info.pid)) return { ...info, stale: true, reason: 'pid not running' };
  if (!info.url) return { ...info, stale: true, reason: 'no url recorded' };
  const health = await httpGet(`${info.url.replace(/\/$/, '')}/api/health`);
  if (!health.ok) return { ...info, stale: true, reason: 'health check failed' };
  return { ...info, stale: false, health: health.body };
}

/** Claim the ATT home for this process. Throws InstanceConflictError if taken. */
async function acquireInstance({ port, url, mode = process.env.ATT_SERVICE_MODE === '1' ? 'service' : 'desktop' }) {
  const file = RUNTIME_FILE();
  const live = await findLiveInstance(file);
  if (live && !live.stale && live.pid !== process.pid) throw new InstanceConflictError(live);

  const info = {
    pid: process.pid,
    port,
    url,
    mode,
    version: config.version,
    node: process.version,
    platform: process.platform,
    hostname: config.paths.hostname,
    home: config.paths.home,
    token: localToken,
    startedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    // A read-only home is survivable (single-instance protection is a bonus),
    // but it must be loud in the log.
    console.warn(`[instance] could not write ${file}: ${err.message}`);
  }
  return info;
}

function releaseInstance() {
  const file = RUNTIME_FILE();
  const info = readRuntimeInfo(file);
  if (info && info.pid !== process.pid) return false; // another instance owns it now
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  InstanceConflictError,
  getLocalToken,
  readRuntimeInfo,
  findLiveInstance,
  acquireInstance,
  releaseInstance,
  isPidAlive,
  RUNTIME_FILE,
};
