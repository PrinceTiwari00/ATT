/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  LOG PROCESSING ENGINE  (spec § B.3)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Groups each day's raw punches per teacher and materializes ONE row in
 *  processed_attendance: first punch → check-in, last punch → check-out,
 *  late/early metrics, and final status via the pure algorithm in
 *  utils/attendanceLogic.js.
 *
 *  Idempotent & rebuildable: rows are upserted, and recompute*() can rebuild
 *  any date/range from the raw ledger at any time.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { getDb } = require('../db/connection');
const { evaluateDay } = require('../utils/attendanceLogic');
const { todayStr } = require('../zk/deviceContract');
const { todayKey, eachDay } = require('../lib/localDate');
const { readCalendar, isWorkingDate } = require('./calendar');

function getDefaultShift(db) {
  return (
    db.prepare('SELECT * FROM shifts WHERE is_default = 1').get() ||
    db.prepare('SELECT * FROM shifts ORDER BY id LIMIT 1').get() ||
    null
  );
}

function resolveShift(db, teacher) {
  if (teacher.shift_id) {
    const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(teacher.shift_id);
    if (s) return s;
  }
  return getDefaultShift(db);
}

/** Recompute one (teacher, date) — the atomic unit of the engine. */
function recomputeTeacherDate(teacherId, workDate) {
  const db = getDb();
  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);
  if (!teacher) return null;

  const punches = db
    .prepare(
      `SELECT punch_time FROM attendance_logs
       WHERE teacher_id = ? AND substr(punch_time, 1, 10) = ?
       ORDER BY punch_time ASC`
    )
    .all(teacherId, workDate)
    .map((r) => r.punch_time);

  const shift = resolveShift(db, teacher);
  const result = evaluateDay({ punches, shift, workDate });

  db.prepare(
    `INSERT INTO processed_attendance
       (teacher_id, work_date, shift_id, check_in, check_out, punch_count,
        late_minutes, early_minutes, work_minutes, status, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT (teacher_id, work_date) DO UPDATE SET
       shift_id      = excluded.shift_id,
       check_in      = excluded.check_in,
       check_out     = excluded.check_out,
       punch_count   = excluded.punch_count,
       late_minutes  = excluded.late_minutes,
       early_minutes = excluded.early_minutes,
       work_minutes  = excluded.work_minutes,
       status        = excluded.status,
       computed_at   = excluded.computed_at`
  ).run(
    teacherId,
    workDate,
    shift ? shift.id : null,
    result.checkIn,
    result.checkOut,
    result.punchCount,
    result.lateMinutes,
    result.earlyMinutes,
    result.workMinutes,
    result.status
  );
  return result;
}

/**
 * Recompute a full calendar date for ALL active teachers. Teachers without
 * any punch get an 'absent' row — the ledger is therefore complete for every
 * processed date and flips automatically when late punches arrive.
 */
function recomputeDate(workDate) {
  const db = getDb();
  const calendar = readCalendar();
  if (!isWorkingDate(workDate, calendar)) {
    // Holidays and weekends are not absence days. Keep/rebuild genuine punches
    // (for occasional holiday work), but remove materialized zero-punch rows.
    db.prepare('DELETE FROM processed_attendance WHERE work_date = ? AND punch_count = 0').run(workDate);
    const teachers = db
      .prepare(
        `SELECT DISTINCT t.id
         FROM teachers t JOIN attendance_logs l ON l.teacher_id = t.id
         WHERE t.status = 'active' AND substr(l.punch_time, 1, 10) = ?`
      )
      .all(workDate);
    for (const t of teachers) recomputeTeacherDate(t.id, workDate);
    return teachers.length;
  }

  const teachers = db
    .prepare("SELECT id FROM teachers WHERE status = 'active'")
    .all();
  for (const t of teachers) recomputeTeacherDate(t.id, workDate);
  return teachers.length;
}

function recomputeRange(from, to) {
  const days = [];
  for (const key of eachDay(from, to)) {
    if (days.length >= 93) break;
    recomputeDate(key);
    days.push(key);
  }
  return days;
}

/**
 * Link punches that were pulled BEFORE their teacher profile existed.
 *
 * Every punch is stored immediately with its durable `zk_user_id`; `teacher_id`
 * is a derived pointer that can only be filled once a profile with that
 * enrollment ID exists. Without this pass a school that syncs the terminal
 * first and registers staff second keeps `teacher_id = NULL` rows forever — the
 * punches are in the ledger but invisible to the daily engine, so everybody
 * shows up absent for history the device already reported.
 *
 * Only the derived pointer is rewritten (raw rows are never deleted, moved or
 * given a new punch time). Returns the work dates that need recomputing.
 */
function adoptOrphanPunches() {
  const db = getDb();
  const dates = db
    .prepare(
      `SELECT DISTINCT substr(punch_time, 1, 10) AS work_date
       FROM attendance_logs
       WHERE teacher_id IS NULL
         AND EXISTS (SELECT 1 FROM teachers WHERE teachers.zk_user_id = attendance_logs.zk_user_id)`
    )
    .all()
    .map((r) => r.work_date);

  if (dates.length === 0) return { linked: 0, dates: [] };

  const info = db
    .prepare(
      `UPDATE attendance_logs
          SET teacher_id = (SELECT id FROM teachers WHERE teachers.zk_user_id = attendance_logs.zk_user_id)
        WHERE teacher_id IS NULL
          AND EXISTS (SELECT 1 FROM teachers WHERE teachers.zk_user_id = attendance_logs.zk_user_id)`
    )
    .run();

  return { linked: info.changes, dates };
}

/**
 * Adopt orphans and rebuild exactly the days they touch — this is what every
 * roster write (teacher created/edited/imported) and every poll calls so the
 * daily summaries never lag behind the raw ledger.
 */
function adoptAndRecompute({ includeToday = false } = {}) {
  const { linked, dates } = adoptOrphanPunches();
  const today = todayStr();
  const days = new Set(dates.filter((d) => d && d <= today)); // never materialize future days
  if (includeToday) days.add(today);

  const recomputed = [];
  for (const day of days) {
    recomputeDate(day);
    recomputed.push(day);
  }
  return { linked, days: recomputed };
}

/**
 * Lazily ensure dates have been processed before serving a view (covers gap
 * days when the service was down). Only backdates ≤ today.
 */
function ensureProcessed(from, to) {
  const db = getDb();
  const today = todayKey();
  // day keys are zero-padded YYYY-MM-DD, so string order is calendar order
  const end = to < today ? to : today;
  const calendar = readCalendar();
  const activeCount = db.prepare("SELECT COUNT(*) AS c FROM teachers WHERE status = 'active'").get().c;
  let guard = 0;
  for (const s of eachDay(from, end)) {
    // Keep in step with the attendance API's maximum 62-day range (BS months
    // can contain 32 days, so the old 31-day guard was too short for reports).
    if (guard++ >= 62) break;
    if (!isWorkingDate(s, calendar)) {
      const staleAbsences = db
        .prepare('SELECT 1 FROM processed_attendance WHERE work_date = ? AND punch_count = 0 LIMIT 1')
        .get(s);
      if (staleAbsences) db.prepare('DELETE FROM processed_attendance WHERE work_date = ? AND punch_count = 0').run(s);
      const unprocessedPunches = db
        .prepare(
          `SELECT 1
           FROM attendance_logs l JOIN teachers t ON t.id = l.teacher_id
           WHERE t.status = 'active' AND substr(l.punch_time, 1, 10) = ?
             AND NOT EXISTS (
               SELECT 1 FROM processed_attendance p
               WHERE p.teacher_id = t.id AND p.work_date = ? AND p.punch_count > 0
             )
           LIMIT 1`
        )
        .get(s, s);
      if (unprocessedPunches) recomputeDate(s);
      continue;
    }

    if (activeCount === 0) continue;
    const processedCount = db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM processed_attendance p JOIN teachers t ON t.id = p.teacher_id
         WHERE p.work_date = ? AND t.status = 'active'`
      )
      .get(s).c;
    if (processedCount < activeCount) recomputeDate(s);
  }
}

module.exports = {
  recomputeTeacherDate,
  recomputeDate,
  recomputeRange,
  ensureProcessed,
  adoptOrphanPunches,
  adoptAndRecompute,
  resolveShift,
  getDefaultShift,
};
