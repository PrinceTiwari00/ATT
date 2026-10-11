/** Monthly staff attendance totals grouped by Bikram Sambat month. */
const express = require('express');
const { getDb } = require('../db/connection');
const { eachDay, todayKey } = require('../lib/localDate');
const {
  BS_MONTHS,
  MIN_BS_YEAR,
  MAX_BS_YEAR,
  bsMonthRange,
} = require('../lib/nepaliDate');
const { ensureProcessed } = require('../services/processor');
const {
  readCalendar,
  isWorkingDate,
  holidayOccurrences,
  parseWorkingDays,
  teacherWorkingDays,
  isTeacherExpectedDate,
} = require('../services/calendar');

const router = express.Router();

function minuteOfDay(timestamp) {
  if (!timestamp) return null;
  const [hour, minute] = timestamp.slice(11, 16).split(':').map(Number);
  return hour * 60 + minute;
}

function overtimeMinutes(row) {
  if (!row.check_out || !row.shift_start || !row.shift_end) return 0;
  const start = Number(row.shift_start.slice(0, 2)) * 60 + Number(row.shift_start.slice(3, 5));
  let end = Number(row.shift_end.slice(0, 2)) * 60 + Number(row.shift_end.slice(3, 5));
  if (end <= start) end += 24 * 60; // overnight shift
  let out = minuteOfDay(row.check_out);
  if (row.check_out.slice(0, 10) !== row.work_date) out += 24 * 60;
  return Math.max(0, out - end);
}

const METRICS = [
  'presentDays', 'absentDays', 'lateDays', 'lateMinutes',
  'earlyDepartureDays', 'earlyMinutes', 'overtimeDays', 'overtimeMinutes',
  'nonWorkingDayPunches',
];

router.get('/monthly', (req, res) => {
  const bsYear = Number(req.query.bsYear);
  const bsMonth = Number(req.query.bsMonth);
  if (!Number.isInteger(bsYear) || bsYear < MIN_BS_YEAR || bsYear > MAX_BS_YEAR ||
      !Number.isInteger(bsMonth) || bsMonth < 1 || bsMonth > 12) {
    return res.status(422).json({ error: `Choose a BS month between ${MIN_BS_YEAR} and ${MAX_BS_YEAR}` });
  }

  let period;
  try {
    period = bsMonthRange(bsYear, bsMonth);
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  const db = getDb();
  const today = todayKey();
  const asOf = period.from > today ? null : (period.to < today ? period.to : today);
  if (asOf) ensureProcessed(period.from, asOf);

  const calendar = readCalendar();
  const allDates = [...eachDay(period.from, period.to)];
  // School-wide figures for the summary cards and the "how it is counted" notes.
  const allWorkingDates = allDates.filter((date) => isWorkingDate(date, calendar));
  const holidays = holidayOccurrences(period.from, period.to, calendar);

  const teachers = db.prepare(
    `SELECT t.id, t.zk_user_id, t.full_name, t.department, t.designation,
            t.employment_type, t.working_days
     FROM teachers t WHERE t.status = 'active'
     ORDER BY t.full_name COLLATE NOCASE`
  ).all();
  const records = db.prepare(
    `SELECT p.teacher_id, p.work_date, p.check_in, p.check_out, p.punch_count,
            p.late_minutes, p.early_minutes, p.status,
            s.start_time AS shift_start, s.end_time AS shift_end
     FROM processed_attendance p
     JOIN teachers t ON t.id = p.teacher_id
     LEFT JOIN shifts s ON s.id = p.shift_id
     WHERE t.status = 'active' AND p.work_date BETWEEN ? AND ? AND p.work_date <= ?`
  ).all(period.from, period.to, today);
  const recordsByTeacher = new Map(teachers.map((teacher) => [teacher.id, new Map()]));
  for (const record of records) recordsByTeacher.get(record.teacher_id)?.set(record.work_date, record);

  const staff = teachers.map((teacher) => {
    /*
     * Every day count below is measured against THIS person's own schedule, not
     * the school week: a Mon/Wed/Fri part-timer has their expected days, their
     * elapsed days and therefore their absences computed from their pattern.
     * A full-time profile (no pattern) lands on exactly the school week, so its
     * numbers are unchanged.
     */
    const scheduledDates = allDates.filter((date) => isTeacherExpectedDate(teacher, date, calendar));
    const completedDates = scheduledDates.filter((date) => date <= today);
    const completedSet = new Set(completedDates);
    const pattern = parseWorkingDays(teacher.working_days);
    const totals = {
      id: teacher.id,
      zkUserId: teacher.zk_user_id,
      fullName: teacher.full_name,
      department: teacher.department,
      designation: teacher.designation,
      employmentType: teacher.employment_type === 'part_time' ? 'part_time' : 'full_time',
      partTime: teacher.employment_type === 'part_time',
      // Weekdays they are expected on (their own pattern, else the school week).
      workPattern: teacherWorkingDays(teacher, calendar),
      followsSchoolWeek: pattern === null,
      scheduledWorkdays: scheduledDates.length,
      workingDays: completedDates.length,
      ...Object.fromEntries(METRICS.map((key) => [key, 0])),
    };
    totals.absentDays = completedDates.length;
    const dayRecords = recordsByTeacher.get(teacher.id) || new Map();

    for (const [date, row] of dayRecords) {
      if (!row.punch_count) continue;
      if (!completedSet.has(date)) {
        // Work outside this person's own schedule — a holiday, a weekend, or a
        // weekday their pattern skips. Kept visible, but it is neither a
        // scheduled present day nor a missed (absent) one.
        totals.nonWorkingDayPunches += 1;
        continue;
      }
      totals.presentDays += 1;
      totals.absentDays -= 1;
      if (row.status === 'late' || row.status === 'late_early') {
        totals.lateDays += 1;
        totals.lateMinutes += row.late_minutes || 0;
      }
      if (row.status === 'early' || row.status === 'late_early') {
        totals.earlyDepartureDays += 1;
        totals.earlyMinutes += row.early_minutes || 0;
      }
      const extra = overtimeMinutes(row);
      if (extra > 0) {
        totals.overtimeDays += 1;
        totals.overtimeMinutes += extra;
      }
    }
    return totals;
  });

  const sum = (key) => staff.reduce((total, row) => total + row[key], 0);
  const summary = {
    staffCount: staff.length,
    partTimeStaff: staff.filter((row) => row.partTime).length,
    calendarWorkdays: allWorkingDates.length,
    completedWorkdays: allWorkingDates.filter((date) => date <= today).length,
    remainingWorkdays:
      allWorkingDates.length - allWorkingDates.filter((date) => date <= today).length,
    // Staff-days people were actually scheduled for — the honest denominator
    // once part-timers are on the roster (sums each person's own days).
    expectedStaffDays: sum('workingDays'),
    scheduledStaffDays: sum('scheduledWorkdays'),
    ...Object.fromEntries(METRICS.map((key) => [key, sum(key)])),
  };

  res.json({
    data: {
      period: {
        bsYear,
        bsMonth,
        bsMonthName: BS_MONTHS[bsMonth - 1],
        bsLabel: `${BS_MONTHS[bsMonth - 1]} ${bsYear} BS`,
        from: period.from,
        to: period.to,
        asOf: asOf || null,
        totalCalendarDays: period.days,
      },
      summary,
      staff,
      holidays,
      workingDays: [...calendar.workingDays].sort((a, b) => a - b),
    },
  });
});

module.exports = { router, overtimeMinutes };
