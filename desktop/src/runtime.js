/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  NODE RUNTIME RESOLUTION
 * ─────────────────────────────────────────────────────────────────────────────
 *  The backend uses `node:sqlite` (Node ≥ 22.13). The installer therefore
 *  ships the official Node.js LTS binary for Windows, so the app never depends
 *  on what happens to be installed on that computer — and never depends on
 *  Electron's internal Node build either.
 *
 *  Resolution order:
 *      1. ATT_NODE_BIN                      (support override)
 *      2. <payload>\runtime\node.exe        (bundled with the installer)
 *      3. `node` on PATH                    (developer machines)
 *      4. Electron itself with ELECTRON_RUN_AS_NODE=1
 *
 *  Every candidate is PROBED (`node:sqlite` must load) before it is used, so a
 *  too-old Node on PATH can never silently break the database layer.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MIN_MAJOR = 22;
const PROBE = "const s=require('node:sqlite');if(!s.DatabaseSync)throw new Error('no DatabaseSync');process.stdout.write(process.versions.node)";

function nodeBinaryName() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

/** Run a candidate and verify it can load node:sqlite. */
function probe(bin, extraEnv = {}, timeoutMs = 15000) {
  if (!bin) return { ok: false, error: 'no binary' };
  try {
    const res = spawnSync(bin, ['-e', PROBE], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    });
    if (res.error) return { ok: false, error: res.error.message, bin };
    if (res.status !== 0) {
      return {
        ok: false,
        bin,
        error: (res.stderr || res.stdout || `exit ${res.status}`).trim().split('\n')[0],
      };
    }
    const version = String(res.stdout || '').trim();
    const major = Number(version.split('.')[0].replace(/^v/, ''));
    if (!Number.isFinite(major) || major < MIN_MAJOR) {
      return { ok: false, bin, version, error: `Node ${version} is too old — ATT needs Node ${MIN_MAJOR}+ (node:sqlite)` };
    }
    return { ok: true, bin, version, extraEnv };
  } catch (err) {
    return { ok: false, bin, error: err.message };
  }
}

/**
 * @param {object} paths output of paths.resolvePaths()
 * @param {(level:string, ...args:any[])=>void} log
 */
function resolveRuntime(paths, log = () => {}) {
  const candidates = [];

  if (process.env.ATT_NODE_BIN) {
    candidates.push({ bin: process.env.ATT_NODE_BIN, source: 'ATT_NODE_BIN' });
  }
  const bundled = path.join(paths.runtimeDir, nodeBinaryName());
  if (fs.existsSync(bundled)) {
    candidates.push({ bin: bundled, source: 'bundled' });
  }
  // A dev checkout may keep the runtime next to the repo instead of the payload.
  const devRuntime = path.resolve(__dirname, '..', 'dist', 'runtime', nodeBinaryName());
  if (devRuntime !== bundled && fs.existsSync(devRuntime)) {
    candidates.push({ bin: devRuntime, source: 'dev-runtime' });
  }
  candidates.push({ bin: nodeBinaryName(), source: 'PATH' });
  candidates.push({
    bin: process.execPath,
    source: 'electron-as-node',
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });

  const attempts = [];
  for (const candidate of candidates) {
    const result = probe(candidate.bin, candidate.extraEnv);
    attempts.push({ source: candidate.source, bin: candidate.bin, ...result });
    if (result.ok) {
      log('info', `node runtime: ${result.version} from ${candidate.source} (${candidate.bin})`);
      return { ...candidate, version: result.version, attempts };
    }
    log('warn', `node runtime candidate rejected (${candidate.source}): ${result.error}`);
  }
  const err = new Error(
    'No usable Node.js runtime found. ATT needs Node 22+ with the built-in SQLite module. ' +
      'Reinstall the app (the installer bundles its own runtime) or set ATT_NODE_BIN to a full path of node.exe.'
  );
  err.attempts = attempts;
  throw err;
}

/**
 * Spawn the backend and stream its stdout/stderr.
 * @returns {{child: import('child_process').ChildProcess, kill: Function}}
 */
function spawnBackend({ runtime, serverEntry, env, cwd, log, onExit }) {
  const child = spawn(runtime.bin, [serverEntry], {
    cwd,
    env: { ...process.env, ...(runtime.extraEnv || {}), ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pipe = (stream, level) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) log(level, line);
    });
    stream.on('end', () => { if (buffer.trim()) log(level, buffer.trim()); });
  };
  pipe(child.stdout, 'info');
  pipe(child.stderr, 'warn');

  child.once('exit', (code, signal) => onExit?.(code, signal));
  child.once('error', (err) => log('error', `backend spawn error: ${err.message}`));

  const kill = () => {
    try {
      if (process.platform === 'win32') {
        // node.exe ignores SIGTERM from a Windows parent — taskkill /T is reliable.
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch (err) {
      log('warn', `could not stop backend: ${err.message}`);
    }
  };

  return { child, kill };
}

module.exports = { resolveRuntime, spawnBackend, probe, nodeBinaryName, MIN_MAJOR };
