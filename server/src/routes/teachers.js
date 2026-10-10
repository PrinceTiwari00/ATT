/**
 * Teacher & Staff CRUD  (spec § A.1) + device enrollment sync (spec § A.2)
 */
const express = require('express');
const { getDb } = require('../db/connection');
const { getManager } = require('../zk/manager');
const { recomputeRange, adoptAndRecompute } = require('../services/processor');
const { todayKey, addDays } = require('../lib/localDate');

/**
 * Something changed the roster (a profile was created, edited or imported).
 * Two things must follow, in this order:
 *   1. adopt punches that arrived before their profile existed, and
 *   2. rebuild the affected days (plus today, so the roster change is visible
 *      in the current ledger immediately).
 */
function refreshAfterRosterChange({ includeToday = true } = {}) {
  try {
    return adoptAndRecompute({ includeToday });
  } catch (err) {
    // never fail the write because a rebuild hiccuped — the poller retries
    console.error(`[teachers] post-write recompute failed: ${err.message}`);
    return { linked: 0, days: [] };
  }
}

const router = express.Router();

function validateTeacher(body, { partial = false } = {}) {
  const errors = [];
  const pick = {};
  const str = (v) => (v == null ? null : String(v).trim());

  if (!partial || body.zk_user_id !== undefined) {
    pick.zk_user_id = str(body.zk_user_id);
    if (!pick.zk_user_id) errors.push('zk_user_id (ZKTeco User ID) is required');
  }
  if (!partial || body.full_name !== undefined) {
    pick.full_name = str(body.full_name);
    if (!pick.full_name) errors.push('full_name is required');
  }
  if (!partial || body.department !== undefined) pick.department = str(body.department) || 'General';
  if (!partial || body.designation !== undefined) {
    pick.designation = str(body.designation) || 'Teacher';
    if (!['Teacher', 'Staff'].includes(pick.designation))
      errors.push("designation must be 'Teacher' or 'Staff'");
  }
  if (!partial || body.shift_id !== undefined) {
    // Omitting shift_id entirely is legitimate (the profile falls back to the
    // default shift) — it must become NULL, not Number(undefined) → NaN → 422.
    const raw = body.shift_id;
    pick.shift_id = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (pick.shift_id !== null && !Number.isInteger(pick.shift_id)) errors.push('shift_id must be an integer or null');
  }
  if (!partial || body.email !== undefined) {
    pick.email = str(body.email);
    if (pick.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(pick.email)) errors.push('invalid email');
  }
  if (!partial || body.phone !== undefined) pick.phone = str(body.phone);
  if (!partial || body.status !== undefined) {
    pick.status = str(body.status) || 'active';
    if (!['active', 'inactive'].includes(pick.status)) errors.push("status must be 'active' or 'inactive'");
  }
  return { errors, data: pick };
}

/* List with optional filters */
router.get('/', (req, res) => {
  const db = getDb();
  const { q, department, designation, status } = req.query;
  let sql = `
    SELECT t.*, s.name AS shift_name, s.start_time AS shift_start, s.end_time AS shift_end
    FROM teachers t LEFT JOIN shifts s ON s.id = t.shift_id
    WHERE 1=1`;
  const args = [];
  if (q) {
    sql += ' AND (t.full_name LIKE ? OR t.zk_user_id LIKE ? OR t.email LIKE ?)';
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  if (department) { sql += ' AND t.department = ?'; args.push(department); }
  if (designation) { sql += ' AND t.designation = ?'; args.push(designation); }
  if (status === 'archived') { /* reserved */ }
  if (status) { sql += ' AND t.status = ?'; args.push(status); }
  sql += ' ORDER BY t.full_name';
  res.json({ data: db.prepare(sql).all(...args) });
});

router.get('/departments', (req, res) => {
  const rows = getDb().prepare('SELECT DISTINCT department FROM teachers ORDER BY department').all();
  res.json({ data: rows.map((r) => r.department) });
});

router.get('/:id', (req, res) => {
  const row = getDb()
    .prepare(
      `SELECT t.*, s.name AS shift_name FROM teachers t
       LEFT JOIN shifts s ON s.id = t.shift_id WHERE t.id = ?`
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Teacher not found' });
  res.json({ data: row });
});

/* Create (optionally also enroll on the device) */
router.post('/', async (req, res) => {
  const { errors, data } = validateTeacher(req.body);
  if (errors.length) return res.status(422).json({ error: errors.join('; ') });

  const db = getDb();
  if (data.shift_id != null && !db.prepare('SELECT id FROM shifts WHERE id = ?').get(data.shift_id)) {
    return res.status(422).json({ error: 'shift_id does not exist' });
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO teachers (zk_user_id, full_name, department, designation, shift_id, email, phone, status)
         VALUES (@zk_user_id, @full_name, @department, @designation, @shift_id, @email, @phone, @status)`
      )
      .run({ status: 'active', department: 'General', designation: 'Teacher', ...data });
    const created = db.prepare('SELECT * FROM teachers WHERE id = ?').get(info.lastInsertRowid);

    // This person may already have punched on the terminal (the device was
    // synced before their profile existed) — adopt those rows and rebuild the
    // days, including today so they appear in the ledger straight away.
    const adoption = refreshAfterRosterChange({ includeToday: created.status === 'active' });

    let pushResult = null;
    if (req.body.pushToDevice) {
      try {
        await getManager().setUser({ userId: data.zk_user_id, name: data.full_name });
        pushResult = { ok: true };
      } catch (err) {
        pushResult = { ok: false, error: err.message };
      }
    }
    res.status(201).json({
      data: created,
      devicePush: pushResult,
      linkedPunches: adoption.linked,
    });
  } catch (err) {
    if (/UNIQUE/.test(err.message))
      return res.status(409).json({ error: `ZKTeco User ID "${data.zk_user_id}" is already registered` });
    throw err;
  }
});

/* Update — if the shift changed, rebuild recent processed rows so statuses
   immediately reflect the new schedule. */
router.put('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM teachers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Teacher not found' });

  const { errors, data } = validateTeacher(req.body, { partial: true });
  if (errors.length) return res.status(422).json({ error: errors.join('; ') });

  const keys = Object.keys(data);
  if (keys.length === 0) return res.json({ data: existing });
  if (data.shift_id != null && !db.prepare('SELECT id FROM shifts WHERE id = ?').get(data.shift_id)) {
    return res.status(422).json({ error: 'shift_id does not exist' });
  }
  try {
    db.prepare(
      `UPDATE teachers SET ${keys.map((k) => `${k} = @${k}`).join(', ')},
         updated_at = datetime('now','localtime')
       WHERE id = @__id`
    ).run({ ...data, __id: Number(req.params.id) });
  } catch (err) {
    if (/UNIQUE/.test(err.message))
      return res.status(409).json({ error: `ZKTeco User ID is already registered` });
    throw err;
  }

  if (data.shift_id !== undefined && data.shift_id !== existing.shift_id) {
    const today = todayKey();
    const from = addDays(today, -30);
    recomputeRange(from, today); // cheap enough; keeps reports consistent
  }

  // A changed zk_user_id leaves its punches orphaned until they are adopted
  // again; any roster edit should also be visible in today's ledger.
  const adoption = refreshAfterRosterChange();

  const row = db
    .prepare(
      `SELECT t.*, s.name AS shift_name FROM teachers t
       LEFT JOIN shifts s ON s.id = t.shift_id WHERE t.id = ?`
    )
    .get(req.params.id);
  res.json({ data: row, linkedPunches: adoption.linked });
});

/* Delete */
router.delete('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM teachers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Teacher not found' });
  db.prepare('DELETE FROM teachers WHERE id = ?').run(req.params.id);
  // attendance_logs keep their raw rows with teacher_id set to NULL (FK SET NULL)
  res.json({ ok: true });
});

/* Push a single teacher's enrollment to the device */
router.post('/:id/push-to-device', async (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT * FROM teachers WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Teacher not found' });

  // Refuse before touching the network when the connected library has no
  // user-enrollment API (node-zklib 1.x) — with the terminal-side workaround.
  const caps = getManager().capabilities();
  if (caps && caps.canWriteUsers === false) {
    return res.status(422).json({ ok: false, error: caps.writeUsersHint, capabilities: caps });
  }

  try {
    await getManager().setUser({ userId: t.zk_user_id, name: t.full_name });
    res.json({ ok: true, message: `Enrolled ${t.full_name} (ID ${t.zk_user_id}) on the device` });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
