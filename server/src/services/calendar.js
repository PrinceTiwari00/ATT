/**
 * Workweek, holiday, per-day and per-person calendar rules shared by
 * processing and reports.
 *
 * Resolution order for one calendar day (highest first):
 *   1. a per-day override  (calendar_day_overrides) — "work this holiday",
 *      "take this working day off", "work this Saturday"
 *   2. a named holiday     (calendar_holidays) — one-off date or annual BS date
 *   3. the regular working week (calendar_settings.working_days)
 *
 * On top of that, each person may carry their OWN weekdays
 * (teachers.working_days) — that is what makes part-time rosters possible:
 *   expected(person, date) = the school is open that date (no holiday, no
 *                            "off" override) AND the weekday is in the person's
 *                            pattern, which defaults to the school working week
 * An empty/NULL pattern therefore means "follow the school week", and every
 * full-time profile behaves exactly as before.
 */
const { getDb } = require('../db/connection');
const { eachDay, parseLocalDate } = require('../lib/localDate');
const { BS_MONTHS, adToBs } = require('../lib/nepaliDate');

const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5]; // Monday–Friday; 0 = Sunday, 6 = Saturday

function readCalendar() {
  const db = getDb();
  const settings = db.prepare('SELECT working_days FROM calendar_settings WHERE id = 1').get();
  let workingDays = DEFAULT_WORKING_DAYS;
  try {
    const parsed = JSON.parse(settings?.working_days || '');
    if (Array.isArray(parsed)) workingDays = parsed;
  } catch (_) {
    // A missing/invalid setting falls back to the shipped school-week default.
  }
  const holidays = db
    .prepare('SELECT id, name, kind, date, bs_month, bs_day FROM calendar_holidays ORDER BY id')
    .all();
  const overrides = db
    .prepare('SELECT date, is_working, note FROM calendar_day_overrides ORDER BY date')
    .all();
  return {
    workingDays,
    holidays,
    overrides,
    overridesByDate: new Map(overrides.map((row) => [row.date, row])),
  };
}

/** The per-day exception for a date, or null when the regular rules apply. */
function overrideForDate(dateKey, calendar = readCalendar()) {
  if (calendar.overridesByDate) return calendar.overridesByDate.get(dateKey) || null;
  return (calendar.overrides || []).find((row) => row.date === dateKey) || null;
}

/** True when the weekday itself is part of the configured regular working week. */
function isWeeklyWorkday(dateKey, calendar = readCalendar()) {
  return calendar.workingDays.includes(parseLocalDate(dateKey).getDay());
}

function holidayNamesForDate(dateKey, calendar = readCalendar()) {
  const matches = [];
  const bs = calendar.holidays.some((h) => h.kind === 'annual') ? adToBs(dateKey) : null;
  for (const holiday of calendar.holidays) {
    if (holiday.kind === 'once' && holiday.date === dateKey) matches.push(holiday.name);
    if (holiday.kind === 'annual' && bs && holiday.bs_month === bs.month && holiday.bs_day === bs.day) {
      matches.push(holiday.name);
    }
  }
  return matches;
}

function isWorkingDate(dateKey, calendar = readCalendar()) {
  const override = overrideForDate(dateKey, calendar);
  if (override) return Boolean(override.is_working); // explicit school decision wins
  if (!isWeeklyWorkday(dateKey, calendar)) return false;
  return holidayNamesForDate(dateKey, calendar).length === 0;
}

/**
 * Weekday numbers out of a stored pattern. Accepts the raw JSON column, an
 * already-parsed array, or nothing at all; anything unusable collapses to
 * `null`, which the callers read as "follow the school working week".
 */
function parseWorkingDays(value) {
  let list = value;
  if (typeof list === 'string') {
    const text = list.trim();
    if (!text || text === 'null') return null;
    try {
      list = JSON.parse(text);
    } catch (_) {
      return null; // a hand-edited/legacy value must never break processing
    }
  }
  if (!Array.isArray(list)) return null;
  const days = [...new Set(list.map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  return days.length ? days : null;
}

/**
 * The weekdays this person is scheduled for: their own pattern when the school
 * registered one, otherwise the school's regular working week. This is only
 * "which weekdays" — a named holiday or an explicit day-off still removes the
 * date for everybody (see isTeacherExpectedDate).
 */
function teacherWorkingDays(teacher, calendar = readCalendar()) {
  return (
    parseWorkingDays(teacher?.working_days ?? teacher?.workingDays ?? null) ||
    parseWorkingDays(calendar?.workingDays) ||
    [...DEFAULT_WORKING_DAYS]
  );
}

/**
 * Is this person due at work on this date?
 *
 *  • no personal pattern (every full-time profile) → the school rule verbatim,
 *    so nothing changes for the existing roster;
 *  • a personal pattern decides the WEEKDAYS — which lets a Saturday-only or
 *    Mon/Wed/Fri part-timer be expected on days the school week skips — while a
 *    named holiday or an explicit "day off" override still closes the date for
 *    everybody, and a make-up day the school pins open only pulls in the
 *    people whose own pattern covers that weekday.
 */
function isTeacherExpectedDate(teacher, dateKey, calendar = readCalendar()) {
  if (!teacher) return false;
  const days = parseWorkingDays(teacher.working_days ?? teacher.workingDays ?? null);
  if (!days) return isWorkingDate(dateKey, calendar);
  const weekday = parseLocalDate(dateKey).getDay();
  const override = overrideForDate(dateKey, calendar);
  if (override) return Boolean(override.is_working) && days.includes(weekday);
  if (holidayNamesForDate(dateKey, calendar).length) return false; // closed for everyone
  return days.includes(weekday);
}

/** Filter a roster down to the people expected on a date (roster order kept). */
function expectedTeachersOn(teachers, dateKey, calendar = readCalendar()) {
  return (teachers || []).filter((teacher) => isTeacherExpectedDate(teacher, dateKey, calendar));
}

function holidayOccurrences(from, to, calendar = readCalendar()) {
  const rows = [];
  const needsBs = calendar.holidays.some((h) => h.kind === 'annual');
  for (const date of eachDay(from, to)) {
    // A holiday the school decided to work is counted as a normal working day.
    if (overrideForDate(date, calendar)?.is_working) continue;
    const bs = needsBs ? adToBs(date) : null;
    const names = [];
    for (const holiday of calendar.holidays) {
      if (holiday.kind === 'once' && holiday.date === date) names.push(holiday.name);
      else if (holiday.kind === 'annual' && bs && holiday.bs_month === bs.month && holiday.bs_day === bs.day) {
        names.push(holiday.name);
      }
    }
    if (names.length) rows.push({ date, names, bs });
  }
  return rows;
}

/**
 * Everything the UI needs to draw one day of the calendar grid.
 * `source` says WHY the day resolves the way it does:
 *   workweek — plain regular working week day
 *   off_week — weekly off (not in the regular working week)
 *   holiday  — a named one-off / annual holiday
 *   override — the school set this specific date by hand
 */
function describeDay(dateKey, calendar = readCalendar()) {
  const date = parseLocalDate(dateKey);
  const weekday = date.getDay();
  const bs = adToBs(dateKey);
  const override = overrideForDate(dateKey, calendar);
  const holidayNames = holidayNamesForDate(dateKey, calendar);
  const weeklyWorkday = calendar.workingDays.includes(weekday);
  const isWorkingDay = isWorkingDate(dateKey, calendar);

  let source = 'off_week';
  if (override) source = 'override';
  else if (holidayNames.length) source = 'holiday';
  else if (weeklyWorkday) source = 'workweek';

  return {
    date: dateKey,
    weekday,
    weeklyWorkday,
    isWorkingDay,
    isHoliday: holidayNames.length > 0,
    holidayNames,
    source,
    override: override ? { isWorking: Boolean(override.is_working), note: override.note || null } : null,
    bs: bs ? { year: bs.year, month: bs.month, day: bs.day, monthName: BS_MONTHS[bs.month - 1] } : null,
  };
}

function describeDayRange(from, to, calendar = readCalendar()) {
  return [...eachDay(from, to)].map((date) => describeDay(date, calendar));
}

function describeHolidays(calendar = readCalendar()) {
  return calendar.holidays.map((holiday) => {
    if (holiday.kind === 'annual') {
      return {
        id: holiday.id,
        name: holiday.name,
        kind: holiday.kind,
        date: null,
        bsMonth: holiday.bs_month,
        bsDay: holiday.bs_day,
        bsMonthName: BS_MONTHS[holiday.bs_month - 1],
        bsLabel: `${holiday.bs_day} ${BS_MONTHS[holiday.bs_month - 1]} (every BS year)`,
        adLabel: null,
      };
    }
    const bs = adToBs(holiday.date);
    return {
      id: holiday.id,
      name: holiday.name,
      kind: holiday.kind,
      date: holiday.date,
      bsMonth: bs?.month ?? null,
      bsDay: bs?.day ?? null,
      bsMonthName: bs ? BS_MONTHS[bs.month - 1] : null,
      bsLabel: bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year} BS` : null,
      adLabel: holiday.date,
    };
  });
}

/** Per-day exceptions ("this holiday is a working day") for the calendar page. */
function describeOverrides(calendar = readCalendar()) {
  return calendar.overrides.map((row) => ({
    date: row.date,
    isWorking: Boolean(row.is_working),
    note: row.note || null,
  }));
}

module.exports = {
  DEFAULT_WORKING_DAYS,
  readCalendar,
  overrideForDate,
  isWeeklyWorkday,
  holidayNamesForDate,
  isWorkingDate,
  parseWorkingDays,
  teacherWorkingDays,
  isTeacherExpectedDate,
  expectedTeachersOn,
  holidayOccurrences,
  describeDay,
  describeDayRange,
  describeHolidays,
  describeOverrides,
};
