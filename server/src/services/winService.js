/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  WINDOWS BACKGROUND SERVICE CONTROL
 * ─────────────────────────────────────────────────────────────────────────────
 *  Attendance must keep syncing after the office PC is locked, after a reboot,
 *  and while nobody is signed in. The installer can therefore register ATT as a
 *  Windows service using WinSW (`att-service.exe`, shipped in
 *  `<install dir>\service\`), which supervises the bundled Node runtime.
 *
 *  Service control needs elevation. When the caller is not elevated we say so
 *  (`needsElevation: true`) instead of failing obscurely — the desktop shell
 *  then relaunches just that one command through a UAC prompt.
 *
 *  On any other platform (or a plain source checkout) every call reports
 *  `supported: false` so the UI can hide the section.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

const SERVICE_NAME = config.desktop.serviceName || 'ATTAttendance';
const SERVICE_DISPLAY = 'ATT Attendance Sync';

function isWindows() {
  return process.platform === 'win32';
}

/** WinSW wrapper exe + its XML config, next to the installed app. */
function toolPaths() {
  const installDir =
    process.env.ATT_INSTALL_DIR ||
    config.desktop.installDir ||
    (config.paths.packaged ? path.dirname(path.dirname(process.execPath)) : config.paths.serverRoot);
  const serviceDir = process.env.ATT_SERVICE_DIR || path.join(installDir, 'service');
  return {
    installDir,
    serviceDir,
    exe: path.join(serviceDir, 'att-service.exe'),
    xml: path.join(serviceDir, 'att-service.xml'),
    outDir: path.join(config.paths.logDir),
  };
}

function run(cmd, args, { timeoutMs = 30000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, cwd });
    } catch (err) {
      return resolve({ ok: false, code: -1, error: err.message, stdout: '', stderr: '' });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, code: -1, error: err.message, stdout, stderr }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Windows elevation check — `net session` only succeeds for administrators. */
async function isElevated() {
  if (!isWindows()) return process.getuid?.() === 0;
  const res = await run('net', ['session'], { timeoutMs: 8000 });
  return res.ok;
}

/** Service state straight from the SCM (does not need elevation). */
async function queryStatus() {
  if (!isWindows()) {
    return { supported: false, installed: false, state: 'unsupported', name: SERVICE_NAME };
  }
  const res = await run('sc', ['query', SERVICE_NAME], { timeoutMs: 8000 });
  const text = `${res.stdout}\n${res.stderr}`;
  if (!res.ok && /1060|does not exist/i.test(text)) {
    return { supported: true, installed: false, state: 'not-installed', name: SERVICE_NAME };
  }
  const stateMatch = /STATE\s*:\s*\d+\s+(\w+)/i.exec(res.stdout);
  const state = stateMatch ? stateMatch[1].toUpperCase() : res.ok ? 'UNKNOWN' : 'QUERY_FAILED';
  return {
    supported: true,
    installed: true,
    name: SERVICE_NAME,
    display: SERVICE_DISPLAY,
    state, // RUNNING | STOPPED | START_PENDING | STOP_PENDING
    running: state === 'RUNNING',
    startType: await queryStartType(),
    raw: res.stdout || res.stderr,
  };
}

async function queryStartType() {
  const res = await run('sc', ['qc', SERVICE_NAME], { timeoutMs: 8000 });
  const m = /START_TYPE\s*:\s*\d+\s+(\w+)/i.exec(res.stdout);
  return m ? m[1].toUpperCase() : null; // AUTO_START | DEMAND_START | DISABLED
}

function notSupported(action) {
  return {
    ok: false,
    supported: false,
    action,
    error:
      'The background Windows service is only available in the installed Windows app. ' +
      'On this host run ATT with `npm --prefix server start` (or systemd) instead.',
  };
}

/** Install/start/stop/uninstall through the WinSW wrapper. */
async function control(action) {
  if (!isWindows()) return notSupported(action);
  const { exe, xml, serviceDir } = toolPaths();
  const haveTool = fs.existsSync(exe) && fs.existsSync(xml);

  if (action === 'status') return queryStatus();

  if (!haveTool) {
    return {
      ok: false,
      supported: true,
      action,
      error: `Service wrapper not found at ${exe}. Reinstall ATT or set ATT_SERVICE_DIR.`,
      paths: { serviceDir },
    };
  }

  const needsAdmin = ['install', 'uninstall', 'start', 'stop'].includes(action);
  if (needsAdmin && !(await isElevated())) {
    return {
      ok: false,
      supported: true,
      action,
      needsElevation: true,
      error: 'Administrator rights are required to change the background service.',
      elevatedCommand: `"${exe}" ${action}`,
    };
  }

  const res = await run(`"${exe}"`, [action], { timeoutMs: 60000, cwd: serviceDir });
  // spawn() on Windows needs shell:true for a quoted exe path — retry plainly.
  const final = res.code === -1 && /ENOENT|spawn/i.test(`${res.error}${res.stderr}`)
    ? await run(exe, [action], { timeoutMs: 60000, cwd: serviceDir })
    : res;

  if (!final.ok) {
    return {
      ok: false,
      supported: true,
      action,
      error: final.error || final.stderr || final.stdout || `service ${action} failed`,
    };
  }
  const status = await queryStatus();
  return { ok: true, supported: true, action, service: status, output: final.stdout };
}

/**
 * Command line an elevated helper should run (used by the desktop shell to
 * trigger exactly one UAC prompt through PowerShell Start-Process -Verb RunAs).
 */
function elevationCommand(action) {
  const { exe } = toolPaths();
  return {
    exe,
    args: [action],
    powershell:
      `Start-Process -FilePath '${exe}' -ArgumentList '${action}' -Verb RunAs -Wait -WindowStyle Hidden`,
  };
}

module.exports = {
  SERVICE_NAME,
  SERVICE_DISPLAY,
  isWindows,
  isElevated,
  toolPaths,
  queryStatus,
  control,
  elevationCommand,
};
