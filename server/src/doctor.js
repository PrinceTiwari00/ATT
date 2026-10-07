/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  `att --doctor` — one-shot health report
 * ─────────────────────────────────────────────────────────────────────────────
 *  Support starts here: without opening the UI this prints who the machine is,
 *  whether it can see the ZKTeco terminal, and whether the database and poller
 *  are healthy. Exit code 0 = device reachable, 1 = something is blocking.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const config = require('./config');
const net = require('./net/diagnostics');
const { probeDevice } = require('./zk/manager');

const line = (s = '') => console.log(s);
const tick = (ok) => (ok ? '  ✅' : '  ❌');
const warn = (ok) => (ok ? '  ✅' : '  ⚠️ ');

async function runDoctor({ json = false } = {}) {
  const report = {
    at: new Date().toISOString(),
    app: { version: config.version, node: process.version, platform: process.platform, packaged: config.desktop.packaged },
    paths: config.paths,
    device: { mode: config.zk.mode, ip: config.zk.ip, port: config.zk.port },
  };

  report.interfaces = net.listInterfaces().filter((i) => !i.internal);
  report.gateways = await net.readDefaultGateways();
  report.link = report.interfaces.find(
    (i) => i.prefix != null && net.sameSubnet(i.address, config.zk.ip, i.prefix)
  ) || null;
  report.ping = await net.pingHost(config.zk.ip, { count: 2, timeoutMs: 1500 });
  report.tcp = await net.tcpProbe(config.zk.ip, config.zk.port, Math.min(5000, config.zk.timeoutMs));
  report.handshake = report.tcp.ok && config.zk.mode === 'real'
    ? await probeDevice({ ip: config.zk.ip, port: config.zk.port, timeoutMs: 5000 })
    : { ok: false, skipped: true };

  try {
    const { getDb } = require('./db/connection');
    const db = getDb();
    report.db = {
      file: config.dbPath,
      exists: fs.existsSync(config.dbPath),
      teachers: db.prepare('SELECT COUNT(*) c FROM teachers').get().c,
      rawLogs: db.prepare('SELECT COUNT(*) c FROM attendance_logs').get().c,
      processedDays: db.prepare('SELECT COUNT(DISTINCT work_date) c FROM processed_attendance').get().c,
    };
  } catch (err) {
    report.db = { error: err.message };
  }

  report.ok = Boolean(report.tcp.ok && (report.handshake.ok || config.zk.mode !== 'real'));

  if (json) {
    line(JSON.stringify(report, null, 2));
    return report.ok;
  }

  line('');
  line(`ATT ${config.version} · doctor`);
  line('──────────────────────────────────────────────');
  line(`  host          ${config.paths.hostname} (${process.platform} ${process.arch})`);
  line(`  node          ${process.version}`);
  line(`  settings      ${config.paths.settingsFile}${fs.existsSync(config.paths.settingsFile) ? '' : ' (not created yet)'}`);
  line(`  database      ${config.dbPath}${report.db?.exists ? '' : ' (not created yet)'}`);
  line(`  log file      ${config.paths.logFile}`);
  line('');
  line(`  device mode   ${config.zk.mode}`);
  line(`  device target ${config.zk.ip}:${config.zk.port}`);
  line('');
  line('  Network checks');
  line(`${warn(report.interfaces.length > 0)} interfaces    ${report.interfaces.map((i) => `${i.name}:${i.address}/${i.prefix ?? '?'}`).join(', ') || 'none'}`);
  line(`${warn(Boolean(report.link))} same subnet   ${report.link ? `${config.zk.ip} is inside ${report.link.cidr}` : `${config.zk.ip} is NOT on any local network — traffic will be routed`}`);
  line(`${warn(report.gateways.length > 0)} gateway       ${report.gateways.map((g) => g.gateway).join(', ') || 'not detected'}`);
  line(`${warn(report.ping.ok)} ping          ${report.ping.ok ? `reply in ${report.ping.rttMs ?? '?'} ms` : 'no ICMP reply (may be blocked)'}`);
  line(`${tick(report.tcp.ok)} tcp ${String(config.zk.port).padEnd(5)}    ${report.tcp.ok ? `open in ${report.tcp.ms} ms` : `${report.tcp.code} — ${report.tcp.error}`}`);
  if (report.handshake.ok) {
    const d = report.handshake.device || {};
    line(`${tick(true)} handshake     ${[d.productName, d.serialNumber, d.version].filter(Boolean).join(' · ') || 'terminal answered'}`);
  } else if (report.handshake.skipped) {
    line(`${warn(true)} handshake     skipped (mode ${config.zk.mode})`);
  } else {
    line(`${tick(false)} handshake     ${report.handshake.error || 'failed'}`);
  }
  if (report.tcp.hints?.length && !report.tcp.ok) {
    line('');
    line('  What to try');
    for (const hint of report.tcp.hints) line(`   • ${hint}`);
  }
  if (report.db && !report.db.error) {
    line('');
    line('  Data');
    line(`  teachers ${report.db.teachers} · raw punches ${report.db.rawLogs} · processed days ${report.db.processedDays}`);
  }
  line('');
  line(report.ok ? '  RESULT: this computer can reach the attendance device.' : '  RESULT: the device link is not working yet — see the failures above.');
  line('');
  return report.ok;
}

module.exports = { runDoctor };
