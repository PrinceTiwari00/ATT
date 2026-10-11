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
const { addDays, eachDay, parseLocalDate, todayKey } = require('../src/lib/localDate');
const { readCalendar, isWorkingDate } = require('../src/services/calendar');
const { adToBs, bsMonthRange } = require('../src/lib/nepaliDate');

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

/* ── calendar grid: day status + per-day work/holiday decisions ─────────── */

const post = (path, body, method = 'PUT') => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Most recent occurrence of `weekday` (0=Sun … 6=Sat) strictly before today. */
function pastDateForWeekday(weekday) {
  let key = addDays(todayKey(), -1);
  for (let step = 0; step < 7; step += 1) {
    if (parseLocalDate(key).getDay() === weekday) return key;
    key = addDays(key, -1);
  }
  throw new Error(`no past ${weekday} found`);
}

const indexDays = (days) => Object.fromEntries(days.map((day) => [day.date, day]));

test('calendar day status explains why each day works or not', async () => {
  const response = await fetch(`${base}/api/calendar/days?from=2026-04-14&to=2026-04-20`);
  assert.equal(response.status, 200);
  const { data } = await json(response);
  assert.equal(data.days.length, 7);
  const byDate = indexDays(data.days);

  // 2026-04-14 = Baisakh 1, 2083 BS — a plain Tuesday of the regular workweek.
  assert.equal(byDate['2026-04-14'].isWorkingDay, true);
  assert.equal(byDate['2026-04-14'].source, 'workweek');
  assert.equal(byDate['2026-04-14'].bs.day, 1);

  // Annual BS holiday (4 Baisakh) and the one-off holiday added above.
  assert.equal(byDate['2026-04-17'].source, 'holiday');
  assert.equal(byDate['2026-04-17'].isWorkingDay, false);
  assert.deepEqual(byDate['2026-04-17'].holidayNames, ['Annual BS holiday']);
  assert.deepEqual(byDate['2026-04-20'].holidayNames, ['School Foundation Day']);

  // Weekend of the regular workweek.
  assert.equal(byDate['2026-04-18'].source, 'off_week');
  assert.equal(byDate['2026-04-18'].isWorkingDay, false);
  assert.equal(byDate['2026-04-18'].isHoliday, false);
});

test('a holiday can be turned into a working day — and a weekly off can be worked', async () => {
  const saturday = pastDateForWeekday(6);
  const response = await post('/api/calendar/days', {
    dates: ['2026-04-17', saturday],
    mode: 'workday',
    note: 'Exam make-up',
  });
  assert.equal(response.status, 200);
  const { data } = await json(response);
  const byDate = indexDays(data.days);

  // The annual holiday is only exempted for this one date …
  assert.equal(byDate['2026-04-17'].isWorkingDay, true);
  assert.equal(byDate['2026-04-17'].source, 'override');
  assert.equal(byDate['2026-04-17'].override.isWorking, true);
  assert.equal(byDate['2026-04-17'].override.note, 'Exam make-up');
  assert.deepEqual(byDate['2026-04-17'].holidayNames, ['Annual BS holiday']);
  // … and the Saturday of the regular week can be worked as well.
  assert.equal(byDate[saturday].isWorkingDay, true);
  assert.equal(byDate[saturday].weeklyWorkday, false);

  const calendar = await json(await fetch(`${base}/api/calendar`));
  assert.equal(calendar.data.overrides.length, 2);
  assert.ok(calendar.data.holidays.some((holiday) => holiday.kind === 'annual'),
    'the recurring holiday definition must survive a day-level override');
  assert.equal(readCalendar().workingDays.includes(6), false);

  // A day that is worked now materializes absences for staff who did not punch.
  const daily = await json(await fetch(`${base}/api/attendance/daily?date=${saturday}`));
  assert.ok(daily.data.some((row) => row.status === 'absent'));

  // Back to the school default: the holiday returns, the absences disappear.
  const reset = await post('/api/calendar/days', { dates: ['2026-04-17', saturday], mode: 'default' });
  assert.equal(reset.status, 200);
  const after = await json(reset);
  const resetByDate = indexDays(after.data.days);
  assert.equal(resetByDate['2026-04-17'].source, 'holiday');
  assert.equal(resetByDate['2026-04-17'].isWorkingDay, false);
  assert.equal(resetByDate['2026-04-17'].override, null);
  assert.equal(resetByDate[saturday].isWorkingDay, false);
  assert.equal(after.data.overrides.length, 0);
  const dailyAfter = await json(await fetch(`${base}/api/attendance/daily?date=${saturday}`));
  assert.equal(dailyAfter.data.length, 0);
});

test('selecting a day on the calendar can add a one-off or a recurring holiday', async () => {
  const wednesday = pastDateForWeekday(3);
  const oneOff = await post('/api/calendar/days', {
    dates: [wednesday], mode: 'holiday', name: 'Sports Day',
  });
  assert.equal(oneOff.status, 200);
  const afterOneOff = await json(oneOff);
  assert.equal(afterOneOff.data.days[0].isHoliday, true);
  assert.deepEqual(afterOneOff.data.days[0].holidayNames, ['Sports Day']);
  assert.equal(afterOneOff.data.days[0].isWorkingDay, false);
  assert.ok(afterOneOff.data.holidays.some((h) => h.kind === 'once' && h.date === wednesday && h.name === 'Sports Day'));

  // Same day, now recurring: the one-off twin is replaced by an annual rule so
  // the holiday list never shows the same date twice.
  const recurring = await post('/api/calendar/days', {
    dates: [wednesday], mode: 'holiday', name: 'Sports Day (annual)', repeat: true,
  });
  assert.equal(recurring.status, 200);
  const { data } = await json(recurring);
  const bs = adToBs(wednesday);
  assert.ok(data.holidays.some((h) => h.kind === 'annual' && h.bsMonth === bs.month && h.bsDay === bs.day));
  assert.equal(data.holidays.filter((h) => h.date === wednesday).length, 0);
  assert.equal(data.days[0].isHoliday, true);
});

test('calendar day API rejects malformed selections', async () => {
  assert.equal((await fetch(`${base}/api/calendar/days?from=2026-04-14&to=not-a-date`)).status, 422);
  assert.equal((await fetch(`${base}/api/calendar/days?from=2026-04-14&to=2027-04-14`)).status, 422);
  assert.equal((await post('/api/calendar/days', { dates: [], mode: 'workday' })).status, 422);
  assert.equal((await post('/api/calendar/days', { dates: ['2026-13-40'], mode: 'workday' })).status, 422);
  assert.equal((await post('/api/calendar/days', { dates: ['2026-04-17'], mode: 'party' })).status, 422);
  assert.equal((await post('/api/calendar/days', {
    dates: Array.from({ length: 201 }, (_, i) => addDays('2026-04-14', i)),
    mode: 'workday',
  })).status, 422);
});
