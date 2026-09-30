/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PRODUCTION ZKTECO CONNECTION  (spec § B.1 / deliverable #2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Talks to a ZKTeco terminal over TCP/IP (default 192.168.1.201:4370) using
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
 *
 *  ADMS note: for push-mode (device → server over internet), run the ADMS
 *  receiver (docs/ARCHITECTURE.md § ADMS) instead of this polling client.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const {
  ZKConnectionError,
  ZKDeviceError,
  parseDeviceTime,
} = require('./deviceContract');

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

function classifyNetworkError(err, ip, port) {
  const msg = String((err && err.message) || err || 'unknown');
  const retryableCodes = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|socket|timeout|timed out/i;
  if (retryableCodes.test(msg) || retryableCodes.test(String(err && err.code))) {
    return new ZKConnectionError(`Cannot reach ZKTeco device at ${ip}:${port} — ${msg}`, err);
  }
  return new ZKDeviceError(`ZKTeco protocol error at ${ip}:${port} — ${msg}`, err);
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
    try {
      await withTimeout(
        zk.createSocket(),
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
    const res = await this.withConnection(async (zk) => {
      const raw = await zk.getUsers();
      return raw && Array.isArray(raw.data) ? raw.data : raw || [];
    }, 'getUsers');

    return res.map((u) => ({
      userId: firstDefined(u.userid, u.user_id, u.userId, u.uid, u.userSn, u.sn),
      name: firstDefined(u.name, u.fullname, u.userName) || '',
      role: u.role,
      cardno: firstDefined(u.cardno, u.card),
    }));
  }

  /**
   * Pull the raw attendance log. NON-destructive read (we never call
   * clearAttendance automatically — logs stay on the terminal until the
   * school chooses to wipe them from its own UI).
   */
  async getAttendance() {
    const logs = await this.withConnection(async (zk) => {
      const raw = await zk.getAttendance();
      return raw && Array.isArray(raw.data) ? raw.data : raw || [];
    }, 'getAttendance');

    const out = [];
    for (const r of logs) {
      const timestamp = parseDeviceTime(
        firstDefined(r.record_time, r.recordTime, r.timestamp, r.time, r.verifyTime)
      );
      const userId = firstDefined(
        r.user_id, r.userId, r.device_user_id, r.deviceUserId, r.userSn, r.userSN, r.sn, r.uid
      );
      if (!timestamp || userId == null) continue; // corrupt row — skip, keep pulling
      out.push({
        userId: String(userId),
        timestamp,
        punchType: Number(firstDefined(r.type, r.punch, r.state, 0)),
        deviceSn: firstDefined(r.sn_device, r.deviceSn, r.terminalSn),
      });
    }
    return out;
  }

  /**
   * Enroll / update a user on the device. node-zklib signature:
   *   setUser(uid, userid, name, password, role, cardno)
   * `uid` is the record index; `userid` is the printable Enrollment ID that
   * maps to teachers.zk_user_id. Adjust to your firmware if it differs.
   */
  async setUser({ userId, name, uid, role = 0, password = '', cardno = 0 }) {
    const numericUid = uid != null ? uid : stableNumericUid(String(userId));
    await this.withConnection(
      async (zk) => zk.setUser(numericUid, String(userId), name || String(userId), password, role, cardno),
      `setUser ${userId}`
    );
    return { ok: true };
  }

  /** Danger: wipes the terminal attendance memory. Call only manually. */
  async clearAttendance() {
    await this.withConnection(async (zk) => {
      if (typeof zk.clearAttendanceLog === 'function') return zk.clearAttendanceLog();
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

module.exports = { RealZKDevice };
