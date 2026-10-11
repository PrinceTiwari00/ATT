const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ATT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'att-calendar-'));
process.env.ZK_MODE = 'mock';
delete process.env.APP_PASSWORD;

const { bootServer } = require('../src/bootstrap');
const { getDb } = require('../src/db/connection');
const { eachDay } = require('../src/lib/localDate');
const { readCalendar, isWorkingDate } = require('../src/services/calendar');
const { bsMonthRange } = require('../src/lib/nepaliDate');

let server;
let base;
const json = (response) => response.json();

 test.before(async () => {
  server = await bootServer({ port: 0, poll: false, mode: 'test' });
  base = server.url;
});

test.after(async () => {
  await server?.close();
});

test('school calendar stores a configurable workweek and one-off plus annual BS holidays', async () => {
  const initial = await json(await fetch(`${base}/api/calendar`));
  assert.deepEqual(initial.data.workingDays, [1, 2, 3, 4, 5]);
  assert.deepEqual(initial.data.holidays, []);

  const workdaysResponse = await fetch(`${base}/api/calendar/workdays`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workingDays: [1, 2, 3, 4, 5] }),
  });
  assert.equal(workdaysResponse.status, 200);

  const oneOff = await fetch(`${base}/api/calendar/holidays`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'School Foundation Day', kind: 'once', date: '2026-04-20' }),
  });
  assert.equal(oneOff.status, 201);

  const annual = await fetch(`${base}/api/calendar/holidays`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Annual BS holiday', kind: 'annual', bsMonth: 1, bsDay: 4 }),
  });
  assert.equal(annual.status, 201);

  const calendar = await json(await fetch(`${base}/api/calendar`));
  assert.equal(calendar.data.holidays.length, 2);
  assert.equal(calendar.data.holidays.find((h) => h.kind === 'annual').bsLabel, '4 Baisakh (every BS year)');

  const duplicate = await fetch(`${base}/api/calendar/holidays`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Duplicate', kind: 'once', date: '2026-04-20' }),
  });
  assert.equal(duplicate.status, 409);
});

test('monthly BS report excludes weekends, named holidays and future workdays from absence totals', async (t) => {
  const db = getDb();
  const shiftId = db.prepare(
    `INSERT INTO shifts (name, start_time, end_time, grace_period_minutes, is_default)
     VALUES ('Report shift', '08:00', '16:00', 10, 1)`
  ).run().lastInsertRowid;
  const teacherId = db.prepare(
    `INSERT INTO teachers (zk_user_id, full_name, department, designation, shift_id, status)
     VALUES ('9001', 'Report Teacher', 'General', 'Teacher', ?, 'active')`
  ).run(shiftId).lastInsertRowid;

  const insertPunch = db.prepare(
    `INSERT INTO attendance_logs (teacher_id, zk_user_id, punch_time, punch_type, source)
     VALUES (?, '9001', ?, 0, 'device')`
  );
  // BS 2083 Baisakh 2: late arrival and 30 minutes of overtime.
  insertPunch.run(teacherId, '2026-04-15T08:25:00');
  insertPunch.run(teacherId, '2026-04-15T16:30:00');
  // BS 2083 Baisakh 3: 30 minutes early departure.
  insertPunch.run(teacherId, '2026-04-16T08:00:00');
  insertPunch.run(teacherId, '2026-04-16T15:30:00');

  // Freeze a date within Baisakh 2083. May 1 is after both configured holidays
  // and before the month end, so the remaining days must not count as absent.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 4, 1, 12, 0) });
  try {
    const response = await fetch(`${base}/api/reports/monthly?bsYear=2083&bsMonth=1`);
    assert.equal(response.status, 200);
    const { data } = await json(response);
    assert.equal(data.period.bsLabel, 'Baisakh 2083 BS');
    assert.equal(data.period.from, '2026-04-14');
    assert.equal(data.period.to, '2026-05-14');
    assert.equal(data.period.asOf, '2026-05-01');

    const row = data.staff.find((person) => person.id === teacherId);
    assert.ok(row);
    assert.equal(row.presentDays, 2);
    assert.equal(row.lateDays, 1);
    assert.equal(row.lateMinutes, 25);
    assert.equal(row.earlyDepartureDays, 1);
    assert.equal(row.earlyMinutes, 30);
    assert.equal(row.overtimeDays, 1);
    assert.equal(row.overtimeMinutes, 30);
    assert.equal(row.nonWorkingDayPunches, 0);

    const calendar = readCalendar();
    const elapsedWorkdays = [...eachDay(data.period.from, data.period.asOf)]
      .filter((date) => isWorkingDate(date, calendar)).length;
    assert.equal(row.workingDays, elapsedWorkdays);
    assert.equal(row.absentDays, elapsedWorkdays - row.presentDays);
    assert.ok(data.summary.remainingWorkdays > 0);
    assert.equal(data.holidays.length, 2);
    assert.equal(data.summary.lateMinutes, 25);
    assert.equal(data.summary.earlyMinutes, 30);
    assert.equal(data.summary.overtimeMinutes, 30);

    // The daily ledger must not create absence rows on the Saturday or named holidays.
    for (const date of ['2026-04-18', '2026-04-17', '2026-04-20']) {
      const daily = await json(await fetch(`${base}/api/attendance/daily?date=${date}`));
      assert.equal(daily.data.length, 0, `no absent record expected for non-working date ${date}`);
    }
  } finally {
    t.mock.timers.reset();
  }
});

 test('workday API rejects an empty or invalid week', async () => {
  const response = await fetch(`${base}/api/calendar/workdays`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workingDays: [7] }),
  });
  assert.equal(response.status, 422);
});
