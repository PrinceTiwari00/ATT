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
const { readCalendar, isWorkingDate, holidayOccurrences } = require('../services/calendar');

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
  const allWorkingDates = allDates.filter((date) => isWorkingDate(date, calendar));
  const completedWorkingDates = allWorkingDates.filter((date) => date <= today);
  const workingDateSet = new Set(completedWorkingDates);
  const holidays = holidayOccurrences(period.from, period.to, calendar);

  const teachers = db.prepare(
    `SELECT t.id, t.zk_user_id, t.full_name, t.department, t.designation
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
    const totals = {
      id: teacher.id,
      zkUserId: teacher.zk_user_id,
      fullName: teacher.full_name,
      department: teacher.department,
      designation: teacher.designation,
      scheduledWorkdays: allWorkingDates.length,
      workingDays: completedWorkingDates.length,
      ...Object.fromEntries(METRICS.map((key) => [key, 0])),
    };
    totals.absentDays = completedWorkingDates.length;
    const dayRecords = recordsByTeacher.get(teacher.id) || new Map();

    for (const [date, row] of dayRecords) {
      if (!row.punch_count) continue;
      if (!workingDateSet.has(date)) {
        // Keep exceptional holiday/weekend work visible without treating the
        // non-working day as a regular present or absent day.
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

  const summary = {
    staffCount: staff.length,
    calendarWorkdays: allWorkingDates.length,
    completedWorkdays: completedWorkingDates.length,
    remainingWorkdays: allWorkingDates.length - completedWorkingDates.length,
    ...Object.fromEntries(METRICS.map((key) => [key, staff.reduce((sum, row) => sum + row[key], 0)])),
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
