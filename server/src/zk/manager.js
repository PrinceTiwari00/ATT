/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CONNECTION MANAGER  (spec § B.1)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Owns the single device adapter, adds the resilience policy on top:
 *
 *   • Retry with exponential backoff + jitter for retryable network faults
 *   • Circuit breaker — after N consecutive failures the circuit OPENS for a
 *     cool-down period so a dead device can't hammer the network every poll;
 *     it half-opens automatically for a probe attempt.
 *   • Observable state (status(), consumed by /api/device/status) so the UI can
 *     show exactly what the link is doing.
 *   • EXCLUSIVE device access — every operation takes the process-wide session
 *     lock (zk/deviceLock.js) before a socket is opened and holds it across
 *     retries, so the poller, the UI buttons, the LAN sweep and the bridge
 *     agent can never talk over each other. A refused second operation is a
 *     DeviceBusyError: non-retryable, and it never counts against the circuit
 *     breaker, because "ATT is already using the terminal" is not a fault.
 *
 *  The poller and all device routes MUST go through this manager — never
 *  instantiate adapters directly elsewhere.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const config = require('../config');
const { RealZKDevice } = require('./realDevice');
const { MockZKDevice } = require('./mockDevice');
const { BridgeZKDevice } = require('./bridgeDevice');
const { getAgentStatus } = require('../services/deviceBridge');
const { ZKConnectionError, ZKDeviceError } = require('./deviceContract');
const { getDeviceLock, isBusyError, tuneDeviceLock } = require('./deviceLock');
const settings = require('../settings');
const { normalizeCommKey } = require('./commKey');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CircuitOpenError extends Error {
  constructor(nextRetryAt) {
    super(`Circuit breaker open — device marked unreachable. Next probe at ${nextRetryAt}.`);
    this.name = 'CircuitOpenError';
    this.retryable = false;
    this.code = 'CIRCUIT_OPEN';
  }
}

class ZKManager {
  /**
   * @param {() => Array} rosterProvider returns teacher/shift rows for the mock sim
   */
  constructor(rosterProvider) {
    this.rosterProvider = rosterProvider;
    this.device = ZKManager.buildDevice(config.zk, rosterProvider);

    this.consecutiveFailures = 0;
    this.circuit = 'closed'; // closed | open | half-open
    this.openedAt = null;
    this.nextAttemptAt = 0;

    this.lastSyncAt = null;
    this.lastSyncResult = null; // { ok, fetched, inserted, processedDays, durationMs, error? }
    this.lastError = null;
    this.busy = false; // poller re-entrancy guard (a sync is running)
    this.reconfiguredAt = null;
    this.lock = getDeviceLock();
    tuneDeviceLock({ staleMs: config.zk.lock.staleMs, gapMs: config.zk.lock.gapMs });
  }

  /** Is the terminal in use by ATT right now (sync running or lock held)? */
  isBusy() {
    return Boolean(this.busy) || this.lock.locked;
  }

  /** Why it is busy — surfaced verbatim in the UI and in 409 responses. */
  busyReason() {
    const lock = this.lock.status();
    if (this.busy && !lock.locked) return 'an attendance sync is in progress';
    if (lock.owner) {
      return `"${lock.owner.label}" is using the terminal (${(lock.owner.heldMs / 1000).toFixed(1)}s so far)`;
    }
    if (lock.cooldownRemainingMs > 0) {
      return `the terminal is finishing the previous session (${lock.cooldownRemainingMs}ms cool-down)`;
    }
    return 'another device operation is in progress';
  }

  /** Adapter factory — also used by reconfigure() so modes can change at runtime. */
  static buildDevice(zkConfig, rosterProvider) {
    if (zkConfig.mode === 'bridge') return new BridgeZKDevice(zkConfig);
    if (zkConfig.mode === 'mock') return new MockZKDevice(zkConfig, rosterProvider);
    return new RealZKDevice(zkConfig);
  }

  get mode() {
    return this.device.mode;
  }

  /**
   * Swap the device adapter at runtime (the Connect wizard saves a new IP/port
   * or mode). `config.zk` has already been updated in place by
   * config.applySettings(); we only rebuild the adapter and clear breaker state
   * so the new target gets a fair first attempt.
   */
  reconfigure(reason = 'settings') {
    // Swapping the adapter is safe even while a sync is in flight: the running
    // operation already holds a reference to the previous adapter and finishes
    // with it, while every later operation uses the new target.
    const busySyncInFlight = this.busy;
    this.device = ZKManager.buildDevice(config.zk, this.rosterProvider);
    this.consecutiveFailures = 0;
    this.circuit = 'closed';
    this.openedAt = null;
    this.nextAttemptAt = 0;
    this.lastError = null;
    this.reconfiguredAt = new Date().toISOString();
    // Lock timings are settings too; a change must apply without a restart.
    tuneDeviceLock({ staleMs: config.zk.lock.staleMs, gapMs: config.zk.lock.gapMs });
    console.log(
      `[zk] device link reconfigured (${reason}) → ${this.mode} @ ${config.zk.ip}:${config.zk.port}` +
        ` · Comm Key ${config.zk.commKey ? 'set (' + config.zk.commKey + ')' : 'not set (0)'}`
    );
    return {
      ok: true,
      mode: this.mode,
      target: { ip: config.zk.ip, port: config.zk.port },
      busySyncInFlight,
      at: this.reconfiguredAt,
    };
  }

  /**
   * Wrap a device operation with the session lock + retry + circuit-breaker
   * bookkeeping.
   *
   * The lock is taken OUTSIDE the retry loop: a retried connect keeps owning
   * the terminal instead of releasing it and racing the next poller tick into
   * the gap.
   *
   * @param {string} opName
   * @param {(device:object, opts:{ticket:object}) => Promise<any>} fn
   * @param {{retries?:number, lockTimeoutMs?:number, origin?:string, ticket?:object}} [opts]
   */
  async call(opName, fn, { retries = config.retry.attempts, lockTimeoutMs, origin = 'manager', ticket = null } = {}) {
    this.assertCircuit();

    const attemptLoop = async (heldTicket) => {
      let attempt = 0;
      let lastErr = null;
      while (attempt < retries) {
        attempt++;
        try {
          const result = await fn(this.device, { ticket: heldTicket, origin });
          this.onSuccess();
          return result;
        } catch (err) {
          lastErr = err;
          // "Terminal busy" is our own lock talking — retrying would only
          // queue behind ourselves.
          if (isBusyError(err) || !(err instanceof ZKConnectionError) || attempt >= retries) break;
          const delay = config.retry.baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
          console.warn(`[zk] ${opName} failed (attempt ${attempt}/${retries}): ${err.message} — retrying in ${delay}ms`);
          await sleep(delay);
        }
      }
      this.onFailure(opName, lastErr);
      throw lastErr;
    };

    // Already inside a locked batch (push-all, comm-key change): reuse it.
    if (ticket && this.lock.owns(ticket)) return attemptLoop(ticket);

    return this.lock.runExclusive(opName, attemptLoop, {
      timeoutMs: lockTimeoutMs != null ? lockTimeoutMs : config.zk.lock.waitMs,
      origin,
    });
  }

  /**
   * Run a MULTI-STEP device workflow as one exclusive session: nobody else can
   * reach the terminal between the steps. Used by "push all teachers" and by
   * the Comm Key change (read → write → verify → roll back on failure).
   */
  async withLock(label, fn, { timeoutMs, origin = 'manager' } = {}) {
    return this.lock.runExclusive(label, fn, {
      timeoutMs: timeoutMs != null ? timeoutMs : config.zk.lock.waitMs,
      origin,
    });
  }

  assertCircuit() {
    if (this.circuit !== 'open') return;
    const now = Date.now();
    if (now >= this.nextAttemptAt) {
      this.circuit = 'half-open'; // allow one probe through
      return;
    }
    throw new CircuitOpenError(new Date(this.nextAttemptAt).toLocaleTimeString());
  }

  onSuccess() {
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.circuit = 'closed';
  }

  onFailure(opName, err) {
    // A device that ATT is already using is not a failing device.
    if (isBusyError(err)) return;
    const retryable = err instanceof ZKConnectionError;
    this.consecutiveFailures = retryable ? this.consecutiveFailures + 1 : this.consecutiveFailures;
    this.lastError = {
      op: opName,
      message: err.message,
      hint: err.hint || null,
      fault: err.fault || null,
      at: new Date().toISOString(),
    };
    if (retryable && this.consecutiveFailures >= config.retry.breakerThreshold && this.circuit !== 'open') {
      this.circuit = 'open';
      this.openedAt = Date.now();
      this.nextAttemptAt = Date.now() + config.retry.breakerCooldownMs;
      console.error(`[zk] circuit OPEN after ${this.consecutiveFailures} failures — cooling down ${config.retry.breakerCooldownMs}ms`);
    } else if (this.circuit === 'half-open' && retryable) {
      // probe failed again — re-open for another cool-down
      this.circuit = 'open';
      this.nextAttemptAt = Date.now() + config.retry.breakerCooldownMs;
    }
  }

  async testConnection(opts = {}) {
    try {
      const res = await this.call(
        'testConnection',
        async (d, callOpts) => {
          const result = await d.testConnection(callOpts);
          if (result && result.ok === false && result.retryable) {
            throw new ZKConnectionError(result.error);
          }
          return result;
        },
        { retries: 2, ...opts }
      );
      return res;
    } catch (err) {
      return {
        ok: false, mode: this.mode, ip: config.zk.ip, port: config.zk.port,
        error: err.message, hint: err.hint || null, busy: isBusyError(err),
        circuit: this.circuit,
      };
    }
  }

  async getUsers(opts = {}) {
    return this.call('getUsers', (d, callOpts) => d.getUsers(callOpts), opts);
  }

  async getAttendance(opts = {}) {
    return this.call('getAttendance', (d, callOpts) => d.getAttendance(callOpts), opts);
  }

  async setUser(payload, opts = {}) {
    return this.call(`setUser(${payload.userId})`, (d, callOpts) => d.setUser(payload, callOpts), opts);
  }

  /** What ATT knows about the terminal's Comm Key, and whether it matches. */
  commKeyStatus() {
    // Where the value came from, for the UI: the settings file (what the app
    // writes), an environment variable the operator owns, or the 0 default.
    let source = 'default';
    try {
      const stored = settings.readRaw();
      if (stored && stored.device && stored.device.commKey !== undefined) source = 'settings-file';
      else if (process.env.ZK_COMM_KEY !== undefined) source = 'environment';
    } catch (_) { /* status must never throw */ }
    // Two different questions, often confused:
    //   editable — can the ACTIVE ADAPTER read/write a key on the device?
    //   savable  — may the UI store a key in settings on THIS host? (a foreign
    //              ZK_COMM_KEY env var owns the value on cloud/systemd boxes)
    let savable = true;
    try {
      const field = settings.describeSchema().find((f) => f.key === 'device.commKey');
      savable = field ? field.editable !== false : true;
    } catch (_) { /* status must never throw */ }
    return {
      configured: config.zk.commKey,
      set: config.zk.commKey !== 0,
      source,
      editable: typeof this.device.readCommKey === 'function',
      savable,
      mode: this.mode,
    };
  }

  /**
   * What the active adapter can really do. `canWriteUsers === false` means the
   * connected library has no user-enrollment API (node-zklib 1.x) — the UI
   * disables "push to device" and explains the terminal-side workaround instead
   * of failing after the click. `null` = unknown (bridge mode).
   */
  capabilities() {
    const device = this.device;
    if (device && typeof device.capabilities === 'function') {
      try {
        return device.capabilities();
      } catch (err) {
        return { source: this.mode, error: err.message, canWriteUsers: null };
      }
    }
    return { source: this.mode, canWriteUsers: null };
  }

  status() {
    return {
      mode: this.mode,
      target: { ip: config.zk.ip, port: config.zk.port },
      circuit: this.circuit,
      consecutiveFailures: this.consecutiveFailures,
      nextProbeAt: this.circuit === 'open' ? new Date(this.nextAttemptAt).toISOString() : null,
      pollIntervalMinutes: config.poll.intervalMinutes,
      pollerBusy: this.busy,
      // One session at a time: who holds the terminal, who is waiting, and how
      // often ATT had to refuse a second operation.
      busy: this.isBusy(),
      busyReason: this.isBusy() ? this.busyReason() : null,
      deviceLock: this.lock.status(),
      commKey: this.commKeyStatus(),
      reconfiguredAt: this.reconfiguredAt,
      bridge: this.mode === 'bridge' ? getAgentStatus() : null,
      capabilities: this.capabilities(),
      lastSyncAt: this.lastSyncAt,
      lastSyncResult: this.lastSyncResult,
      lastError: this.lastError,
    };
  }
}

let manager = null;

function initManager(rosterProvider) {
  manager = new ZKManager(rosterProvider);
  return manager;
}

function getManager() {
  if (!manager) throw new Error('ZK manager not initialised');
  return manager;
}

/**
 * Handshake with an ARBITRARY terminal without touching the configured link —
 * used by the Connect wizard ("test before you save") and by LAN discovery to
 * confirm that an open :4370 host really is a ZKTeco device.
 */
async function probeDevice({
  ip,
  port = config.zk.port,
  timeoutMs = 4000,
  inPort = config.zk.inPort,
  // Probing another terminal must not queue behind the live one: a LAN sweep
  // identifies dozens of hosts and would otherwise stall the poller.
  lockTimeoutMs = 0,
  commKey = config.zk.commKey,
} = {}) {
  const device = new RealZKDevice({
    ip,
    port,
    timeoutMs,
    inPort,
    commKey,
    lockWaitMs: lockTimeoutMs,
    origin: 'probe',
  });
  const started = Date.now();
  try {
    const result = await device.testConnection();
    return { ...result, probedIp: ip, probedPort: port, durationMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false, mode: 'real', ip, port, error: err.message,
      durationMs: Date.now() - started,
    };
  }
}

module.exports = { initManager, getManager, ZKManager, ZKDeviceError, probeDevice, normalizeCommKey };
