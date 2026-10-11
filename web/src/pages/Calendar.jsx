import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, Clock3, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { api, todayISO } from '../api/client';
import { BsDateFields } from '../components/BsDateFields';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';
import { BS_MONTHS, adToBsParts, daysInBsMonth } from '../lib/nepaliDate';

const WEEKDAYS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];
const currentBs = () => adToBsParts(todayISO()) || { year: 2083, month: 1, day: 1 };
const blankHoliday = () => {
  const bs = currentBs();
  return { name: '', kind: 'once', date: todayISO(), bsMonth: bs.month, bsDay: bs.day };
};

export default function Calendar() {
  const toast = useToast();
  const [calendar, setCalendar] = useState(null);
  const [workingDays, setWorkingDays] = useState([1, 2, 3, 4, 5]);
  const [loading, setLoading] = useState(true);
  const [savingDays, setSavingDays] = useState(false);
  const [savingHoliday, setSavingHoliday] = useState(false);
  const [modal, setModal] = useState({ open: false, editing: null, form: blankHoliday() });

  const load = useCallback(() => {
    setLoading(true);
    api.calendar()
      .then((r) => {
        setCalendar(r.data);
        setWorkingDays(r.data.workingDays || []);
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(load, [load]);

  const saveWorkweek = async () => {
    setSavingDays(true);
    try {
      const r = await api.saveWorkingDays(workingDays);
      setCalendar(r.data);
      setWorkingDays(r.data.workingDays);
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

  const openCreate = () => setModal({ open: true, editing: null, form: blankHoliday() });
  const openEdit = (holiday) => setModal({
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
  const closeModal = () => setModal({ open: false, editing: null, form: blankHoliday() });
  const setForm = (patch) => setModal((current) => ({ ...current, form: { ...current.form, ...patch } }));

  const saveHoliday = async (event) => {
    event.preventDefault();
    setSavingHoliday(true);
    const { form, editing } = modal;
    const payload = form.kind === 'once'
      ? { name: form.name, kind: form.kind, date: form.date }
      : { name: form.name, kind: form.kind, bsMonth: Number(form.bsMonth), bsDay: Number(form.bsDay) };
    try {
      const r = editing
        ? await api.updateHoliday(editing.id, payload)
        : await api.createHoliday(payload);
      setCalendar(r.data);
      setWorkingDays(r.data.workingDays || workingDays);
      toast.success(editing ? 'Holiday updated' : 'Holiday added');
      closeModal();
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
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const holidayRows = useMemo(() => calendar?.holidays || [], [calendar]);
  const bsYearForDays = currentBs().year;
  const annualDayLimit = daysInBsMonth(bsYearForDays, Number(modal.form.bsMonth)) || 32;

  return (
    <div className="anim-in space-y-5">
      <section className="card overflow-hidden">
        <header className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-50 text-indigo-600"><Clock3 size={18} /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-bold text-slate-800">Regular working week</h2>
            <p className="text-[12px] text-slate-500">Only working days without punches count as absent.</p>
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
          Default is Monday–Friday. Saturdays and Sundays are non-working unless you select them above.
        </p>
      </section>

      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-amber-50 text-amber-600"><CalendarDays size={18} /></div>
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
            <p className="mt-1 text-sm text-slate-500">Add school holidays so those dates won’t count as absences.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {holidayRows.map((holiday) => (
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
                <div className="flex gap-1.5">
                  <button className="btn-ghost !px-2.5 !py-2" title="Edit holiday" onClick={() => openEdit(holiday)}><Pencil size={14} /></button>
                  <button className="btn-ghost !px-2.5 !py-2 !text-rose-600 hover:!border-rose-200 hover:!bg-rose-50" title="Remove holiday" onClick={() => deleteHoliday(holiday)}><Trash2 size={14} /></button>
                </div>
              </article>
            ))}
          </div>
        )}
        <div className="border-t border-slate-100 px-5 py-3 text-[11.5px] text-slate-400">
          Holiday dates and report periods are managed in Bikram Sambat (BS); Gregorian dates are retained for device records.
        </div>
      </section>

      <Modal
        open={modal.open}
        onClose={closeModal}
        title={modal.editing ? 'Edit holiday' : 'Add a school holiday'}
        subtitle="Holidays do not count as absence days in attendance reports."
      >
        <form onSubmit={saveHoliday} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Holiday name *</span>
            <input className="input" required maxLength={100} value={modal.form.name}
              onChange={(event) => setForm({ name: event.target.value })} placeholder="Holiday name" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Repeat</span>
            <select className="input" value={modal.form.kind} onChange={(event) => setForm({ kind: event.target.value })}>
              <option value="once">One date only</option>
              <option value="annual">Every year on this BS date</option>
            </select>
          </label>

          {modal.form.kind === 'once' ? (
            <label className="block">
              <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Holiday date (BS)</span>
              <BsDateFields value={modal.form.date} onChange={(date) => setForm({ date })} />
            </label>
          ) : (
            <div>
              <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Annual BS date</span>
              <div className="grid grid-cols-2 gap-2">
                <select className="input" value={modal.form.bsMonth}
                  onChange={(event) => {
                    const bsMonth = Number(event.target.value);
                    const maxDay = daysInBsMonth(bsYearForDays, bsMonth) || 32;
                    setForm({ bsMonth, bsDay: Math.min(Number(modal.form.bsDay), maxDay) });
                  }}>
                  {BS_MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
                </select>
                <select className="input" value={modal.form.bsDay}
                  onChange={(event) => setForm({ bsDay: Number(event.target.value) })}>
                  {Array.from({ length: annualDayLimit }, (_, index) => index + 1)
                    .map((day) => <option key={day} value={day}>{day}</option>)}
                </select>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">The holiday recurs on the same Nepali month and day. If that date is not present in a BS year, that year has no occurrence.</p>
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button type="button" className="btn-ghost" onClick={closeModal}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={savingHoliday}>
              {savingHoliday ? 'Saving…' : <><Check size={15} /> {modal.editing ? 'Save changes' : 'Add holiday'}</>}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
