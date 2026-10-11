/**
 * Bikram Sambat (BS) calendar helpers.
 *
 * ATT keeps ZKTeco timestamps and SQLite day keys in Gregorian YYYY-MM-DD
 * form. BS dates are converted at the presentation/report boundary so device
 * data and existing records are never rewritten.
 */
const nepaliDateModule = require('nepali-date-converter');
const NepaliDate = nepaliDateModule.default || nepaliDateModule;
const dateConfigMap = nepaliDateModule.dateConfigMap || NepaliDate.dateConfigMap;

const BS_MONTHS = [
  'Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Aswin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra',
];
const pad = (value) => String(value).padStart(2, '0');
const MIN_BS_YEAR = 2000;
const MAX_BS_YEAR = 2090;

function validInteger(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max;
}

function daysInBsMonth(year, month) {
  if (!validInteger(year, MIN_BS_YEAR, MAX_BS_YEAR) || !validInteger(month, 1, 12)) return 0;
  return Number(dateConfigMap?.[String(year)]?.[BS_MONTHS[month - 1]]) || 0;
}

/** Convert a stored Gregorian day key to a BS parts object, or null if out of range. */
function adToBs(dateKey) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  try {
    const bs = new NepaliDate(date).getBS();
    return { year: bs.year, month: bs.month + 1, day: bs.date, weekday: bs.day };
  } catch (_) {
    return null;
  }
}

/** Convert a BS date (month is 1-12) to the app's Gregorian YYYY-MM-DD key. */
function bsToAdKey(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const monthDays = daysInBsMonth(y, m);
  if (!monthDays || !validInteger(d, 1, monthDays)) {
    throw new RangeError(`Invalid Bikram Sambat date ${y}-${pad(m)}-${pad(d)}`);
  }
  const converted = new NepaliDate(y, m - 1, d);
  const bs = converted.getBS();
  if (bs.year !== y || bs.month !== m - 1 || bs.date !== d) {
    throw new RangeError(`Invalid Bikram Sambat date ${y}-${pad(m)}-${pad(d)}`);
  }
  const ad = converted.getAD();
  return `${ad.year}-${pad(ad.month + 1)}-${pad(ad.date)}`;
}

function bsMonthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  const days = daysInBsMonth(y, m);
  if (!days) throw new RangeError('BS year or month is outside the supported range (2000–2090 BS)');
  return {
    from: bsToAdKey(y, m, 1),
    to: bsToAdKey(y, m, days),
    days,
    year: y,
    month: m,
    monthName: BS_MONTHS[m - 1],
  };
}

function formatBsDate(dateKey, { weekday = false } = {}) {
  const bs = adToBs(dateKey);
  if (!bs) return dateKey || '';
  const [year, month, day] = dateKey.split('-').map(Number);
  const prefix = weekday ? `${new NepaliDate(new Date(year, month - 1, day)).format('ddd')} ` : '';
  return `${prefix}${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year} BS`;
}

module.exports = {
  BS_MONTHS,
  MIN_BS_YEAR,
  MAX_BS_YEAR,
  daysInBsMonth,
  adToBs,
  bsToAdKey,
  bsMonthRange,
  formatBsDate,
};
