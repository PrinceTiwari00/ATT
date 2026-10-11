import nepaliDatePackage, { dateConfigMap } from 'nepali-date-converter';

// The package's CommonJS entry exposes the class under `.default`, while its
// browser ESM entry exports the class directly. Support both build targets.
const NepaliDate = nepaliDatePackage?.default || nepaliDatePackage;

export const BS_MONTHS = [
  'Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Aswin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra',
];
export const MIN_BS_YEAR = 2000;
export const MAX_BS_YEAR = 2090;
const pad = (n) => String(n).padStart(2, '0');

export function daysInBsMonth(year, month) {
  if (!Number.isInteger(Number(year)) || !Number.isInteger(Number(month)) || Number(month) < 1 || Number(month) > 12) return 0;
  return Number(dateConfigMap?.[String(year)]?.[BS_MONTHS[Number(month) - 1]]) || 0;
}

export function adToBsParts(isoDate) {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  try {
    const bs = new NepaliDate(date).getBS();
    return { year: bs.year, month: bs.month + 1, day: bs.date, weekday: bs.day };
  } catch (_) {
    return null;
  }
}

export function bsToAdIso(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const lastDay = daysInBsMonth(y, m);
  if (!lastDay || !Number.isInteger(d) || d < 1 || d > lastDay) {
    throw new RangeError(`Invalid Bikram Sambat date ${y}-${pad(m)}-${pad(d)}`);
  }
  const converted = new NepaliDate(y, m - 1, d);
  const check = converted.getBS();
  if (check.year !== y || check.month !== m - 1 || check.date !== d) {
    throw new RangeError(`Invalid Bikram Sambat date ${y}-${pad(m)}-${pad(d)}`);
  }
  const ad = converted.getAD();
  return `${ad.year}-${pad(ad.month + 1)}-${pad(ad.date)}`;
}

export function bsMonthRange(year, month) {
  const days = daysInBsMonth(Number(year), Number(month));
  if (!days) throw new RangeError('BS month is outside the supported range (2000–2090 BS)');
  return {
    from: bsToAdIso(year, month, 1),
    to: bsToAdIso(year, month, days),
    days,
  };
}

export function formatBsDate(isoDate, { weekday = false, short = false } = {}) {
  const [year, month, day] = String(isoDate || '').split('-').map(Number);
  if (!year || !month || !day) return isoDate || '';
  try {
    const converted = new NepaliDate(new Date(year, month - 1, day));
    return converted.format(weekday ? 'ddd DD MMMM YYYY' : short ? 'DD MMM YYYY' : 'DD MMMM YYYY');
  } catch (_) {
    return isoDate;
  }
}

export function formatAdDate(isoDate, { weekday = false } = {}) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate || '';
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-GB', {
    ...(weekday ? { weekday: 'short' } : {}),
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDatePair(isoDate, { weekday = false, short = false } = {}) {
  if (!isoDate) return '—';
  const bs = formatBsDate(isoDate, { weekday, short });
  const ad = formatAdDate(isoDate, { weekday });
  return `${bs} BS · ${ad} AD`;
}
