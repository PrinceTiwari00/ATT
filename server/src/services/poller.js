/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  BACKGROUND LOG POLLER  (spec § B.2)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Every N minutes (config.poll.intervalMinutes):
 *    1. ask the device for its attendance memory (raw punches)
 *    2. INSERT OR IGNORE them into attendance_logs (unique key makes re-polls
 *       idempotent — overlapping fetches can never duplicate a punch)
 *    3. recompute the daily summaries for every affected (teacher, date)
 *
 *  Unmatched device IDs are still stored (teacher_id = NULL) so admins can
 *  discover & enroll stragglers from the Device page.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const config = require('../config');
const { getDb, tx } = require('../db/connection');
const { getManager } = require('../zk/manager');
const { recomputeDate, adoptOrphanPunches } = require('./processor');
const { todayStr } = require('../zk/deviceContract');
const { isBusyError } = require('../zk/deviceLock');

let timer = null;

/** "Not now" answers — a skipped sync is normal, not a failure. */
function skipped(trigger, reason, extra = {}) {
  return { ok: false, skipped: true, busy: true, trigger, reason, at: new Date().toISOString(), ...extra };
}

/**
 * Pull the device log once.
 *
 * Two guards, because the terminal serves ONE session:
 *   • `manager.busy`  — another SYNC is already running (poller re-entrancy).
 *   • `manager.isBusy()` — anything else owns the device right now (a manual
 *     test, a device-user fetch, a push-all, a Comm Key change, a LAN probe).
 * Either way this tick is skipped and the next one tries again; the poller
 * never queues behind a long operation and never opens a second socket.
 */
async function syncOnce(trigger = 'poll') {
  const manager = getManager();
  if (manager.busy) {
    return skipped(trigger, 'sync already in progress');
  }
  if (manager.isBusy()) {
    const lock = manager.lock.status();
    return skipped(trigger, `terminal is busy — ${manager.busyReason()}`, { owner: lock.owner });
  }
  manager.busy = true;
  const started = Date.now();

  try {
    const records = await manager.getAttendance({ origin: `poller:${trigger}` });
    const db = getDb();

    const teacherByZk = new Map(
      db.prepare('SELECT id, zk_user_id FROM teachers').all().map((t) => [t.zk_user_id, t.id])
    );
    const findTeacher = db.prepare('SELECT id FROM teachers WHERE zk_user_id = ?');
    const insertLog = db.prepare(
      `INSERT OR IGNORE INTO attendance_logs
         (teacher_id, zk_user_id, device_sn, punch_time, punch_type, source)
       VALUES (?, ?, ?, ?, ?, 'device')`
    );

    let inserted = 0;
    const affectedDates = new Set();
    const unknownIds = new Set();

    tx(() => {
      for (const rec of records) {
        const zkId = String(rec.userId);
        let teacherId = teacherByZk.get(zkId);
        if (teacherId === undefined) {
          const row = findTeacher.get(zkId);
          teacherId = row ? row.id : null;
          if (row) teacherByZk.set(zkId, row.id);
        }
        if (teacherId === null) unknownIds.add(zkId);

        const res = insertLog.run(
          teacherId,
          zkId,
          rec.deviceSn || null,
          rec.timestamp,
          rec.punchType ?? 0
        );
        if (res.changes > 0) {
          inserted++;
          affectedDates.add(rec.timestamp.slice(0, 10));
        }
      }
    });

    // Rows the previous polls stored before their teacher profile existed are
    // adopted here, so the days they touch are rebuilt in this same pass. (A
    // fresh install that synced first and registered staff second would
    // otherwise leave that history showing "absent" forever.)
    const adopted = adoptOrphanPunches();
    for (const day of adopted.dates) affectedDates.add(day);

    if (config.poll.alwaysReprocessToday) affectedDates.add(todayStr());
    for (const dateStr of affectedDates) recomputeDate(dateStr);

    const result = {
      ok: true,
      trigger,
      fetched: records.length,
      inserted,
      adoptedPunches: adopted.linked,
      daysRecomputed: affectedDates.size,
      unknownDeviceIds: [...unknownIds],
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    };
    manager.lastSyncAt = result.at;
    manager.lastSyncResult = result;
    return result;
  } catch (err) {
    // Somebody claimed the terminal between the check above and the acquire
    // (a manual sync, the wizard, a Comm Key change). Report it as a skip, not
    // as a device fault — and never let it feed the circuit breaker.
    if (isBusyError(err)) {
      const result = skipped(trigger, err.message, { durationMs: Date.now() - started });
      manager.lastSyncAt = result.at;
      manager.lastSyncResult = result;
      console.warn(`[poller] ${trigger} skipped — ${err.message}`);
      return result;
    }
    const result = {
      ok: false,
      trigger,
      error: err.message,
      hint: err.hint || null,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    };
    manager.lastSyncAt = result.at;
    manager.lastSyncResult = result;
    console.error(`[poller] sync failed: ${err.message}`);
    return result;
  } finally {
    manager.busy = false;
  }
}

let startedAt = null;
let ticks = 0;

function startPoller({ immediate = true } = {}) {
  if (!config.poll.enabled) {
    console.log('[poller] disabled via POLL_ENABLED=false');
    return { running: false, reason: 'disabled' };
  }
  if (timer) clearInterval(timer);
  const intervalMs = Math.max(10, config.poll.intervalMinutes) * 60 * 1000;
  console.log(`[poller] started — pulling attendance every ${config.poll.intervalMinutes} min`);
  startedAt = new Date().toISOString();
  // immediate first pull, then fixed interval (unref so it never blocks exit)
  if (immediate) syncOnce('boot').catch(() => {});
  timer = setInterval(() => {
    ticks++;
    syncOnce('poll').catch(() => {});
  }, intervalMs);
  timer.unref();
  return { running: true, intervalMs };
}

function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Re-read config.poll and restart the timer (used after a settings change). */
function restartPoller() {
  stopPoller();
  return startPoller({ immediate: config.poll.enabled });
}

function getPollerState() {
  return {
    running: Boolean(timer),
    enabled: config.poll.enabled,
    intervalMinutes: config.poll.intervalMinutes,
    startedAt,
    ticks,
  };
}

module.exports = { startPoller, stopPoller, restartPoller, getPollerState, syncOnce };
