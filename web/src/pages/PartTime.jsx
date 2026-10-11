/**
 * Part-time Staff — a page of its own for people who do not work every school
 * day. Pick the weekdays each person is actually on duty; the ledger, the
 * dashboard and the monthly report then count their days (and their absences)
 * against that pattern instead of the whole school week.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays, CalendarCheck, Check, ChevronLeft, ChevronRight, Clock3, Info,
  Pencil, RefreshCw, Save, Search, UserCog,
} from 'lucide-react';
import { api, todayISO } from '../api/client';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';
import { adToBsParts, bsMonthRange, formatBsDate } from '../lib/nepaliDate';
import { WEEKDAY_LABELS, bsMonthWeeks, bsMonthTitle, canShiftBsMonth, shiftBsMonth } from '../lib/calendarGrid';
import {
  QUICK_PATTERNS, isExpectedOn, patternLabel, resolvePattern, summarizePattern, toggleWeekday,
} from '../lib/workPattern';

const currentBsMonth = () => adToBsParts(todayISO()) || { year: 2083, month: 1 };

export default function PartTime() {
  const toast = useToast();
  const [staff, setStaff] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [schoolWeek, setSchoolWeek] = useState(null);
  const [month, setMonth] = useState(currentBsMonth);
  const [dayStatus, setDayStatus] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('part'); // part = only custom schedules
  const [editor, setEditor] = useState({ open: false, teacher: null, form: null });
  const [refreshKey, setRefreshKey] = useState(0); // bump after a save to re-read the month

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([api.teachers({ status: 'active' }), api.shifts(), api.calendar()])
      .then(([t, s, c]) => {
        setStaff(t.data);
        setShifts(s.data);
        setSchoolWeek(c.data.workingDays);
      })
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const range = useMemo(() => {
    try {
      return bsMonthRange(month.year, month.month);
    } catch {
      return null;
    }
  }, [month]);

  // The month the preview + the attendance numbers are read from.
  useEffect(() => {
    if (!range) return;
    let dead = false;
    api.calendarDays(range.from, range.to)
      .then((r) => !dead && setDayStatus(r.data.days))
      .catch(() => !dead && setDayStatus([]));
    api.monthlyReport(month.year, month.month)
      .then((r) => !dead && setReport(r.data))
      .catch(() => !dead && setReport(null));
    return () => { dead = true; };
  }, [range, month, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const week = schoolWeek || resolvePattern(null, []);
  const today = todayISO();

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return staff
      .filter((t) => !q
        || t.full_name.toLowerCase().includes(q)
        || String(t.zk_user_id).includes(q)
        || (t.department || '').toLowerCase().includes(q))
      .map((teacher) => {
        const pattern = resolvePattern(teacher.working_days, week);
        const numbers = report?.staff.find((person) => person.id === teacher.id);
        return {
          ...teacher,
          partTime: teacher.employment_type === 'part_time',
          customDays: Boolean(teacher.working_days?.length),
          pattern,
          preview: summarizePattern(dayStatus, pattern, today),
          numbers,
        };
      })
      .filter((row) => (scope === 'part' ? row.partTime || row.customDays : true))
      .sort((a, b) => (a.partTime === b.partTime
        ? a.full_name.localeCompare(b.full_name)
        : (a.partTime ? -1 : 1)));
  }, [staff, query, scope, dayStatus, report, week, today]);

  const partTimers = staff.filter((t) => t.employment_type === 'part_time' || t.working_days?.length);

  const openEditor = (row) => setEditor({
    open: true,
    teacher: row,
    form: {
      employment_type: row.employment_type || 'full_time',
      customDays: Boolean(row.working_days?.length),
      working_days: row.working_days?.length ? [...row.working_days] : [...week],
      shift_id: row.shift_id ?? '',
    },
  });

  const closeEditor = () => setEditor({ open: false, teacher: null, form: null });

  const save = async () => {
    const { teacher, form } = editor;
    if (form.customDays && form.working_days.length === 0) {
      toast.error('Pick at least one working day, or switch back to the school week');
      return;
    }
    setSaving(true);
    try {
      await api.updateTeacher(teacher.id, {
        employment_type: form.employment_type,
        working_days: form.customDays ? form.working_days : null,
        shift_id: form.shift_id === '' ? null : Number(form.shift_id),
      });
      toast.success(`${teacher.full_name} — ${form.customDays ? patternLabel(form.working_days) : 'every school day'}`);
      closeEditor();
      await load();
      setRefreshKey((key) => key + 1); // the day counts in the table follow the new pattern
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const editorPreview = useMemo(() => {
    if (!editor.form) return null;
    const pattern = editor.form.customDays ? editor.form.working_days : week;
    return { pattern, summary: summarizePattern(dayStatus, pattern, today) };
  }, [editor.form, dayStatus, week, today]);

  return (
    <div className="anim-in space-y-4">
      <section className="card p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
            <UserCog size={19} />
          </div>
          <div className="min-w-[260px] flex-1">
            <h2 className="text-[14px] font-bold text-slate-800">Who works which days?</h2>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-slate-500">
              Everyone follows the school working week unless you give them their own days here. A part-timer is only
              expected on their own days — other days are not absences, and the monthly report counts theirs, not the
              school&rsquo;s. A day the whole school has off (holiday or a calendar override) is off for them too.
            </p>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-slate-500">
              <span className="badge bg-slate-100 text-slate-600">
                <CalendarDays size={12} /> School week: {patternLabel(week)}
              </span>
              <span className="badge bg-indigo-100 text-indigo-700">{partTimers.length} with their own days</span>
              <Link to="/calendar" className="badge bg-white text-indigo-600 ring-1 ring-indigo-100 hover:bg-indigo-50">
                Change the school week
              </Link>
              <Link to="/teachers" className="badge bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50">
                Add a profile in Teachers &amp; Staff
              </Link>
            </p>
          </div>
          <button className="btn-ghost" onClick={load} title="Reload"><RefreshCw size={15} /></button>
        </div>
      </section>

      <section className="card flex flex-wrap items-center gap-3 p-3.5">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="input w-56 pl-9" placeholder="Search name, ZK ID…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="flex rounded-xl bg-slate-100 p-0.5">
          {[['part', 'Part-time only'], ['all', 'Everyone']].map(([value, label]) => (
            <button key={value} onClick={() => setScope(value)}
              className={`rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold transition ${
                scope === value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-ghost !px-2" disabled={!canShiftBsMonth(month.year, month.month, -1)}
            onClick={() => setMonth((m) => shiftBsMonth(m.year, m.month, -1))} title="Previous month">
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[132px] text-center text-[12.5px] font-bold text-slate-700">{bsMonthTitle(month.year, month.month)}</span>
          <button className="btn-ghost !px-2" disabled={!canShiftBsMonth(month.year, month.month, 1)}
            onClick={() => setMonth((m) => shiftBsMonth(m.year, m.month, 1))} title="Next month">
            <ChevronRight size={16} />
          </button>
        </div>
        <p className="w-full text-[11.5px] text-slate-400">
          The month picker only drives the day preview and the attendance figures beside each name.
        </p>
      </section>

      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-[14px] font-bold text-slate-800">
              {scope === 'part' ? 'Part-time roster' : 'All active staff'}
            </h2>
            <p className="text-[12px] text-slate-500">
              {bsMonthTitle(month.year, month.month)} · expected days are each person&rsquo;s own, not the school&rsquo;s
            </p>
          </div>
          {report && (
            <span className="badge bg-slate-100 text-slate-600">
              {report.summary.completedWorkdays}/{report.summary.calendarWorkdays} school workdays elapsed
            </span>
          )}
        </header>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="th-table">Teacher / Staff</th>
                <th className="th-table">Employment</th>
                <th className="th-table">Working days</th>
                <th className="th-table">Shift</th>
                <th className="th-table text-right">Expected this month</th>
                <th className="th-table text-right">Present · absent</th>
                <th className="th-table text-right">Schedule</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 w-3/4 animate-pulse rounded bg-slate-100" /></td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-400">
                    {scope === 'part'
                      ? 'Nobody has their own working days yet — pick a person under “Everyone” to set a part-time schedule.'
                      : 'No active staff match that search.'}
                    {scope === 'part' && (
                      <button className="ml-2 font-semibold text-indigo-600 hover:underline" onClick={() => setScope('all')}>
                        Show everyone
                      </button>
                    )}
                  </td>
                </tr>
              ) : rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 transition hover:bg-slate-50">
                  <td className="td-table">
                    <div className="flex items-center gap-3">
                      <div className="grid h-9 w-9 place-items-center rounded-full bg-indigo-100 text-[12px] font-bold text-indigo-700">
                        {row.full_name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-slate-900">{row.full_name}</div>
                        <div className="text-[11.5px] text-slate-400">ZK #{row.zk_user_id} · {row.department} · {row.designation}</div>
                      </div>
                    </div>
                  </td>
                  <td className="td-table">
                    <span className={`badge ${row.partTime ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                      {row.partTime ? 'Part-time' : 'Full-time'}
                    </span>
                  </td>
                  <td className="td-table">
                    <div className="flex flex-wrap gap-1">
                      {WEEKDAY_LABELS.map((label, value) => {
                        const mine = row.pattern.includes(value);
                        return (
                          <span key={value} title={`${label} — ${mine ? 'expected' : 'not a working day'}`}
                            className={`grid h-6 w-9 place-items-center rounded-md text-[10.5px] font-bold ${
                              mine ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                            {label}
                          </span>
                        );
                      })}
                    </div>
                    {!row.customDays && (
                      <div className="mt-1 text-[11px] text-slate-400">Follows the school working week</div>
                    )}
                  </td>
                  <td className="td-table">
                    {row.shift_name ? (
                      <>
                        <div className="font-medium">{row.shift_name}</div>
                        <div className="flex items-center gap-1 text-[11.5px] text-slate-400">
                          <Clock3 size={11} /> {row.shift_start}–{row.shift_end}
                        </div>
                      </>
                    ) : <span className="text-slate-400">Default shift</span>}
                  </td>
                  <td className="td-table text-right tabular-nums">
                    <div className="font-semibold text-slate-800">{row.preview.scheduled}</div>
                    <div className="text-[11.5px] text-slate-400">{row.preview.elapsed} elapsed · {row.preview.remaining} to go</div>
                  </td>
                  <td className="td-table text-right tabular-nums">
                    {row.numbers ? (
                      <>
                        <span className="font-semibold text-emerald-700">{row.numbers.presentDays}</span>
                        <span className="text-slate-300"> · </span>
                        <span className={`font-semibold ${row.numbers.absentDays > 0 ? 'text-rose-600' : 'text-slate-500'}`}>
                          {row.numbers.absentDays}
                        </span>
                      </>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="td-table text-right">
                    <button className="btn-ghost !py-1.5 !text-xs" onClick={() => openEditor(row)}>
                      <Pencil size={13} /> Working days
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-100 px-5 py-3 text-[11.5px] leading-relaxed text-slate-400">
          <Info size={12} className="mr-1 inline -mt-0.5" />
          Absences are only counted on a person&rsquo;s own days, so a missed Mon/Wed/Fri teacher shows 2 absences a week
          only if they skip two of their three days. Punches on a day they were not due for stay in the log as extra
          work and are never marked late.
        </p>
      </section>

      <PatternEditor
        editor={editor}
        shifts={shifts}
        week={week}
        dayStatus={dayStatus}
        month={month}
        preview={editorPreview}
        setEditor={setEditor}
        onClose={closeEditor}
        onSave={save}
        saving={saving}
      />
    </div>
  );
}

function PatternEditor({ editor, shifts, week, dayStatus, month, preview, setEditor, onClose, onSave, saving }) {
  if (!editor.open || !editor.form) return null;
  const { form, teacher } = editor;
  const patch = (changes) => setEditor((state) => ({ ...state, form: { ...state.form, ...changes } }));
  const weeks = bsMonthWeeks(month.year, month.month);
  const statusOf = new Map(dayStatus.map((day) => [day.date, day]));
  const pattern = preview?.pattern || [];

  return (
    <Modal
      open={editor.open}
      onClose={onClose}
      width="max-w-2xl"
      title={`Working days — ${teacher.full_name}`}
      subtitle={`Expected on ${preview?.summary.scheduled ?? 0} of the ${bsMonthTitle(month.year, month.month)} days shown · saves instantly`}
    >
      <div className="space-y-4">
        <div>
          <span className="mb-1.5 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Employment</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { value: 'full_time', title: 'Full-time', body: 'Every day the school is open. No personal pattern needed.' },
              { value: 'part_time', title: 'Part-time', body: 'Only the days you tick below — the rest are not absences.' },
            ].map((option) => (
              <button key={option.value} type="button" onClick={() => {
                if (option.value === 'part_time' && !form.customDays) patch({ employment_type: option.value, customDays: true });
                else patch({ employment_type: option.value });
              }}
                className={`rounded-xl border p-3 text-left transition ${
                  form.employment_type === option.value
                    ? 'border-indigo-500 bg-indigo-50/70 ring-1 ring-indigo-200'
                    : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                <span className="flex items-center gap-2 text-[13px] font-bold text-slate-800">
                  <CalendarCheck size={14} className={form.employment_type === option.value ? 'text-indigo-600' : 'text-slate-400'} />
                  {option.title}
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-slate-500">{option.body}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 p-3.5">
          <label className="flex cursor-pointer items-center gap-2.5">
            <input type="checkbox" className="h-4 w-4 accent-indigo-600" checked={form.customDays}
              onChange={(e) => patch({ customDays: e.target.checked })} />
            <span className="text-[13px] font-semibold text-slate-800">This person works their own days</span>
            {!form.customDays && (
              <span className="badge bg-slate-100 text-slate-500">following {patternLabel(week)}</span>
            )}
          </label>

          {form.customDays ? (
            <>
              <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-7">
                {WEEKDAY_LABELS.map((label, value) => {
                  const on = form.working_days.includes(value);
                  const schoolDay = week.includes(value);
                  return (
                    <button key={value} type="button" title={schoolDay ? 'Also a school working day' : 'Outside the school week'}
                      onClick={() => patch({ working_days: toggleWeekday(form.working_days, value) || [] })}
                      className={`relative rounded-xl border px-2 py-2.5 text-[12px] font-bold transition ${
                        on ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-400'}`}>
                      {label}
                      {on && <Check size={11} className="absolute right-1 top-1 opacity-80" />}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Quick</span>
                {QUICK_PATTERNS.map((preset) => (
                  <button key={preset.label} type="button" onClick={() => patch({ working_days: [...preset.days] })}
                    className="rounded-lg bg-slate-100 px-2 py-1 text-[11.5px] font-semibold text-slate-600 hover:bg-slate-200">
                    {preset.label}
                  </button>
                ))}
                <button type="button" onClick={() => patch({ working_days: [...week] })}
                  className="rounded-lg bg-slate-100 px-2 py-1 text-[11.5px] font-semibold text-slate-600 hover:bg-slate-200">
                  Copy school week
                </button>
              </div>
              <p className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11.5px] leading-relaxed text-slate-500">
                <Info size={12} className="shrink-0 text-slate-400" />
                A day you tick that the school has off (weekend) still counts for this person — close it with a calendar
                override when the school is genuinely shut.
              </p>
            </>
          ) : (
            <p className="mt-2 text-[12px] text-slate-500">
              They are expected on <b className="text-slate-700">{patternLabel(week)}</b> and automatically follow any
              change you make to the school week later.
            </p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Shift on their days</span>
            <select className="input" value={form.shift_id} onChange={(e) => patch({ shift_id: e.target.value })}>
              <option value="">— Default shift —</option>
              {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_time}–{s.end_time})</option>)}
            </select>
            <span className="mt-1 block text-[11px] text-slate-400">
              Short days are fairer with a short shift — a 08:00–13:00 shift gives a real grace window.
            </span>
          </label>
          <div>
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
              {bsMonthTitle(month.year, month.month)} preview
            </span>
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-2">
              {weeks.map((weekRow, index) => (
                <div key={index} className="mb-1 flex gap-1 last:mb-0">
                  {weekRow.map((cell) => {
                    if (!cell) return <span key={`gap-${index}`} className="h-7 w-7" />;
                    const expected = isExpectedOn(
                      statusOf.get(cell.date) || { date: cell.date, weekday: cell.weekday, isHoliday: false, override: null },
                      pattern
                    );
                    const isToday = cell.date === todayISO();
                    return (
                      <span key={cell.date} title={`${formatBsDate(cell.date)} · ${WEEKDAY_LABELS[cell.weekday]}${expected ? ' — expected' : ''}`}
                        className={`grid h-7 w-7 place-items-center rounded-md text-[11px] font-semibold tabular-nums ${
                          expected ? 'bg-indigo-600 text-white' : 'bg-white text-slate-400 ring-1 ring-slate-200'
                        } ${isToday ? 'ring-2 ring-slate-900' : ''}`}>
                        {cell.bsDay}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11.5px] text-slate-500">
              <b className="text-slate-700">{preview?.summary.elapsed ?? 0}</b> of {preview?.summary.scheduled ?? 0} expected
              days have passed
              {preview?.summary.nextDate ? <> · next one is <b className="text-slate-700">{formatBsDate(preview.summary.nextDate)}</b> BS</> : ' · none left this month'}.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <p className="text-[11px] leading-relaxed text-slate-400">
            Rebuilds the last 30 days, so past absences follow the new pattern.
          </p>
          <div className="flex shrink-0 gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" onClick={onSave} disabled={saving}>
              {saving ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />} Save schedule
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
