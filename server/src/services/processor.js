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
const { getDb, tx } = require('../db/connection');
const { evaluateDay } = require('../utils/attendanceLogic');
const { todayStr } = require('../zk/deviceContract');

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
  const teachers = db
    .prepare("SELECT id FROM teachers WHERE status = 'active'")
    .all();
  for (const t of teachers) recomputeTeacherDate(t.id, workDate);
  return teachers.length;
}

function recomputeRange(from, to) {
  const days = [];
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (d <= end && days.length < 93) {
    const s = d.toISOString().slice(0, 10);
    recomputeDate(s);
    days.push(s);
    d.setDate(d.getDate() + 1);
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
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const d = new Date(from + 'T00:00:00');
  const end = new Date(Math.min(new Date(to + 'T00:00:00').getTime(), new Date(todayStr + 'T00:00:00').getTime()));
  let guard = 0;
  while (d <= end && guard++ < 31) {
    const s = d.toISOString().slice(0, 10);
    const has = db
      .prepare('SELECT 1 FROM processed_attendance WHERE work_date = ? LIMIT 1')
      .get(s);
    if (!has) recomputeDate(s);
    d.setDate(d.getDate() + 1);
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
