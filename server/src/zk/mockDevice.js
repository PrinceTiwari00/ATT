/**
 * ZKTeco hardware SIMULATOR.
 *
 * Implements the exact same contract as RealZKDevice so the full pipeline
 * (poller → raw logs → processing engine → dashboard) can run without a
 * physical terminal — essential for development, CI, and demos.
 *
 * Fidelity notes:
 *   • Punches are DETERMINISTIC per (user, date) via a seeded PRNG, so every
 *     poll returns a stable history and today's log "grows" as time passes —
 *     exactly like a real terminal recording a live school day.
 *   • Network latency and configurable connection drops are simulated so the
 *     retry/circuit-breaker code paths are exercised.
 *   • setUser()/getUsers() mimic the enroll/fetch workflow for teacher sync.
 */
const {
  ZKConnectionError,
  ZKDeviceError,
  toLocalISO,
  todayStr,
} = require('./deviceContract');
const { toMinutes } = require('../utils/attendanceLogic');

/* ── deterministic PRNG (mulberry32) ─────────────────────────────────────── */
function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The one source of truth for synthetic punches — also used by the seeder to
 * backfill history. Returns [{ userId, timestamp, punchType }] sorted.
 *
 * Distribution (per teacher/day, seeded so it's stable):
 *   ~4% absent • check-in mostly around start (on-time), ~20% late (+11..+55m)
 *   ~15% early departures (−8..−60m) • ~8% stray mid-day punch
 */
function generateDayPunches({ userId, dateStr, shiftStart, shiftEnd, upTo = null }) {
  const rng = mulberry32(hashString(`${userId}::${dateStr}`));
  const startMin = toMinutes(shiftStart);
  const endMin = toMinutes(shiftEnd);

  const oral = rng(); // day archetype
  if (oral < 0.04) return []; // absent day

  const punches = [];
  const at = (absMin, jitterSec = 0) => {
    const m = ((Math.round(absMin) % 1440) + 1440) % 1440;
    const sec = Math.floor(rng() * 60) + jitterSec;
    return `${dateStr}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  };

  // check-in
  const r = rng();
  let ciOffset;
  if (r < 0.55) ciOffset = -14 + rng() * 22;          // early→right-on-time
  else if (r < 0.8) ciOffset = 1 + rng() * 9;         // inside grace
  else ciOffset = 11 + rng() * 44;                     // LATE (+11..+55)
  const checkIn = at(startMin + ciOffset);
  if (upTo && checkIn > upTo) return punches; // hasn't punched yet today
  punches.push({ userId, timestamp: checkIn, punchType: 0 });

  // occasional stray mid-day punch (lunch / gate scan)
  if (rng() < 0.08) {
    const mid = at((startMin + endMin) / 2 + (rng() * 60 - 30));
    if (!upTo || mid <= upTo)
      punches.push({ userId, timestamp: mid, punchType: rng() < 0.5 ? 0 : 4 });
  }

  // check-out
  const r2 = rng();
  let coOffset;
  if (r2 < 0.85) coOffset = rng() * 35;               // on-time / staying late
  else coOffset = -(8 + rng() * 52);                  // EARLY (−8..−60)
  const checkOut = at(endMin + coOffset);
  if (!upTo || checkOut <= upTo)
    punches.push({ userId, timestamp: checkOut, punchType: 1 });

  punches.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return punches;
}

/* ── the simulated terminal's own Comm Key ───────────────────────────────────
 * Module-level on purpose: it survives an adapter rebuild (which is what
 * manager.reconfigure() does when settings change), exactly like the key stored
 * in a real terminal survives a client restart. That is what makes the
 * "ATT has a key the device does not" failure reproducible without hardware.
 */
let SIM_DEVICE_COMM_KEY = 0;

/** Test/dev hook: what the simulated terminal currently demands. */
function setSimulatedCommKey(key) {
  SIM_DEVICE_COMM_KEY = Number(key) || 0;
  return SIM_DEVICE_COMM_KEY;
}

class MockZKDevice {
  constructor(cfg, rosterProvider) {
    this.ip = cfg.ip;
    this.port = cfg.port;
    this.mode = 'mock';
    this.failureRate = cfg.mockFailureRate || 0;
    this.dayMode = cfg.mockDayMode || 'complete';
    this.getRoster = rosterProvider; // () => [{zk_user_id, full_name, shift:{start_time,end_time}}]
    this.enrolled = new Map(); // userId -> name (device-side memory)
    this.sn = 'SIMZKTECO0001';
    this.commKey = Number(cfg.commKey) || 0;
  }

  async simulateNetwork() {
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 380));
    // Comm Key mismatch behaves like the real thing: the socket is accepted and
    // every command is refused.
    if (SIM_DEVICE_COMM_KEY !== this.commKey) {
      throw new ZKDeviceError(
        SIM_DEVICE_COMM_KEY
          ? `The simulated terminal requires Comm Key ${SIM_DEVICE_COMM_KEY} but ATT is using ${this.commKey}. ` +
            'Save the same key in ATT (Device & Sync → Comm Key) or reset the simulated device key to 0.'
          : `The simulated terminal has Comm Key 0 but ATT is sending ${this.commKey}. ` +
            'Clear the key in ATT (Device & Sync → Comm Key → 0) or write it to the device.'
      );
    }
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      throw new ZKConnectionError(`Simulated drop to ${this.ip}:${this.port} (ETIMEDOUT)`);
    }
  }

  /** What the simulated terminal says its Comm Key is. */
  async readCommKey(_opts = {}) {
    await this.simulateNetwork();
    return {
      supported: true,
      name: 'COMKey',
      value: String(SIM_DEVICE_COMM_KEY),
      deviceValue: String(SIM_DEVICE_COMM_KEY),
      configuredKey: this.commKey,
      matches: SIM_DEVICE_COMM_KEY === this.commKey,
      simulated: true,
      tried: [],
    };
  }

  /** Change the simulated terminal's Comm Key (menu → COMM → Comm Key). */
  async writeCommKey(key, _opts = {}) {
    await this.simulateNetwork();
    SIM_DEVICE_COMM_KEY = Number(key) || 0;
    return { ok: true, name: 'COMKey', simulated: true, deviceValue: String(SIM_DEVICE_COMM_KEY) };
  }

  async testConnection(_opts = {}) {
    try {
      await this.simulateNetwork();
      const roster = this.getRoster();
      return {
        ok: true,
        mode: this.mode,
        ip: this.ip,
        port: this.port,
        device: {
          serialNumber: this.sn,
          firmware: 'Ver 6.60 (simulation)',
          platform: 'ZEM800',
          deviceName: 'ZKTeco iClock (SIM)',
          userCount: this.enrolled.size || roster.length,
        },
        commKey: {
          configured: this.commKey,
          required: SIM_DEVICE_COMM_KEY !== 0,
          authenticated: SIM_DEVICE_COMM_KEY === this.commKey,
        },
      };
    } catch (err) {
      return { ok: false, mode: this.mode, ip: this.ip, port: this.port, error: err.message, retryable: true };
    }
  }

  /** Live device memory = DB roster, plus anyone pushed via setUser(). */
  async getUsers(_opts = {}) {
    await this.simulateNetwork();
    const roster = this.getRoster();
    for (const t of roster) if (!this.enrolled.has(t.zk_user_id)) this.enrolled.set(t.zk_user_id, t.full_name);
    return [...this.enrolled.entries()].map(([userId, name], i) => ({
      userId, name, role: 0, cardno: 0, uid: i + 1,
    }));
  }

  /**
   * Attendance visible "so far today": returns today's punches with
   * timestamp ≤ now — every poll may surface new punches, like real hardware.
   */
  async getAttendance(_opts = {}) {
    await this.simulateNetwork();
    const now = toLocalISO(new Date());
    const today = todayStr();
    // 'live'  → reveal punches strictly up to now (device-like realtime)
    // 'complete' → the full simulated day is visible (demo-friendly default)
    const upTo = this.dayMode === 'live' ? now : null;
    const out = [];
    for (const t of this.getRoster()) {
      if (!t.shift) continue;
      out.push(
        ...generateDayPunches({
          userId: t.zk_user_id,
          dateStr: today,
          shiftStart: t.shift.start_time,
          shiftEnd: t.shift.end_time,
          upTo,
        })
      );
    }
    return out.map((p) => ({ ...p, deviceSn: this.sn }));
  }

  async setUser({ userId, name }, _opts = {}) {
    await this.simulateNetwork();
    this.enrolled.set(String(userId), name || String(userId));
    return { ok: true };
  }

  /** Capabilities of the simulator — everything works. */
  capabilities() {
    return {
      source: 'mock',
      library: null,
      libraryVersion: null,
      installed: true,
      canFetchAttendance: true,
      canFetchUsers: true,
      canClearAttendance: true,
      canWriteUsers: true,
      availableMethods: [],
    };
  }

  async clearAttendance() {
    await this.simulateNetwork();
    return { ok: true, note: 'simulation keeps generated history' };
  }
}

module.exports = { MockZKDevice, generateDayPunches, setSimulatedCommKey, getSimulatedCommKey: () => SIM_DEVICE_COMM_KEY };
