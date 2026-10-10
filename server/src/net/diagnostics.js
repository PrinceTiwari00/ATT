/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  NETWORK DIAGNOSTICS & DEVICE DISCOVERY
 * ─────────────────────────────────────────────────────────────────────────────
 *  "Connect this computer to the attendance device" fails for a handful of
 *  well-known reasons: wrong subnet, AP client isolation, a firewall, the
 *  terminal keeping its single management session for another PC, or simply a
 *  typo in the IP. This module turns those reasons into a structured report
 *  the UI can render as a checklist, and can sweep the local /24 to FIND the
 *  terminal automatically.
 *
 *  Everything here is dependency-free (node:net, node:dgram, node:os,
 *  node:child_process) so it survives being bundled into the Windows app.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { isValidIpv4 } = require('../settings');

const ZK_DEFAULT_PORT = 4370;
const MAX_SCAN_HOSTS = 1024; // hard cap — never sweep a /16 by accident

/* ── IPv4 arithmetic ───────────────────────────────────────────────────── */

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function netmaskToPrefix(mask) {
  if (!isValidIpv4(mask)) return null;
  const bits = ipToInt(mask).toString(2).replace(/0/g, '').length;
  // a valid netmask has no holes: 1s followed by 0s
  const asBin = ipToInt(mask).toString(2).padStart(32, '0');
  return /^1*0*$/.test(asBin) ? bits : null;
}

function prefixToNetmask(prefix) {
  const p = Math.max(0, Math.min(32, Number(prefix) || 0));
  return intToIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
}

/** Parse '192.168.1.0/24', '192.168.1.5/255.255.255.0' or a bare host. */
function parseCidr(input) {
  const raw = String(input || '').trim();
  const [ip, suffix] = raw.split('/');
  if (!isValidIpv4(ip)) return null;
  let prefix = 24;
  if (suffix) {
    prefix = suffix.includes('.') ? netmaskToPrefix(suffix) : Number(suffix);
    if (prefix === null || !Number.isFinite(prefix) || prefix < 8 || prefix > 32) return null;
  }
  const mask = prefixToNetmask(prefix);
  const network = intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
  const broadcast = intToIp(((ipToInt(network) | ~ipToInt(mask)) >>> 0));
  return { cidr: `${network}/${prefix}`, network, broadcast, mask, prefix, ip };
}

function sameSubnet(a, b, maskOrPrefix) {
  const pa = parseCidr(`${a}/${maskOrPrefix}`);
  const pb = parseCidr(`${b}/${maskOrPrefix}`);
  if (!pa || !pb) return false;
  return pa.network === pb.network;
}

/** Every usable host address of a CIDR (network + broadcast excluded). */
function enumerateHosts(cidr, { limit = MAX_SCAN_HOSTS } = {}) {
  const parsed = parseCidr(cidr);
  if (!parsed) return [];
  const first = ipToInt(parsed.network) + 1;
  const last = ipToInt(parsed.broadcast) - 1;
  if (last < first) return [];
  const out = [];
  for (let n = first; n <= last && out.length < limit; n++) out.push(intToIp(n));
  return out;
}

/* ── local machine identity ────────────────────────────────────────────── */

/**
 * IPv4/IPv6 interfaces of THIS computer — what the wizard shows first so a
 * user can see whether the PC and the terminal are on the same network.
 */
function listInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const prefix = a.cidr ? Number(a.cidr.split('/')[1]) : netmaskToPrefix(a.netmask);
      const parsed = prefix != null ? parseCidr(`${a.address}/${prefix}`) : null;
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        prefix: prefix ?? null,
        cidr: parsed ? parsed.cidr : null,
        network: parsed ? parsed.network : null,
        broadcast: parsed ? parsed.broadcast : null,
        mac: a.mac,
        internal: Boolean(a.internal),
      });
    }
  }
  return out;
}

function usableInterfaces() {
  return listInterfaces().filter((i) => !i.internal && !i.address.startsWith('169.254.'));
}

/** Best-effort default gateway per interface (routing table parsing is OS-specific). */
function readDefaultGateways() {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'route' : 'ip';
    const args = isWin ? ['print', '-4'] : ['route', 'show', 'default'];
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, timeout: 5000 });
    } catch (_) {
      return resolve([]);
    }
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    const finish = () => {
      const gateways = [];
      const seen = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        // Windows: "          0.0.0.0          0.0.0.0      192.168.1.1     192.168.1.23     25"
        // Linux:   "default via 192.168.1.1 dev wlan0 proto dhcp metric 600"
        const win = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
        const nix = /^default via (\d+\.\d+\.\d+\.\d+) dev (\S+)/.exec(line.trim());
        if (win && !seen.has(win[1])) {
          seen.add(win[1]);
          gateways.push({ gateway: win[1], interfaceAddress: win[2] });
        } else if (nix && !seen.has(nix[1])) {
          seen.add(nix[1]);
          gateways.push({ gateway: nix[1], interface: nix[2] });
        }
      }
      resolve(gateways);
    };
    child.on('error', () => resolve([]));
    child.on('close', finish);
    setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, 5000);
  });
}

/* ── reachability probes ───────────────────────────────────────────────── */

const ERROR_HINTS = {
  ECONNREFUSED: 'The computer reached the device but nothing is listening on that port. Check Menu → COMM → Connection port on the terminal, then reboot it.',
  ETIMEDOUT: 'No answer at all — wrong IP, a different subnet/VLAN, Wi-Fi "AP client isolation", or a firewall between this PC and the terminal.',
  EHOSTUNREACH: 'This computer has no route to that address. Connect the PC to the same network/VLAN as the terminal.',
  ENETUNREACH: 'This computer has no active network interface for that address range. Check the Ethernet/Wi-Fi connection of the PC itself.',
  ENETDOWN: 'The network interface of this computer is down.',
  EAI_AGAIN: 'DNS lookup failed. Use the numeric IP address of the terminal instead of a hostname.',
  ENOTFOUND: 'Hostname could not be resolved. Use the numeric IP address of the terminal.',
  ECONNRESET: 'The device closed the connection. ZKTeco terminals allow only one management session — close ZKTime/other software and try again.',
};

function hintFor(errorCode, message = '') {
  if (ERROR_HINTS[errorCode]) return [ERROR_HINTS[errorCode]];
  const hints = [];
  if (/timeout|timed out/i.test(message)) hints.push(ERROR_HINTS.ETIMEDOUT);
  if (/comm key|password/i.test(message)) {
    hints.push('Connects but rejects commands → set Menu → COMM → Comm Key = 0 on the terminal.');
  }
  return hints;
}

/** TCP connect probe. Classifies the failure the same way the ZK adapter does. */
function tcpProbe(host, port = ZK_DEFAULT_PORT, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, port, ms: Date.now() - started, ...result });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ ok: true, open: true }));
    socket.once('timeout', () => done({ ok: false, open: false, code: 'ETIMEDOUT', error: `TCP ${host}:${port} did not answer within ${timeoutMs}ms`, hints: hintFor('ETIMEDOUT') }));
    socket.once('error', (err) => done({
      ok: false,
      open: false,
      code: err.code || 'ERROR',
      error: err.message,
      hints: hintFor(err.code, err.message),
    }));
    try {
      socket.connect(port, host);
    } catch (err) {
      done({ ok: false, open: false, code: err.code || 'ERROR', error: err.message, hints: hintFor(err.code, err.message) });
    }
  });
}

/** ICMP ping through the OS utility (best-effort; firewalls may block ICMP). */
function pingHost(host, { count = 2, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const args = isWin
      ? ['-n', String(count), '-w', String(timeoutMs), host]
      : ['-c', String(count), '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), host];
    let child;
    try {
      child = spawn(isWin ? 'ping' : 'ping', args, { windowsHide: true });
    } catch (err) {
      return resolve({ host, ok: false, skipped: true, error: `ping unavailable: ${err.message}` });
    }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, timeoutMs * count + 3000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ host, ok: false, skipped: true, error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const rtt = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
      // Windows exit codes are unreliable across locales — trust the TTL marker.
      const answered = /TTL=/i.test(out) || /bytes from/i.test(out);
      const ok = answered || code === 0;
      resolve({
        host,
        ok,
        code,
        rttMs: rtt ? Number(rtt[1]) : null,
        unreachable: /unreachable|100% packet loss|could not find host/i.test(out),
        output: out.split(/\r?\n/).filter(Boolean).slice(0, 8),
      });
    });
  });
}

/* ── subnet sweep / discovery ──────────────────────────────────────────── */

function pool(items, worker, concurrency = 64, onProgress) {
  return new Promise((resolve) => {
    const results = [];
    let index = 0;
    let finished = 0;
    const total = items.length;
    if (!total) return resolve(results);
    const next = async () => {
      while (index < total) {
        const i = index++;
        try {
          const value = await worker(items[i], i);
          if (value !== undefined && value !== null) results.push(value);
        } catch (_) { /* one bad host must not abort the sweep */ }
        finished++;
        if (onProgress && (finished % 16 === 0 || finished === total)) onProgress({ done: finished, total });
      }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, next);
    Promise.all(workers).then(() => resolve(results));
  });
}

/** Candidate CIDRs to sweep: every non-internal IPv4 interface with a /24-ish mask. */
function discoverableCidrs({ maxPrefix = 24, minPrefix = 16 } = {}) {
  return usableInterfaces()
    .filter((i) => i.prefix != null && i.prefix >= minPrefix && i.prefix <= maxPrefix)
    .map((i) => ({ cidr: i.cidr, interface: i.name, address: i.address, prefix: i.prefix }));
}

/**
 * Sweep the LAN for anything listening on the ZKTeco port, then optionally
 * perform a real ZK handshake to confirm it is an attendance terminal.
 *
 * @param {object}   opts
 * @param {string[]} [opts.cidrs]        networks to sweep (default: local interfaces)
 * @param {number}   [opts.port]         device port (default 4370)
 * @param {number}   [opts.timeoutMs]    per-host TCP timeout
 * @param {number}   [opts.concurrency]  parallel probes
 * @param {boolean}  [opts.identify]     run a ZK handshake on every open host
 * @param {(ip:number, port:number) => Promise<object>} [opts.identifyFn] injected handshake
 * @param {Function} [opts.onProgress]
 */
async function discoverDevices({
  cidrs,
  port = ZK_DEFAULT_PORT,
  timeoutMs = 1200,
  concurrency = 96,
  identify = true,
  identifyFn = null,
  onProgress = null,
} = {}) {
  const started = Date.now();
  const targets = (cidrs && cidrs.length ? cidrs : discoverableCidrs().map((c) => c.cidr));
  const seen = new Set();
  const hosts = [];
  for (const cidr of targets) {
    const parsed = parseCidr(cidr);
    if (!parsed) continue;
    for (const host of enumerateHosts(cidr)) {
      if (seen.has(host)) continue;
      seen.add(host);
      hosts.push(host);
    }
    if (hosts.length >= MAX_SCAN_HOSTS) break;
  }
  if (hosts.length > MAX_SCAN_HOSTS) hosts.length = MAX_SCAN_HOSTS;

  const open = await pool(
    hosts,
    async (host) => {
      const probe = await tcpProbe(host, port, timeoutMs);
      return probe.ok ? { ip: host, port, rttMs: probe.ms } : null;
    },
    concurrency,
    onProgress
  );

  open.sort((a, b) => a.rttMs - b.rttMs);

  const devices = [];
  for (const found of open) {
    const entry = { ...found, zk: null };
    if (identify && typeof identifyFn === 'function') {
      try {
        entry.zk = await identifyFn(found.ip, port);
      } catch (err) {
        entry.zk = { ok: false, error: err.message };
      }
    }
    devices.push(entry);
  }

  return {
    ok: true,
    port,
    scanned: hosts.length,
    networks: targets,
    found: devices.length,
    devices,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
}

/* ── full structured diagnosis ─────────────────────────────────────────── */

/**
 * Produce the checklist the Connect wizard renders.
 * Steps: local identity → subnet relation → ICMP ping → TCP port → ZK handshake.
 */
async function diagnose({
  ip,
  port = ZK_DEFAULT_PORT,
  timeoutMs = 4000,
  ping = true,
  handshakeFn = null,
} = {}) {
  if (!ip) throw new Error('A device IP address is required');
  const started = Date.now();
  const steps = [];
  const interfaces = listInterfaces();
  const local = usableInterfaces();
  const target = parseCidr(ip);
  const gateways = await readDefaultGateways();

  const add = (id, label, status, detail, hints = [], extra = {}) => {
    steps.push({ id, label, status, detail, hints, ...extra });
    return steps[steps.length - 1];
  };

  // 1 — this computer
  if (!local.length) {
    const anyInterface = interfaces.filter((i) => !i.internal);
    add('local-network', 'This computer has a network connection', 'fail',
      anyInterface.length
        ? `Only unusable addresses found: ${anyInterface.map((i) => `${i.name}: ${i.address}`).join(', ')}.`
        : 'No active non-loopback IPv4 interface was found.',
      ['Connect an Ethernet cable or join the school Wi-Fi, then run the check again.',
       'An address starting with 169.254.x means the PC did not get a DHCP lease — reconnect the cable, or set a static IP on the same subnet as the terminal.']);
  } else {
    add('local-network', 'This computer has a network connection', 'pass',
      local.map((i) => `${i.name}: ${i.address}/${i.prefix ?? '?'}`).join('  ·  '),
      [], { interfaces: local });
  }

  // 2 — same subnet?
  const match = target
    ? local.find((i) => i.prefix != null && sameSubnet(i.address, ip, i.prefix))
    : null;
  const linkLocalTarget = /^169\.254\./.test(ip);
  if (!target) {
    add('subnet', 'Device address is on this network', 'warn',
      `"${ip}" is a hostname — subnet checks are skipped.`,
      ['ZKTeco terminals are addressed by IP; using the numeric IP avoids DNS problems.']);
  } else if (match) {
    add('subnet', 'Device address is on this network', 'pass',
      `${ip} is inside ${match.cidr} (${match.name}) — direct layer-2 link.`,
      [], { interface: match.name, interfaceAddress: match.address });
  } else if (linkLocalTarget) {
    add('subnet', 'Device address is on this network', 'warn',
      `${ip} is a link-local fallback address (DHCP off / no lease on the terminal).`,
      ['Give the terminal a static IP on your LAN: Menu → COMM → Ethernet → IP Address, DHCP = OFF.']);
  } else {
    const gatewayNote = gateways.length
      ? ` Default gateways seen: ${gateways.map((g) => g.gateway).join(', ')}.`
      : '';
    add('subnet', 'Device address is on this network', 'warn',
      `None of this PC's networks (${local.map((i) => i.cidr).filter(Boolean).join(', ') || 'none'}) contains ${ip}.${gatewayNote}`,
      ['Traffic will be routed — many school routers/VLANs block that. Put the PC and the terminal on the same subnet, or ask IT for a route.',
       'If the terminal is on a Wi-Fi network with "AP/client isolation" enabled, disable it or wire the terminal with Ethernet.',
       'Static terminal IP: Menu → COMM → Ethernet → IP Address / Subnet / Gateway, DHCP = OFF, then reboot the terminal.'],
      { interfaces: local, gateways });
  }

  // 3 — ICMP
  if (ping) {
    const result = await pingHost(ip, { timeoutMs: Math.min(2000, timeoutMs) });
    if (result.skipped) {
      add('icmp', 'Device answers ping', 'skipped', result.error || 'ping not available', []);
    } else if (result.ok) {
      add('icmp', 'Device answers ping', 'pass',
        `Reply from ${ip}${result.rttMs != null ? ` in ${result.rttMs} ms` : ''}.`, [], { rttMs: result.rttMs });
    } else {
      add('icmp', 'Device answers ping', 'warn',
        `No ICMP reply from ${ip}.`,
        ['Some terminals and firewalls ignore ping — the TCP test below is the one that matters.',
         'If TCP also fails: wrong IP, different subnet, or client isolation (see the hints above).'],
        { output: result.output });
    }
  }

  // 4 — TCP port
  const probe = await tcpProbe(ip, port, timeoutMs);
  if (probe.ok) {
    add('tcp', `TCP port ${port} is open`, 'pass', `Connected to ${ip}:${port} in ${probe.ms} ms.`, [], { ms: probe.ms });
  } else {
    add('tcp', `TCP port ${port} is open`, 'fail', `${probe.error} (${probe.code})`, probe.hints.length ? probe.hints : [
      'Confirm the port under Menu → COMM → Connection (ZKTeco default 4370).',
      'Reboot the terminal after any network change — it often applies only after a restart.',
      'Allow outbound TCP 4370 for ATT in Windows Defender Firewall / endpoint security.',
    ], { code: probe.code });
  }

  // 5 — ZK protocol handshake
  let handshake = null;
  if (probe.ok && typeof handshakeFn === 'function') {
    try {
      handshake = await handshakeFn(ip, port);
    } catch (err) {
      handshake = { ok: false, error: err.message };
    }
    if (handshake && handshake.ok) {
      const d = handshake.device || {};
      const bits = [d.productName, d.serialNumber || d.sn, d.version || d.firmwareVersion].filter(Boolean);
      add('handshake', 'ZKTeco protocol handshake', 'pass',
        bits.length ? `Terminal answered: ${bits.join(' · ')}` : 'Terminal answered the ZK handshake.',
        [], { device: d });
    } else {
      add('handshake', 'ZKTeco protocol handshake', 'fail',
        (handshake && handshake.error) || 'The port is open but the terminal did not answer the ZK protocol.',
        ['Set Menu → COMM → Comm Key (Password) = 0 — a non-zero key accepts the socket and then rejects every command.',
         'Close ZKTime / ZKAccess / any other management software: the terminal serves only one session at a time.',
         'Check the device clock (Menu → System → Date/Time); a wrong clock skews late/early minutes.'],
        { error: handshake && handshake.error });
    }
  } else if (!probe.ok) {
    add('handshake', 'ZKTeco protocol handshake', 'skipped', 'Skipped — the TCP port is not reachable.', []);
  } else {
    add('handshake', 'ZKTeco protocol handshake', 'skipped', 'Skipped by request.', []);
  }

  const failed = steps.filter((s) => s.status === 'fail');
  const ok = probe.ok && (!handshake || handshake.ok !== false);
  return {
    ok,
    target: { ip, port },
    verdict: ok
      ? 'This computer can reach the attendance device.'
      : failed.length
        ? failed[failed.length - 1].detail
        : 'This computer cannot reach the attendance device yet.',
    steps,
    interfaces,
    gateways,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
}

module.exports = {
  ZK_DEFAULT_PORT,
  MAX_SCAN_HOSTS,
  ipToInt,
  intToIp,
  netmaskToPrefix,
  prefixToNetmask,
  parseCidr,
  sameSubnet,
  enumerateHosts,
  listInterfaces,
  usableInterfaces,
  discoverableCidrs,
  readDefaultGateways,
  tcpProbe,
  pingHost,
  pool,
  discoverDevices,
  diagnose,
  hintFor,
  isValidIpv4,
};
