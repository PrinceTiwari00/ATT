/**
 * Shift / Schedule configuration CRUD  (spec § C.1)
 */
const express = require('express');
const { getDb } = require('../db/connection');
const { recomputeRange } = require('../services/processor');
const { todayKey, addDays } = require('../lib/localDate');

const router = express.Router();
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function validateShift(body, { partial = false } = {}) {
  const errors = [];
  const data = {};
  if (!partial || body.name !== undefined) {
    data.name = body.name == null ? '' : String(body.name).trim();
    if (!data.name) errors.push('name is required');
  }
  if (!partial || body.start_time !== undefined) {
    data.start_time = String(body.start_time || '').slice(0, 5);
    if (!TIME_RE.test(data.start_time)) errors.push('start_time must be HH:MM (24h)');
  }
  if (!partial || body.end_time !== undefined) {
    data.end_time = String(body.end_time || '').slice(0, 5);
    if (!TIME_RE.test(data.end_time)) errors.push('end_time must be HH:MM (24h)');
  }
  if (!partial || body.grace_period_minutes !== undefined) {
    const g = Number(body.grace_period_minutes ?? 10);
    if (!Number.isInteger(g) || g < 0 || g > 240) errors.push('grace_period_minutes must be 0–240');
    else data.grace_period_minutes = g;
  }
  if (!partial || body.description !== undefined) data.description = body.description == null ? null : String(body.description);
  if (body.is_default !== undefined) data.is_default = body.is_default ? 1 : 0;
  return { errors, data };
}

router.get('/', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM teachers t WHERE t.shift_id = s.id) AS teacher_count
       FROM shifts s ORDER BY s.start_time`
    )
    .all();
  res.json({ data: rows });
});

router.post('/', (req, res) => {
  const { errors, data } = validateShift(req.body);
  if (errors.length) return res.status(422).json({ error: errors.join('; ') });
  const db = getDb();
  try {
    db.exec('BEGIN');
    if (data.is_default) db.prepare('UPDATE shifts SET is_default = 0').run();
    const info = db
      .prepare(
        `INSERT INTO shifts (name, start_time, end_time, grace_period_minutes, description, is_default)
         VALUES (@name, @start_time, @end_time, @grace_period_minutes, @description, @is_default)`
      )
      .run({ description: null, is_default: 0, ...data });
    db.exec('COMMIT');
    res.status(201).json({ data: db.prepare('SELECT * FROM shifts WHERE id = ?').get(info.lastInsertRowid) });
  } catch (err) {
    db.exec('ROLLBACK');
    if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'A shift with this name already exists' });
    throw err;
  }
});

router.put('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Shift not found' });

  const { errors, data } = validateShift(req.body, { partial: true });
  if (errors.length) return res.status(422).json({ error: errors.join('; ') });

  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (keys.length) {
    try {
      db.exec('BEGIN');
      if (data.is_default) db.prepare('UPDATE shifts SET is_default = 0 WHERE id != ?').run(req.params.id);
      db.prepare(
        `UPDATE shifts SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`
      ).run({ ...data, __id: Number(req.params.id) });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'A shift with this name already exists' });
      throw err;
    }
  }

  // Shift timings changed → statuses for last 30 days may be stale; rebuild.
  const timingChanged = keys.some((k) => ['start_time', 'end_time', 'grace_period_minutes'].includes(k));
  if (timingChanged) {
    const today = todayKey();
    const from = addDays(today, -30);
    recomputeRange(from, today);
  }

  res.json({ data: db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  const refs = db.prepare('SELECT COUNT(*) AS c FROM teachers WHERE shift_id = ?').get(req.params.id).c;
  if (refs > 0)
    return res.status(409).json({ error: `Shift is assigned to ${refs} teacher(s) — reassign them first` });
  db.prepare('DELETE FROM shifts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
