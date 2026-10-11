import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Clock3, Download, LogOut, Timer, UserCheck, UserX } from 'lucide-react';
import { api, humanizeMinutes, todayISO } from '../api/client';
import { BsMonthFields } from '../components/BsDateFields';
import KpiCard from '../components/KpiCard';
import { useToast } from '../components/Toast';
import { adToBsParts, formatAdDate, formatDatePair } from '../lib/nepaliDate';
import { patternLabel } from '../lib/workPattern';

const initialMonth = () => adToBsParts(todayISO()) || { year: 2083, month: 1 };
const CSV_COLUMNS = [
  ['Full name', 'fullName'],
  ['ZKTeco ID', 'zkUserId'],
  ['Department', 'department'],
  ['Employment', (row) => employmentLabel(row)],
  ['Working days (their own pattern)', (row) => formatWorkPattern(row)],
  ['Scheduled workdays in month', 'scheduledWorkdays'],
  ['Elapsed workdays', 'workingDays'],
  ['Present days', 'presentDays'],
  ['Absent days', 'absentDays'],
  ['Late arrival days', 'lateDays'],
  ['Late time (minutes)', 'lateMinutes'],
  ['Early departure days', 'earlyDepartureDays'],
  ['Early departure time (minutes)', 'earlyMinutes'],
  ['Overtime days', 'overtimeDays'],
  ['Overtime (minutes)', 'overtimeMinutes'],
  ['Off-day / off-pattern punch days', 'nonWorkingDayPunches'],
];

/** How a row should be labelled for pay: full-time or part-time. */
function employmentLabel(row) {
  return row.partTime || row.employmentType === 'part_time' ? 'Part-time' : 'Full-time';
}
/** The days a person was measured against, as words instead of JSON. */
function formatWorkPattern(row) {
  return row.followsSchoolWeek === false ? patternLabel(row.workPattern) : 'Every school day';
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export default function MonthlyReport() {
  const toast = useToast();
  const [selected, setSelected] = useState(initialMonth);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.monthlyReport(selected.year, selected.month)
      .then((r) => setReport(r.data))
      .catch((err) => {
        setReport(null);
        toast.error(err.message);
      })
      .finally(() => setLoading(false));
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const exportCsv = () => {
    if (!report) return;
    const lines = [
      [csvCell('Monthly attendance'), csvCell(report.period.bsLabel)].join(','),
      [csvCell('Gregorian period'), csvCell(`${report.period.from} to ${report.period.to}`)].join(','),
      [csvCell('Day counts'), csvCell("each person's own working days")].join(','),
      [],
      CSV_COLUMNS.map(([label]) => csvCell(label)).join(','),
      ...report.staff.map((person) => CSV_COLUMNS.map(([, field]) => csvCell(
        typeof field === 'function' ? field(person) : person[field]
      )).join(',')),
    ];
    const blob = new Blob(['\uFEFF', lines.map((line) => Array.isArray(line) ? line.join(',') : line).join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement('a'), {
      href: url,
      download: `ATT_monthly_${report.period.bsYear}_${String(report.period.bsMonth).padStart(2, '0')}_BS.csv`,
    });
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const summary = report?.summary;
  return (
    <div className="anim-in space-y-5">
      <section className="card flex flex-wrap items-end gap-4 p-4">
        <div className="min-w-[250px] flex-1">
          <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Report month (Bikram Sambat)</span>
          <BsMonthFields year={selected.year} month={selected.month} onChange={setSelected} disabled={loading} />
        </div>
        <button className="btn-primary" onClick={exportCsv} disabled={!report || loading}>
          <Download size={15} /> Download CSV
        </button>
        {report && (
          <p className="w-full text-[11.5px] text-slate-500">
            {report.period.bsLabel} <span className="text-slate-400">· Gregorian {formatAdDate(report.period.from)} to {formatAdDate(report.period.to)}</span>
          </p>
        )}
      </section>

      {loading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-2xl bg-slate-200/70" />)}
        </div>
      ) : report && summary ? (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
            <KpiCard icon={CalendarDays} label="Working days" value={summary.calendarWorkdays} sub={`${summary.completedWorkdays} elapsed · ${summary.remainingWorkdays} remaining`} tone="indigo" />
            <KpiCard icon={UserCheck} label="Present days" value={summary.presentDays} sub="staff-days with a punch" tone="emerald" />
            <KpiCard icon={UserX} label="Absent days" value={summary.absentDays}
              sub={`of ${summary.expectedStaffDays} expected staff-days`} tone="slate" />
            <KpiCard icon={Clock3} label="Late arrivals" value={summary.lateDays} sub={humanizeMinutes(summary.lateMinutes)} tone="rose" />
            <KpiCard icon={LogOut} label="Early departures" value={summary.earlyDepartureDays} sub={humanizeMinutes(summary.earlyMinutes)} tone="purple" />
            <KpiCard icon={Timer} label="Overtime" value={summary.overtimeDays} sub={humanizeMinutes(summary.overtimeMinutes)} tone="amber" />
          </div>

          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
              <div>
                <h2 className="text-[14px] font-bold text-slate-800">Staff monthly totals</h2>
                <p className="text-[12px] text-slate-500">Totals are per person; summary cards add the staff-days together.</p>
              </div>
              <span className="badge bg-slate-100 text-slate-600">{summary.staffCount} active staff</span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80">
                    <th className="th-table">Teacher / Staff</th>
                    <th className="th-table text-right">Elapsed / scheduled</th>
                    <th className="th-table text-right">Present</th>
                    <th className="th-table text-right">Absent</th>
                    <th className="th-table text-right">Late days · time</th>
                    <th className="th-table text-right">Early depart. · time</th>
                    <th className="th-table text-right">Overtime · time</th>
                    <th className="th-table text-right">Off-day / off-pattern punches</th>
                  </tr>
                </thead>
                <tbody>
                  {report.staff.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-slate-400">No active teachers or staff are registered.</td></tr>
                  ) : report.staff.map((person) => (
                    <tr key={person.id} className="border-b border-slate-100 transition hover:bg-slate-50">
                      <td className="td-table">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-slate-900">{person.fullName}</span>
                          {(person.partTime || person.followsSchoolWeek === false) && (
                            <span className="badge bg-amber-100 text-amber-700"
                              title="Counted against their own working days, not the school week">
                              {employmentLabel(person)} · {patternLabel(person.workPattern)}
                            </span>
                          )}
                        </div>
                        <div className="text-[11.5px] text-slate-400">ZK #{person.zkUserId} · {person.department}</div>
                      </td>
                      <td className="td-table text-right tabular-nums">
                        {person.workingDays} / {person.scheduledWorkdays}
                        {person.followsSchoolWeek === false && (
                          <div className="text-[11px] text-slate-400">their own days</div>
                        )}
                      </td>
                      <td className="td-table text-right font-semibold tabular-nums text-emerald-700">{person.presentDays}</td>
                      <td className="td-table text-right font-semibold tabular-nums text-slate-700">{person.absentDays}</td>
                      <td className="td-table text-right tabular-nums"><span className="font-semibold text-rose-700">{person.lateDays}</span><span className="text-slate-400"> · {humanizeMinutes(person.lateMinutes)}</span></td>
                      <td className="td-table text-right tabular-nums"><span className="font-semibold text-purple-700">{person.earlyDepartureDays}</span><span className="text-slate-400"> · {humanizeMinutes(person.earlyMinutes)}</span></td>
                      <td className="td-table text-right tabular-nums"><span className="font-semibold text-amber-700">{person.overtimeDays}</span><span className="text-slate-400"> · {humanizeMinutes(person.overtimeMinutes)}</span></td>
                      <td className="td-table text-right tabular-nums">{person.nonWorkingDayPunches}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-5">
              <h2 className="text-sm font-bold text-slate-800">Holidays this month</h2>
              {report.holidays.length ? (
                <ul className="mt-3 divide-y divide-slate-100">
                  {report.holidays.map((holiday) => (
                    <li key={holiday.date} className="flex items-start justify-between gap-3 py-2 text-[12.5px]">
                      <span className="font-medium text-slate-700">{holiday.names.join(', ')}</span>
                      <span className="shrink-0 text-right text-slate-500">{formatDatePair(holiday.date)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-[12.5px] text-slate-400">No named holidays in this month.</p>}
            </section>
            <section className="card p-5">
              <h2 className="text-sm font-bold text-slate-800">How totals are counted</h2>
              <ul className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-slate-500">
                <li><b className="text-slate-700">Present:</b> at least one punch on a day this person is scheduled for.</li>
                <li><b className="text-slate-700">Absent:</b> a completed scheduled day with no punches. Each person is measured
                  against their own working days — a part-timer set to Mon/Wed/Fri is never absent on a Tuesday. Weekends,
                  configured days off and holidays are excluded for everyone, and future days are never counted absent.
                  {summary.partTimeStaff > 0 && <> {summary.partTimeStaff} of {summary.staffCount} staff carry a personal pattern this month.</>}</li>
                <li><b className="text-slate-700">Late:</b> on one of their own days, after the assigned shift’s grace period; total
                  late minutes are measured from the scheduled start time. Off-pattern arrivals are never marked late.</li>
                <li><b className="text-slate-700">Early departure:</b> check-out before the scheduled shift end. <b className="text-slate-700">Overtime:</b> check-out after shift end.</li>
                <li>Punches on a day off — or on a weekday outside the person&rsquo;s own pattern — are listed separately and do
                  not change the scheduled-day totals.</li>
              </ul>
            </section>
          </div>
        </>
      ) : (
        <div className="card p-8 text-center text-sm text-slate-500">The monthly report could not be loaded. Choose another BS month or refresh.</div>
      )}
    </div>
  );
}
