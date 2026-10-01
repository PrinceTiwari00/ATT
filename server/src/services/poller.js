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
const { recomputeDate } = require('./processor');
const { todayStr } = require('../zk/deviceContract');

let timer = null;

async function syncOnce(trigger = 'poll') {
  const manager = getManager();
  if (manager.busy) {
    return { ok: false, skipped: true, reason: 'sync already in progress' };
  }
  manager.busy = true;
  const started = Date.now();

  try {
    const records = await manager.getAttendance();
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

    if (config.poll.alwaysReprocessToday) affectedDates.add(todayStr());
    let processedTeachers = 0;
    for (const dateStr of affectedDates) {
      processedTeachers = recomputeDate(dateStr);
    }

    const result = {
      ok: true,
      trigger,
      fetched: records.length,
      inserted,
      daysRecomputed: affectedDates.size,
      unknownDeviceIds: [...unknownIds],
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    };
    manager.lastSyncAt = result.at;
    manager.lastSyncResult = result;
    return result;
  } catch (err) {
    const result = {
      ok: false,
      trigger,
      error: err.message,
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

function startPoller() {
  if (!config.poll.enabled) {
    console.log('[poller] disabled via POLL_ENABLED=false');
    return;
  }
  const intervalMs = Math.max(10, config.poll.intervalMinutes) * 60 * 1000;
  console.log(`[poller] started — pulling attendance every ${config.poll.intervalMinutes} min`);
  // immediate first pull, then fixed interval (unref so it never blocks exit)
  syncOnce('boot').catch(() => {});
  timer = setInterval(() => syncOnce('poll').catch(() => {}), intervalMs);
  timer.unref();
}

function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startPoller, stopPoller, syncOnce };
