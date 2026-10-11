const test = require('node:test');
const assert = require('node:assert/strict');
const {
  adToBs,
  bsToAdKey,
  bsMonthRange,
  daysInBsMonth,
  formatBsDate,
} = require('../src/lib/nepaliDate');

test('known Gregorian dates convert to Bikram Sambat and back', () => {
  assert.deepEqual(adToBs('2026-10-11'), { year: 2083, month: 6, day: 25, weekday: 0 });
  assert.equal(bsToAdKey(2083, 1, 1), '2026-04-14');
  assert.equal(formatBsDate('2026-10-11'), '25 Aswin 2083 BS');
});

test('BS month range uses the right variable-length calendar month', () => {
  const period = bsMonthRange(2083, 6);
  assert.equal(period.monthName, 'Aswin');
  assert.equal(period.from, '2026-09-17');
  assert.equal(period.to, '2026-10-17');
  assert.equal(period.days, 31);
  assert.equal(daysInBsMonth(2083, 12), 30);
});

test('invalid BS dates and unsupported years are rejected', () => {
  assert.throws(() => bsToAdKey(2083, 6, 32), RangeError);
  assert.throws(() => bsMonthRange(2091, 1), RangeError);
  assert.equal(adToBs('not-a-date'), null);
});
