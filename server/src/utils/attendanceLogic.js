/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ATTENDANCE LOGIC ALGORITHM  (spec § C)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Pure, side-effect-free, unit-tested. Converts a day's raw punch list for one
 *  teacher + their shift definition into the daily summary stored in
 *  `processed_attendance`.
 *
 *  Rules per the specification:
 *    • Check-In  = FIRST punch of the day, Check-Out = LAST punch of the day
 *      (with ≥2 punches; a lonely punch is a check-in with no check-out).
 *    • Late Arrival    : check-in  >  start + grace        → "late by X mins"
 *                        (X measured from scheduled shift start)
 *    • Early Departure : check-out <  end                  → "early by Y mins"
 *    • On-Time         : check-in  ≤  start + grace AND check-out ≥ end
 *    • Absent          : no punches recorded that day
 *  Overnight shifts (end ≤ start) roll the end to the next calendar day.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 'HH:MM' -> minutes since midnight */
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/** 'YYYY-MM-DDTHH:MM:SS' (device-local ISO) -> minutes since local midnight */
function minutesOfDay(iso) {
  return toMinutes(iso.slice(11, 16));
}

function datePart(iso) {
  return iso.slice(0, 10);
}

/**
 * @param {object}   args
 * @param {string[]} args.punches Sorted-asc array of 'YYYY-MM-DDTHH:MM:SS' strings
 * @param {object}   args.shift   { start_time:'HH:MM', end_time:'HH:MM', grace_period_minutes:int } | null
 * @param {string}   args.workDate 'YYYY-MM-DD' being evaluated
 * @returns {{
 *   checkIn:string|null, checkOut:string|null, punchCount:number,
 *   lateMinutes:number, earlyMinutes:number, workMinutes:number|null,
 *   status:'on_time'|'late'|'early'|'late_early'|'absent'
 * }}
 */
function evaluateDay({ punches, shift, workDate }) {
  const sorted = [...(punches || [])].sort();

  if (sorted.length === 0) {
    return {
      checkIn: null,
      checkOut: null,
      punchCount: 0,
      lateMinutes: 0,
      earlyMinutes: 0,
      workMinutes: null,
      status: 'absent',
    };
  }

  const checkIn = sorted[0];
  const checkOut = sorted.length > 1 ? sorted[sorted.length - 1] : null;

  // Fallback if teacher somehow has no shift: never penalise, just record times.
  if (!shift) {
    return {
      checkIn,
      checkOut,
      punchCount: sorted.length,
      lateMinutes: 0,
      earlyMinutes: 0,
      workMinutes: checkOut ? diffLocalMinutes(checkIn, checkOut) : null,
      status: 'on_time',
    };
  }

  const startMin = toMinutes(shift.start_time);
  let endMin = toMinutes(shift.end_time);
  const overnight = endMin <= startMin; // e.g. 22:00 → 06:00
  if (overnight) endMin += 24 * 60;

  const grace = shift.grace_period_minutes || 0;

  // ── Late arrival ──────────────────────────────────────────────────────────
  const ciMin = minutesOfDay(checkIn);
  let lateMinutes = 0;
  if (ciMin > startMin + grace) {
    lateMinutes = ciMin - startMin; // lateness measured from scheduled start
  }
  // Overnight edge: a punch just past midnight belongs to the same work day
  // when it falls within the shift window after the rolled-over end.

  // ── Early departure ("fast going") ────────────────────────────────────────
  let earlyMinutes = 0;
  if (checkOut) {
    let coMin = minutesOfDay(checkOut);
    // If check-out date is the next calendar day (overnight shift), add 24h.
    const coIsNextDay = datePart(checkOut) !== workDate;
    if (coIsNextDay) coMin += 24 * 60;
    if (coMin > ciMin && coMin < endMin) {
      earlyMinutes = endMin - coMin;
    }
  }

  let status;
  if (lateMinutes > 0 && earlyMinutes > 0) status = 'late_early';
  else if (lateMinutes > 0) status = 'late';
  else if (earlyMinutes > 0) status = 'early';
  else status = 'on_time';

  return {
    checkIn,
    checkOut,
    punchCount: sorted.length,
    lateMinutes,
    earlyMinutes,
    workMinutes: checkOut ? diffLocalMinutes(checkIn, checkOut) : null,
    status,
  };
}

/** minutes between two device-local ISO timestamps (naive, same-tz) */
function diffLocalMinutes(a, b) {
  const toMs = (s) => new Date(s.replace('T', ' ')).getTime();
  return Math.max(0, Math.round((toMs(b) - toMs(a)) / 60000));
}

/** format positive minutes as '1h 05m' / '12m' for badges */
function humanizeMinutes(min) {
  if (!min || min <= 0) return '0m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? (m > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`) : `${m}m`;
}

module.exports = { evaluateDay, toMinutes, minutesOfDay, humanizeMinutes, diffLocalMinutes };
