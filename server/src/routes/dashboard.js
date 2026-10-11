/**
 * Dashboard KPIs  (spec § D.4)
 */
const express = require('express');
const { getDb } = require('../db/connection');
const { ensureProcessed } = require('../services/processor');
const {
  readCalendar,
  isWorkingDate,
  holidayNamesForDate,
  isTeacherExpectedDate,
} = require('../services/calendar');

const router = express.Router();

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayOffset(n) {
  const d = new Date(Date.now() + n * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

router.get('/summary', (req, res) => {
  const db = getDb();
  const date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : todayStr();
  ensureProcessed(date, date);
  const calendar = readCalendar();
  const holidayNames = holidayNamesForDate(date, calendar);
  const isWorkday = isWorkingDate(date, calendar);

  const kpi = db
    .prepare(
      `SELECT
         COUNT(*)                                                        AS rostered,
         -- COALESCE: on a day nobody is due (weekend, holiday, or a roster of
         -- part-timers who are all off) there are no rows and SUM() is NULL.
         COALESCE(SUM(CASE WHEN punch_count > 0 THEN 1 ELSE 0 END), 0)     AS present,
         COALESCE(SUM(CASE WHEN status IN ('late','late_early') THEN 1 ELSE 0 END), 0) AS late,
         COALESCE(SUM(CASE WHEN status IN ('early','late_early') THEN 1 ELSE 0 END), 0) AS early,
         COALESCE(SUM(CASE WHEN status = 'on_time' THEN 1 ELSE 0 END), 0)  AS on_time,
         COALESCE(SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END), 0)    AS absent,
         COALESCE(MAX(late_minutes), 0)                                     AS worst_late
       FROM processed_attendance WHERE work_date = ?`
    )
    .get(date);

  /*
   * "Expected today" respects each person's own working days: a Mon/Wed/Fri
   * part-timer is not on Tuesday's roster, so they are neither present nor
   absent — and the absence KPI below only ever counts people who were due in.
   */
  const roster = db
    .prepare("SELECT id, employment_type, working_days FROM teachers WHERE status = 'active'")
    .all();
  const totalActive = roster.length;
  const expectedToday = roster.filter((teacher) => isTeacherExpectedDate(teacher, date, calendar)).length;

  const lateList = db
    .prepare(
      `SELECT t.full_name, t.department, p.check_in, p.late_minutes, s.start_time
       FROM processed_attendance p
       JOIN teachers t ON t.id = p.teacher_id
       LEFT JOIN shifts s ON s.id = p.shift_id
       WHERE p.work_date = ? AND p.status IN ('late','late_early')
       ORDER BY p.late_minutes DESC LIMIT 8`
    )
    .all(date);

  const earlyList = db
    .prepare(
      `SELECT t.full_name, t.department, p.check_out, p.early_minutes, s.end_time
       FROM processed_attendance p
       JOIN teachers t ON t.id = p.teacher_id
       LEFT JOIN shifts s ON s.id = p.shift_id
       WHERE p.work_date = ? AND p.status IN ('early','late_early')
       ORDER BY p.early_minutes DESC LIMIT 8`
    )
    .all(date);

  const deptBreakdown = db
    .prepare(
      `SELECT t.department,
              COUNT(*)                                                     AS total,
              SUM(CASE WHEN p.punch_count > 0 THEN 1 ELSE 0 END)           AS present,
              SUM(CASE WHEN p.status IN ('late','late_early') THEN 1 ELSE 0 END) AS late
       FROM processed_attendance p JOIN teachers t ON t.id = p.teacher_id
       WHERE p.work_date = ?
       GROUP BY t.department ORDER BY t.department`
    )
    .all(date);

  // 7-day trend ending on `date`
  const trend = db
    .prepare(
      `SELECT work_date AS date,
              SUM(CASE WHEN punch_count > 0 THEN 1 ELSE 0 END)             AS present,
              SUM(CASE WHEN status IN ('late','late_early') THEN 1 ELSE 0 END) AS late,
              SUM(CASE WHEN status IN ('early','late_early') THEN 1 ELSE 0 END) AS early,
              SUM(CASE WHEN status = 'on_time' THEN 1 ELSE 0 END)          AS on_time,
              SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END)           AS absent
       FROM processed_attendance
       WHERE work_date BETWEEN ? AND ?
       GROUP BY work_date ORDER BY work_date`
    )
    .all(dayOffset(-6), date);

  res.json({
    data: {
      date,
      calendar: { isWorkday, holidayNames },
      kpi: {
        ...kpi,
        totalActive,
        expectedToday,
        offPatternToday: Math.max(0, totalActive - expectedToday),
        notNow: Math.max(0, expectedToday - (kpi.rostered || 0)),
      },
      lateList,
      earlyList,
      deptBreakdown,
      trend,
    },
  });
});

module.exports = router;
