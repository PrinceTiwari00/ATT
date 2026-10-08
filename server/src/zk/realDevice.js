/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PRODUCTION ZKTECO CONNECTION  (spec § B.1 / deliverable #2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Talks to a ZKTeco terminal over TCP/IP (default 192.168.1.110:4370) using
 *  the `node-zklib` protocol implementation.
 *
 *  Production-hardening built in here:
 *   • Lazy module load      — server never crashes if node-zklib is absent;
 *                             mock mode stays usable.
 *   • withConnection()      — a connect → operate → ALWAYS disconnect wrapper.
 *                             ZKTeco terminals accept a very limited number of
 *                             concurrent TCP sessions; leaving a socket open is
 *                             the #1 cause of "device not responding" after a
 *                             few polls. We disconnect on every exit path.
 *   • Timeout guard         — every operation is wrapped in a hard timeout so a
 *                             hung device can't wedge the poller.
 *   • Error classification  — network faults become retryable
 *                             ZKConnectionError for the manager's
 *                             circuit breaker; protocol oddities become
 *                             ZKDeviceError.
 *   • Defensive field parse — different firmware reports attendance rows with
 *                             different field names; we accept all known
 *                             variants and normalize to the device contract.
 *   • Version-drift-proof calls — node-zklib's API names have drifted between
 *                             releases (and its README over-promises), so no
 *                             operation hard-codes a single spelling. Every
 *                             call resolves against the INSTALLED library and
 *                             a missing method raises an actionable error
 *                             instead of `undefined is not a function`.
 *
 *  Cloud deployments should use BridgeZKDevice on the server and run this
 *  adapter locally inside the authenticated LAN-side agent.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const {
  ZKConnectionError,
  ZKDeviceError,
  parseDeviceTime,
} = require('./deviceContract');

/**
 * The methods we need, in order of preference. Keep this in sync with the
 * probe in test/zkLibraryContract.test.js — it asserts these all resolve on the
 * library that is actually installed, which is the test that catches a rename
 * (for example node-zklib 1.x ships `getAttendances`, never `getAttendance`).
 */
const ZK_METHODS = {
  connect: ['createSocket', 'connect'],
  getUsers: ['getUsers'],
  getLogs: ['getAttendances', 'getAttendance'],
  getInfo: ['getInfo'],
  clearLogs: ['clearAttendanceLog', 'clearAttendance'],
  writeUser: ['setUser', 'createUser'],
};

function loadZkLib() {
  try {
    // node-zklib: CommonJS default export is a constructor.
    // Signature: new ZKLib(ip, port, timeout_ms, inport)
    return require('node-zklib');
  } catch (err) {
    throw new ZKDeviceError(
      "node-zklib is not installed. Run `npm --prefix server install` or use ZK_MODE=mock.",
      err
    );
  }
}

/** Version string of the installed library, or null (it is bundled in the app). */
function zkLibVersion() {
  try {
    return require('node-zklib/package.json').version || null;
  } catch (_) {
    return null;
  }
}

/** First alias of `key` that exists on `source` (instance or prototype) → {name, fn}. */
function resolveMethodOn(source, key) {
  const aliases = ZK_METHODS[key] || [key];
  if (!source) return null;
  for (const name of aliases) {
    if (typeof source[name] === 'function') return { name, fn: source[name] };
  }
  return null;
}

function methodNames(source) {
  if (!source) return [];
  return Object.getOwnPropertyNames(source).filter(
    (n) => n !== 'constructor' && typeof source[n] === 'function'
  );
}

/** Actionable error when the installed library lacks a method we need. */
function missingMethodError(key, source) {
  const aliases = ZK_METHODS[key] || [key];
  const version = zkLibVersion();
  const available = methodNames(source);
  const who = `node-zklib${version ? ` v${version}` : ''}`;
  const diagnostics = available.length ? ` (installed library exposes: ${available.join(', ')})` : '';

  if (key === 'writeUser') {
    return new ZKDeviceError(
      `${who} has no \`${aliases[0]}\` — this library version cannot create users on the terminal. ` +
        'Enroll the person on the device itself (Menu → User Mgt → New User), then use ' +
        `"Fetch device users" → Import in Device & Sync.${diagnostics}`
    );
  }
  return new ZKDeviceError(
    `${who} has none of [${aliases.join(', ')}], so this operation cannot run. ` +
      `Install a supported library: npm --prefix server install node-zklib@^1.3.0.${diagnostics}`
  );
}

/**
 * node-zklib logs a bare `ok tcp` (or `ok udp`) on every connect. In the
 * packaged app that lands in the school's log file on every single poll, so it
 * is filtered for the duration of the handshake. Only that exact banner line is
 * dropped — everything else still reaches console.log untouched.
 */
const ZKLIB_BANNER = /^ok (tcp|udp)$/i;

async function withoutZlklibBanner(fn) {
  const original = console.log;
  console.log = function filteredLog(...args) {
    if (args.length === 1 && typeof args[0] === 'string' && ZKLIB_BANNER.test(args[0].trim())) return;
    return original.apply(this, args);
  };
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

/** Static capability report — works while the terminal is offline (no socket). */
function capabilitiesFrom(source, version) {
  const canWriteUsers = Boolean(resolveMethodOn(source, 'writeUser'));
  const caps = {
    source: 'real',
    library: 'node-zklib',
    libraryVersion: version || null,
    installed: Boolean(source),
    canFetchAttendance: Boolean(resolveMethodOn(source, 'getLogs')),
    canFetchUsers: Boolean(resolveMethodOn(source, 'getUsers')),
    canClearAttendance: Boolean(resolveMethodOn(source, 'clearLogs')),
    canWriteUsers,
    availableMethods: methodNames(source),
  };
  if (!caps.installed) {
    caps.writeUsersHint = null;
    caps.fetchHint = 'node-zklib is not installed — run `npm --prefix server install`, or use ZK_MODE=mock.';
  } else if (!canWriteUsers) {
    caps.writeUsersHint =
      `node-zklib${version ? ` v${version}` : ''} can read users and logs but cannot create users on the ` +
      'terminal (it has no setUser API). Enroll people on the device itself — Menu → User Mgt → New User — ' +
      'then use "Fetch device users" → Import to link them here.';
  }
  return caps;
}

function libraryProto() {
  try {
    const ZKLib = loadZkLib();
    return ZKLib && ZKLib.prototype ? ZKLib.prototype : null;
  } catch (_) {
    return null; // not installed → capabilities report installed:false
  }
}

/** Normalize raw node-zklib attendance rows to the device contract. */
function normalizeAttendanceRecords(logs) {
  const out = [];
  for (const r of logs) {
    const timestamp = parseDeviceTime(
      firstDefined(r.record_time, r.recordTime, r.timestamp, r.time, r.verifyTime)
    );
    const userId = firstDefined(
      r.user_id, r.userId, r.device_user_id, r.deviceUserId, r.userSn, r.userSN, r.sn, r.uid
    );
    if (!timestamp || userId == null || userId === '') continue; // corrupt row — skip, keep pulling
    out.push({
      userId: String(userId),
      timestamp,
      punchType: Number(firstDefined(r.type, r.punch, r.state, 0)) || 0,
      deviceSn: firstDefined(r.sn_device, r.deviceSn, r.terminalSn) ?? null,
    });
  }
  return out;
}

/**
 * Pull a human-readable message + code out of whatever a protocol library threw.
 *
 * node-zklib rejects with its own `ZKError`, which does NOT extend Error: it has
 * no `.message` at all and hides the real failure in `.err` (plus a `toast()`
 * helper). Treating it like an Error produced messages such as
 *     "ZKTeco protocol error at 192.168.1.110:4370 — [object Object]"
 * and — much worse — the ECONNREFUSED/ETIMEDOUT codes never matched, so
 * unreachable devices were classified as non-retryable and the circuit breaker
 * never engaged. Walk the whole chain instead.
 */
function describeError(err) {
  if (err == null) return { message: 'unknown error', code: null, command: null };
  if (typeof err === 'string') return { message: err, code: null, command: null };

  let message = null;
  let code = null;
  let command = null;
  const seen = new Set();
  let node = err;

  for (let depth = 0; node && typeof node === 'object' && depth < 4 && !seen.has(node); depth++) {
    seen.add(node);
    if (!code && node.code) code = String(node.code);
    if (!command && typeof node.command === 'string' && node.command) command = node.command;
    if (!message && typeof node.message === 'string' && node.message) message = node.message;
    if (!message && typeof node.toast === 'function') {
      try {
        const t = node.toast(); // node-zklib's human phrasing, e.g. "IP of the device is refused"
        if (typeof t === 'string' && t) message = t;
      } catch (_) { /* toast() throws when .err is missing — ignore */ }
    }
    node = node.err || node.cause || node.originalError || node.error || null;
  }

  if (!message) message = code || 'unknown error';
  return { message, code, command };
}

function classifyNetworkError(err, ip, port) {
  const { message, code } = describeError(err);
  const retryableCodes = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET|socket|timeout|timed out/i;
  // Keep the library's human phrasing ("IP of the device is refused") and add
  // the OS code for whoever supports the school.
  const detail = code && !message.includes(code) ? `${message} (${code})` : message;
  if (retryableCodes.test(message) || retryableCodes.test(String(code))) {
    return new ZKConnectionError(`Cannot reach ZKTeco device at ${ip}:${port} — ${detail}`, err);
  }
  return new ZKDeviceError(`ZKTeco protocol error at ${ip}:${port} — ${detail}`, err);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ZKConnectionError(`"${label}" exceeded ${ms}ms timeout`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class RealZKDevice {
  /**
   * @param {{ip:string, port:number, timeoutMs:number, inPort:number}} cfg
   */
  constructor(cfg) {
    this.ip = cfg.ip;
    this.port = cfg.port;
    this.timeoutMs = cfg.timeoutMs;
    this.inPort = cfg.inPort;
    this.mode = 'real';
  }

  /**
   * Connect → run `op(zk)` → always disconnect.
   * Retries live one layer up (zk/manager.js); this wrapper just guarantees a
   * clean session for every operation.
   */
  async withConnection(op, label = 'operation') {
    const ZKLib = loadZkLib();
    const zk = new ZKLib(this.ip, this.port, this.timeoutMs, this.inPort);
    const connect = resolveMethodOn(zk, 'connect');
    if (!connect) throw missingMethodError('connect', Object.getPrototypeOf(zk) || zk);
    try {
      await withTimeout(
        withoutZlklibBanner(() => connect.fn.call(zk)),
        this.timeoutMs,
        `createSocket ${this.ip}:${this.port}`
      );
    } catch (err) {
      await safeDisconnect(zk);
      throw classifyNetworkError(err, this.ip, this.port);
    }

    try {
      return await withTimeout(op(zk), this.timeoutMs * 2, label);
    } catch (err) {
      if (err instanceof ZKConnectionError || err instanceof ZKDeviceError) throw err;
      throw classifyNetworkError(err, this.ip, this.port);
    } finally {
      await safeDisconnect(zk); // never leak a session on the terminal
    }
  }

  /** What the installed library can actually do (no connection required). */
  static capabilities() {
    const proto = libraryProto();
    const caps = capabilitiesFrom(proto, zkLibVersion());
    caps.source = 'real';
    return caps;
  }

  capabilities() {
    return RealZKDevice.capabilities();
  }

  /**
   * Fail fast when the installed library lacks a method — before opening a TCP
   * session we would only have to tear down again. Returns the resolved name.
   */
  assertSupports(key) {
    const proto = libraryProto();
    if (!proto) loadZkLib(); // throws the "not installed" ZKDeviceError
    const resolved = resolveMethodOn(proto, key);
    if (!resolved) throw missingMethodError(key, proto);
    return resolved.name;
  }

  async testConnection() {
    try {
      const info = await this.withConnection(async (zk) => {
        const out = {};
        try {
          if (typeof zk.getInfo === 'function') {
            const infoFn = await zk.getInfo();
            Object.assign(out, infoFn && infoFn.data ? infoFn.data : infoFn);
          }
        } catch (_) {
          /* getInfo unsupported on some firmware — not fatal */
        }
        return out;
      }, 'getInfo');
      return {
        ok: true,
        mode: this.mode,
        ip: this.ip,
        port: this.port,
        device: info,
      };
    } catch (err) {
      return {
        ok: false,
        mode: this.mode,
        ip: this.ip,
        port: this.port,
        error: err.message,
        retryable: !!err.retryable,
      };
    }
  }

  /** Pull enrolled users from the device memory (→ map to teachers). */
  async getUsers() {
    this.assertSupports('getUsers');
    const res = await this.withConnection(async (zk) => {
      const method = resolveMethodOn(zk, 'getUsers');
      if (!method) throw missingMethodError('getUsers', Object.getPrototypeOf(zk) || zk);
      const raw = await method.fn.call(zk);
      return raw && Array.isArray(raw.data) ? raw.data : raw || [];
    }, 'getUsers');

    return res.map((u) => ({
      userId: firstDefined(u.userid, u.user_id, u.userId, u.userSn, u.sn, u.uid),
      name: firstDefined(u.name, u.fullname, u.userName) || '',
      role: u.role,
      cardno: firstDefined(u.cardno, u.card),
    }));
  }

  /**
   * Pull the raw attendance log. NON-destructive read (we never call
   * clearAttendance automatically — logs stay on the terminal until the
   * school chooses to wipe them from its own UI).
   *
   * NOTE the plural: node-zklib 1.x exposes `getAttendances`. `getAttendance`
   * has never existed in any published release, and calling it produced the
   * "zk.getAttendance is not a function" failure on every real-device sync.
   * Resolution goes through ZK_METHODS so either spelling works.
   */
  async getAttendance() {
    const method = this.assertSupports('getLogs');
    const logs = await this.withConnection(async (zk) => {
      const resolved = resolveMethodOn(zk, 'getLogs');
      if (!resolved) throw missingMethodError('getLogs', Object.getPrototypeOf(zk) || zk);
      const raw = await resolved.fn.call(zk);
      return raw && Array.isArray(raw.data) ? raw.data : raw || [];
    }, method);

    return normalizeAttendanceRecords(logs);
  }

  /**
   * Enroll / update a user on the device.
   *
   * node-zklib 1.x ships NO user-writing API at all (`setUser`/`createUser` are
   * absent), so this throws an actionable ZKDeviceError unless the installed
   * library actually provides one. Callers should check capabilities() first.
   */
  async setUser({ userId, name, uid, role = 0, password = '', cardno = 0 }) {
    this.assertSupports('writeUser');
    const numericUid = uid != null ? uid : stableNumericUid(String(userId));
    await this.withConnection(async (zk) => {
      const method = resolveMethodOn(zk, 'writeUser');
      if (!method) throw missingMethodError('writeUser', Object.getPrototypeOf(zk) || zk);
      // setUser(uid, userid, name, password, role, cardno)
      return method.fn.call(zk, numericUid, String(userId), name || String(userId), password, role, cardno);
    }, `setUser ${userId}`);
    return { ok: true };
  }

  /** Danger: wipes the terminal attendance memory. Call only manually. */
  async clearAttendance() {
    this.assertSupports('clearLogs');
    await this.withConnection(async (zk) => {
      const method = resolveMethodOn(zk, 'clearLogs');
      if (method) return method.fn.call(zk);
      return null;
    }, 'clearAttendanceLog');
    return { ok: true };
  }
}

async function safeDisconnect(zk) {
  try {
    if (zk && typeof zk.disconnect === 'function') await zk.disconnect();
  } catch (_) {
    /* ignore: disconnect failures are harmless */
  }
}

function firstDefined(...vals) {
  return vals.find((v) => v !== undefined && v !== null);
}

/** ZKTeco uid fields are integers — derive a stable one from the string id. */
function stableNumericUid(userId) {
  const n = parseInt(userId, 10);
  if (Number.isFinite(n) && n >= 0 && n <= 65534) return n;
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) % 65534;
  return h || 1;
}

module.exports = {
  RealZKDevice,
  // exported for the contract test + capability reporting
  ZK_METHODS,
  resolveMethodOn,
  capabilitiesFrom,
  normalizeAttendanceRecords,
  missingMethodError,
  withoutZlklibBanner,
  describeError,
  classifyNetworkError,
};
