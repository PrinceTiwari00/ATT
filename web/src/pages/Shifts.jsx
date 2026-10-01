import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Clock3, Timer, RefreshCw, Star } from 'lucide-react';
import { api } from '../api/client';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

const EMPTY = { name: '', start_time: '08:00', end_time: '15:30', grace_period_minutes: 10, description: '', is_default: false };

export default function Shifts() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState({ open: false, form: EMPTY, editing: null });
  const [confirmDel, setConfirmDel] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.shifts()
      .then((r) => setRows(r.data))
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(load, [load]);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...modal.form, grace_period_minutes: Number(modal.form.grace_period_minutes) };
      if (modal.editing) {
        await api.updateShift(modal.editing.id, payload);
        toast.success('Shift updated — attendance recalculated for recent days');
      } else {
        await api.createShift(payload);
        toast.success('Shift created');
      }
      setModal({ open: false, form: EMPTY, editing: null });
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="anim-in space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-slate-500">
          Late and <span className="font-medium text-purple-600">“fast going”</span> verdicts are computed against these windows.
        </p>
        <button className="btn-primary" onClick={() => setModal({ open: true, form: EMPTY, editing: null })}>
          <Plus size={15} /> New Shift
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading
          ? Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-44 animate-pulse rounded-2xl bg-slate-200/70" />)
          : rows.map((s) => (
            <div key={s.id} className="card group relative overflow-hidden p-5 transition hover:shadow-md">
              {!!s.is_default && (
                <span className="absolute right-4 top-4 badge bg-amber-100 text-amber-700"><Star size={11} /> DEFAULT</span>
              )}
              <div className="flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-indigo-100 text-indigo-600"><Clock3 size={20} /></div>
                <div>
                  <h3 className="font-bold text-slate-900">{s.name}</h3>
                  <p className="text-[12px] text-slate-400">{s.description || 'Working schedule'}</p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <Metric label="Start" value={to12(s.start_time)} />
                <Metric label="End" value={to12(s.end_time)} />
                <Metric label="Grace" value={`${s.grace_period_minutes}m`} accent />
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                <span className="text-[12px] font-medium text-slate-500">
                  <Timer size={13} className="mr-1 inline -mt-0.5" />
                  {s.teacher_count} teacher{s.teacher_count === 1 ? '' : 's'} assigned
                </span>
                <div className="flex gap-1.5 opacity-0 transition group-hover:opacity-100">
                  <button className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-100 cursor-pointer"
                    onClick={() => setModal({
                      open: true, editing: s,
                      form: { name: s.name, start_time: s.start_time, end_time: s.end_time, grace_period_minutes: s.grace_period_minutes, description: s.description || '', is_default: !!s.is_default },
                    })}>
                    <Pencil size={14} />
                  </button>
                  <button className="rounded-lg border border-rose-200 p-2 text-rose-500 hover:bg-rose-50 cursor-pointer" onClick={() => setConfirmDel(s)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
      </div>

      <Modal
        open={modal.open}
        onClose={() => setModal({ open: false, form: EMPTY, editing: null })}
        title={modal.editing ? `Edit — ${modal.editing.name}` : 'New Shift'}
        subtitle="A check-in after Start + Grace = LATE; check-out before End = EARLY DEPARTURE"
      >
        <form onSubmit={save} className="grid grid-cols-2 gap-3">
          <label className="col-span-2 block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Shift name *</span>
            <input className="input" required value={modal.form.name}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, name: e.target.value } }))} placeholder="Morning Shift" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Start time *</span>
            <input type="time" className="input" required value={modal.form.start_time}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, start_time: e.target.value } }))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">End time *</span>
            <input type="time" className="input" required value={modal.form.end_time}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, end_time: e.target.value } }))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Grace period (minutes) *</span>
            <input type="number" min="0" max="240" className="input" required value={modal.form.grace_period_minutes}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, grace_period_minutes: e.target.value } }))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Description</span>
            <input className="input" value={modal.form.description}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, description: e.target.value } }))} placeholder="Optional" />
          </label>
          <label className="col-span-2 flex cursor-pointer items-center gap-2.5 rounded-xl border border-dashed border-amber-300 bg-amber-50/60 px-3.5 py-2.5">
            <input type="checkbox" className="h-4 w-4 accent-amber-500" checked={modal.form.is_default}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, is_default: e.target.checked } }))} />
            <span className="text-[13px] font-medium text-amber-900">
              Make this the default shift for teachers with no explicit assignment
            </span>
          </label>
          <div className="col-span-2 mt-1 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setModal({ open: false, form: EMPTY, editing: null })}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? <RefreshCw size={15} className="animate-spin" /> : null}
              {modal.editing ? 'Save & recalculate' : 'Create shift'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={!!confirmDel} onClose={() => setConfirmDel(null)} title="Delete shift" width="max-w-sm">
        <p className="text-sm text-slate-600">Delete <b>{confirmDel?.name}</b>? Teachers must be reassigned first.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirmDel(null)}>Cancel</button>
          <button className="btn-danger" onClick={async () => {
            try {
              await api.deleteShift(confirmDel.id);
              toast.success('Shift deleted');
              setConfirmDel(null); load();
            } catch (e) { toast.error(e.message); }
          }}><Trash2 size={15} /> Delete</button>
        </div>
      </Modal>
    </div>
  );
}

function Metric({ label, value, accent }) {
  return (
    <div className={`rounded-xl py-2 ${accent ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-700'}`}>
      <div className="text-[13px] font-bold tabular-nums">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{label}</div>
    </div>
  );
}

function to12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
