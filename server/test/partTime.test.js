/**
 * REGRESSION — part-time staff and personal working-day patterns.
 *
 * Before teachers.employment_type / teachers.working_days existed, every active
 * profile was expected on every school working day: a Mon/Wed/Fri teacher
 * silently collected two absences a week, the dashboard counted them as rostered
 * on days they never work, and a punch on a day off was charged as lateness.
 *
 * These tests run against a real (temporary) database, so they also pin
 * migration #4 and the report/dashboard maths that reads the pattern.
 *
 * Baisakh 2083 BS = 2026-04-14 (Tue) … 2026-05-14 (Thu) with the default
 * Mon–Fri school week: Tue/Wed/Thu fall in it 5 times each, Mon/Fri/Sat/Sun 4
 * times ⇒ 23 school working days and 13 Mon/Wed/Fri days in the month.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ATT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'att-parttime-'));
process.env.ZK_MODE = 'mock';
process.env.SEED_DEMO = 'false';
delete process.env.APP_PASSWORD;

const { bootServer } = require('../src/bootstrap');
const { getDb } = require('../src/db/connection');
const { eachDay } = require('../src/lib/localDate');
const {
  parseWorkingDays,
  teacherWorkingDays,
  isTeacherExpectedDate,
  expectedTeachersOn,
} = require('../src/services/calendar');
const { ensureProcessed } = require('../src/services/processor');

const MONTH = { bsYear: 2083, bsMonth: 1, from: '2026-04-14', to: '2026-05-14' };
const weekdayOf = (dateKey) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
};
const daysIn = (from, to) => [...eachDay(from, to)];
const schoolDays = MONTH.from <= MONTH.to ? daysIn(MONTH.from, MONTH.to).filter((d) => [1, 2, 3, 4, 5].includes(weekdayOf(d))) : [];
const PART_TIME_DAYS = [1, 3, 5];
const partTimeDaysInMonth = daysIn(MONTH.from, MONTH.to).filter((d) => PART_TIME_DAYS.includes(weekdayOf(d)));

let server;
let base;
let fullTimeId;
let partTimeId;

const json = (response) => response.json();
const api = {
  get: (route) => fetch(`${base}/api${route}`).then(json),
  post: (route, body) =>
    fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  put: (route, body) =>
    fetch(`${base}/api${route}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

/** Raw punches straight into the ledger (the device side is covered elsewhere). */
function punch(teacherId, zkUserId, timestamp) {
  getDb()
    .prepare(
      `INSERT INTO attendance_logs (teacher_id, zk_user_id, punch_time, punch_type, source)
       VALUES (?, ?, ?, 0, 'device')`
    )
    .run(teacherId, zkUserId, timestamp);
}

const rowOn = (teacherId, date) =>
  getDb()
    .prepare('SELECT * FROM processed_attendance WHERE teacher_id = ? AND work_date = ?')
    .get(teacherId, date);

test.before(async () => {
  server = await bootServer({ port: 0, poll: false, mode: 'test' });
  base = server.url;

  getDb()
    .prepare(
      `INSERT INTO shifts (name, start_time, end_time, grace_period_minutes, is_default)
       VALUES ('School day', '08:00', '16:00', 10, 1)`
    )
    .run();

  const fullTime = await api.post('/teachers', {
    zk_user_id: '7001',
    full_name: 'Full Time Farah',
    department: 'Science',
    designation: 'Teacher',
  });
  assert.equal(fullTime.status, 201);
  fullTimeId = (await json(fullTime)).data.id;

  const partTime = await api.post('/teachers', {
    zk_user_id: '7002',
    full_name: 'Part-time Priya',
    department: 'Music',
    designation: 'Teacher',
    employment_type: 'part_time',
    working_days: PART_TIME_DAYS,
  });
  assert.equal(partTime.status, 201);
  const created = await json(partTime);
  partTimeId = created.data.id;
  assert.equal(created.data.employment_type, 'part_time');
  assert.deepEqual(created.data.working_days, PART_TIME_DAYS);

  // A brand-new profile defaults to "every school day, no personal pattern".
  const farah = await api.get(`/teachers/${fullTimeId}`);
  assert.equal(farah.data.employment_type, 'full_time');
  assert.equal(farah.data.working_days, null);

  /* ── the month's raw punches ─────────────────────────────────────────── */
  punch(fullTimeId, '7001', '2026-04-14T07:50:00'); // Tue — on time
  punch(fullTimeId, '7001', '2026-04-14T16:05:00');
  punch(fullTimeId, '7001', '2026-04-15T07:55:00'); // Wed — on time
  punch(fullTimeId, '7001', '2026-04-18T10:30:00'); // Sat — weekend work, never "late"
  punch(fullTimeId, '7001', '2026-04-18T12:00:00');

  punch(partTimeId, '7002', '2026-04-15T07:55:00'); // Wed — their day, on time
  punch(partTimeId, '7002', '2026-04-15T16:10:00');
  punch(partTimeId, '7002', '2026-04-16T10:30:00'); // Thu — NOT their day, arrived late by shift
  punch(partTimeId, '7002', '2026-04-16T11:00:00');
  punch(partTimeId, '7002', '2026-04-20T08:40:00'); // Mon — their day, 40 min late
  punch(partTimeId, '7002', '2026-04-20T16:00:00');
  // 2026-04-17 (Fri) is one of their days and nobody turned up.

  await api.post('/attendance/recompute', { from: '2026-04-13', to: '2026-04-21' });
});

test.after(async () => {
  await server?.close();
});

test('a part-timer is simply not on the ledger on a day that is not theirs', async () => {
  const tuesday = await api.get('/attendance/daily?date=2026-04-21');
  assert.deepEqual(tuesday.data.map((row) => row.full_name), ['Full Time Farah']);
  assert.equal(tuesday.data[0].status, 'absent', 'the full-timer still owes Tuesday');

  // Friday is their day and they were absent ⇒ a real absence for Priya…
  const friday = await api.get('/attendance/daily?date=2026-04-17');
  assert.deepEqual(
    friday.data.map((row) => `${row.full_name}:${row.status}`).sort(),
    ['Full Time Farah:absent', 'Part-time Priya:absent']
  );

  // …but a punch on a day they do not work is kept, without a lateness charge.
  const thursday = rowOn(partTimeId, '2026-04-16');
  assert.equal(thursday.punch_count, 2);
  assert.equal(thursday.status, 'on_time', 'an off-pattern day is not governed by the shift window');
  assert.equal(thursday.late_minutes, 0);
  assert.equal(thursday.work_minutes, 30);

  // Their own day is still policed normally.
  const monday = rowOn(partTimeId, '2026-04-20');
  assert.equal(monday.status, 'late');
  assert.equal(monday.late_minutes, 40);

  // Weekend work for a full-timer: hours recorded, no penalty.
  const saturday = rowOn(fullTimeId, '2026-04-18');
  assert.equal(saturday.status, 'on_time');
  assert.equal(saturday.late_minutes, 0);
});

test('the monthly report counts each person against their own days', async () => {
  const report = await api.get(`/reports/monthly?bsYear=${MONTH.bsYear}&bsMonth=${MONTH.bsMonth}`);
  const { data } = report;

  const partTime = data.staff.find((person) => person.id === partTimeId);
  const fullTime = data.staff.find((person) => person.id === fullTimeId);

  assert.equal(partTime.partTime, true);
  assert.equal(partTime.followsSchoolWeek, false);
  assert.deepEqual(partTime.workPattern, PART_TIME_DAYS);
  assert.equal(partTime.scheduledWorkdays, partTimeDaysInMonth.length);
  assert.equal(partTime.scheduledWorkdays, 13, 'four Mondays, five Wednesdays, four Fridays');
  assert.equal(partTime.workingDays, 13);
  assert.equal(partTime.presentDays, 2, 'Wed 15 + Mon 20');
  assert.equal(partTime.absentDays, 11, 'the other eleven of THEIR days — not 21');
  assert.equal(partTime.lateDays, 1);
  assert.equal(partTime.lateMinutes, 40);
  assert.equal(partTime.nonWorkingDayPunches, 1, 'the Thursday visit is extra work, not a scheduled day');
  assert.equal(partTime.absentDays, partTime.workingDays - partTime.presentDays);

  assert.equal(fullTime.partTime, false);
  assert.equal(fullTime.followsSchoolWeek, true);
  assert.deepEqual(fullTime.workPattern, [1, 2, 3, 4, 5]);
  assert.equal(fullTime.scheduledWorkdays, schoolDays.length);
  assert.equal(fullTime.scheduledWorkdays, 23);
  assert.equal(fullTime.presentDays, 2);
  assert.equal(fullTime.absentDays, 21);
  assert.equal(fullTime.nonWorkingDayPunches, 1, 'Saturday punch stays off the scheduled totals');

  assert.equal(data.summary.staffCount, 2);
  assert.equal(data.summary.partTimeStaff, 1);
  assert.equal(data.summary.calendarWorkdays, 23, 'the school-wide figures keep the school week');
  assert.equal(data.summary.expectedStaffDays, 23 + 13);
  assert.equal(data.summary.absentDays, 21 + 11);

  // School-wide holiday list is untouched by personal patterns.
  assert.deepEqual(data.holidays, []);
});

test('the dashboard only expects the staff who are due today', async () => {
  const thursday = await api.get('/dashboard/summary?date=2026-04-16');
  assert.equal(thursday.data.kpi.totalActive, 2);
  assert.equal(thursday.data.kpi.expectedToday, 1, 'Priya works Mon/Wed/Fri');
  assert.equal(thursday.data.kpi.offPatternToday, 1);
  assert.equal(thursday.data.kpi.rostered, 2, '…but her punch still shows up');
  assert.equal(thursday.data.kpi.present, 1);
  assert.equal(thursday.data.kpi.absent, 1, 'only Farah owes Thursday');

  const friday = await api.get('/dashboard/summary?date=2026-04-17');
  assert.equal(friday.data.kpi.expectedToday, 2, 'Friday is a school day AND her day');
  assert.equal(friday.data.kpi.absent, 2);
  assert.equal(friday.data.kpi.late, 0);

  const saturday = await api.get('/dashboard/summary?date=2026-04-18');
  assert.equal(saturday.data.calendar.isWorkday, false);
  assert.equal(saturday.data.kpi.expectedToday, 0);
});

test('an invalid pattern is refused and an empty one means the school week', async () => {
  const tooBig = await api.put(`/teachers/${partTimeId}`, { working_days: [1, 3, 8] });
  assert.equal(tooBig.status, 422);
  assert.match((await json(tooBig)).error, /working_days/);

  const duplicates = await json(await api.put(`/teachers/${partTimeId}`, { working_days: [5, 1, 3, 1] }));
  assert.deepEqual(duplicates.data.working_days, PART_TIME_DAYS, 'sorted + de-duplicated on the way in');

  const emptied = await json(await api.put(`/teachers/${partTimeId}`, { working_days: [] }));
  assert.equal(emptied.data.working_days, null, 'no days picked ⇒ follow the school week');
  assert.equal(emptied.data.employment_type, 'part_time', 'the label survives');

  // Back to the pattern the rest of the file assumes.
  await api.put(`/teachers/${partTimeId}`, { working_days: PART_TIME_DAYS });
  await api.post('/attendance/recompute', { from: '2026-04-13', to: '2026-04-21' });
});

test('switching the pattern rewrites the ledger: new absences in, stale ones out', async () => {
  assert.ok(rowOn(partTimeId, '2026-04-17'), 'Friday absence exists while Friday is her day');
  assert.equal(rowOn(partTimeId, '2026-04-21'), undefined, 'Tuesday carries nothing yet');

  const updated = await json(await api.put(`/teachers/${partTimeId}`, {
    employment_type: 'part_time',
    working_days: [2, 4], // Tue + Thu
  }));
  assert.deepEqual(updated.data.working_days, [2, 4]);

  await api.post('/attendance/recompute', { from: '2026-04-13', to: '2026-04-21' });

  const tuesday = rowOn(partTimeId, '2026-04-21');
  assert.ok(tuesday, 'Tue/Thu now makes Tuesday hers ⇒ an absence row appears');
  assert.equal(tuesday.status, 'absent');
  assert.equal(rowOn(partTimeId, '2026-04-17'), undefined, 'the Friday absence must not linger');
  assert.equal(rowOn(partTimeId, '2026-04-20').status, 'on_time', 'her Monday punch survives as extra work, no late flag');

  const report = await api.get(`/reports/monthly?bsYear=${MONTH.bsYear}&bsMonth=${MONTH.bsMonth}`);
  const priya = report.data.staff.find((person) => person.id === partTimeId);
  assert.equal(priya.scheduledWorkdays, 10, 'five Tuesdays + five Thursdays');
  assert.equal(priya.presentDays, 1);
  assert.equal(priya.absentDays, 9);
  assert.equal(priya.nonWorkingDayPunches, 2, 'the Wednesday and Monday visits became extra work');
  // Lateness follows the pattern in both directions: her 40-minute Monday
  // arrival is off-pattern now (no longer a violation), while the 10:30
  // Thursday arrival that used to be forgiven is a real late arrival.
  assert.equal(priya.lateDays, 1);
  assert.equal(priya.lateMinutes, 150);
});

test('the school calendar still closes a day for everybody', async () => {
  // A named holiday on a Tuesday (now Priya's day) releases both of them.
  const holiday = await api.post('/calendar/holidays', {
    name: 'Exam break',
    kind: 'once',
    date: '2026-04-22',
  });
  assert.equal(holiday.status, 201);
  await api.post('/attendance/recompute', { from: '2026-04-21', to: '2026-04-25' });
  assert.equal(rowOn(partTimeId, '2026-04-22'), undefined, 'their weekday, but the school is shut');
  assert.equal(rowOn(fullTimeId, '2026-04-22'), undefined);

  // A make-up Saturday pulls in the full-timer only.
  const override = await api.put('/calendar/days', { dates: ['2026-04-25'], mode: 'workday', note: 'Sports day' });
  assert.equal(override.status, 200);
  assert.equal(rowOn(fullTimeId, '2026-04-25')?.status, 'absent', 'Farah owes the make-up day');
  assert.equal(rowOn(partTimeId, '2026-04-25'), undefined, 'a Saturday is not a Tue/Thu teacher’s day');

  // …and clearing the override takes it away again (the row must not stay).
  await api.put('/calendar/days', { dates: ['2026-04-25'], mode: 'default' });
  assert.equal(rowOn(fullTimeId, '2026-04-25'), undefined, 'removing the override drops the absence again');
});

test('views stay idempotent: re-reading a month does not rebuild it forever', async () => {
  const before = getDb()
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS maxId, COALESCE(SUM(id), 0) AS sumId
       FROM processed_attendance WHERE work_date BETWEEN ? AND ?`
    )
    .get(MONTH.from, '2026-04-30');
  ensureProcessed(MONTH.from, '2026-04-30');
  ensureProcessed(MONTH.from, '2026-04-30');
  const after = getDb()
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS maxId, COALESCE(SUM(id), 0) AS sumId
       FROM processed_attendance WHERE work_date BETWEEN ? AND ?`
    )
    .get(MONTH.from, '2026-04-30');
  assert.deepEqual(after, before, 'a complete month must not be rewritten on every view');
});

test('the pattern helpers survive junk and mirror the school week', () => {
  const calendar = {
    workingDays: [1, 2, 3, 4, 5],
    holidays: [],
    overrides: [],
    overridesByDate: new Map([
      ['2026-04-25', { date: '2026-04-25', is_working: 1, note: 'Sports day' }],
      ['2026-04-16', { date: '2026-04-16', is_working: 0, note: 'Staff training off' }],
    ]),
  };
  assert.equal(parseWorkingDays('[1,3,5]').join(), '1,3,5');
  assert.equal(parseWorkingDays('[ 3 , 1 , 5 ]').join(), '1,3,5');
  assert.equal(parseWorkingDays('nonsense'), null);
  assert.equal(parseWorkingDays('[9]'), null);
  assert.equal(parseWorkingDays([]), null);

  assert.deepEqual(teacherWorkingDays({ working_days: null }, calendar), [1, 2, 3, 4, 5]);
  assert.deepEqual(teacherWorkingDays({ working_days: '[6]' }, calendar), [6]);
  assert.deepEqual(teacherWorkingDays({ working_days: 'garbage' }, calendar), [1, 2, 3, 4, 5]);

  const priya = { working_days: '[1,3,5]' };
  const farah = { working_days: null };
  assert.ok(isTeacherExpectedDate(priya, '2026-04-20', calendar), 'Monday');
  assert.equal(isTeacherExpectedDate(priya, '2026-04-21', calendar), false, 'Tuesday');
  assert.ok(isTeacherExpectedDate(farah, '2026-04-21', calendar));
  assert.ok(isTeacherExpectedDate(priya, '2026-04-25', calendar) === false, 'make-up Saturday is not hers');
  assert.ok(isTeacherExpectedDate({ working_days: '[6]' }, '2026-04-25', calendar), 'a Saturday-only teacher is');
  assert.equal(isTeacherExpectedDate(priya, '2026-04-16', calendar), false, 'an explicit day off beats the pattern');
  assert.equal(isTeacherExpectedDate(farah, '2026-04-16', calendar), false);

  const roster = [{ id: 1, working_days: '[1,3,5]' }, { id: 2, working_days: null }];
  assert.deepEqual(expectedTeachersOn(roster, '2026-04-21', calendar).map((t) => t.id), [2]);
  assert.deepEqual(expectedTeachersOn(roster, '2026-04-20', calendar).map((t) => t.id), [1, 2]);
  assert.deepEqual(expectedTeachersOn([], '2026-04-20', calendar), []);
  assert.equal(isTeacherExpectedDate(null, '2026-04-20', calendar), false);
});

test('a late punch sync still flips an absence into a present day', async () => {
  const date = '2026-04-28'; // Tuesday — one of Priya's days under the new pattern
  const before = rowOn(partTimeId, date);
  assert.ok(before, 'viewing the month materialized the day…');
  assert.equal(before.status, 'absent');

  punch(partTimeId, '7002', `${date}T08:05:00`); // …then the terminal sync arrives
  await api.get(`/attendance/daily?date=${date}`);
  const row = rowOn(partTimeId, date);
  assert.equal(row.punch_count, 1);
  assert.equal(row.status, 'on_time', 'inside the grace window');
});
