#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ATT — ZKTeco Attendance Tracking System · entrypoint
 * ─────────────────────────────────────────────────────────────────────────────
 *  Works identically for every way ATT is launched:
 *
 *    node src/index.js                 development / systemd / Render
 *    node server.cjs --service         Windows background service (WinSW)
 *    node server.cjs --port 4010       desktop app child process
 *    node server.cjs --agent           cloud bridge agent on the school LAN
 *    node server.cjs --doctor          network + device health report
 *
 *  Boot order: settings → file log → migrate → seed → manager → poller → API.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { attachFileLog, flushSync } = require('./log');
const settings = require('./settings');
const config = require('./config');

/* ── CLI arguments ─────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')[0]));
const opts = Object.fromEntries(
  argv.filter((a) => a.startsWith('--') && a.includes('=')).map((a) => [a.replace(/^--/, '').split('=')[0], a.slice(a.indexOf('=') + 1)])
);
const command = argv.find((a) => !a.startsWith('--')) || null;

const isService = flags.has('service') || process.env.ATT_SERVICE_MODE === '1';
const wantAgent = flags.has('agent') || command === 'agent';
const wantDoctor = flags.has('doctor') || command === 'doctor';
const wantPaths = flags.has('print-paths') || command === 'paths';
const wantVersion = flags.has('version') || command === 'version';

/* ── log to file so the installed app can show/support itself ──────────── */
// Always on unless explicitly disabled with ATT_LOG_FILE=off: the desktop app,
// the Windows service and `att --doctor` all read this file back through
// GET /api/system/logs.
if (process.env.ATT_LOG_FILE !== 'off') {
  attachFileLog(process.env.ATT_LOG_FILE || config.paths.logFile);
}

function banner(runtime) {
  console.log('────────────────────────────────────────────────');
  console.log(` ATT ${config.version} · listening on ${runtime.url}`);
  console.log(` ZKTeco mode: ${config.zk.mode} @ ${config.zk.ip}:${config.zk.port}`);
  console.log(` DB: ${config.dbPath}`);
  console.log(` Settings: ${config.paths.settingsFile}`);
  if (isService) console.log(' Running as a Windows service (logs mirrored to file)');
  console.log('────────────────────────────────────────────────');
}

async function main() {
  if (wantVersion) {
    console.log(config.version);
    return;
  }
  if (wantPaths) {
    console.log(JSON.stringify(config.paths, null, 2));
    return;
  }
  if (wantAgent) {
    await require('./agent').run();
    return;
  }
  if (wantDoctor) {
    const { runDoctor } = require('./doctor');
    const ok = await runDoctor({ json: flags.has('json') });
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const { bootServer } = require('./bootstrap');
  let runtime;
  try {
    runtime = await bootServer({
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      host: opts.host,
      poll: !flags.has('no-poll'),
      mode: isService ? 'service' : 'desktop',
    });
  } catch (err) {
    if (err && err.code === 'INSTANCE_RUNNING') {
      // The desktop shell reads this to attach to the running instance instead
      // of showing an error.
      console.error(`[att] ${err.message}`);
      console.error(`[att] existing instance: ${JSON.stringify(err.instance)}`);
      flushSync();
      process.exit(3);
    }
    throw err;
  }
  banner(runtime);

  const shutdown = async (signal) => {
    console.log(`[att] ${signal} received — shutting down`);
    try {
      await runtime.close();
    } catch (err) {
      console.error(`[att] shutdown error: ${err.message}`);
    }
    flushSync();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  // The Electron shell closes stdin when it exits; the child must follow.
  process.on('disconnect', () => shutdown('disconnect'));
  // Graceful shutdown requested through POST /api/system/shutdown.
  process.on('att:shutdown', () => shutdown('shutdown requested by the desktop app'));
  if (process.env.ATT_WATCH_PARENT === '1' && process.ppid && process.platform !== 'win32') {
    const ppid = process.ppid;
    const watcher = setInterval(() => {
      try {
        process.kill(ppid, 0);
      } catch (_) {
        clearInterval(watcher);
        shutdown('parent exited');
      }
    }, 2000);
    watcher.unref();
  }
}

main().catch((err) => {
  console.error(`[att] fatal: ${err && err.stack ? err.stack : err}`);
  flushSync();
  process.exit(1);
});

module.exports = { settings };
