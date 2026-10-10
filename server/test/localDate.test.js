/**
 * Calendar-day helpers + the "wrong day before 05:45 in Kathmandu" regression.
 *
 * These must pass in EVERY timezone — run `npm run test:tz` to check all three
 * (UTC, Asia/Kathmandu, America/Los_Angeles).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ATT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'att-localdate-'));
process.env.ZK_MODE = 'mock';

const {
  toLocalDateKey,
  todayKey,
  parseLocalDate,
  addDays,
  dayBounds,
  eachDay,
} = require('../src/lib/localDate');

test('toLocalDateKey uses the local calendar date, not the UTC one', () => {
  // 03:00 local on 10 Oct: in Kathmandu this is still 9 Oct in UTC.
  assert.equal(toLocalDateKey(new Date(2026, 9, 10, 3, 0)), '2026-10-10');
  // 23:30 local on 10 Oct: in Los Angeles this is already 11 Oct in UTC.
  assert.equal(toLocalDateKey(new Date(2026, 9, 10, 23, 30)), '2026-10-10');
});

test('parseLocalDate reads a key as LOCAL midnight (not UTC midnight)', () => {
  const d = parseLocalDate('2026-10-10');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 10);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test('parseLocalDate round-trips and rejects malformed keys', () => {
  for (const k of ['2026-01-01', '2026-12-31', '2028-02-29']) {
    assert.equal(toLocalDateKey(parseLocalDate(k)), k);
  }
  for (const bad of ['2026-10-10T00:00:00', '10/10/2026', '', null, undefined]) {
    assert.throws(() => parseLocalDate(bad), TypeError);
  }
});

test('addDays crosses month, year and leap-day boundaries', () => {
  assert.equal(addDays('2026-10-10', 1), '2026-10-11');
  assert.equal(addDays('2026-10-10', -1), '2026-10-09');
  assert.equal(addDays('2026-10-10', -30), '2026-09-10');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('addDays stays on the calendar across DST changes', () => {
  // Zone-independent guarantee: a "day" is a calendar step, never 24 hours.
  assert.equal(addDays('2026-03-07', 1), '2026-03-08'); // US spring-forward is 8 Mar 2026
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01'); // US fall-back is 1 Nov 2026
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
});

test('dayBounds is a half-open window in the device timestamp format', () => {
  assert.deepEqual(dayBounds('2026-10-10'), {
    start: '2026-10-10T00:00:00',
    end: '2026-10-11T00:00:00',
  });
  assert.deepEqual(dayBounds('2026-12-31'), {
    start: '2026-12-31T00:00:00',
    end: '2027-01-01T00:00:00',
  });
  // text comparison matches the intended punch set
  const { start, end } = dayBounds('2026-10-10');
  const inDay = (p) => p >= start && p < end;
  assert.equal(inDay('2026-10-10T00:00:00'), true);
  assert.equal(inDay('2026-10-10T23:59:59'), true);
  assert.equal(inDay('2026-10-09T23:59:59'), false);
  assert.equal(inDay('2026-10-11T00:00:00'), false);
});

test('eachDay is inclusive and empty when reversed', () => {
  assert.deepEqual([...eachDay('2026-10-30', '2026-11-02')], [
    '2026-10-30',
    '2026-10-31',
    '2026-11-01',
    '2026-11-02',
  ]);
  assert.deepEqual([...eachDay('2026-10-10', '2026-10-09')], []);
  assert.deepEqual([...eachDay('2026-10-10', '2026-10-10')], ['2026-10-10']);
});

test('todayKey follows the local clock', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 10, 3, 0) });
  assert.equal(todayKey(), '2026-10-10');
  t.mock.timers.reset();
});
