import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adDayLabel,
  bsMonthCells,
  bsMonthTitle,
  bsMonthWeeks,
  canShiftBsMonth,
  dateRangeSelection,
  shiftBsMonth,
} from '../src/lib/calendarGrid.js';

test('a BS month lays out Sunday-first weeks carrying Gregorian dates', () => {
  // Aswin 2083 BS = 17 Sep 2026 → 17 Oct 2026 (Aswin 1 falls on a Thursday).
  const cells = bsMonthCells(2083, 6);
  assert.equal(cells.length, 31);
  assert.equal(bsMonthTitle(2083, 6), 'Aswin 2083 BS');
  assert.equal(cells[0].date, '2026-09-17');
  assert.equal(cells[0].weekday, 4);
  assert.equal(cells[30].date, '2026-10-17');
  assert.equal(adDayLabel(cells[0]), '17 Sep');

  const weeks = bsMonthWeeks(2083, 6);
  assert.equal(weeks.length, 5);
  assert.deepEqual(weeks[0].slice(0, 4), [null, null, null, null]);
  assert.equal(weeks[0][4].bsDay, 1);
  assert.deepEqual(weeks[4].map((cell) => cell.bsDay), [25, 26, 27, 28, 29, 30, 31]);

  // A month that starts on a Sunday needs no leading blanks.
  assert.equal(bsMonthWeeks(2083, 7)[0][0].bsDay, 1);
});

test('drag selection walks the grid in calendar order whichever way it is dragged', () => {
  const cells = bsMonthCells(2083, 6);
  const forward = dateRangeSelection(cells, '2026-09-29', '2026-10-01');
  const backward = dateRangeSelection(cells, '2026-10-01', '2026-09-29');
  assert.deepEqual(forward, ['2026-09-29', '2026-09-30', '2026-10-01']);
  assert.deepEqual(backward, forward);
  assert.deepEqual(dateRangeSelection(cells, '2026-10-01', '2026-10-01'), ['2026-10-01']);
  assert.deepEqual(dateRangeSelection(cells, '2026-10-01', '2026-08-01'), ['2026-10-01']);
});

test('month navigation moves one BS month at a time and stops at the supported range', () => {
  assert.deepEqual(shiftBsMonth(2083, 12, 1), { year: 2084, month: 1 });
  assert.deepEqual(shiftBsMonth(2083, 1, -1), { year: 2082, month: 12 });
  assert.deepEqual(shiftBsMonth(2083, 6, 4), { year: 2083, month: 10 });
  assert.equal(canShiftBsMonth(2083, 6, -1), true);
  assert.equal(canShiftBsMonth(2000, 1, -1), false);
  assert.equal(canShiftBsMonth(2090, 12, 1), false);
});
