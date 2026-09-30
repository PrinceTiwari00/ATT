/**
 * Attendance views + raw log inspection  (spec § D.1–D.3 / § B.2–B.3)
 */
const express = require('express');
const { getDb } = require('../db/connection');
const { ensureProcessed, recomputeRange } = require('../services/processor');

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Daily / range attendance rows with filters:
 *   ?date=YYYY-MM-DD                single day shorthand
 *   ?from=&to=                      range (inclusive, max 62 days)
 *   &q= teacher name/id search
 *   &department=&designation=&status=(on_time|late|early|late_early|absent)
 */
router.get('/daily', (req, res) => {
  const db = getDb();
  let { date, from, to, q, department, designation, status, limit } = req.query;

  if (date && DATE_RE.test(date)) {
    from = to = date;
  }
  if (!from || !DATE_RE.test(from)) from = todayStr();
  if (!to || !DATE_RE.test(to)) to = from;
  if (to < from) [from, to] = [to, from];
  const maxSpan = 62 * 864e5;
  if (new Date(to) - new Date(from) > maxSpan) {
    return res.status(422).json({ error: 'Date range too large (max 62 days)' });
  }

  ensureProcessed(from, to);

  let sql = `
    SELECT p.id, p.teacher_id, p.work_date, p.check_in, p.check_out, p.punch_count,
           p.late_minutes, p.early_minutes, p.work_minutes, p.status,
           t.full_name, t.zk_user_id, t.department, t.designation,
           s.name AS shift_name, s.start_time AS shift_start, s.end_time AS shift_end,
           s.grace_period_minutes
    FROM processed_attendance p
    JOIN teachers  t ON t.id = p.teacher_id
    LEFT JOIN shifts s ON s.id = p.shift_id
    WHERE p.work_date BETWEEN ? AND ?`;
  const args = [from, to];
  if (q) {
    sql += ' AND (t.full_name LIKE ? OR t.zk_user_id LIKE ?)';
    args.push(`%${q}%`, `%${q}%`);
  }
  if (department) { sql += ' AND t.department = ?'; args.push(department); }
  if (designation) { sql += ' AND t.designation = ?'; args.push(designation); }
  if (status) { sql += ' AND p.status = ?'; args.push(status); }
  sql += ' ORDER BY p.work_date DESC, t.full_name ASC';

  const rows = db.prepare(sql).all(...args);
  const lim = Math.min(parseInt(limit || '500', 10) || 500, 2000);

  const counts = rows.reduce(
    (acc, r) => {
      acc.total++;
      if (r.status === 'late' || r.status === 'late_early') acc.late++;
      if (r.status === 'early' || r.status === 'late_early') acc.early++;
      if (r.status === 'absent') acc.absent++;
      if (r.status === 'on_time') acc.onTime++;
      acc.present += r.punch_count > 0 ? 1 : 0;
      return acc;
    },
    { total: 0, present: 0, late: 0, early: 0, onTime: 0, absent: 0 }
  );

  res.json({ data: rows.slice(0, lim), meta: { from, to, ...counts } });
});

/** Raw punch ledger (Device page / audits) */
router.get('/logs', (req, res) => {
  const db = getDb();
  const { date, zk_user_id, limit } = req.query;
  let sql = `
    SELECT l.*, t.full_name
    FROM attendance_logs l LEFT JOIN teachers t ON t.id = l.teacher_id
    WHERE 1=1`;
  const args = [];
  if (date && DATE_RE.test(date)) { sql += ' AND substr(l.punch_time,1,10) = ?'; args.push(date); }
  if (zk_user_id) { sql += ' AND l.zk_user_id = ?'; args.push(String(zk_user_id)); }
  sql += ' ORDER BY l.punch_time DESC';
  const lim = Math.min(parseInt(limit || '200', 10) || 200, 1000);
  res.json({ data: db.prepare(sql).all(...args).slice(0, lim) });
});

/** Manual rebuild of processed summaries from the raw ledger */
router.post('/recompute', (req, res) => {
  let { from, to } = req.body || {};
  if (!from || !DATE_RE.test(from)) from = todayStr();
  if (!to || !DATE_RE.test(to)) to = from;
  if (to < from) [from, to] = [to, from];
  const days = recomputeRange(from, to);
  res.json({ ok: true, recomputedDays: days });
});

module.exports = router;
