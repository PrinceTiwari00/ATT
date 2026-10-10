/**
 * Desktop-shell logger. The Electron main process has no console in a packaged
 * Windows app, so everything it does lands in <ATT_HOME>/logs/desktop.log next
 * to the backend log. Kept tiny and dependency-free.
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 3 * 1024 * 1024;

let file = null;
let forwardToConsole = true;

function init(logFile, { console: toConsole = true } = {}) {
  file = logFile;
  forwardToConsole = toConsole;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch (_) {
    file = null;
  }
}

function write(level, args) {
  const text = args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a)))
    .join(' ');
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [desktop] ${text}\n`;
  if (forwardToConsole) process.stdout.write(line);
  if (!file) return;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      fs.rmSync(`${file}.1`, { force: true });
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, line);
  } catch (_) {
    /* never let logging kill the shell */
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

module.exports = {
  init,
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  debug: (...a) => { if (process.env.ATT_DEBUG === '1') write('debug', a); },
  file: () => file,
};
