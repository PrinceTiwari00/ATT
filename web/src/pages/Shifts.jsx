import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Clock3,
  Plus,
  Pencil,
  RefreshCw,
  Star,
  Timer,
  Trash2,
} from 'lucide-react';
import { api } from '../api/client';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

const EMPTY = {
  name: '',
  start_time: '08:00',
  end_time: '15:30',
  grace_period_minutes: 10,
  description: '',
  is_default: false,
};

const blankForm = () => ({ ...EMPTY });

export default function Shifts() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [modal, setModal] = useState({ open: false, form: blankForm(), editing: null });
  const [confirmDel, setConfirmDel] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError('');
    api.shifts()
      .then((r) => setRows(Array.isArray(r?.data) ? r.data : []))
      .catch((e) => {
        const message = e.message || 'Unable to load shifts.';
        setLoadError(message);
        toast.error(message);
      })
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(load, [load]);

  const closeForm = () => setModal({ open: false, form: blankForm(), editing: null });
  const openCreate = () => setModal({ open: true, form: blankForm(), editing: null });
  const openEdit = (shift) =>
    setModal({
      open: true,
      editing: shift,
      form: {
        name: shift.name,
        start_time: shift.start_time,
        end_time: shift.end_time,
        grace_period_minutes: shift.grace_period_minutes,
        description: shift.description || '',
        is_default: !!shift.is_default,
      },
    });

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...modal.form,
        grace_period_minutes: Number(modal.form.grace_period_minutes),
      };
      if (modal.editing) {
        await api.updateShift(modal.editing.id, payload);
        toast.success('Shift updated — attendance recalculated for recent days');
      } else {
        await api.createShift(payload);
        toast.success('Shift created');
      }
      closeForm();
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteShift = async () => {
    if (!confirmDel || Number(confirmDel.teacher_count) > 0) return;
    setDeleting(true);
    try {
      await api.deleteShift(confirmDel.id);
      toast.success('Shift deleted');
      setConfirmDel(null);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="anim-in space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-[13px] leading-relaxed text-slate-500">
          Late and <span className="font-medium text-purple-600">“fast going”</span> verdicts are computed against these windows.
        </p>
        <button className="btn-primary w-full shrink-0 sm:w-auto" onClick={openCreate}>
          <Plus size={15} /> New Shift
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-2xl bg-slate-200/70" />
          ))
        ) : loadError ? (
          <div className="card col-span-full flex flex-col items-center px-5 py-12 text-center">
            <div className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-rose-50 text-rose-500">
              <AlertCircle size={20} />
            </div>
            <h2 className="font-semibold text-slate-900">Shifts could not be loaded</h2>
            <p className="mt-1 max-w-md text-sm text-slate-500">{loadError}</p>
            <button className="btn-ghost mt-4" onClick={load}>
              <RefreshCw size={14} /> Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="card col-span-full flex flex-col items-center px-5 py-12 text-center">
            <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-indigo-50 text-indigo-600">
              <Clock3 size={22} />
            </div>
            <h2 className="font-semibold text-slate-900">No shifts yet</h2>
            <p className="mt-1 max-w-md text-sm text-slate-500">
              Create a shift to define scheduled hours and grace periods for attendance tracking.
            </p>
            <button className="btn-primary mt-4" onClick={openCreate}>
              <Plus size={15} /> Create your first shift
            </button>
          </div>
        ) : (
          rows.map((shift) => {
            const assigned = Number(shift.teacher_count) || 0;
            const overnight = isOvernight(shift.start_time, shift.end_time);

            return (
              <article
                key={shift.id}
                className={`card flex h-full flex-col p-5 transition hover:shadow-md ${
                  shift.is_default ? 'border-amber-200/80' : ''
                }`}
              >
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-600">
                      <Clock3 size={20} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="break-words text-[15px] font-bold text-slate-900">{shift.name}</h2>
                      <p className="truncate text-[12px] text-slate-400" title={shift.description || 'Working schedule'}>
                        {shift.description || 'Working schedule'}
                      </p>
                    </div>
                  </div>
                  {!!shift.is_default && (
                    <span className="badge shrink-0 bg-amber-100 text-amber-700">
                      <Star size={11} /> Default
                    </span>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <Metric label="Start" value={to12(shift.start_time)} />
                  <Metric label="End" value={to12(shift.end_time)} />
                  <Metric label="Grace" value={`${shift.grace_period_minutes}m`} accent />
                </div>

                {overnight && (
                  <p className="mt-2 text-[11px] font-medium text-indigo-600">End time is on the following day</p>
                )}

                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                  <span className="text-[12px] font-medium text-slate-500">
                    <Timer size={13} className="-mt-0.5 mr-1 inline" />
                    {assigned} teacher{assigned === 1 ? '' : 's'} assigned
                  </span>
                  <div className="flex shrink-0 gap-1.5">
                    <button
                      type="button"
                      aria-label={`Edit ${shift.name}`}
                      title="Edit shift"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      onClick={() => openEdit(shift)}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${shift.name}`}
                      title={assigned > 0 ? 'Reassign teachers before deleting' : 'Delete shift'}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rose-200 text-rose-500 transition hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                      onClick={() => setConfirmDel(shift)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>

      <Modal
        open={modal.open}
        onClose={closeForm}
        title={modal.editing ? `Edit — ${modal.editing.name}` : 'New Shift'}
        subtitle="A check-in after Start + Grace = LATE; check-out before End = EARLY DEPARTURE"
      >
        <form onSubmit={save} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="col-span-full block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Shift name *</span>
            <input
              className="input"
              required
              maxLength={80}
              value={modal.form.name}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, name: e.target.value } }))}
              placeholder="Morning Shift"
            />
          </label>
          <label className="block min-w-0">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Start time *</span>
            <input
              type="time"
              className="input"
              required
              value={modal.form.start_time}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, start_time: e.target.value } }))}
            />
          </label>
          <label className="block min-w-0">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">End time *</span>
            <input
              type="time"
              className="input"
              required
              value={modal.form.end_time}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, end_time: e.target.value } }))}
            />
          </label>
          <label className="block min-w-0">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Grace period (minutes) *</span>
            <input
              type="number"
              min="0"
              max="240"
              step="1"
              inputMode="numeric"
              className="input"
              required
              value={modal.form.grace_period_minutes}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, grace_period_minutes: e.target.value } }))}
            />
          </label>
          <label className="block min-w-0">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Description</span>
            <input
              className="input"
              maxLength={240}
              value={modal.form.description}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, description: e.target.value } }))}
              placeholder="Optional"
            />
          </label>
          <label className="col-span-full flex cursor-pointer items-start gap-2.5 rounded-xl border border-dashed border-amber-300 bg-amber-50/60 px-3.5 py-2.5">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-amber-500"
              checked={modal.form.is_default}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, is_default: e.target.checked } }))}
            />
            <span className="text-[13px] leading-snug font-medium text-amber-900">
              Make this the default shift for teachers with no explicit assignment
            </span>
          </label>
          <div className="col-span-full mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn-ghost" onClick={closeForm}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? <RefreshCw size={15} className="animate-spin" /> : null}
              {modal.editing ? 'Save & recalculate' : 'Create shift'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        title="Delete shift"
        width="max-w-sm"
      >
        <p className="text-sm text-slate-600">
          Delete <b>{confirmDel?.name}</b>? This cannot be undone.
        </p>
        {Number(confirmDel?.teacher_count) > 0 && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Reassign {confirmDel.teacher_count} teacher{Number(confirmDel.teacher_count) === 1 ? '' : 's'} before deleting this shift.
          </p>
        )}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button className="btn-ghost" onClick={() => setConfirmDel(null)}>Cancel</button>
          <button
            className="btn-danger"
            disabled={deleting || Number(confirmDel?.teacher_count) > 0}
            onClick={deleteShift}
          >
            {deleting ? <RefreshCw size={15} className="animate-spin" /> : <Trash2 size={15} />}
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}

function Metric({ label, value, accent }) {
  return (
    <div className={`min-w-0 rounded-xl px-2 py-2 ${accent ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-700'}`}>
      <div className="truncate text-[13px] font-bold tabular-nums">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{label}</div>
    </div>
  );
}

function to12(hhmm) {
  if (typeof hhmm !== 'string' || !/^\d{1,2}:\d{2}$/.test(hhmm)) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return '—';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function isOvernight(start, end) {
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  return Number.isFinite(startMinutes) && Number.isFinite(endMinutes) && endMinutes <= startMinutes;
}

function toMinutes(value) {
  if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value)) return NaN;
  const [hours, minutes] = value.split(':').map(Number);
  if (hours > 23 || minutes > 59) return NaN;
  return hours * 60 + minutes;
}
