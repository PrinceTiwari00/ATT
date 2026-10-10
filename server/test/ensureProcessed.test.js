/**
 * REGRESSION — "today" must be the local calendar day, even very early in the morning.
 *
 * Before the fix, ensureProcessed() derived today from toISOString(). In a zone
 * east of UTC, e.g. Asia/Kathmandu (UTC+05:45), at 03:00 local the UTC date is
 * still YESTERDAY, so the clamp dropped today and today's summary was never
 * rebuilt. This test pins the clock at 03:00 local on 10 Oct 2026 and asks for
 * that day.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ATT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'att-ensure-'));
process.env.ZK_MODE = 'mock';

const { migrate } = require('../src/db/migrate');
const { getDb } = require('../src/db/connection');
const { ensureProcessed } = require('../src/services/processor');

migrate();
const db = getDb();

test('ensureProcessed rebuilds TODAY at 03:00 local, before the 05:45 Kathmandu boundary', (t) => {
  db.prepare(
    `INSERT INTO shifts (name, start_time, end_time, grace_period_minutes, is_default)
     VALUES ('School day', '08:00', '16:00', 10, 1)`
  ).run();
  const teacherId = db
    .prepare(
      `INSERT INTO teachers (zk_user_id, full_name, department, designation, status)
       VALUES ('501', 'Early Bird', 'General', 'Teacher', 'active')`
    )
    .run().lastInsertRowid;
  for (const punch of ['2026-10-10T07:55:00', '2026-10-10T16:05:00']) {
    db.prepare(
      `INSERT INTO attendance_logs (teacher_id, zk_user_id, device_sn, punch_time, punch_type, source)
       VALUES (?, '501', 'TEST-SN', ?, 0, 'device')`
    ).run(teacherId, punch);
  }

  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 10, 3, 0) });
  try {
    // Nothing has been processed for 10 Oct yet.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM processed_attendance WHERE work_date = ?').get('2026-10-10').c,
      0
    );

    ensureProcessed('2026-10-10', '2026-10-10');

    const row = db
      .prepare('SELECT * FROM processed_attendance WHERE teacher_id = ? AND work_date = ?')
      .get(teacherId, '2026-10-10');
    assert.ok(row, 'today (2026-10-10) must be processed, not clamped away to 2026-10-09');
    assert.equal(row.punch_count, 2);
    assert.equal(row.status, 'on_time');
  } finally {
    t.mock.timers.reset();
  }
});

test('ensureProcessed never materializes a day after today', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 10, 3, 0) });
  try {
    ensureProcessed('2026-10-11', '2026-10-12');
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM processed_attendance WHERE work_date >= ?').get('2026-10-11').c,
      0
    );
  } finally {
    t.mock.timers.reset();
  }
});
