/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  FILE LOGGING
 * ─────────────────────────────────────────────────────────────────────────────
 *  A Windows service (and a packaged desktop app) has no console, so every
 *  log line is mirrored into <ATT_HOME>/logs/att.log with rotation. The UI can
 *  tail it through GET /api/system/logs, which is how a school administrator
 *  sends a support screenshot instead of a text transcript.
 *
 *  Dependency-free on purpose: it must survive being bundled into a single
 *  server.cjs file and run under a bare node.exe.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB
const KEEP_ROTATIONS = 3;

let attached = false;
let logFile = null;
let stream = null;

function stamp() {
  return new Date().toISOString();
}

function format(level, args) {
  const parts = args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch (_) {
      return String(a);
    }
  });
  return `${stamp()} ${level.toUpperCase().padEnd(5)} ${parts.join(' ')}\n`;
}

function rotateIfNeeded() {
  try {
    if (!logFile || !fs.existsSync(logFile)) return;
    if (fs.statSync(logFile).size < MAX_BYTES) return;
    if (stream) {
      stream.end();
      stream = null;
    }
    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const from = `${logFile}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${logFile}.${i + 1}`);
    }
    fs.renameSync(logFile, `${logFile}.1`);
  } catch (err) {
    // Rotation must never take the app down.
    try { process.stderr.write(`[log] rotation failed: ${err.message}\n`); } catch (_) { /* ignore */ }
  }
}

function write(level, args) {
  try {
    rotateIfNeeded();
    if (!stream) stream = fs.createWriteStream(logFile, { flags: 'a' });
    stream.write(format(level, args));
  } catch (_) {
    /* a logging failure is never worth crashing the attendance poller */
  }
}

/**
 * Mirror console.info/log/warn/error into the log file. Idempotent.
 * @param {string} file absolute path of the log file
 */
function attachFileLog(file) {
  if (attached || !file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.closeSync(fs.openSync(file, 'a'));
  } catch (err) {
    process.stderr.write(`[log] cannot write to ${file}: ${err.message}\n`);
    return false;
  }
  logFile = file;
  attached = true;

  const wrap = (level, original) =>
    function patched(...args) {
      original.apply(console, args);
      write(level, args);
    };

  console.log = wrap('info', console.log);
  console.info = wrap('info', console.info);
  console.warn = wrap('warn', console.warn);
  console.error = wrap('error', console.error);

  process.on('uncaughtExceptionMonitor', (err) => write('fatal', ['uncaught exception', err]));
  process.on('unhandledRejectionMonitor', (reason) => write('fatal', ['unhandled rejection', reason]));
  return true;
}

function flushSync() {
  try {
    if (stream) stream.end();
    stream = null;
  } catch (_) { /* ignore */ }
}

/** Last `lines` lines of the log file (or of all rotations when requested). */
function tailLog(file = logFile, lines = 200) {
  if (!file || !fs.existsSync(file)) return { file, lines: [], exists: false };
  const clamp = Math.max(1, Math.min(5000, Number(lines) || 200));
  try {
    const content = fs.readFileSync(file, 'utf8');
    const all = content.split(/\r?\n/);
    if (all.length && all[all.length - 1] === '') all.pop();
    return { file, exists: true, total: all.length, lines: all.slice(-clamp) };
  } catch (err) {
    return { file, exists: true, error: err.message, lines: [] };
  }
}

module.exports = { attachFileLog, tailLog, flushSync, logFile: () => logFile };
