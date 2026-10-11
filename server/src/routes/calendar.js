/**
 * Calendar settings, one-off / recurring school holidays, and per-day
 * exceptions ("work this holiday", "take this working day off").
 */
const express = require('express');
const { getDb } = require('../db/connection');
const { eachDay, parseLocalDate, todayKey } = require('../lib/localDate');
const {
  BS_MONTHS,
  MIN_BS_YEAR,
  MAX_BS_YEAR,
  daysInBsMonth,
  adToBs,
} = require('../lib/nepaliDate');
const {
  readCalendar,
  describeHolidays,
  describeOverrides,
  describeDay,
  describeDayRange,
} = require('../services/calendar');
const { recomputeDate } = require('../services/processor');

const router = express.Router();

const MAX_DATES_PER_WRITE = 200; // a dragged range can be long, but never unbounded
const MAX_DATES_PER_READ = 93; // matches the attendance API's largest window
const DAY_MODES = ['workday', 'holiday', 'default'];
const DEFAULT_HOLIDAY_NAME = 'School holiday';

function validDayKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    const date = parseLocalDate(value);
    return date.getFullYear() === Number(value.slice(0, 4)) &&
      date.getMonth() + 1 === Number(value.slice(5, 7)) &&
      date.getDate() === Number(value.slice(8, 10)) &&
      adToBs(value) !== null;
  } catch (_) {
    return false;
  }
}

function validateHoliday(body = {}) {
  const name = String(body.name ?? '').trim();
  const kind = String(body.kind ?? '');
  const errors = [];
  if (!name) errors.push('Holiday name is required');
  else if (name.length > 100) errors.push('Holiday name must be 100 characters or fewer');
  if (!['once', 'annual'].includes(kind)) errors.push('Holiday type must be once or annual');

  if (kind === 'once') {
    if (!validDayKey(body.date)) errors.push('Choose a valid BS holiday date within the supported calendar range');
    return { errors, value: { name, kind, date: body.date, bsMonth: null, bsDay: null } };
  }

  const bsMonth = Number(body.bsMonth);
  const bsDay = Number(body.bsDay);
  if (!Number.isInteger(bsMonth) || bsMonth < 1 || bsMonth > 12) {
    errors.push('Choose a valid Bikram Sambat month');
  }
  if (!Number.isInteger(bsDay) || bsDay < 1 || bsDay > 32) {
    errors.push('Choose a valid Bikram Sambat day');
  } else if (Number.isInteger(bsMonth) && bsMonth >= 1 && bsMonth <= 12) {
    const occursInRange = Array.from({ length: MAX_BS_YEAR - MIN_BS_YEAR + 1 }, (_, i) => MIN_BS_YEAR + i)
      .some((year) => bsDay <= daysInBsMonth(year, bsMonth));
    if (!occursInRange) errors.push(`Day ${bsDay} is not valid in ${BS_MONTHS[bsMonth - 1]}`);
  }
  return { errors, value: { name, kind, date: null, bsMonth, bsDay } };
}

function calendarPayload(calendar = readCalendar()) {
  return {
    workingDays: [...calendar.workingDays].sort((a, b) => a - b),
    holidays: describeHolidays(calendar),
    overrides: describeOverrides(calendar),
  };
}

function saveHoliday({ id = null, value }) {
  const db = getDb();
  try {
    if (id == null) {
      const result = db.prepare(
        `INSERT INTO calendar_holidays (name, kind, date, bs_month, bs_day)
         VALUES (?, ?, ?, ?, ?)`
      ).run(value.name, value.kind, value.date, value.bsMonth, value.bsDay);
      return Number(result.lastInsertRowid);
    }
    db.prepare(
      `UPDATE calendar_holidays
       SET name = ?, kind = ?, date = ?, bs_month = ?, bs_day = ?
       WHERE id = ?`
    ).run(value.name, value.kind, value.date, value.bsMonth, value.bsDay, id);
    return id;
  } catch (err) {
    if (/UNIQUE constraint failed/.test(err.message)) {
      const conflict = new Error('A holiday is already defined for that date');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}

/**
 * Apply one decision ("workday" | "holiday" | "default") to a set of dates.
 *
 *  • workday — an explicit working-day exception. A one-off holiday record on
 *    that date is removed (it would contradict the decision); annual holidays
 *    are left alone because they apply to every year, the exception wins for
 *    this date only.
 *  • holiday — the date becomes a named holiday: one-off by default, or a
 *    recurring annual BS date when `repeat` is set. Any working-day exception
 *    on the date is cleared.
 *  • default — back to the regular working week + holiday list.
 *
 * Every touched day up to today is recomputed, so absences / present days in
 * reports follow the new calendar immediately.
 */
function applyDayChange({ dates, mode, name, repeat, note }) {
  const db = getDb();
  const holidayName = String(name ?? '').trim().slice(0, 100);
  const noteText = String(note ?? '').trim().slice(0, 200);
  const touched = new Set();
  const removedHolidays = [];

  db.exec('BEGIN');
  try {
    for (const date of dates) {
      touched.add(date);
      db.prepare('DELETE FROM calendar_day_overrides WHERE date = ?').run(date);

      if (mode === 'workday') {
        const removed = db
          .prepare("DELETE FROM calendar_holidays WHERE kind = 'once' AND date = ?")
          .run(date);
        if (removed.changes) removedHolidays.push({ date, name: null, reason: 'replaced by a working day' });
        db.prepare(
          `INSERT INTO calendar_day_overrides (date, is_working, note, updated_at)
           VALUES (?, 1, ?, datetime('now','localtime'))`
        ).run(date, noteText || null);
        continue;
      }

      if (mode === 'holiday') {
        const bs = adToBs(date);
        if (repeat && bs) {
          const annual = db
            .prepare("SELECT id, name FROM calendar_holidays WHERE kind = 'annual' AND bs_month = ? AND bs_day = ?")
            .get(bs.month, bs.day);
          if (annual) {
            if (holidayName && holidayName !== annual.name) {
              db.prepare('UPDATE calendar_holidays SET name = ? WHERE id = ?').run(holidayName, annual.id);
            }
          } else {
            db.prepare(
              `INSERT INTO calendar_holidays (name, kind, bs_month, bs_day)
               VALUES (?, 'annual', ?, ?)`
            ).run(holidayName || DEFAULT_HOLIDAY_NAME, bs.month, bs.day);
          }
          // The annual rule already covers this date; a one-off twin would just
          // duplicate the name in the holiday list.
          db.prepare("DELETE FROM calendar_holidays WHERE kind = 'once' AND date = ?").run(date);
          continue;
        }

        const oneOff = db
          .prepare("SELECT id, name FROM calendar_holidays WHERE kind = 'once' AND date = ?")
          .get(date);
        if (oneOff) {
          if (holidayName && holidayName !== oneOff.name) {
            db.prepare('UPDATE calendar_holidays SET name = ? WHERE id = ?').run(holidayName, oneOff.id);
          }
          continue;
        }
        const annual = bs
          ? db.prepare("SELECT id FROM calendar_holidays WHERE kind = 'annual' AND bs_month = ? AND bs_day = ?").get(bs.month, bs.day)
          : null;
        if (!annual) {
          db.prepare(
            `INSERT INTO calendar_holidays (name, kind, date)
             VALUES (?, 'once', ?)`
          ).run(holidayName || DEFAULT_HOLIDAY_NAME, date);
        }
        continue;
      }

      // mode === 'default' — drop the exception and any one-off holiday on the date.
      db.prepare("DELETE FROM calendar_holidays WHERE kind = 'once' AND date = ?").run(date);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const today = todayKey();
  const recomputed = [...touched].filter((date) => date <= today).sort();
  for (const date of recomputed) recomputeDate(date);

  const calendar = readCalendar();
  return {
    ...calendarPayload(calendar),
    days: [...touched].sort().map((date) => describeDay(date, calendar)),
    removedHolidays,
    recomputed,
  };
}

router.get('/', (_req, res) => {
  res.json({ data: calendarPayload() });
});

/** Day-by-day status for a date window — what the calendar grid renders. */
router.get('/days', (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!validDayKey(from) || !validDayKey(to)) {
    return res.status(422).json({ error: 'Provide from and to as YYYY-MM-DD dates inside the supported BS range' });
  }
  if (to < from) return res.status(422).json({ error: 'The end date must not be before the start date' });
  let count = 0;
  for (const _ of eachDay(from, to)) {
    if (++count > MAX_DATES_PER_READ) {
      return res.status(422).json({ error: `Choose a range of ${MAX_DATES_PER_READ} days or fewer` });
    }
  }
  res.json({ data: { from, to, days: describeDayRange(from, to) } });
});

/** Mark selected day(s) as a working day, a holiday, or back to the default. */
router.put('/days', (req, res) => {
  const raw = req.body?.dates ?? (req.body?.date ? [req.body.date] : []);
  const dates = Array.isArray(raw) ? [...new Set(raw.map((d) => String(d)))] : [];
  const mode = String(req.body?.mode ?? '');

  if (!dates.length) return res.status(422).json({ error: 'Select at least one calendar day' });
  if (dates.length > MAX_DATES_PER_WRITE) {
    return res.status(422).json({ error: `Select ${MAX_DATES_PER_WRITE} days or fewer at a time` });
  }
  if (dates.some((date) => !validDayKey(date))) {
    return res.status(422).json({ error: 'Every selected day must be a valid date within the supported BS range' });
  }
  if (!DAY_MODES.includes(mode)) {
    return res.status(422).json({ error: `mode must be one of ${DAY_MODES.join(', ')}` });
  }
  const name = req.body?.name;
  if (name != null && String(name).trim().length > 100) {
    return res.status(422).json({ error: 'Holiday name must be 100 characters or fewer' });
  }
  const note = req.body?.note;
  if (note != null && String(note).trim().length > 200) {
    return res.status(422).json({ error: 'Note must be 200 characters or fewer' });
  }

  const data = applyDayChange({
    dates: [...dates].sort(),
    mode,
    name,
    repeat: mode === 'holiday' && Boolean(req.body?.repeat),
    note,
  });
  res.json({ data });
});

router.put('/workdays', (req, res) => {
  const incoming = req.body?.workingDays;
  if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > 7 ||
      incoming.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(incoming).size !== incoming.length) {
    return res.status(422).json({ error: 'Select one or more unique weekdays (Sunday=0 through Saturday=6)' });
  }
  const workingDays = [...incoming].sort((a, b) => a - b);
  getDb().prepare(
    `UPDATE calendar_settings
     SET working_days = ?, updated_at = datetime('now', 'localtime')
     WHERE id = 1`
  ).run(JSON.stringify(workingDays));
  // The regular week changed: rebuild today so the ledger reflects it at once.
  recomputeDate(todayKey());
  res.json({ data: calendarPayload() });
});

router.post('/holidays', (req, res) => {
  const { errors, value } = validateHoliday(req.body);
  if (errors.length) return res.status(422).json({ error: errors.join('; ') });
  let id;
  try {
    id = saveHoliday({ value });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  res.status(201).json({ data: calendarPayload(), id });
});

router.put('/holidays/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid holiday ID' });
  const db = getDb();
  if (!db.prepare('SELECT id FROM calendar_holidays WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Holiday not found' });
  }
  const { errors, value } = validateHoliday(req.body);
  if (errors.length) return res.status(422).json({ error: errors.join('; ') });
  try {
    saveHoliday({ id, value });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  res.json({ data: calendarPayload() });
});

router.delete('/holidays/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid holiday ID' });
  const result = getDb().prepare('DELETE FROM calendar_holidays WHERE id = ?').run(id);
  if (!result.changes) return res.status(404).json({ error: 'Holiday not found' });
  res.json({ ok: true });
});

module.exports = router;
