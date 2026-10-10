/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PATH RESOLUTION FOR THE INSTALLED APP
 * ─────────────────────────────────────────────────────────────────────────────
 *  Installed layout (per-machine NSIS):
 *
 *      C:\Program Files\ATT Attendance\
 *          ATT Attendance.exe            Electron shell (asar: src/**)
 *          resources\
 *              payload\
 *                  server.cjs            the whole backend in ONE file
 *                  web\                  built React SPA (served by server.cjs)
 *                  runtime\node.exe      bundled Node.js LTS runtime
 *              service\
 *                  att-service.exe       WinSW wrapper (background service)
 *                  att-service.xml
 *
 *      C:\ProgramData\ATT\               ← ATT_HOME (shared by app + service)
 *          config.json                   settings written by the UI
 *          attendance.db                 SQLite database
 *          runtime.json                  which backend owns the port (lock)
 *          logs\att.log                  backend log
 *          logs\desktop.log              Electron shell log
 *          backups\                      one-click database snapshots
 *
 *  Everything the backend needs is passed through the environment, so the very
 *  same `server.cjs` runs under the desktop app, the Windows service, or a
 *  plain `node` invocation.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {Electron.App} app Electron app object (needed for userData)
 */
function resolvePaths(app) {
  const packaged = Boolean(app?.isPackaged);
  const resourcesPath = process.resourcesPath || (packaged ? path.dirname(app.getPath('exe')) : null);
  const installDir = packaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..', '..');

  const payloadDir = packaged
    ? path.join(resourcesPath, 'payload')
    : path.join(__dirname, '..', 'dist', 'payload');

  const serviceDir = packaged
    ? path.join(resourcesPath, 'service')
    : path.join(__dirname, '..', 'service');

  /* ── ATT_HOME: one directory shared by the desktop app and the service ── */
  const candidates = [];
  if (process.env.ATT_HOME) candidates.push(path.resolve(process.env.ATT_HOME));
  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA || process.env.ProgramData || 'C:\\ProgramData';
    candidates.push(path.join(programData, 'ATT'));
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(local, 'ATT'));
  }
  if (app) candidates.push(path.join(app.getPath('userData'), 'att-home'));
  candidates.push(path.join(os.homedir(), '.att'));

  let home = null;
  for (const candidate of candidates) {
    // An existing home always wins (even if the probe would fail on a full disk)
    if (fs.existsSync(path.join(candidate, 'config.json')) || fs.existsSync(path.join(candidate, 'attendance.db'))) {
      home = candidate;
      break;
    }
    if (isWritable(candidate)) {
      home = candidate;
      break;
    }
  }
  home = home || candidates[candidates.length - 1];

  const logDir = path.join(home, 'logs');
  return {
    packaged,
    platform: process.platform,
    installDir,
    resourcesPath,
    payloadDir,
    serverEntry: path.join(payloadDir, 'server.cjs'),
    webDist: path.join(payloadDir, 'web'),
    runtimeDir: path.join(payloadDir, 'runtime'),
    serviceDir,
    serviceExe: path.join(serviceDir, 'att-service.exe'),
    serviceXml: path.join(serviceDir, 'att-service.xml'),
    home,
    homeCandidates: candidates,
    configFile: path.join(home, 'config.json'),
    dbFile: path.join(home, 'attendance.db'),
    runtimeFile: path.join(home, 'runtime.json'),
    logDir,
    serverLog: path.join(logDir, 'att.log'),
    desktopLog: path.join(logDir, 'desktop.log'),
    backupDir: path.join(home, 'backups'),
  };
}

module.exports = { resolvePaths, isWritable };
