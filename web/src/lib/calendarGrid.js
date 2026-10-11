import { BS_MONTHS, MAX_BS_YEAR, MIN_BS_YEAR, bsToAdIso, daysInBsMonth } from './nepaliDate.js';

/** Nepali school weeks start on Sunday. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
export const AD_MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Move a BS month view by `delta` months, staying inside the supported range. */
export function shiftBsMonth(year, month, delta) {
  const index = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  if (nextYear < MIN_BS_YEAR) return { year: MIN_BS_YEAR, month: 1 };
  if (nextYear > MAX_BS_YEAR) return { year: MAX_BS_YEAR, month: 12 };
  return { year: nextYear, month: nextMonth };
}

export function canShiftBsMonth(year, month, delta) {
  const next = shiftBsMonth(year, month, delta);
  return next.year !== year || next.month !== month;
}

/**
 * One entry per day of a BS month, carrying both the BS day number and the
 * matching Gregorian date/weekday (device records stay Gregorian).
 */
export function bsMonthCells(year, month) {
  const days = daysInBsMonth(Number(year), Number(month));
  return Array.from({ length: days }, (_, index) => {
    const bsDay = index + 1;
    const date = bsToAdIso(year, month, bsDay);
    const [adYear, adMonth, adDay] = date.split('-').map(Number);
    const weekday = new Date(adYear, adMonth - 1, adDay).getDay();
    return { date, bsDay, bsYear: Number(year), bsMonth: Number(month), adYear, adMonth, adDay, weekday };
  });
}

/** The BS month laid out in Sunday-first weeks (leading/trailing cells are null). */
export function bsMonthWeeks(year, month) {
  const cells = bsMonthCells(year, month);
  if (!cells.length) return [];
  const lead = cells[0].weekday;
  const slots = Math.ceil((lead + cells.length) / 7) * 7;
  const padded = Array.from({ length: slots }, (_, index) => cells[index - lead] || null);
  const weeks = [];
  for (let index = 0; index < padded.length; index += 7) weeks.push(padded.slice(index, index + 7));
  return weeks;
}

/** All dates between two grid cells (inclusive, in calendar order, either direction). */
export function dateRangeSelection(cells, anchor, focus) {
  const dates = cells.map((cell) => cell.date);
  const anchorIndex = dates.indexOf(anchor);
  if (anchorIndex === -1) return anchor ? [anchor] : [];
  const focusIndex = dates.indexOf(focus);
  if (focusIndex === -1) return [anchor];
  const [start, end] = anchorIndex <= focusIndex ? [anchorIndex, focusIndex] : [focusIndex, anchorIndex];
  return dates.slice(start, end + 1);
}

/** Short AD label for a cell, e.g. "11 Oct". */
export function adDayLabel(cell) {
  return `${cell.adDay} ${AD_MONTHS_SHORT[cell.adMonth - 1]}`;
}

export function bsMonthTitle(year, month) {
  return `${BS_MONTHS[month - 1]} ${year} BS`;
}
