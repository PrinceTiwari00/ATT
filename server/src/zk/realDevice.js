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
 *   • ONE session at a time — every connect goes through the process-wide
 *                             device lock (zk/deviceLock.js), so the poller,
 *                             the UI buttons, the LAN sweep and the bridge
 *                             agent can never open two sockets to the
 *                             terminal at once. That self-collision is what
 *                             produces TIMEOUT_ON_WRITING_MESSAGE and
 *                             "Another device is connecting to the device so
 *                             the connection is interrupted" (ECONNRESET).
 *   • Comm Key (device password) — ATT completes the CMD_CONNECT →
 *                             CMD_ACK_UNAUTH → CMD_AUTH handshake node-zklib
 *                             does not implement, so a terminal can be keyed
 *                             against every other client (zk/commKey.js). It
 *                             can also read and WRITE that key on the device.
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
const { DeviceLock, DeviceBusyError, getDeviceLock, isBusyError } = require('./deviceLock');
const commKeyProto = require('./commKey');

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
  // The Comm Key handshake and the option read/write both go through the
  // library's raw command channel; without it ATT can still talk to a device
  // whose Comm Key is 0, but it cannot authenticate or set one.
  const canSendRawCommand = Boolean(source && typeof source.executeCmd === 'function');
  const caps = {
    source: 'real',
    library: 'node-zklib',
    libraryVersion: version || null,
    installed: Boolean(source),
    canFetchAttendance: Boolean(resolveMethodOn(source, 'getLogs')),
    canFetchUsers: Boolean(resolveMethodOn(source, 'getUsers')),
    canClearAttendance: Boolean(resolveMethodOn(source, 'clearLogs')),
    canWriteUsers,
    canUseCommKey: canSendRawCommand,
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
  if (caps.installed && !canSendRawCommand) {
    caps.commKeyHint =
      'This library build exposes no raw command channel, so ATT cannot perform the Comm Key handshake or ' +
      'change the key on the terminal. Leave Comm Key = 0 on the device keypad.';
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

  // A session that was accepted and then went silent / was torn down is the
  // signature of the terminal's SINGLE management slot being taken by someone
  // else (another ATT copy, ZKTime, a laptop on the LAN) — or of a Comm Key
  // mismatch, where the device accepts the socket and refuses every command.
  // Say so, because "cannot reach the device" sends the school chasing cables.
  const hint = sessionFaultHint(message, code);

  if (retryableCodes.test(message) || retryableCodes.test(String(code)) || hint) {
    const out = new ZKConnectionError(
      hint ? `${hint.headline} at ${ip}:${port} — ${detail}` : `Cannot reach ZKTeco device at ${ip}:${port} — ${detail}`,
      err
    );
    if (hint) {
      out.hint = hint.text;
      out.fault = hint.fault;
    }
    return out;
  }
  const deviceErr = new ZKDeviceError(`ZKTeco protocol error at ${ip}:${port} — ${detail}`, err);
  if (hint) {
    deviceErr.hint = hint.text;
    deviceErr.fault = hint.fault;
  }
  return deviceErr;
}

/**
 * Recognise the two failures that mean "the terminal's one session was
 * contested" and explain them in plain language. Returns null for anything
 * else so ordinary network faults keep their normal message.
 */
function sessionFaultHint(message, code) {
  const text = `${message || ''} ${code || ''}`;
  if (/TIMEOUT_ON_WRITING_MESSAGE|NO_REPLY_ON_CMD_CONNECT|TIMEOUT_ON_RECEIVING/i.test(text)) {
    return {
      fault: 'session-no-reply',
      headline: 'ZKTeco device accepted the connection but never answered',
      text:
        'The terminal took the TCP connection and then stayed silent. That is its single management session being ' +
        'held by another client (ZKTime, a second ATT install, a laptop on the LAN), or a Comm Key mismatch — a ' +
        'keyed device accepts the socket and refuses every command. ATT already serialises its own access, so: ' +
        'close other ZK software, check Device & Sync → Comm Key matches Menu → COMM → Comm Key, and reboot the ' +
        'terminal if it stays stuck.',
    };
  }
  if (/ECONNRESET|Socket is disconnected unexpectedly|PACKETS REMAIN|Another device is connecting/i.test(text)) {
    return {
      fault: 'session-stolen',
      headline: 'ZKTeco device dropped the connection mid-command',
      text:
        'Another client opened a session on the terminal while ATT was talking to it, and the device cut ATT off ' +
        '(a ZKTeco terminal serves one management connection). Close every other ZK program and any second copy of ' +
        'ATT. Setting a non-zero Comm Key (Device & Sync → Comm Key) makes other software fail the handshake ' +
        'instead of stealing the session.',
    };
  }
  return null;
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
   * @param {{ip:string, port:number, timeoutMs:number, inPort:number,
   *          commKey?:number, explicitHandshake?:boolean, lockWaitMs?:number,
   *          origin?:string, lock?:object}} cfg
   */
  constructor(cfg) {
    this.ip = cfg.ip;
    this.port = cfg.port;
    this.timeoutMs = cfg.timeoutMs;
    this.inPort = cfg.inPort;
    this.mode = 'real';
    /** Terminal Comm Key (connection password). 0 = device accepts anyone. */
    this.commKey = cfg.commKey != null ? commKeyProto.normalizeCommKey(cfg.commKey) : 0;
    /**
     * Do our own CMD_CONNECT so a keyed terminal is DETECTED instead of
     * silently accepting the socket and then ignoring every command. Set
     * ZK_EXPLICIT_HANDSHAKE=false to go back to node-zklib's blind connect.
     */
    this.explicitHandshake = cfg.explicitHandshake !== false;
    /** How long to wait for the device when another ATT operation holds it. */
    this.lockWaitMs = cfg.lockWaitMs != null ? Math.max(0, Number(cfg.lockWaitMs) || 0) : 0;
    this.origin = cfg.origin || null;
    // An explicit DeviceLock (tests, a second terminal); otherwise the shared
    // process-wide one. NOTE the name: `cfg.lock` is the *timing* object in
    // config.zk.lock, not a lock instance.
    this.lock = cfg.deviceLock instanceof DeviceLock ? cfg.deviceLock : null;
  }

  /** The process-wide "one session at a time" lock. */
  get deviceLock() {
    if (!this.lock) this.lock = getDeviceLock();
    return this.lock;
  }

  /**
   * Connect → run `op(zk)` → always disconnect, holding the device lock for
   * the whole session so nothing else in this process can touch the terminal
   * at the same moment.
   *
   * Retries live one layer up (zk/manager.js) and pass their ticket down, so a
   * retried operation keeps exclusive ownership instead of releasing the
   * terminal between attempts.
   *
   * @param {(zk:object, session:object) => Promise<any>} op
   * @param {string} label
   * @param {{ticket?:object, origin?:string, timeoutMs?:number}} [opts]
   */
  async withConnection(op, label = 'operation', opts = {}) {
    return this.deviceLock.runExclusive(
      label,
      (ticket) => this.runSession(op, label, ticket),
      {
        ticket: opts.ticket || null,
        origin: opts.origin || this.origin,
        timeoutMs: opts.timeoutMs != null ? opts.timeoutMs : this.lockWaitMs,
      }
    );
  }

  /** The locked body of withConnection: one socket, one operation, always closed. */
  async runSession(op, label, ticket) {
    const ZKLib = loadZkLib();
    const zk = new ZKLib(this.ip, this.port, this.timeoutMs, this.inPort);
    const session = await this.openSession(zk);

    try {
      // The ticket is passed to the operation so a nested device call inside a
      // batch (push-all, comm-key change) re-enters this same session lock
      // instead of deadlocking against itself.
      return await withTimeout(op(zk, session, ticket), this.timeoutMs * 2, label);
    } catch (err) {
      if (err instanceof ZKConnectionError || err instanceof ZKDeviceError) throw err;
      if (isBusyError(err)) throw err;
      throw classifyNetworkError(err, this.ip, this.port);
    } finally {
      await safeDisconnect(zk); // never leak a session on the terminal
    }
  }

  /**
   * Open (and authenticate) the session.
   *
   * node-zklib's own `createSocket()` sends CMD_CONNECT and only checks that
   * *something* came back — against a terminal with a Comm Key that "success"
   * is CMD_ACK_UNAUTH, and every later command then dies with
   * TIMEOUT_ON_WRITING_MESSAGE. Doing the handshake ourselves means ATT can
   * authenticate with the key, and can tell the operator when the device has a
   * key ATT does not know (or the other way round).
   */
  async openSession(zk) {
    const connectLabel = `connect ${this.ip}:${this.port}`;
    const useExplicit = this.explicitHandshake && Boolean(commKeyProto.transportOf(zk));

    if (!useExplicit) {
      try {
        await withTimeout(
          withoutZlklibBanner(() => zk.createSocket()),
          this.timeoutMs,
          connectLabel
        );
        return { path: 'library', sessionId: null, commKeyRequired: null, authenticated: false };
      } catch (err) {
        await safeDisconnect(zk);
        throw classifyNetworkError(err, this.ip, this.port);
      }
    }

    try {
      return await withTimeout(
        withoutZlklibBanner(() =>
          commKeyProto.openSession(zk, { commKey: this.commKey, ip: this.ip, port: this.port })
        ),
        this.timeoutMs,
        connectLabel
      );
    } catch (err) {
      // Our own, already-explained failures (missing/rejected Comm Key) must
      // reach the user verbatim — never flattened into "cannot reach device".
      if (err instanceof ZKConnectionError || err instanceof ZKDeviceError) {
        await safeDisconnect(zk);
        throw err;
      }
      // node-zklib's UDP fallback only kicks in for a refused TCP port, and
      // only makes sense while no Comm Key is in play. Keep that behaviour.
      if (this.commKey === 0 && isRefused(err)) {
        resetTcpTransport(zk);
        try {
          await withTimeout(
            withoutZlklibBanner(() => zk.createSocket()),
            this.timeoutMs,
            connectLabel
          );
          return { path: 'library-udp', sessionId: null, commKeyRequired: null, authenticated: false };
        } catch (udpErr) {
          await safeDisconnect(zk);
          throw classifyNetworkError(udpErr, this.ip, this.port);
        }
      }
      await safeDisconnect(zk);
      throw classifyNetworkError(err, this.ip, this.port);
    }
  }

  /**
   * What the terminal itself says about its Comm Key. Reads the device option
   * (`COMKey` on most firmware) inside ONE locked session.
   *
   * @returns {Promise<{supported:boolean, name:string|null, deviceValue:string|null,
   *                    configuredKey:number, matches:boolean|null, tried:Array}>}
   */
  async readCommKey(opts = {}) {
    const configuredKey = this.commKey;
    const read = await this.withConnection(
      async (zk) => commKeyProto.readCommKeyOption(zk),
      'readCommKey',
      opts
    );
    const deviceValue = read.supported ? String(read.value) : null;
    return {
      ...read,
      configuredKey,
      deviceValue,
      // null when the firmware would not tell us
      matches: deviceValue == null ? null : Number(deviceValue) === configuredKey,
    };
  }

  /**
   * Write a new Comm Key ONTO the terminal (Menu → COMM → Comm Key, remotely).
   * Returns the option spelling the firmware accepted.
   */
  async writeCommKey(key, { name = null } = {}, opts = {}) {
    const value = commKeyProto.normalizeCommKey(key);
    return this.withConnection(
      async (zk) => commKeyProto.writeCommKeyOption(zk, value, { name }),
      `writeCommKey(${value})`,
      opts
    );
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

  async testConnection(opts = {}) {
    try {
      const { info, session } = await this.withConnection(async (zk, opened) => {
        const out = {};
        try {
          if (typeof zk.getInfo === 'function') {
            const infoFn = await zk.getInfo();
            Object.assign(out, infoFn && infoFn.data ? infoFn.data : infoFn);
          }
        } catch (_) {
          /* getInfo unsupported on some firmware — not fatal */
        }
        return { info: out, session: opened };
      }, 'testConnection', opts);
      return {
        ok: true,
        mode: this.mode,
        ip: this.ip,
        port: this.port,
        device: info,
        // Proves the Comm Key story: did the terminal ask for one, and did ours work?
        commKey: {
          configured: this.commKey,
          required: session ? session.commKeyRequired === true : null,
          authenticated: session ? session.authenticated === true : false,
        },
      };
    } catch (err) {
      return {
        ok: false,
        mode: this.mode,
        ip: this.ip,
        port: this.port,
        error: err.message,
        retryable: !!err.retryable,
        busy: isBusyError(err),
        code: err.code || null,
        commKey: { configured: this.commKey, required: null, authenticated: false },
      };
    }
  }

  /** Pull enrolled users from the device memory (→ map to teachers). */
  async getUsers(opts = {}) {
    this.assertSupports('getUsers');
    const res = await this.withConnection(async (zk) => {
      const method = resolveMethodOn(zk, 'getUsers');
      if (!method) throw missingMethodError('getUsers', Object.getPrototypeOf(zk) || zk);
      const raw = await method.fn.call(zk);
      return raw && Array.isArray(raw.data) ? raw.data : raw || [];
    }, 'getUsers', opts);

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
  async getAttendance(opts = {}) {
    const method = this.assertSupports('getLogs');
    const logs = await this.withConnection(async (zk) => {
      const resolved = resolveMethodOn(zk, 'getLogs');
      if (!resolved) throw missingMethodError('getLogs', Object.getPrototypeOf(zk) || zk);
      const raw = await resolved.fn.call(zk);
      return raw && Array.isArray(raw.data) ? raw.data : raw || [];
    }, method, opts);

    return normalizeAttendanceRecords(logs);
  }

  /**
   * Enroll / update a user on the device.
   *
   * node-zklib 1.x ships NO user-writing API at all (`setUser`/`createUser` are
   * absent), so this throws an actionable ZKDeviceError unless the installed
   * library actually provides one. Callers should check capabilities() first.
   */
  async setUser({ userId, name, uid, role = 0, password = '', cardno = 0 }, opts = {}) {
    this.assertSupports('writeUser');
    const numericUid = uid != null ? uid : stableNumericUid(String(userId));
    await this.withConnection(async (zk) => {
      const method = resolveMethodOn(zk, 'writeUser');
      if (!method) throw missingMethodError('writeUser', Object.getPrototypeOf(zk) || zk);
      // setUser(uid, userid, name, password, role, cardno)
      return method.fn.call(zk, numericUid, String(userId), name || String(userId), password, role, cardno);
    }, `setUser ${userId}`, opts);
    return { ok: true };
  }

  /** Danger: wipes the terminal attendance memory. Call only manually. */
  async clearAttendance(opts = {}) {
    this.assertSupports('clearLogs');
    await this.withConnection(async (zk) => {
      const method = resolveMethodOn(zk, 'clearLogs');
      if (method) return method.fn.call(zk);
      return null;
    }, 'clearAttendanceLog', opts);
    return { ok: true };
  }
}

/** A refused TCP port — the only case where node-zklib's UDP fallback applies. */
function isRefused(err) {
  const { code, message } = describeError(err);
  return code === 'ECONNREFUSED' || /ECONNREFUSED|refused/i.test(message || '');
}

/**
 * Clear a half-open TCP transport so `zk.createSocket()` really starts over.
 * node-zklib leaves `zklibTcp.socket` set after a failed connect, which would
 * otherwise make the wrapper believe it is already connected.
 */
function resetTcpTransport(zk) {
  destroyTransport(zk && zk.zklibTcp, 'tcp');
  if (zk) zk.connectionType = null;
}

/**
 * Always leave the terminal with ZERO open sockets.
 *
 * `zk.disconnect()` routes through the library's `connectionType`, which is only
 * set once a session is established — so a connection that failed DURING the
 * handshake (wrong Comm Key, UNAUTH, a refused command) left the raw TCP socket
 * open on the device. That is a leaked management session: the next attempt
 * then finds the terminal "busy with another client" — us. Hence the explicit
 * transport teardown below.
 */
async function safeDisconnect(zk) {
  try {
    if (zk && typeof zk.disconnect === 'function') await zk.disconnect();
  } catch (_) {
    /* ignore: disconnect failures are harmless — teardown below is the guarantee */
  }
  destroyTransport(zk && zk.zklibTcp, 'tcp');
  destroyTransport(zk && zk.zklibUdp, 'udp');
}

/** Force one node-zklib transport closed, whatever state it is in. */
function destroyTransport(transport, kind) {
  if (!transport) return;
  const socket = transport.socket;
  transport.socket = null;
  if (!socket) return;
  try {
    if (typeof socket.removeAllListeners === 'function') socket.removeAllListeners();
    if (typeof socket.destroy === 'function') socket.destroy();
    else if (typeof socket.close === 'function') socket.close(); // dgram (UDP)
    else if (typeof socket.end === 'function') socket.end();
  } catch (_) {
    /* nothing else to try — the device will drop an idle session itself */
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
  DeviceBusyError,
  describeError,
  classifyNetworkError,
  sessionFaultHint,
  isRefused,
  resetTcpTransport,
  safeDisconnect,
  destroyTransport,
};
