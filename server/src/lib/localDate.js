/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  LOCAL CALENDAR-DAY HELPERS
 * ─────────────────────────────────────────────────────────────────────────────
 *  A "day key" is a plain 'YYYY-MM-DD' string meaning a calendar day on the
 *  machine's local clock (the school's wall clock, which is what the terminal
 *  records). Never derive a day key from `toISOString()`: that is the UTC
 *  date, so in any zone east of UTC between midnight and the offset (e.g.
 *  Asia/Kathmandu, UTC+05:45, from 00:00 to 05:45) it names YESTERDAY. And
 *  never parse a bare 'YYYY-MM-DD' with `new Date(str)`: that is read as UTC
 *  midnight, which is the previous day in the Americas.
 *
 *  Every place that turns a date into a calendar day goes through here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD' using the LOCAL calendar date. */
function toLocalDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's day key on the local clock. */
function todayKey(now = new Date()) {
  return toLocalDateKey(now);
}

/** 'YYYY-MM-DD' → Date at LOCAL midnight of that day. Throws on malformed input. */
function parseLocalDate(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new TypeError(`Expected a YYYY-MM-DD day key, got ${JSON.stringify(key)}`);
  }
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Shift a day key by n calendar days (negative goes back). Uses the local
 * calendar, so it stays correct across DST changes (no 86400000 arithmetic).
 */
function addDays(key, n) {
  const d = parseLocalDate(key);
  d.setDate(d.getDate() + n);
  return toLocalDateKey(d);
}

/**
 * Half-open bounds for one local day, as 'YYYY-MM-DDTHH:MM:SS' strings — the
 * same format the device writes to attendance_logs.punch_time, so they compare
 * correctly as text: `punch_time >= start AND punch_time < end`.
 */
function dayBounds(key) {
  parseLocalDate(key); // validate
  return { start: `${key}T00:00:00`, end: `${addDays(key, 1)}T00:00:00` };
}

/** Inclusive generator of day keys from `from` to `to` (empty if to < from). */
function* eachDay(from, to) {
  for (let k = from; k <= to; k = addDays(k, 1)) yield k;
}

module.exports = {
  toLocalDateKey,
  todayKey,
  parseLocalDate,
  addDays,
  dayBounds,
  eachDay,
};
