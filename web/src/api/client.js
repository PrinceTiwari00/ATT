/** Tiny fetch wrapper around the backend REST API (same-origin, proxied). */

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    // Error detail may live at body.error, body.message, or nested in
    // body.data.error / body.data.reason (device endpoints) — surface all.
    const msg =
      (body &&
        (body.error ||
          body.message ||
          (body.data && (body.data.error || body.data.reason)))) ||
      `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  // dashboard
  dashboardSummary: (date) => request(`/dashboard/summary${date ? `?date=${date}` : ''}`),

  // attendance
  daily: (params) => request(`/attendance/daily?${new URLSearchParams(params)}`),
  rawLogs: (params) => request(`/attendance/logs?${new URLSearchParams(params)}`),
  recompute: (from, to) =>
    request(`/attendance/recompute`, { method: 'POST', body: JSON.stringify({ from, to }) }),

  // teachers
  teachers: (params = {}) => request(`/teachers?${new URLSearchParams(params)}`),
  departments: () => request(`/teachers/departments`),
  createTeacher: (data) => request(`/teachers`, { method: 'POST', body: JSON.stringify(data) }),
  updateTeacher: (id, data) => request(`/teachers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTeacher: (id) => request(`/teachers/${id}`, { method: 'DELETE' }),
  pushTeacher: (id) => request(`/teachers/${id}/push-to-device`, { method: 'POST' }),

  // shifts
  shifts: () => request(`/shifts`),
  createShift: (data) => request(`/shifts`, { method: 'POST', body: JSON.stringify(data) }),
  updateShift: (id, data) => request(`/shifts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteShift: (id) => request(`/shifts/${id}`, { method: 'DELETE' }),

  // device
  deviceStatus: () => request(`/device/status`),
  deviceTest: () => request(`/device/test`, { method: 'POST' }),
  syncNow: () => request(`/device/sync-now`, { method: 'POST' }),
  deviceUsers: () => request(`/device/users`),
  importDeviceUsers: (users, extra = {}) =>
    request(`/device/users/import`, { method: 'POST', body: JSON.stringify({ users, ...extra }) }),
  pushAllTeachers: () => request(`/device/users/push-all`, { method: 'POST' }),
  unknownUsers: () => request(`/device/unknown-users`),
};

/* ── small formatting helpers ─────────────────────────────────────────── */
export function fmtTime(iso) {
  if (!iso) return '—';
  const hh = Number(iso.slice(11, 13));
  const mm = iso.slice(14, 16);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const h12 = ((hh + 11) % 12) + 1;
  return `${String(h12).padStart(2, '0')}:${mm} ${ampm}`;
}

export function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!iso) return '—';
  return new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', opts);
}

export function humanizeMinutes(min) {
  if (!min || min <= 0) return '0m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? (m > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`) : `${m}m`;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysAgoISO(n) {
  const d = new Date(Date.now() - n * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
