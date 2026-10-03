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
    this.device =
      config.zk.mode === 'real'
        ? new RealZKDevice(config.zk)
        : config.zk.mode === 'bridge'
          ? new BridgeZKDevice(config.zk)
          : new MockZKDevice(config.zk, rosterProvider);

    this.consecutiveFailures = 0;
    this.circuit = 'closed'; // closed | open | half-open
    this.openedAt = null;
    this.nextAttemptAt = 0;

    this.lastSyncAt = null;
    this.lastSyncResult = null; // { ok, fetched, inserted, processedDays, durationMs, error? }
    this.lastError = null;
    this.busy = false; // poller re-entrancy guard
  }

  get mode() {
    return this.device.mode;
  }

  /** Wrap a device operation with retry + circuit-breaker bookkeeping. */
  async call(opName, fn, { retries = config.retry.attempts } = {}) {
    this.assertCircuit();

    let attempt = 0;
    let lastErr = null;
    while (attempt < retries) {
      attempt++;
      try {
        const result = await fn(this.device);
        this.onSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof ZKConnectionError) || attempt >= retries) break;
        const delay = config.retry.baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        console.warn(`[zk] ${opName} failed (attempt ${attempt}/${retries}): ${err.message} — retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
    this.onFailure(opName, lastErr);
    throw lastErr;
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
    const retryable = err instanceof ZKConnectionError;
    this.consecutiveFailures = retryable ? this.consecutiveFailures + 1 : this.consecutiveFailures;
    this.lastError = { op: opName, message: err.message, at: new Date().toISOString() };
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

  async testConnection() {
    try {
      const res = await this.call(
        'testConnection',
        async (d) => {
          const result = await d.testConnection();
          if (result && result.ok === false && result.retryable) {
            throw new ZKConnectionError(result.error);
          }
          return result;
        },
        { retries: 2 }
      );
      return res;
    } catch (err) {
      return {
        ok: false, mode: this.mode, ip: config.zk.ip, port: config.zk.port,
        error: err.message, circuit: this.circuit,
      };
    }
  }

  async getUsers() {
    return this.call('getUsers', (d) => d.getUsers());
  }

  async getAttendance() {
    return this.call('getAttendance', (d) => d.getAttendance());
  }

  async setUser(payload) {
    return this.call(`setUser(${payload.userId})`, (d) => d.setUser(payload));
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
      bridge: this.mode === 'bridge' ? getAgentStatus() : null,
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

module.exports = { initManager, getManager, ZKManager, ZKDeviceError };
