/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  DEVICE SESSION LOCK — one ZKTeco session at a time, process-wide
 * ─────────────────────────────────────────────────────────────────────────────
 *  A ZKTeco terminal serves a SINGLE management session. When two ATT code
 *  paths open a socket at the same moment — the background poller while an
 *  admin clicks "Fetch logs now", or a LAN sweep identifying hosts during a
 *  sync — the terminal drops one of them and both sides see
 *
 *      TIMEOUT_ON_WRITING_MESSAGE            (device never answered CMD_CONNECT)
 *      ECONNRESET / "Another device is
 *      connecting to the device so the
 *      connection is interrupted"            (the session was stolen)
 *
 *  i.e. ATT collides with ITSELF and then blames the network.
 *
 *  This module is the fix: a FIFO mutex that every path to the hardware must
 *  pass through. Rules:
 *
 *   • ONE holder at a time. Everyone else either waits (queue mode) or gets an
 *     immediate DeviceBusyError (reject mode, the default — an operation that
 *     cannot run must say so, not pile up behind a 30 s sync).
 *   • Re-entrant BY TICKET: a caller that already holds the lock (a batch such
 *     as "push all teachers", or the manager wrapping a retried operation)
 *     hands its ticket down, so nested device calls never deadlock on
 *     themselves. No hidden async-context magic — the ticket is explicit.
 *   • STALE-HOLDER WATCHDOG: a wedged operation is force-released after
 *     `staleMs` so one hung socket can never brick device access permanently.
 *   • COOL-DOWN GAP: after a session closes the lock stays shut for `gapMs`,
 *     giving the terminal time to release the socket before the next connect.
 *     Back-to-back sessions are the second most common ECONNRESET source.
 *   • A busy device is NOT a broken device: DeviceBusyError is non-retryable
 *     and is never counted by the circuit breaker (see zk/manager.js).
 *
 *  The lock lives at the ADAPTER level (RealZKDevice.withConnection) so it
 *  protects every caller — the manager, `probeDevice()`, the LAN discovery
 *  sweep, and the standalone LAN bridge agent, which builds its own adapter.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Thrown when the terminal is already in use by another ATT operation. */
class DeviceBusyError extends Error {
  constructor({ label = 'operation', owner = null, waiting = 0, waitedMs = 0, cooldownMs = 0 } = {}) {
    const who = owner
      ? `"${owner.label}" has held the device for ${(owner.heldMs / 1000).toFixed(1)}s`
      : cooldownMs > 0
        ? `the previous session is still closing (${cooldownMs}ms cool-down left)`
        : 'another operation holds the device';
    super(
      `The ZKTeco terminal is busy — ${who}. ` +
        `ATT allows only one device session at a time so "${label}" was refused` +
        (waitedMs > 0 ? ` after waiting ${waitedMs}ms` : ' immediately') +
        (waiting > 0 ? ` (${waiting} other request${waiting === 1 ? '' : 's'} waiting)` : '') +
        '. Nothing is wrong with the device: try again in a few seconds.'
    );
    this.name = 'DeviceBusyError';
    this.code = 'DEVICE_BUSY';
    this.status = 409;
    this.retryable = false; // must never feed the circuit breaker
    this.busy = true;
    this.owner = owner;
    this.waiting = waiting;
    this.waitedMs = waitedMs;
    this.cooldownMs = cooldownMs;
  }
}

/** True for anything that means "the device is in use by us right now". */
function isBusyError(err) {
  return Boolean(err) && (err.code === 'DEVICE_BUSY' || err.name === 'DeviceBusyError');
}

let ticketSeq = 0;

class DeviceLock {
  /**
   * @param {{name?:string, staleMs?:number, gapMs?:number, logger?:{log:Function,warn:Function,error:Function}, now?:() => number}} [opts]
   */
  constructor({ name = 'zk-device', staleMs = 120_000, gapMs = 0, logger = console, now = () => Date.now() } = {}) {
    this.name = name;
    this.staleMs = Math.max(1000, Number(staleMs) || 120_000);
    this.gapMs = Math.max(0, Number(gapMs) || 0);
    this.logger = logger || console;
    this.now = now;

    /** @type {null | {id:number,label:string,origin:string|null,acquiredAt:number,expiresAt:number,released:boolean,forced:boolean,staleTimer:any}} */
    this.holder = null;
    /** FIFO of {label, origin, enqueuedAt, timer, resolve, reject} */
    this.queue = [];
    /** Inter-session cool-down: no grants before this timestamp. */
    this.cooldownUntil = 0;
    /** At most one pending "re-check the queue when the cool-down ends" timer. */
    this.pumpTimer = null;

    this.stats = {
      acquired: 0,
      rejected: 0,
      timedOut: 0,
      forcedReleases: 0,
      longestHoldMs: 0,
      totalHoldMs: 0,
      totalWaitMs: 0,
    };
    /** Ring buffer of the last few sessions — what the UI shows as "recent device use". */
    this.history = [];
  }

  get locked() {
    return Boolean(this.holder);
  }

  get waitingCount() {
    return this.queue.length;
  }

  /** Is `ticket` the live holder? (re-entrancy check for nested calls) */
  owns(ticket) {
    return Boolean(ticket) && this.holder === ticket && !ticket.released;
  }

  /**
   * Take the device.
   *
   * @param {string} label        what this session is doing (shown to the user)
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] 0 = refuse immediately when busy (default),
   *                                  >0 = wait this long first
   * @param {string} [opts.origin]    who asked (poller / route / agent …)
   * @param {object} [opts.ticket]    an already-held ticket → re-entrant pass-through
   * @returns {Promise<object>} the ticket; release it with release(ticket)
   */
  async acquire(label, { timeoutMs = 0, origin = null, ticket = null } = {}) {
    const name = String(label || 'operation');
    if (ticket && this.owns(ticket)) return ticket; // nested call inside a batch

    if (!this.holder && this.now() >= this.cooldownUntil && this.queue.length === 0) {
      return this.grant(name, origin);
    }

    const wait = Math.max(0, Number(timeoutMs) || 0);
    if (wait <= 0) {
      this.stats.rejected++;
      throw new DeviceBusyError({
        label: name,
        owner: this.ownerSnapshot(),
        waiting: this.queue.length,
        cooldownMs: Math.max(0, this.cooldownUntil - this.now()),
      });
    }

    const enqueuedAt = this.now();
    return new Promise((resolve, reject) => {
      const waiter = { label: name, origin, enqueuedAt, timer: null, resolve, reject, settled: false };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        // Last chance before refusing: on a loaded machine the cool-down pump
        // can itself be delayed past the wait budget, and telling a caller the
        // terminal is busy when it is in fact free would be plain wrong.
        this.pump();
        if (waiter.settled) return;
        waiter.settled = true;
        this.queue = this.queue.filter((w) => w !== waiter);
        this.stats.timedOut++;
        reject(
          new DeviceBusyError({
            label: name,
            owner: this.ownerSnapshot(),
            waiting: this.queue.length,
            waitedMs: this.now() - enqueuedAt,
            cooldownMs: Math.max(0, this.cooldownUntil - this.now()),
          })
        );
      }, wait);
      // Deliberately NOT unref'd: a request waiting for the terminal is live
      // work, and the process must stay up until it is granted or refused.
      // (The watchdog and cool-down timers below ARE unref'd — they are
      // background safety nets and must never hold the server open.)
      this.queue.push(waiter);
      this.pump(); // a cool-down may already be over
    });
  }

  /** Give the device up. Safe to call twice and safe after a forced release. */
  release(ticket) {
    if (!ticket || ticket.released) return false;
    if (this.holder !== ticket) {
      // Stale-release already happened, or the ticket belongs to another lock.
      ticket.released = true;
      return false;
    }
    const heldMs = this.now() - ticket.acquiredAt;
    ticket.released = true;
    clearTimeout(ticket.staleTimer);
    this.holder = null;
    this.record(ticket, heldMs, 'released');
    // Let the terminal finish closing the socket before anybody reconnects.
    this.cooldownUntil = this.now() + this.gapMs;
    this.schedulePump(this.gapMs);
    this.pump();
    return true;
  }

  /**
   * Re-check the queue once a cool-down expires. Without this a waiter queued
   * during the gap would sit there until somebody else happened to call pump().
   */
  schedulePump(delayMs) {
    const delay = Number(delayMs) > 0 ? Math.ceil(delayMs) : 0;
    if (delay <= 0) {
      this.pump();
      return;
    }
    if (this.pumpTimer) return; // one pending re-check is enough
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, delay);
    // Unref only when nobody is queued: an idle cool-down must never hold the
    // process open, but a waiter is live work and must be served.
    if (!this.queue.length && typeof this.pumpTimer.unref === 'function') this.pumpTimer.unref();
  }

  /** acquire → fn(ticket) → release. The form every adapter call uses. */
  async runExclusive(label, fn, opts = {}) {
    // A caller that already holds the lock (a batch, or the manager wrapping a
    // retried operation) passes its ticket down; we must not release it here —
    // that belongs to the outermost holder.
    const reentrant = Boolean(opts.ticket) && this.owns(opts.ticket);
    const ticket = await this.acquire(label, opts);
    try {
      return await fn(ticket);
    } finally {
      if (!reentrant) this.release(ticket);
    }
  }

  /** Force the lock open — used by the watchdog and by tests. */
  forceRelease(reason = 'stale holder') {
    const ticket = this.holder;
    if (!ticket) return false;
    const heldMs = this.now() - ticket.acquiredAt;
    ticket.released = true;
    ticket.forced = true;
    clearTimeout(ticket.staleTimer);
    this.holder = null;
    this.stats.forcedReleases++;
    this.record(ticket, heldMs, 'forced');
    this.logger.error(
      `[${this.name}] lock FORCE-RELEASED: "${ticket.label}" held the device for ` +
        `${(heldMs / 1000).toFixed(1)}s (> ${this.staleMs}ms) — ${reason}. ` +
        'A device operation outlived its timeout; the terminal may still be closing that session.'
    );
    // The wedged socket may still be open on the device: keep the cool-down,
    // and make sure the queue is re-checked when it ends.
    const cooldown = Math.max(this.gapMs, 1000);
    this.cooldownUntil = this.now() + cooldown;
    this.schedulePump(cooldown);
    this.pump();
    return true;
  }

  /** Drop every waiter (shutdown / reconfigure). They get a DeviceBusyError. */
  abortWaiters(reason = 'device link reconfigured') {
    const waiters = this.queue;
    this.queue = [];
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    for (const w of waiters) {
      if (w.settled) continue;
      w.settled = true;
      clearTimeout(w.timer);
      w.reject(new DeviceBusyError({ label: w.label, owner: this.ownerSnapshot(), waiting: 0 }));
    }
    return waiters.length;
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  grant(label, origin) {
    const at = this.now();
    const ticket = {
      id: ++ticketSeq,
      label,
      origin: origin || null,
      acquiredAt: at,
      expiresAt: at + this.staleMs,
      released: false,
      forced: false,
      staleTimer: null,
    };
    ticket.staleTimer = setTimeout(() => {
      if (this.holder === ticket && !ticket.released) this.forceRelease('stale holder watchdog');
    }, this.staleMs);
    if (typeof ticket.staleTimer.unref === 'function') ticket.staleTimer.unref();

    this.holder = ticket;
    this.stats.acquired++;
    return ticket;
  }

  /** Hand the lock to the next waiter as soon as it is free and cooled down. */
  pump() {
    if (this.holder) return;
    if (this.now() < this.cooldownUntil) {
      // Re-arm for exactly the time still left. This matters: `cooldownUntil`
      // comes from Date.now() while timers run on a monotonic clock, so a pump
      // can fire a hair early — and a queue with nobody left to re-check it
      // strands a waiter until it times out, on an actually-free terminal.
      if (this.queue.length) this.schedulePump(this.cooldownUntil - this.now());
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    if (next.settled) return this.pump();
    next.settled = true;
    clearTimeout(next.timer);
    this.stats.totalWaitMs += this.now() - next.enqueuedAt;
    next.resolve(this.grant(next.label, next.origin));
  }

  record(ticket, heldMs, outcome) {
    this.stats.totalHoldMs += heldMs;
    if (heldMs > this.stats.longestHoldMs) this.stats.longestHoldMs = heldMs;
    this.history.push({
      label: ticket.label,
      origin: ticket.origin,
      heldMs,
      outcome,
      at: new Date().toISOString(),
    });
    if (this.history.length > 8) this.history.shift();
  }

  ownerSnapshot() {
    if (!this.holder) return null;
    return {
      label: this.holder.label,
      origin: this.holder.origin,
      since: new Date(this.holder.acquiredAt).toISOString(),
      heldMs: this.now() - this.holder.acquiredAt,
    };
  }

  /** Observable state for /api/device/status and the Device page. */
  status() {
    return {
      locked: this.locked,
      owner: this.ownerSnapshot(),
      waiting: this.queue.map((w) => ({
        label: w.label,
        origin: w.origin,
        waitedMs: this.now() - w.enqueuedAt,
      })),
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - this.now()),
      policy: { staleMs: this.staleMs, gapMs: this.gapMs },
      stats: { ...this.stats },
      history: [...this.history],
    };
  }
}

/* ── process-wide singleton ──────────────────────────────────────────────── */

let shared = null;

/**
 * The one lock every path to the terminal shares. Config is read lazily so
 * tests can set env vars before the first call.
 */
function getDeviceLock() {
  if (shared) return shared;
  // Required lazily: config.js reads settings/env at import time.
  const config = require('../config');
  shared = new DeviceLock({
    name: 'zk-device',
    staleMs: config.zk.lock.staleMs,
    gapMs: config.zk.lock.gapMs,
  });
  return shared;
}

/** Rebuild the singleton (settings changed / tests). */
function resetDeviceLock(next = null) {
  if (shared) {
    shared.abortWaiters('device lock reset');
    shared.forceRelease('device lock reset');
  }
  shared = next;
  return shared;
}

/** Apply new gap/stale values without dropping the current holder. */
function tuneDeviceLock({ staleMs, gapMs } = {}) {
  const lock = getDeviceLock();
  if (Number.isFinite(staleMs)) lock.staleMs = Math.max(1000, staleMs);
  if (Number.isFinite(gapMs)) lock.gapMs = Math.max(0, gapMs);
  return lock;
}

module.exports = { DeviceLock, DeviceBusyError, isBusyError, getDeviceLock, resetDeviceLock, tuneDeviceLock };
