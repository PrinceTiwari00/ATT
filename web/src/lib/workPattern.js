/**
 * Part-time work patterns: the shared math behind the "Part-time Staff" page.
 *
 * A person is expected on a date when
 *   1. the school is open that day (no named holiday, and a per-day "off"
 *      override beats everything), and
 *   2. the weekday is inside their own pattern — which defaults to the school
 *      working week, so a full-time profile is expected on every school day.
 *
 * `isExpectedOn` mirrors server/src/services/calendar.js → isTeacherExpectedDate
 * so the preview the school sees before saving matches the ledger afterwards.
 */
import { WEEKDAY_LABELS } from './calendarGrid.js';

/** Sunday-first picker, matching the school calendar grid. */
export const WEEKDAY_CHOICES = WEEKDAY_LABELS.map((label, value) => ({ value, label }));

/** The school week this app ships with when nothing is configured. */
export const DEFAULT_SCHOOL_WEEK = [1, 2, 3, 4, 5];

/** Unique weekday numbers 0-6, sorted; anything unusable becomes `null`. */
export function normalizePattern(value) {
  let list = value;
  if (typeof list === 'string') {
    const text = list.trim();
    if (!text || text === 'null') return null;
    try {
      list = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const days = [...new Set(list.map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  return days.length ? days : null;
}

/** The weekdays this person works: their own pattern, else the school week. */
export function resolvePattern(patternDays, schoolWeek = DEFAULT_SCHOOL_WEEK) {
  return normalizePattern(patternDays) || normalizePattern(schoolWeek) || [...DEFAULT_SCHOOL_WEEK];
}

/** "Mon, Wed, Fri" — short labels, Sunday first. */
export function patternLabel(days) {
  const pattern = normalizePattern(days);
  if (!pattern) return 'School working week';
  return pattern.map((day) => WEEKDAY_LABELS[day]).join(', ');
}

export function isSamePattern(a, b) {
  const left = normalizePattern(a) || [];
  const right = normalizePattern(b) || [];
  return left.length === right.length && left.every((day, i) => day === right[i]);
}

/** Toggle one weekday, keeping the list sorted and unique. */
export function toggleWeekday(days, day) {
  const pattern = normalizePattern(days) || [];
  const next = pattern.includes(day) ? pattern.filter((d) => d !== day) : [...pattern, day].sort((a, b) => a - b);
  return next.length ? next : null;
}

/**
 * Is the person due for work on one day of the school calendar grid
 * (`GET /api/calendar/days` row: { date, weekday, isWorkingDay, isHoliday,
 * holidayNames, override })?
 */
export function isExpectedOn(day, pattern) {
  if (!day) return false;
  const days = normalizePattern(pattern) || [];
  if (day.override) return Boolean(day.override.isWorking) && days.includes(day.weekday);
  if (day.isHoliday) return false;
  return days.includes(day.weekday);
}

/**
 * Count a pattern against a month of calendar days.
 * `today` is 'YYYY-MM-DD'; future days are scheduled but not yet elapsed, so
 * they are never missing/absent.
 */
export function summarizePattern(days, pattern, today) {
  const expected = (days || []).filter((day) => isExpectedOn(day, pattern));
  const elapsed = expected.filter((day) => !today || day.date <= today);
  const upcoming = expected.filter((day) => today && day.date > today);
  return {
    scheduled: expected.length,
    elapsed: elapsed.length,
    remaining: upcoming.length,
    nextDate: upcoming.length ? upcoming[0].date : null,
    dates: expected.map((day) => day.date),
  };
}

/** One-tap schedules for the picker, in weekday numbers (Sunday = 0). */
export const QUICK_PATTERNS = [
  { label: 'Mon · Wed · Fri', days: [1, 3, 5] },
  { label: 'Tue · Thu', days: [2, 4] },
  { label: 'Sun – Thu', days: [0, 1, 2, 3, 4, 5] },
  { label: 'Sat only', days: [6] },
];
