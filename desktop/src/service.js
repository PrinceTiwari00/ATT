/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  WINDOWS BACKGROUND SERVICE (WinSW wrapper)
 * ─────────────────────────────────────────────────────────────────────────────
 *  `resources\service\att-service.exe` (WinSW, MIT) supervises
 *  `runtime\node.exe payload\server.cjs --service` as a real Windows service:
 *  it starts at boot before anybody signs in, restarts on crash, and keeps the
 *  poller pulling punches from the terminal all day.
 *
 *  Status queries need no privileges; install/start/stop/uninstall do, so those
 *  run through exactly one UAC prompt (`Start-Process -Verb RunAs`) and the
 *  result is verified by re-querying the SCM.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SERVICE_NAME = 'ATTAttendance';
const SERVICE_DISPLAY = 'ATT Attendance Sync';

function run(cmd, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, code: -1, error: err.message, stdout: '', stderr: '' });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, code: -1, error: err.message, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

function isWindows() {
  return process.platform === 'win32';
}

function machineWideHome() {
  const programData = process.env.PROGRAMDATA || process.env.ProgramData || 'C:\\ProgramData';
  return path.join(programData, 'ATT');
}

/**
 * The service runs as LocalSystem and can only see a machine-wide home. If the
 * desktop app fell back to a per-user folder, installing the service would
 * silently create a SECOND database — refuse instead.
 */
function homeIsMachineWide(paths) {
  return path.resolve(paths.home).toLowerCase() === machineWideHome().toLowerCase();
}

async function status() {
  if (!isWindows()) {
    return { supported: false, installed: false, running: false, state: 'unsupported', name: SERVICE_NAME };
  }
  const res = await run('sc', ['query', SERVICE_NAME], { timeoutMs: 8000 });
  const text = `${res.stdout}\n${res.stderr}`;
  if (!res.ok && /1060|does not exist/i.test(text)) {
    return { supported: true, installed: false, running: false, state: 'not-installed', name: SERVICE_NAME };
  }
  const stateMatch = /STATE\s*:\s*\d+\s+(\w+)/i.exec(res.stdout);
  const state = stateMatch ? stateMatch[1].toUpperCase() : res.ok ? 'UNKNOWN' : 'QUERY_FAILED';
  const qc = await run('sc', ['qc', SERVICE_NAME], { timeoutMs: 8000 });
  const startType = /START_TYPE\s*:\s*\d+\s+(\w+)/i.exec(qc.stdout)?.[1]?.toUpperCase() || null;
  return {
    supported: true,
    installed: true,
    running: state === 'RUNNING',
    state,
    startType,
    name: SERVICE_NAME,
    display: SERVICE_DISPLAY,
    raw: res.stdout || res.stderr,
  };
}

/** Run the WinSW wrapper elevated (one UAC prompt) and verify the outcome. */
async function control(action, { paths, log = () => {} } = {}) {
  if (!isWindows()) {
    return { ok: false, supported: false, action, error: 'The background service is only available on Windows.' };
  }
  if (action === 'status') return { ok: true, ...(await status()) };

  const exe = paths?.serviceExe;
  const xml = paths?.serviceXml;
  if (!exe || !fs.existsSync(exe) || !fs.existsSync(xml)) {
    return {
      ok: false,
      supported: true,
      action,
      error: `Service wrapper not found (${exe || '<unknown>'}). Reinstall ATT with the latest installer.`,
    };
  }
  if ((action === 'install' || action === 'start') && !homeIsMachineWide(paths)) {
    return {
      ok: false,
      supported: true,
      action,
      error:
        `ATT's data folder is ${paths.home}, but the service can only use the machine-wide folder ` +
        `${machineWideHome()}. Grant your user Modify rights on ${machineWideHome()} (the installer does this), then try again.`,
    };
  }

  const before = await status();
  log('info', `service ${action}: ${before.state} → requesting elevation`);

  const ps =
    `Start-Process -FilePath '${exe}' -ArgumentList '${action}' -Verb RunAs -Wait -WindowStyle Hidden; ` +
    `exit $LASTEXITCODE`;
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    timeoutMs: 120000,
  });

  // Give the SCM a moment to settle, then verify.
  await new Promise((r) => setTimeout(r, 1500));
  const after = await status();
  const ok =
    res.ok ||
    (action === 'install' && after.installed) ||
    (action === 'uninstall' && !after.installed) ||
    (action === 'start' && after.running) ||
    (action === 'stop' && after.installed && !after.running);

  log('info', `service ${action}: ${after.state} (elevated command exit ${res.code})`);
  return {
    ok: Boolean(ok),
    supported: true,
    action,
    elevatedExitCode: res.code,
    output: res.stdout || res.stderr || undefined,
    cancelled: /1223|operation was canceled|The operation was canceled by the user/i.test(`${res.stdout}${res.stderr}`),
    service: after,
    error: ok ? undefined : res.stderr || res.stdout || `Service ${action} did not complete (exit ${res.code})`,
  };
}

module.exports = { SERVICE_NAME, SERVICE_DISPLAY, status, control, isWindows, homeIsMachineWide, machineWideHome };
