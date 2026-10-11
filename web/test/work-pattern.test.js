import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isExpectedOn,
  isSamePattern,
  normalizePattern,
  patternLabel,
  resolvePattern,
  summarizePattern,
  toggleWeekday,
} from '../src/lib/workPattern.js';

/** A day of the calendar grid, as GET /api/calendar/days returns it. */
const day = (date, weekday, extra = {}) => ({
  date,
  weekday,
  weeklyWorkday: true,
  isWorkingDay: true,
  isHoliday: false,
  holidayNames: [],
  source: 'workweek',
  override: null,
  ...extra,
});

test('a stored pattern is parsed, cleaned and printed', () => {
  assert.deepEqual(normalizePattern('[1,3,5]'), [1, 3, 5]);
  assert.deepEqual(normalizePattern([5, 1, 1, 3, 9, -2, 'x']), [1, 3, 5]);
  assert.equal(normalizePattern(null), null);
  assert.equal(normalizePattern(''), null);
  assert.equal(normalizePattern('null'), null);
  assert.equal(normalizePattern('[]'), null);
  assert.equal(normalizePattern([]), null);
  assert.equal(normalizePattern('not json'), null);
  assert.equal(patternLabel([1, 3, 5]), 'Mon, Wed, Fri');
  assert.equal(patternLabel(null), 'School working week');
});

test('nobody loses their days: a pattern only exists once it differs', () => {
  assert.deepEqual(resolvePattern(null, [1, 2, 3, 4, 5, 6]), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(resolvePattern([2, 4], [1, 2, 3, 4, 5]), [2, 4]);
  assert.deepEqual(resolvePattern([2, 4], null), [2, 4]); // school week unset → school default
  assert.ok(isSamePattern([1, 3, 5], '[3,1,5]'));
  assert.ok(!isSamePattern([1, 3, 5], null));
  assert.deepEqual(toggleWeekday([1, 3, 5], 2), [1, 2, 3, 5]);
  assert.deepEqual(toggleWeekday([1], 1), null); // unchecking the last day = back to the school week
});

test('a Mon/Wed/Fri teacher is only expected on Mon, Wed and Fri', () => {
  const pattern = [1, 3, 5];
  assert.ok(isExpectedOn(day('2026-10-12', 1), pattern));
  assert.equal(isExpectedOn(day('2026-10-13', 2), pattern), false);
  assert.ok(isExpectedOn(day('2026-10-14', 3), pattern));
  assert.equal(isExpectedOn(day('2026-10-17', 6), pattern), false);
  // …while a profile without a pattern keeps every school day.
  assert.ok(isExpectedOn(day('2026-10-13', 2), [1, 2, 3, 4, 5]));
});

test('the school calendar still closes a day for everybody', () => {
  const pattern = [1, 3, 5];
  const mondayHoliday = day('2026-10-12', 1, {
    isWorkingDay: false, isHoliday: true, holidayNames: ['Dashain'], source: 'holiday',
  });
  assert.equal(isExpectedOn(mondayHoliday, pattern), false);

  const saturdayMadeWorkday = day('2026-10-17', 6, {
    weeklyWorkday: false, isWorkingDay: true, source: 'override', override: { isWorking: true, note: 'Exam day' },
  });
  assert.equal(isExpectedOn(saturdayMadeWorkday, pattern), false); // not their weekday
  assert.ok(isExpectedOn(saturdayMadeWorkday, [6]));               // Sat-only teacher is due
  assert.equal(isExpectedOn(saturdayMadeWorkday, [0, 6]), true);

  const mondayOff = day('2026-10-12', 1, { isWorkingDay: false, source: 'override', override: { isWorking: false } });
  assert.equal(isExpectedOn(mondayOff, pattern), false);
});

test('a month preview counts elapsed and remaining days, never future absences', () => {
  const pattern = [1, 3, 5];
  // October 2026: the 1st is a Thursday, so the school's Mon–Fri week starts
  // on Fri 2, and this teacher works Mon 5, Wed 7 and Mon 12 as well.
  const days = [
    day('2026-10-01', 4), // Thu — not their day
    day('2026-10-02', 5), // Fri — elapsed
    day('2026-10-05', 1), // Mon — elapsed
    day('2026-10-07', 3), // Wed — elapsed
    day('2026-10-08', 4), // Thu — not their day
    day('2026-10-09', 5), // Fri — still to come
    day('2026-10-12', 1), // Mon — still to come
  ];
  const preview = summarizePattern(days, pattern, '2026-10-07');
  assert.equal(preview.scheduled, 5);
  assert.equal(preview.elapsed, 3);
  assert.equal(preview.remaining, 2);
  assert.equal(preview.nextDate, '2026-10-09');
  assert.deepEqual(preview.dates, ['2026-10-02', '2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12']);

  // A holiday inside the month drops out of their schedule entirely.
  const withHoliday = days.map((d) => (d.date === '2026-10-05'
    ? day(d.date, d.weekday, { isWorkingDay: false, isHoliday: true, holidayNames: ['Tihar'] })
    : d));
  assert.equal(summarizePattern(withHoliday, pattern, '2026-10-07').elapsed, 2); // Fri + Wed only
  assert.equal(summarizePattern([], pattern, '2026-10-07').scheduled, 0);
});
