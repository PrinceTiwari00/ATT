/** Workweek and holiday calendar rules shared by processing and reports. */
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
  return { workingDays, holidays };
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
  const date = parseLocalDate(dateKey);
  if (!calendar.workingDays.includes(date.getDay())) return false;
  return holidayNamesForDate(dateKey, calendar).length === 0;
}

function holidayOccurrences(from, to, calendar = readCalendar()) {
  const rows = [];
  const needsBs = calendar.holidays.some((h) => h.kind === 'annual');
  for (const date of eachDay(from, to)) {
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

module.exports = {
  DEFAULT_WORKING_DAYS,
  readCalendar,
  holidayNamesForDate,
  isWorkingDate,
  holidayOccurrences,
  describeHolidays,
};
