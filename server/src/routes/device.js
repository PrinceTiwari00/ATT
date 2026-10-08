/**
 * Device management  (spec § A.2 / § B.1) — link status, manual sync,
 * enrollment push/pull, orphan device-ID discovery.
 */
const express = require('express');
const { getDb } = require('../db/connection');
const { getManager } = require('../zk/manager');
const { syncOnce } = require('../services/poller');
const { adoptAndRecompute } = require('../services/processor');

const router = express.Router();

router.get('/status', (req, res) => {
  const db = getDb();
  const counts = {
    teachers: db.prepare('SELECT COUNT(*) c FROM teachers').get().c,
    activeTeachers: db.prepare("SELECT COUNT(*) c FROM teachers WHERE status='active'").get().c,
    rawLogs: db.prepare('SELECT COUNT(*) c FROM attendance_logs').get().c,
    todayLogs: db
      .prepare("SELECT COUNT(*) c FROM attendance_logs WHERE substr(punch_time,1,10) = date('now','localtime')")
      .get().c,
    processedDays: db.prepare('SELECT COUNT(DISTINCT work_date) c FROM processed_attendance').get().c,
  };
  res.json({ data: { ...getManager().status(), counts } });
});

router.post('/test', async (req, res) => {
  const result = await getManager().testConnection();
  res.status(result.ok ? 200 : 502).json({ data: result });
});

/** Manual "Fetch Logs Now" — same path as the cron poller. */
router.post('/sync-now', async (req, res) => {
  const result = await syncOnce('manual');
  res.status(result.ok ? 200 : result.skipped ? 409 : 502).json({ data: result });
});

/** List the users currently enrolled on the device. */
router.get('/users', async (req, res) => {
  try {
    const users = await getManager().getUsers();
    const db = getDb();
    const known = new Set(db.prepare('SELECT zk_user_id FROM teachers').all().map((r) => r.zk_user_id));
    res.json({
      data: users.map((u) => ({ ...u, userId: String(u.userId), registered: known.has(String(u.userId)) })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Import device users as teacher profiles (Smart import). Body:
 *   { users: [{userId, name}], department?, designation?, shiftId? }
 */
router.post('/users/import', (req, res) => {
  const users = Array.isArray(req.body?.users) ? req.body.users : [];
  if (users.length === 0) return res.status(422).json({ error: 'users[] is required' });
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO teachers (zk_user_id, full_name, department, designation, shift_id, status)
     VALUES (?, ?, ?, ?, ?, 'active')
     ON CONFLICT (zk_user_id) DO UPDATE SET full_name = excluded.full_name,
       department = COALESCE(teachers.department, excluded.department),
       updated_at = datetime('now','localtime')`
  );
  let imported = 0;
  db.exec('BEGIN');
  try {
    for (const u of users) {
      if (u.userId == null || u.userId === '') continue;
      insert.run(
        String(u.userId),
        String(u.name || `Device user ${u.userId}`).trim() || `Device user ${u.userId}`,
        req.body.department || 'General',
        ['Teacher', 'Staff'].includes(req.body.designation) ? req.body.designation : 'Teacher',
        req.body.shiftId ?? null
      );
      imported++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // Newly imported teachers almost always already own punches on the terminal
  // (this route exists precisely for that case). Link those rows AND rebuild the
  // days they touch — linking alone leaves stale "absent" summaries behind.
  const adoption = adoptAndRecompute({ includeToday: imported > 0 });
  res.json({ ok: true, imported, linkedPunches: adoption.linked, daysRecomputed: adoption.days.length });
});

/** Push EVERY active teacher's enrollment to the device. */
router.post('/users/push-all', async (req, res) => {
  const db = getDb();
  const teachers = db.prepare("SELECT zk_user_id, full_name FROM teachers WHERE status = 'active'").all();
  const manager = getManager();

  // The connected library may have no user-writing API at all (node-zklib 1.x):
  // say so once, with the terminal-side workaround, instead of failing per
  // teacher with an opaque protocol error.
  const caps = manager.capabilities();
  if (caps && caps.canWriteUsers === false) {
    return res.status(422).json({
      ok: false,
      error: caps.writeUsersHint,
      data: { total: teachers.length, pushed: 0, results: [], capabilities: caps },
    });
  }

  const results = [];
  for (const t of teachers) {
    try {
      await manager.setUser({ userId: t.zk_user_id, name: t.full_name });
      results.push({ zk_user_id: t.zk_user_id, ok: true });
    } catch (err) {
      results.push({ zk_user_id: t.zk_user_id, ok: false, error: err.message });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  res.status(okCount === results.length ? 200 : 207).json({
    data: { total: results.length, pushed: okCount, results },
  });
});

/** Punching IDs seen in logs with no matching teacher profile. */
router.get('/unknown-users', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT zk_user_id, COUNT(*) AS punches,
              MIN(punch_time) AS first_seen, MAX(punch_time) AS last_seen
       FROM attendance_logs WHERE teacher_id IS NULL
       GROUP BY zk_user_id ORDER BY last_seen DESC`
    )
    .all();
  res.json({ data: rows });
});

module.exports = router;
