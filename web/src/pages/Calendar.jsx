import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Briefcase, CalendarDays, CalendarOff, Check, ChevronLeft, ChevronRight,
  Clock3, Info, Pencil, Plus, RotateCcw, Save, Trash2,
} from 'lucide-react';
import { api, todayISO } from '../api/client';
import { BsDateFields } from '../components/BsDateFields';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';
import { BS_MONTHS, adToBsParts, daysInBsMonth, formatAdDate, formatBsDate } from '../lib/nepaliDate';
import {
  WEEKDAY_NAMES, adDayLabel, bsMonthCells, bsMonthTitle, bsMonthWeeks,
  canShiftBsMonth, dateRangeSelection, shiftBsMonth,
} from '../lib/calendarGrid';

const WEEKDAYS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

const DAY_MODES = [
  {
    value: 'workday',
    label: 'Work day',
    icon: Briefcase,
    hint: 'Counts as a working day — staff without a punch are marked absent. Works even on a holiday or weekend.',
    tone: 'emerald',
  },
  {
    value: 'holiday',
    label: 'Holiday',
    icon: CalendarOff,
    hint: 'Excluded from absence totals. Punches on that day stay visible as off-day work.',
    tone: 'amber',
  },
  {
    value: 'default',
    label: 'School default',
    icon: RotateCcw,
    hint: 'Follow the regular working week and the holiday list again.',
    tone: 'slate',
  },
];

const TONE_CLASSES = {
  emerald: 'border-emerald-500 bg-emerald-50/70 ring-emerald-200',
  amber: 'border-amber-500 bg-amber-50/70 ring-amber-200',
  slate: 'border-slate-500 bg-slate-50 ring-slate-200',
};
const TONE_ICON = {
  emerald: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-700',
  slate: 'bg-slate-200 text-slate-600',
};

const currentBs = () => adToBsParts(todayISO()) || { year: 2083, month: 1, day: 1 };
const blankHoliday = () => {
  const bs = currentBs();
  return { name: '', kind: 'once', date: todayISO(), bsMonth: bs.month, bsDay: bs.day };
};

/** One day of the month grid: BS day prominent, Gregorian date beside it. */
function DayCell({ cell, status, isToday, selected, onPointerDown, onKeySelect }) {
  const working = Boolean(status?.isWorkingDay);
  const holiday = Boolean(status?.isHoliday);
  const custom = Boolean(status?.override);
  const holidayName = status?.holidayNames?.[0] || '';

  let tone = 'border-slate-200 bg-slate-50 text-slate-500';
  let badgeTone = 'bg-slate-200/80 text-slate-600';
  let badgeLabel = 'Off';
  if (custom && working) {
    tone = 'border-emerald-300 bg-emerald-50 text-emerald-900';
    badgeTone = 'bg-emerald-200/80 text-emerald-800';
    badgeLabel = 'Work · custom';
  } else if (custom && !working) {
    tone = 'border-rose-300 bg-rose-50 text-rose-900';
    badgeTone = 'bg-rose-200/80 text-rose-800';
    badgeLabel = 'Off · custom';
  } else if (holiday) {
    tone = 'border-amber-300 bg-amber-50 text-amber-900';
    badgeTone = 'bg-amber-200/80 text-amber-800';
    badgeLabel = 'Holiday';
  } else if (working) {
    tone = 'border-indigo-200 bg-indigo-50/70 text-indigo-900';
    badgeTone = 'bg-indigo-200/70 text-indigo-700';
    badgeLabel = 'Work';
  }

  const title = [
    `${formatBsDate(cell.date, { weekday: true })} · ${formatAdDate(cell.date, { weekday: true })}`,
    status ? (working ? 'Working day' : 'Non-working day') : 'Loading…',
    holidayName && `Holiday: ${holidayName}`,
    status?.override?.note && `Note: ${status.override.note}`,
    'Click to change · drag across days to select more',
  ].filter(Boolean).join('\n');

  return (
    <button
      type="button"
      data-date={cell.date}
      title={title}
      aria-label={title.split('\n')[0]}
      aria-pressed={selected}
      onPointerDown={(event) => onPointerDown(event, cell.date)}
      onClick={(event) => { if (event.detail === 0) onKeySelect(cell.date); }}
      className={`relative flex h-[82px] w-full select-none flex-col rounded-xl border p-1.5 text-left transition ${tone} ${
        selected ? 'ring-2 ring-indigo-500 ring-offset-1' : 'hover:border-slate-400'
      } ${isToday ? 'shadow-[inset_0_0_0_2px_rgba(15,23,42,0.55)]' : ''}`}
    >
      <span className="flex items-start justify-between gap-1">
        <span className="text-[17px] font-extrabold leading-none">{cell.bsDay}</span>
        <span className="text-[9.5px] font-medium text-slate-500">{adDayLabel(cell)}</span>
      </span>
      <span className="mt-auto flex flex-col items-start gap-0.5">
        <span className={`badge !px-1.5 !text-[9.5px] ${badgeTone}`}>{status ? badgeLabel : '…'}</span>
        {holidayName && <span className="w-full truncate text-[9.5px] font-medium text-amber-800">{holidayName}</span>}
        {isToday && <span className="text-[9px] font-bold uppercase tracking-wide text-slate-600">Today</span>}
      </span>
    </button>
  );
}

export default function Calendar() {
  const toast = useToast();
  const [calendar, setCalendar] = useState(null);
  const [workingDays, setWorkingDays] = useState([1, 2, 3, 4, 5]);
  const [loading, setLoading] = useState(true);
  const [savingDays, setSavingDays] = useState(false);
  const [savingHoliday, setSavingHoliday] = useState(false);
  const [holidayModal, setHolidayModal] = useState({ open: false, editing: null, form: blankHoliday() });

  const today = todayISO();
  const [view, setView] = useState(() => {
    const bs = currentBs();
    return { year: bs.year, month: bs.month };
  });
  const [dayStatus, setDayStatus] = useState({});
  const [monthLoading, setMonthLoading] = useState(false);
  const [drag, setDrag] = useState(null);
  const [chooser, setChooser] = useState(null);
  const [applying, setApplying] = useState(false);
  const finishedRef = useRef(false);

  const cells = useMemo(() => bsMonthCells(view.year, view.month), [view]);
  const weeks = useMemo(() => bsMonthWeeks(view.year, view.month), [view]);
  const cellByDate = useMemo(() => new Map(cells.map((cell) => [cell.date, cell])), [cells]);
  const overridesByDate = useMemo(
    () => new Map((calendar?.overrides || []).map((row) => [row.date, row])),
    [calendar],
  );

  const dragDates = useMemo(
    () => (drag ? dateRangeSelection(cells, drag.anchor, drag.focus) : []),
    [drag, cells],
  );
  const dragSet = useMemo(() => new Set(dragDates), [dragDates]);

  /* ── data loading ─────────────────────────────────────────────────────── */
  const loadCalendar = useCallback(() => {
    setLoading(true);
    api.calendar()
      .then((r) => {
        setCalendar(r.data);
        setWorkingDays(r.data.workingDays || []);
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMonth = useCallback((year, month) => {
    const monthCells = bsMonthCells(year, month);
    if (!monthCells.length) return;
    setMonthLoading(true);
    api.calendarDays(monthCells[0].date, monthCells[monthCells.length - 1].date)
      .then((r) => {
        setDayStatus((current) => {
          const next = { ...current };
          for (const day of r.data.days) next[day.date] = day;
          return next;
        });
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setMonthLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(loadCalendar, [loadCalendar]);
  useEffect(() => { loadMonth(view.year, view.month); }, [view, loadMonth]);

  /* ── regular working week ─────────────────────────────────────────────── */
  const saveWorkweek = async () => {
    setSavingDays(true);
    try {
      const r = await api.saveWorkingDays(workingDays);
      setCalendar(r.data);
      setWorkingDays(r.data.workingDays);
      loadMonth(view.year, view.month);
      toast.success('Working days saved — absences now follow this calendar');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingDays(false);
    }
  };

  const toggleWeekday = (day) => {
    setWorkingDays((current) => current.includes(day)
      ? current.filter((value) => value !== day)
      : [...current, day].sort((a, b) => a - b));
  };

  /* ── day selection (click + drag) ─────────────────────────────────────── */
  const openChooser = useCallback((dates, dragged = false) => {
    if (!dates.length) return;
    const first = dayStatus[dates[0]];
    const allWorking = dates.every((date) => dayStatus[date]?.isWorkingDay);
    const mode = allWorking ? 'holiday' : 'workday';
    setChooser({
      dates,
      mode,
      dragged,
      name: first?.holidayNames?.[0] || '',
      repeat: false,
      note: first?.override?.note || '',
    });
  }, [dayStatus]);

  const beginSelection = (event, date) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    finishedRef.current = false;
    setDrag({ anchor: date, focus: date });
  };

  const extendSelection = (event) => {
    if (!drag) return;
    // Works for mouse and touch alike: touch pointers stay captured by the cell
    // they started on, so read the element actually under the finger.
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const cell = element?.closest?.('[data-date]');
    const date = cell?.getAttribute('data-date');
    if (!date || !cellByDate.has(date) || date === drag.focus) return;
    setDrag((current) => (current ? { ...current, focus: date } : current));
  };

  useEffect(() => {
    if (!drag) return undefined;
    const finish = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const dates = dateRangeSelection(cells, drag.anchor, drag.focus);
      setDrag(null);
      openChooser(dates, dates.length > 1 || drag.focus !== drag.anchor);
    };
    const cancel = (event) => { if (event.key === 'Escape') setDrag(null); };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', cancel);
    };
  }, [drag, cells, openChooser]);

  /* ── applying a day decision ──────────────────────────────────────────── */
  const applyChoice = async (event) => {
    event.preventDefault();
    if (!chooser) return;
    const { dates, mode, name, repeat, note } = chooser;
    setApplying(true);
    try {
      const r = await api.setCalendarDays({
        dates,
        mode,
        ...(mode === 'holiday' ? { name: name.trim() || undefined, repeat } : {}),
        ...(mode === 'workday' ? { note: note.trim() || undefined } : {}),
      });
      setCalendar({ workingDays: r.data.workingDays, holidays: r.data.holidays, overrides: r.data.overrides });
      setWorkingDays(r.data.workingDays);
      setDayStatus((current) => {
        const next = { ...current };
        for (const day of r.data.days) next[day.date] = day;
        return next;
      });
      const many = dates.length > 1 ? `${dates.length} days` : formatAdDate(dates[0], { weekday: true });
      toast.success(mode === 'workday'
        ? `${many} marked as working`
        : mode === 'holiday'
          ? `${many} marked as holiday`
          : `${many} back on the school default`);
      setChooser(null);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setApplying(false);
    }
  };

  /* ── named holiday list (one-off & annual) ────────────────────────────── */
  const openCreate = () => setHolidayModal({ open: true, editing: null, form: blankHoliday() });
  const openEdit = (holiday) => setHolidayModal({
    open: true,
    editing: holiday,
    form: {
      name: holiday.name,
      kind: holiday.kind,
      date: holiday.date || todayISO(),
      bsMonth: holiday.bsMonth || currentBs().month,
      bsDay: holiday.bsDay || currentBs().day,
    },
  });
  const closeHolidayModal = () => setHolidayModal({ open: false, editing: null, form: blankHoliday() });
  const setForm = (patch) => setHolidayModal((current) => ({ ...current, form: { ...current.form, ...patch } }));

  const saveHoliday = async (event) => {
    event.preventDefault();
    setSavingHoliday(true);
    const { form, editing } = holidayModal;
    const payload = form.kind === 'once'
      ? { name: form.name, kind: form.kind, date: form.date }
      : { name: form.name, kind: form.kind, bsMonth: Number(form.bsMonth), bsDay: Number(form.bsDay) };
    try {
      const r = editing
        ? await api.updateHoliday(editing.id, payload)
        : await api.createHoliday(payload);
      setCalendar(r.data);
      setWorkingDays(r.data.workingDays || workingDays);
      loadMonth(view.year, view.month);
      toast.success(editing ? 'Holiday updated' : 'Holiday added');
      closeHolidayModal();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingHoliday(false);
    }
  };

  const deleteHoliday = async (holiday) => {
    if (!window.confirm(`Remove ${holiday.name} from the school calendar?`)) return;
    try {
      await api.deleteHoliday(holiday.id);
      toast.success('Holiday removed');
      loadCalendar();
      loadMonth(view.year, view.month);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const holidayRows = useMemo(() => calendar?.holidays || [], [calendar]);
  const bsYearForDays = currentBs().year;
  const annualDayLimit = daysInBsMonth(bsYearForDays, Number(holidayModal.form.bsMonth)) || 32;

  const monthSummary = useMemo(() => {
    const statuses = cells.map((cell) => dayStatus[cell.date]).filter(Boolean);
    return {
      working: statuses.filter((day) => day.isWorkingDay).length,
      holidays: statuses.filter((day) => day.isHoliday).length,
      custom: statuses.filter((day) => day.override).length,
    };
  }, [cells, dayStatus]);

  const selectionSummary = useMemo(() => {
    if (!chooser) return { holidayNames: [] };
    return {
      holidayNames: [...new Set(chooser.dates.flatMap((date) => dayStatus[date]?.holidayNames || []))],
    };
  }, [chooser, dayStatus]);

  const chooserLabel = useMemo(() => {
    if (!chooser) return '';
    const [first] = chooser.dates;
    const last = chooser.dates[chooser.dates.length - 1];
    if (chooser.dates.length === 1) {
      return `${formatBsDate(first, { weekday: true })} · ${formatAdDate(first, { weekday: true })}`;
    }
    return `${chooser.dates.length} days · ${formatBsDate(first, { short: true })} → ${formatBsDate(last, { short: true })}`;
  }, [chooser]);

  const goToToday = () => {
    const bs = currentBs();
    setView({ year: bs.year, month: bs.month });
  };

  return (
    <div className="anim-in space-y-5">
      {/* ── Month calendar ─────────────────────────────────────────────── */}
      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-50 text-indigo-600"><CalendarDays size={18} /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-bold text-slate-800">School calendar</h2>
            <p className="text-[12px] text-slate-500">
              Click a day — or drag across several days — to set it as a working day or a holiday.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              className="btn-ghost !px-2.5"
              title="Previous month"
              disabled={!canShiftBsMonth(view.year, view.month, -1)}
              onClick={() => setView(shiftBsMonth(view.year, view.month, -1))}
            >
              <ChevronLeft size={16} />
            </button>
            <div className="min-w-[152px] text-center">
              <div className="text-[13.5px] font-bold text-slate-800">{bsMonthTitle(view.year, view.month)}</div>
              <div className="text-[10.5px] text-slate-400">
                {cells.length ? `${formatAdDate(cells[0].date)} – ${formatAdDate(cells[cells.length - 1].date)}` : '—'}
              </div>
            </div>
            <button
              className="btn-ghost !px-2.5"
              title="Next month"
              disabled={!canShiftBsMonth(view.year, view.month, 1)}
              onClick={() => setView(shiftBsMonth(view.year, view.month, 1))}
            >
              <ChevronRight size={16} />
            </button>
            <button className="btn-ghost" onClick={goToToday}>Today</button>
          </div>
        </header>

        <div className="p-4 sm:p-5">
          <div className="grid grid-cols-7 gap-1.5 pb-1.5">
            {WEEKDAY_NAMES.map((name) => (
              <div key={name} className="text-center text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
                {name.slice(0, 3)}
              </div>
            ))}
          </div>

          <div
            className="grid grid-cols-7 gap-1.5"
            style={{ touchAction: 'pan-y' }}
            onPointerMove={extendSelection}
          >
            {weeks.flatMap((week, weekIndex) => week.map((cell, dayIndex) => (
              cell ? (
                <DayCell
                  key={cell.date}
                  cell={cell}
                  status={dayStatus[cell.date]}
                  isToday={cell.date === today}
                  selected={dragSet.has(cell.date)}
                  onPointerDown={beginSelection}
                  onKeySelect={(date) => openChooser([date])}
                />
              ) : (
                <div key={`empty-${weekIndex}-${dayIndex}`} className="h-[82px] rounded-xl bg-slate-50/60" />
              )
            )))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-indigo-200 bg-indigo-50/70" /> Working day</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-amber-300 bg-amber-50" /> Holiday</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-slate-200 bg-slate-50" /> Weekly off</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-emerald-300 bg-emerald-50" /> Marked working by you</span>
            <span className="ml-auto flex items-center gap-2">
              {monthLoading && <span className="text-slate-400">loading…</span>}
              <span className="badge bg-indigo-100 text-indigo-700">{monthSummary.working} working</span>
              <span className="badge bg-amber-100 text-amber-700">{monthSummary.holidays} holidays</span>
              <span className="badge bg-emerald-100 text-emerald-700">{monthSummary.custom} custom</span>
            </span>
          </div>
        </div>
      </section>

      {/* ── Regular working week ───────────────────────────────────────── */}
      <section className="card overflow-hidden">
        <header className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-50 text-indigo-600"><Clock3 size={18} /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-bold text-slate-800">Regular working week</h2>
            <p className="text-[12px] text-slate-500">Only working days without punches count as absent. Single days can still be changed on the calendar above, and staff with their own days (part-time) are set under Part-time Staff.</p>
          </div>
          <button className="btn-primary" onClick={saveWorkweek} disabled={loading || savingDays || workingDays.length === 0}>
            <Save size={15} /> {savingDays ? 'Saving…' : 'Save workweek'}
          </button>
        </header>
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {WEEKDAYS.map((day) => (
            <label key={day.value} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${
              workingDays.includes(day.value) ? 'border-indigo-200 bg-indigo-50/70' : 'border-slate-200 bg-white'
            }`}>
              <input
                type="checkbox"
                checked={workingDays.includes(day.value)}
                disabled={loading}
                onChange={() => toggleWeekday(day.value)}
                className="h-4 w-4 accent-indigo-600"
              />
              <span className="flex-1 text-sm font-semibold text-slate-700">{day.label}</span>
              {workingDays.includes(day.value)
                ? <span className="badge bg-indigo-100 text-indigo-700">Workday</span>
                : <span className="badge bg-slate-100 text-slate-500">Off</span>}
            </label>
          ))}
        </div>
        <p className="px-5 pb-5 text-[11.5px] text-slate-400">
          Default is Monday–Friday. Saturdays and Sundays are non-working unless you select them above. A holiday that falls on a
          working day is skipped for absences — and a single day can be changed back to a working day from the calendar.
          People on a personal pattern (Part-time Staff) are only expected on their own weekdays, and this week decides
          which dates the school is open for them at all.
        </p>
      </section>

      {/* ── Named holidays ────────────────────────────────────────────── */}
      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-amber-50 text-amber-600"><CalendarOff size={18} /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-bold text-slate-800">School holidays</h2>
            <p className="text-[12px] text-slate-500">One-off and annual BS holidays are excluded from absence totals.</p>
          </div>
          <button className="btn-primary" onClick={openCreate}><Plus size={15} /> Add holiday</button>
        </header>

        {loading ? (
          <div className="space-y-3 p-5">
            {[1, 2, 3].map((n) => <div key={n} className="h-12 animate-pulse rounded-xl bg-slate-100" />)}
          </div>
        ) : holidayRows.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-amber-50 text-amber-600"><CalendarDays size={20} /></div>
            <h3 className="font-semibold text-slate-800">No holidays added yet</h3>
            <p className="mt-1 text-sm text-slate-500">Click a date on the calendar above, or add a holiday here.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {holidayRows.map((holiday) => {
              const workedHere = holiday.date && overridesByDate.get(holiday.date)?.isWorking;
              return (
                <article key={holiday.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-600"><CalendarDays size={16} /></div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-slate-800">{holiday.name}</h3>
                    <p className="text-[12px] text-slate-500">
                      {holiday.kind === 'annual'
                        ? `Every year: ${holiday.bsDay} ${holiday.bsMonthName} (BS)`
                        : <>{holiday.bsLabel || 'BS date unavailable'} <span className="text-slate-400">· {holiday.adLabel} AD</span></>}
                    </p>
                  </div>
                  {workedHere && <span className="badge bg-emerald-100 text-emerald-700">worked this day</span>}
                  <div className="flex gap-1.5">
                    <button className="btn-ghost !px-2.5 !py-2" title="Edit holiday" onClick={() => openEdit(holiday)}><Pencil size={14} /></button>
                    <button className="btn-ghost !px-2.5 !py-2 !text-rose-600 hover:!border-rose-200 hover:!bg-rose-50" title="Remove holiday" onClick={() => deleteHoliday(holiday)}><Trash2 size={14} /></button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <div className="border-t border-slate-100 px-5 py-3 text-[11.5px] text-slate-400">
          Holiday dates and report periods are managed in Bikram Sambat (BS); Gregorian dates are retained for device records.
        </div>
      </section>

      {/* ── Day chooser ────────────────────────────────────────────────── */}
      <Modal
        open={Boolean(chooser)}
        onClose={() => setChooser(null)}
        title={chooser && chooser.dates.length > 1 ? `Set ${chooser.dates.length} days` : 'Set this day'}
        subtitle={chooserLabel}
      >
        {chooser && (
          <form onSubmit={applyChoice} className="space-y-4">
            {chooser.dates.length > 1 && (
              <div className="flex flex-wrap gap-1.5 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                {chooser.dates.slice(0, 12).map((date) => (
                  <span key={date} className="badge bg-white text-slate-600 shadow-sm">
                    {formatBsDate(date, { short: true })}
                  </span>
                ))}
                {chooser.dates.length > 12 && (
                  <span className="badge bg-white text-slate-500 shadow-sm">+{chooser.dates.length - 12} more</span>
                )}
              </div>
            )}

            <div className="space-y-2">
              {DAY_MODES.map((option) => {
                const Icon = option.icon;
                const active = chooser.mode === option.value;
                return (
                  <button
                    type="button"
                    key={option.value}
                    onClick={() => setChooser((current) => ({ ...current, mode: option.value }))}
                    className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                      active ? `ring-1 ${TONE_CLASSES[option.tone]}` : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${TONE_ICON[option.tone]}`}><Icon size={16} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-800">{option.label}</span>
                      <span className="mt-0.5 block text-[11.5px] leading-relaxed text-slate-500">{option.hint}</span>
                    </span>
                    {active && <Check size={16} className="mt-1 shrink-0 text-indigo-600" />}
                  </button>
                );
              })}
            </div>

            {chooser.mode === 'holiday' && (
              <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                <label className="block">
                  <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-amber-700">Holiday name</span>
                  <input
                    className="input"
                    maxLength={100}
                    value={chooser.name}
                    onChange={(event) => setChooser((current) => ({ ...current, name: event.target.value }))}
                    placeholder="e.g. Dashain, Sports Day"
                  />
                </label>
                {chooser.dates.length === 1 && (
                  <label className="flex items-center gap-2.5 text-[12.5px] font-medium text-amber-900">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-amber-600"
                      checked={chooser.repeat}
                      onChange={(event) => setChooser((current) => ({ ...current, repeat: event.target.checked }))}
                    />
                    Repeat every year on this BS date
                  </label>
                )}
                {selectionSummary.holidayNames.length > 0 && (
                  <p className="flex items-start gap-1.5 text-[11.5px] text-amber-800">
                    <Info size={13} className="mt-0.5 shrink-0" />
                    Already a holiday here: {selectionSummary.holidayNames.join(', ')}.
                  </p>
                )}
              </div>
            )}

            {chooser.mode === 'workday' && (
              <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                <label className="block">
                  <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-emerald-700">Note (optional)</span>
                  <input
                    className="input"
                    maxLength={200}
                    value={chooser.note}
                    onChange={(event) => setChooser((current) => ({ ...current, note: event.target.value }))}
                    placeholder="e.g. exam day · make-up class"
                  />
                </label>
                {selectionSummary.holidayNames.length > 0 && (
                  <p className="flex items-start gap-1.5 text-[11.5px] text-emerald-900">
                    <Info size={13} className="mt-0.5 shrink-0" />
                    {selectionSummary.holidayNames.join(', ')} is on the holiday list — this day-level change overrides it for
                    {chooser.dates.length > 1 ? ' these dates' : ' this date'} only.
                  </p>
                )}
              </div>
            )}

            {chooser.mode === 'default' && (
              <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11.5px] text-slate-600">
                Removes your manual change — the regular working week and the holiday list decide
                {chooser.dates.length > 1 ? ' these days' : ' this day'} again.
              </p>
            )}

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button type="button" className="btn-ghost" onClick={() => setChooser(null)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={applying}>
                {applying ? 'Saving…' : <><Check size={15} /> Apply</>}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ── Add / edit named holiday ───────────────────────────────────── */}
      <Modal
        open={holidayModal.open}
        onClose={closeHolidayModal}
        title={holidayModal.editing ? 'Edit holiday' : 'Add a school holiday'}
        subtitle="Holidays do not count as absence days in attendance reports."
      >
        <form onSubmit={saveHoliday} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Holiday name *</span>
            <input className="input" required maxLength={100} value={holidayModal.form.name}
              onChange={(event) => setForm({ name: event.target.value })} placeholder="Holiday name" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Repeat</span>
            <select className="input" value={holidayModal.form.kind} onChange={(event) => setForm({ kind: event.target.value })}>
              <option value="once">One date only</option>
              <option value="annual">Every year on this BS date</option>
            </select>
          </label>

          {holidayModal.form.kind === 'once' ? (
            <label className="block">
              <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Holiday date (BS)</span>
              <BsDateFields value={holidayModal.form.date} onChange={(date) => setForm({ date })} />
            </label>
          ) : (
            <div>
              <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Annual BS date</span>
              <div className="grid grid-cols-2 gap-2">
                <select className="input" value={holidayModal.form.bsMonth}
                  onChange={(event) => {
                    const bsMonth = Number(event.target.value);
                    const maxDay = daysInBsMonth(bsYearForDays, bsMonth) || 32;
                    setForm({ bsMonth, bsDay: Math.min(Number(holidayModal.form.bsDay), maxDay) });
                  }}>
                  {BS_MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
                </select>
                <select className="input" value={holidayModal.form.bsDay}
                  onChange={(event) => setForm({ bsDay: Number(event.target.value) })}>
                  {Array.from({ length: annualDayLimit }, (_, index) => index + 1)
                    .map((day) => <option key={day} value={day}>{day}</option>)}
                </select>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">The holiday recurs on the same Nepali month and day. If that date is not present in a BS year, that year has no occurrence.</p>
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button type="button" className="btn-ghost" onClick={closeHolidayModal}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={savingHoliday}>
              {savingHoliday ? 'Saving…' : <><Check size={15} /> {holidayModal.editing ? 'Save changes' : 'Add holiday'}</>}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
