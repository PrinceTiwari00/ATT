import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Search, CalendarDays, Hourglass } from 'lucide-react';
import { api, fmtTime, fmtDate, humanizeMinutes, todayISO, daysAgoISO } from '../api/client';
import StatusBadges, { rowTone } from '../components/Badge';
import { useToast } from '../components/Toast';

const STATUS_OPTS = [
  ['', 'All statuses'], ['on_time', 'On time'], ['late', 'Late'],
  ['early', 'Early departure'], ['late_early', 'Late + Early'], ['absent', 'Absent'],
];

/** Attendance view table (spec § D.1–D.4 / deliverable #5) */
export default function Attendance() {
  const toast = useToast();
  const [filters, setFilters] = useState({
    from: todayISO(), to: todayISO(), q: '', department: '', status: '',
  });
  const [departments, setDepartments] = useState([]);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    api.departments().then((r) => setDepartments(r.data)).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    api.daily(params)
      .then((r) => { setRows(r.data); setMeta(r.meta); })
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const quick = (n) => setFilters((f) => ({ ...f, from: daysAgoISO(n), to: todayISO() }));

  const doSync = async () => {
    setSyncing(true);
    try {
      const r = await api.syncNow();
      if (r.data.ok) {
        toast.success(`Sync complete — pulled ${r.data.fetched} device logs, ${r.data.inserted} new.`);
      } else toast.warning(r.data.reason || r.data.error || 'Sync skipped');
      load();
    } catch (e) {
      toast.error(`Sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const exportCsv = () => {
    const head = ['Teacher', 'ZK ID', 'Department', 'Date', 'Shift', 'Check-in', 'Check-out', 'Late (min)', 'Early (min)', 'Work (min)', 'Status'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.map(esc).join(',')];
    for (const r of rows) {
      lines.push([
        r.full_name, r.zk_user_id, r.department, r.work_date,
        r.shift_name || '', r.check_in || '', r.check_out || '',
        r.late_minutes, r.early_minutes, r.work_minutes ?? '', r.status,
      ].map(esc).join(','));
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), {
      href: url, download: `attendance_${filters.from}_${filters.to}.csv`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  const chips = useMemo(() => meta && [
    ['Total rows', meta.total, 'bg-slate-100 text-slate-700'],
    ['Present', meta.present, 'bg-emerald-100 text-emerald-700'],
    ['On time', meta.onTime, 'bg-teal-100 text-teal-700'],
    ['Late', meta.late, 'bg-rose-100 text-rose-700'],
    ['Early dep.', meta.early, 'bg-purple-100 text-purple-700'],
    ['Absent', meta.absent, 'bg-slate-200 text-slate-600'],
  ], [meta]);

  return (
    <div className="anim-in space-y-4">
      {/* Filter bar (spec § D.3) */}
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <Field label="From">
          <input type="date" className="input w-[150px]" value={filters.from}
            max={todayISO()} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </Field>
        <Field label="To">
          <input type="date" className="input w-[150px]" value={filters.to}
            max={todayISO()} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
        </Field>
        <div className="flex gap-1.5">
          {[['Today', () => setFilters((f) => ({ ...f, from: todayISO(), to: todayISO() }))],
           ['7d', () => quick(6)], ['14d', () => quick(13)], ['30d', () => quick(29)]].map(([label, fn]) => (
            <button key={label} onClick={fn} className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 cursor-pointer">
              {label}
            </button>
          ))}
        </div>
        <Field label="Teacher">
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="input w-52 pl-9" placeholder="Name or ZK ID…" value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
          </div>
        </Field>
        <Field label="Department">
          <select className="input w-44" value={filters.department}
            onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className="input w-40" value={filters.status}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            {STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost" onClick={doSync} disabled={syncing}>
            <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} /> Sync device
          </button>
          <button className="btn-primary" onClick={exportCsv}><Download size={15} /> CSV</button>
        </div>
      </div>

      {/* Summary chips (live filter metrics) */}
      {chips && (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <CalendarDays size={15} className="text-slate-400" />
          <span className="text-xs font-semibold text-slate-500">
            {fmtDate(filters.from)}{filters.to !== filters.from ? ` → ${fmtDate(filters.to)}` : ''}
          </span>
          {chips.map(([l, v, cls]) => (
            <span key={l} className={`badge ${cls} tabular-nums`}>{l}: {v}</span>
          ))}
        </div>
      )}

      {/* The table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="th-table">Teacher</th>
                <th className="th-table">Date</th>
                <th className="th-table">Check-in</th>
                <th className="th-table">Check-out</th>
                <th className="th-table">Shift</th>
                <th className="th-table">Hours</th>
                <th className="th-table">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 animate-pulse rounded bg-slate-100" style={{ width: `${60 + ((i + j) * 17) % 40}%` }} /></td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-14 text-center text-sm text-slate-400">
                  No records match these filters.
                </td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className={`border-b border-slate-100 transition ${rowTone(r.status)}`}>
                    <td className="td-table">
                      <div className="font-semibold text-slate-900">{r.full_name}</div>
                      <div className="text-[11.5px] text-slate-400">ZK #{r.zk_user_id} · {r.department}</div>
                    </td>
                    <td className="td-table font-medium">{fmtDate(r.work_date)}</td>
                    <td className={`td-table tabular-nums font-semibold ${r.late_minutes > 0 ? 'text-rose-600' : 'text-slate-800'}`}>
                      {fmtTime(r.check_in)}
                      {r.late_minutes > 0 && (
                        <div className="text-[10.5px] font-bold text-rose-500">+{humanizeMinutes(r.late_minutes)} late</div>
                      )}
                    </td>
                    <td className={`td-table tabular-nums font-semibold ${r.early_minutes > 0 ? 'text-purple-600' : 'text-slate-800'}`}>
                      {fmtTime(r.check_out)}
                      {r.early_minutes > 0 && (
                        <div className="text-[10.5px] font-bold text-purple-500">−{humanizeMinutes(r.early_minutes)} early</div>
                      )}
                    </td>
                    <td className="td-table">
                      {r.shift_name ? (
                        <>
                          <div className="font-medium text-slate-700">{r.shift_name}</div>
                          <div className="text-[11.5px] text-slate-400">{r.shift_start}–{r.shift_end} · grace {r.grace_period_minutes}m</div>
                        </>
                      ) : '—'}
                    </td>
                    <td className="td-table tabular-nums">
                      {r.work_minutes != null ? (
                        <span className="inline-flex items-center gap-1 text-slate-600"><Hourglass size={13} className="text-slate-400" />{humanizeMinutes(r.work_minutes)}</span>
                      ) : '—'}
                    </td>
                    <td className="td-table">
                      <StatusBadges status={r.status} lateMinutes={r.late_minutes} earlyMinutes={r.early_minutes} punchCount={r.punch_count} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!loading && rows.length > 0 && (
          <div className="border-t border-slate-100 px-4 py-2.5 text-[12px] text-slate-400">
            {rows.length} record{rows.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      {children}
    </label>
  );
}
