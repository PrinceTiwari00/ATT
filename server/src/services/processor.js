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
const { readCalendar, isWorkingDate, isTeacherExpectedDate } = require('./calendar');

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

/**
 * Recompute one (teacher, date) — the atomic unit of the engine.
 * `calendar` may be passed in by a caller that already read it (recomputeDate
 * loops over the whole roster and must not re-read the rules per person).
 */
function recomputeTeacherDate(teacherId, workDate, calendar = readCalendar()) {
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
  /*
   * Only a day the person is actually due for is governed by the shift window.
   * Anything else — a Mon/Wed/Fri teacher who came in on a Tuesday, anyone
   * called in on a holiday — is still recorded (check-in/out, hours) but never
   * charged lateness or early departure, exactly like a profile with no shift.
   */
  const onTheirDay = isTeacherExpectedDate(teacher, workDate, calendar);
  const result = evaluateDay({ punches, shift: onTheirDay ? shift : null, workDate });

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

/** Active teachers that really have raw punches on a date. */
function punchedTeacherIds(db, workDate) {
  return db
    .prepare(
      `SELECT DISTINCT t.id
       FROM teachers t JOIN attendance_logs l ON l.teacher_id = t.id
       WHERE t.status = 'active' AND substr(l.punch_time, 1, 10) = ?`
    )
    .all(workDate)
    .map((row) => row.id);
}

const ACTIVE_ROSTER_SQL = `SELECT id, employment_type, working_days FROM teachers WHERE status = 'active'`;

/**
 * Recompute a full calendar date. Absence rows are materialized for everyone
 * the date is a working day FOR — i.e. the school is open that day and it is
 * one of their own weekdays — so a Mon/Wed/Fri part-timer is simply not on the
 * ledger on a Tuesday instead of being counted absent.
 *
 * A person who punches on a day they were not due for still gets a row (their
 * attendance must not vanish), and any stale zero-punch row from an older rule
 * is removed, which makes every pattern/calendar change self-healing on rebuild.
 */
function recomputeDate(workDate) {
  const db = getDb();
  const calendar = readCalendar();
  const teachers = db.prepare(ACTIVE_ROSTER_SQL).all();
  const punched = new Set(punchedTeacherIds(db, workDate));

  // Whole-school closures (weekly off, holiday) never leave an absence behind.
  // Rebuilding from scratch is safe: the loop below re-creates what the personal
  // patterns still require (e.g. a Saturday-only teacher on a school Saturday).
  if (!isWorkingDate(workDate, calendar)) {
    db.prepare('DELETE FROM processed_attendance WHERE work_date = ? AND punch_count = 0').run(workDate);
  }

  let touched = 0;
  for (const teacher of teachers) {
    if (isTeacherExpectedDate(teacher, workDate, calendar) || punched.has(teacher.id)) {
      recomputeTeacherDate(teacher.id, workDate, calendar);
      touched += 1;
    } else {
      db.prepare(
        'DELETE FROM processed_attendance WHERE teacher_id = ? AND work_date = ? AND punch_count = 0'
      ).run(teacher.id, workDate);
    }
  }
  return touched;
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
  const roster = db.prepare(ACTIVE_ROSTER_SQL).all();
  let guard = 0;
  for (const s of eachDay(from, end)) {
    // Keep in step with the attendance API's maximum 62-day range (BS months
    // can contain 32 days, so the old 31-day guard was too short for reports).
    if (guard++ >= 62) break;
    if (dateNeedsRebuild(db, s, calendar, roster)) recomputeDate(s);
  }
}

/**
 * Does this processed date match what the roster + the calendar ask for?
 *
 *  • someone who is due on the date (school open AND their own weekday) or who
 *    actually punched must have a row;
 *  • a row that says "absent" while raw punches exist means the punches arrived
 *    after the day was last built;
 *  • an absence row on a day that is NOT part of the person's pattern — or on a
 *    closure day for a profile that has since been deactivated — must go.
 *
 * This replaces the old "one row per active profile" count check, which can
 * never be satisfied once part-timers exist (and would rebuild every view).
 */
function dateNeedsRebuild(db, dateKey, calendar, roster) {
  const rows = db
    .prepare(
      `SELECT p.teacher_id, p.punch_count, t.status AS teacher_status
       FROM processed_attendance p JOIN teachers t ON t.id = p.teacher_id
       WHERE p.work_date = ?`
    )
    .all(dateKey);
  const rowOf = new Map(rows.map((row) => [row.teacher_id, row]));
  const punched = new Set(punchedTeacherIds(db, dateKey));

  for (const teacher of roster) {
    const row = rowOf.get(teacher.id);
    if (isTeacherExpectedDate(teacher, dateKey, calendar) || punched.has(teacher.id)) {
      if (!row) return true;
      if (!row.punch_count && punched.has(teacher.id)) return true;
    } else if (row && !row.punch_count) {
      return true;
    }
  }

  // A closure day carries no absences at all, not even for people who left the
  // active roster after the day was materialized.
  const rosterIds = new Set(roster.map((teacher) => teacher.id));
  if (!isWorkingDate(dateKey, calendar) &&
      rows.some((row) => !row.punch_count && !rosterIds.has(row.teacher_id))) {
    return true;
  }
  return false;
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
