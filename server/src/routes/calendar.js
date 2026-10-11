/** Calendar settings and one-off / recurring school holidays. */
const express = require('express');
const { getDb } = require('../db/connection');
const { parseLocalDate } = require('../lib/localDate');
const {
  BS_MONTHS,
  MIN_BS_YEAR,
  MAX_BS_YEAR,
  daysInBsMonth,
  adToBs,
} = require('../lib/nepaliDate');
const { readCalendar, describeHolidays } = require('../services/calendar');

const router = express.Router();

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

function holidayPayload() {
  const calendar = readCalendar();
  return {
    workingDays: [...calendar.workingDays].sort((a, b) => a - b),
    holidays: describeHolidays(calendar),
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

router.get('/', (_req, res) => {
  res.json({ data: holidayPayload() });
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
  res.json({ data: holidayPayload() });
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
  res.status(201).json({ data: holidayPayload(), id });
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
  res.json({ data: holidayPayload() });
});

router.delete('/holidays/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid holiday ID' });
  const result = getDb().prepare('DELETE FROM calendar_holidays WHERE id = ?').run(id);
  if (!result.changes) return res.status(404).json({ error: 'Holiday not found' });
  res.json({ ok: true });
});

module.exports = router;
