/**
 * Shared device contract + time helpers for ZK adapters.
 *
 * Every adapter (real node-zklib, mock simulator) implements:
 *
 *   await testConnection()            -> { ok, mode, ip, port, device?, users?, logs?, error? }
 *   await getUsers()                  -> [{ userId, name, role?, cardno? }]
 *   await getAttendance(opts?)        -> [{ userId, timestamp, punchType, deviceSn? }]
 *                                        timestamp: 'YYYY-MM-DDTHH:MM:SS' device-local
 *   await setUser({userId, name,...}) -> { ok }
 *
 * Anything below this layer may throw ZKConnectionError (retryable) or
 * ZKDeviceError (non-retryable).
 */

class ZKConnectionError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ZKConnectionError';
    this.retryable = true;
    if (cause) this.cause = cause;
  }
}

class ZKDeviceError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ZKDeviceError';
    this.retryable = false;
    if (cause) this.cause = cause;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Date -> 'YYYY-MM-DDTHH:MM:SS' in LOCAL time (device reports local wall-clock). */
function toLocalISO(d) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function todayStr(d = new Date()) {
  return toLocalISO(d).slice(0, 10);
}

/** Tolerant ISO parser for device log time fields (Date | string | number). */
function parseDeviceTime(v) {
  if (v == null) return null;
  if (v instanceof Date) return toLocalISO(v);
  if (typeof v === 'number') return toLocalISO(new Date(v));
  const s = String(v).trim();
  // normalize 'YYYY-MM-DD HH:MM:SS' -> ISO 'T'
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
  if (m) return `${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toLocalISO(d);
}

module.exports = { ZKConnectionError, ZKDeviceError, toLocalISO, todayStr, parseDeviceTime };
