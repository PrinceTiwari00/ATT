import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  UserCheck, Clock, LogOut, UserX, Users, ArrowRight,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts';
import { api, fmtTime, fmtDate, humanizeMinutes, todayISO } from '../api/client';
import KpiCard from '../components/KpiCard';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let dead = false;
    const load = () =>
      api.dashboardSummary(todayISO())
        .then((r) => !dead && (setData(r.data), setErr(null)))
        .catch((e) => !dead && setErr(e.message));
    load();
    const id = setInterval(load, 30000);
    return () => { dead = true; clearInterval(id); };
  }, []);

  if (err) return <div className="card p-6 text-sm text-rose-600">Dashboard unavailable: {err}</div>;
  if (!data) return <Loading />;

  const { kpi, lateList, earlyList, deptBreakdown, trend, date } = data;
  const trendData = trend.map((t) => ({
    ...t,
    day: new Date(t.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
  }));
  const maxDept = Math.max(1, ...deptBreakdown.map((d) => d.total));

  return (
    <div className="space-y-5 anim-in">
      {/* KPI row (spec § D.4) */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiCard icon={Users} label="Total Present" value={kpi.present} sub={`of ${kpi.totalActive} active staff`} tone="emerald" />
        <KpiCard icon={UserCheck} label="On Time" value={kpi.on_time} sub={`≤ shift start + grace`} tone="indigo" />
        <KpiCard icon={Clock} label="Late Arrivals" value={kpi.late} sub={kpi.worst_late ? `worst +${humanizeMinutes(kpi.worst_late)}` : 'none today'} tone="rose" />
        <KpiCard icon={LogOut} label="Early Departures" value={kpi.early} sub="left before shift end" tone="amber" />
        <KpiCard icon={UserX} label="Absent" value={kpi.absent} sub={fmtDate(date)} tone="slate" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* 7-day trend */}
        <div className="card p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-[15px] font-bold text-slate-900">7-Day Attendance Trend</h3>
              <p className="text-xs text-slate-500">On-time vs late vs early departures vs absent</p>
            </div>
            <Link to="/attendance" className="btn-ghost !py-1.5 !text-xs">Open log <ArrowRight size={13} /></Link>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData} barCategoryGap="22%">
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} width={26} />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                  contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12, boxShadow: '0 8px 24px rgba(15,23,42,.08)' }}
                />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                <Bar dataKey="on_time" name="On time" stackId="a" fill="#34d399" radius={[0, 0, 0, 0]} />
                <Bar dataKey="late" name="Late" stackId="a" fill="#fb7185" />
                <Bar dataKey="early" name="Early dep." stackId="a" fill="#c084fc" />
                <Bar dataKey="absent" name="Absent" stackId="a" fill="#cbd5e1" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Department presence */}
        <div className="card p-5">
          <h3 className="text-[15px] font-bold text-slate-900">Presence by Department</h3>
          <p className="mb-4 text-xs text-slate-500">Who is in today</p>
          <div className="space-y-3">
            {deptBreakdown.map((d) => (
              <div key={d.department}>
                <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
                  <span className="font-medium text-slate-700">{d.department}</span>
                  <span className="tabular-nums text-slate-500">
                    <span className="font-bold text-slate-800">{d.present}</span>/{d.total}
                    {d.late > 0 && <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-600">{d.late} late</span>}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-500 transition-all duration-700"
                    style={{ width: `${(d.present / maxDept) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            {deptBreakdown.length === 0 && <p className="py-6 text-center text-xs text-slate-400">No data yet</p>}
          </div>
        </div>
      </div>

      {/* Late + Early lists */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MiniList
          title="Late Arrivals Today"
          empty="Nobody was late — perfect morning 🎉"
          rows={lateList.map((r) => ({
            name: r.full_name,
            dept: r.department,
            when: fmtTime(r.check_in),
            whenLabel: 'check-in',
            pill: `+${humanizeMinutes(r.late_minutes)}`,
            pillCls: 'bg-rose-100 text-rose-700',
            sub: `shift starts ${r.start_time}`,
          }))}
        />
        <MiniList
          title="Early Departures Today"
          empty="No early leavers today"
          rows={earlyList.map((r) => ({
            name: r.full_name,
            dept: r.department,
            when: fmtTime(r.check_out),
            whenLabel: 'check-out',
            pill: `−${humanizeMinutes(r.early_minutes)}`,
            pillCls: 'bg-purple-100 text-purple-700',
            sub: `shift ends ${r.end_time}`,
          }))}
        />
      </div>
    </div>
  );
}

function MiniList({ title, rows, empty }) {
  return (
    <div className="card p-5">
      <h3 className="mb-3 text-[15px] font-bold text-slate-900">{title}</h3>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-[13px] text-slate-400">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-100 text-[12px] font-bold text-slate-600">
                  {r.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-800">{r.name}</div>
                  <div className="text-[11.5px] text-slate-500">{r.dept} · {r.sub}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] tabular-nums text-slate-500">{r.whenLabel} {r.when}</span>
                <span className={`badge ${r.pillCls} tabular-nums`}>{r.pill}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-28 animate-pulse rounded-2xl bg-slate-200/70" />
      ))}
    </div>
  );
}
