import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adToBsParts,
  bsToAdIso,
  bsMonthRange,
  formatDatePair,
  daysInBsMonth,
} from '../src/lib/nepaliDate.js';

test('the browser date helper converts and displays BS together with Gregorian dates', () => {
  assert.deepEqual(adToBsParts('2026-10-11'), { year: 2083, month: 6, day: 25, weekday: 0 });
  assert.equal(bsToAdIso(2083, 1, 1), '2026-04-14');
  assert.equal(formatDatePair('2026-10-11'), '25 Aswin 2083 BS · 11 Oct 2026 AD');
});

test('BS month helpers respect month length and reject impossible dates', () => {
  assert.equal(daysInBsMonth(2083, 6), 31);
  assert.deepEqual(bsMonthRange(2083, 6), { from: '2026-09-17', to: '2026-10-17', days: 31 });
  assert.throws(() => bsToAdIso(2083, 6, 32), RangeError);
});
