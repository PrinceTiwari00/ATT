/**
 * REGRESSION GUARD — punches that arrive before their teacher profile exists.
 *
 * The failure this pins down is the classic fresh install:
 *
 *   1. the school connects the terminal and the poller pulls the whole log
 *      (punches land in attendance_logs with teacher_id = NULL, because nobody
 *      is registered yet),
 *   2. staff are registered afterwards,
 *   3. every one of those days reads "absent" — the punches are in the ledger
 *      but the daily engine can only see rows that point at a teacher.
 *
 * The fix is adoptOrphanPunches()/adoptAndRecompute(): the durable zk_user_id is
 * never rewritten, only the derived teacher_id back-filled, and exactly the
 * affected days are rebuilt.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set before config.js is first required (dbPath is computed from it).
process.env.ATT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'att-orphans-'));
process.env.ZK_MODE = 'mock';

const { migrate } = require('../src/db/migrate');
const { getDb } = require('../src/db/connection');
const {
  recomputeDate,
  adoptOrphanPunches,
  adoptAndRecompute,
} = require('../src/services/processor');
const { todayStr } = require('../src/zk/deviceContract');
const { addDays } = require('../src/lib/localDate');

migrate();

const db = getDb();
// This suite tests punch adoption on whatever weekday the clock lands; make
// every day a workday so the calendar policy does not affect its assertions.
db.prepare("UPDATE calendar_settings SET working_days = '[0,1,2,3,4,5,6]' WHERE id = 1").run();
const TODAY = todayStr();
// Calendar arithmetic on the local date. Never toISOString() here: in zones
// east of UTC, local midnight is the previous UTC day and TOMORROW == TODAY.
const TOMORROW = addDays(TODAY, 1);

db.prepare(
  `INSERT INTO shifts (name, start_time, end_time, grace_period_minutes, is_default)
   VALUES ('School day', '08:00', '16:00', 10, 1)`
).run();

/** A punch exactly as the poller stores it from the device: durable zk_user_id. */
function insertPunch(zkUserId, punchTime, teacherId = null) {
  db.prepare(
    `INSERT INTO attendance_logs (teacher_id, zk_user_id, device_sn, punch_time, punch_type, source)
     VALUES (?, ?, 'TEST-SN', ?, 0, 'device')`
  ).run(teacherId, zkUserId, punchTime);
}

function insertTeacher(zkUserId, fullName) {
  return db
    .prepare(
      `INSERT INTO teachers (zk_user_id, full_name, department, designation, status)
       VALUES (?, ?, 'General', 'Teacher', 'active')`
    )
    .run(zkUserId, fullName).lastInsertRowid;
}

const dayRow = (teacherId, workDate) =>
  db
    .prepare('SELECT * FROM processed_attendance WHERE teacher_id = ? AND work_date = ?')
    .get(teacherId, workDate);

/* ── the reported failure, exactly ──────────────────────────────────────── */

test('history synced BEFORE registration reads absent until the punches are adopted', async (t) => {
  await t.test('setup: punches for an unregistered device id', () => {
    insertPunch('77', `${TODAY}T07:55:00`);
    insertPunch('77', `${TODAY}T16:05:00`);
  });

  await t.test('the teacher is registered afterwards', () => {
    t.diagnostic(`teacher id ${insertTeacher('77', 'Ram Bahadur')}`);
  });

  await t.test('without adoption the day is computed as absent (the bug)', () => {
    recomputeDate(TODAY);
    const teacher = db.prepare("SELECT id FROM teachers WHERE zk_user_id = '77'").get();
    const row = dayRow(teacher.id, TODAY);
    assert.equal(row.status, 'absent');
    assert.equal(row.punch_count, 0);
    // and the evidence is still sitting in the ledger, unlinked
    assert.equal(
      db.prepare("SELECT COUNT(*) c FROM attendance_logs WHERE teacher_id IS NULL AND zk_user_id = '77'").get().c,
      2
    );
  });

  await t.test('adoption links the rows and rebuilds the day to on_time', () => {
    const res = adoptAndRecompute({ includeToday: true });
    assert.equal(res.linked, 2);
    assert.ok(res.days.includes(TODAY));

    const teacher = db.prepare("SELECT id FROM teachers WHERE zk_user_id = '77'").get();
    const row = dayRow(teacher.id, TODAY);
    assert.equal(row.check_in, `${TODAY}T07:55:00`);
    assert.equal(row.check_out, `${TODAY}T16:05:00`);
    assert.equal(row.punch_count, 2);
    assert.equal(row.status, 'on_time');
    assert.equal(row.late_minutes, 0);
    assert.equal(row.early_minutes, 0);
  });

  await t.test('raw ledger rows are preserved, never rewritten', () => {
    const rows = db
      .prepare("SELECT * FROM attendance_logs WHERE zk_user_id = '77' ORDER BY punch_time")
      .all();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.punch_time),
      [`${TODAY}T07:55:00`, `${TODAY}T16:05:00`]
    );
    assert.deepEqual(rows.map((r) => r.zk_user_id), ['77', '77']);
    assert.equal(rows[0].source, 'device');
    assert.ok(rows.every((r) => r.teacher_id !== null));
  });

  await t.test('a second pass is a no-op (idempotent)', () => {
    assert.deepEqual(adoptOrphanPunches(), { linked: 0, dates: [] });
    const before = dayRow(db.prepare("SELECT id FROM teachers WHERE zk_user_id = '77'").get().id, TODAY);
    const res = adoptAndRecompute({ includeToday: true });
    assert.equal(res.linked, 0);
    const after = dayRow(db.prepare("SELECT id FROM teachers WHERE zk_user_id = '77'").get().id, TODAY);
    assert.equal(after.status, before.status);
    assert.equal(after.punch_count, 2);
  });
});

/* ── the poller path: an id that is still unknown stays stored ──────────── */

test('punches for genuinely unknown ids stay orphaned and discoverable', () => {
  insertPunch('99', `${TODAY}T09:15:00`);
  const res = adoptOrphanPunches();
  assert.equal(res.linked, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM attendance_logs WHERE teacher_id IS NULL AND zk_user_id = '99'").get().c,
    1
  );
  // the Device page's "unknown device IDs" query still finds it
  const unknown = db
    .prepare('SELECT zk_user_id FROM attendance_logs WHERE teacher_id IS NULL GROUP BY zk_user_id')
    .all()
    .map((r) => r.zk_user_id);
  assert.ok(unknown.includes('99'));
});

/* ── guard rail: never materialize future days ─────────────────────────── */

test('adoption refuses to materialize future work dates', () => {
  insertTeacher('88', 'Future Person');
  insertPunch('88', `${TOMORROW}T08:00:00`);

  const res = adoptAndRecompute({ includeToday: true });
  assert.ok(res.linked >= 1, 'the row is still linked to its teacher');
  assert.ok(!res.days.includes(TOMORROW), 'future days must never be recomputed into the ledger');
  const teacher = db.prepare("SELECT id FROM teachers WHERE zk_user_id = '88'").get();
  assert.equal(dayRow(teacher.id, TOMORROW), undefined);
});
