import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Search, Pencil, Trash2, Fingerprint, RefreshCw, UserPlus } from 'lucide-react';
import { api } from '../api/client';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

const EMPTY_FORM = {
  zk_user_id: '', full_name: '', department: '', designation: 'Teacher',
  shift_id: '', email: '', phone: '', status: 'active', pushToDevice: false,
};

export default function Teachers() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [filters, setFilters] = useState({ q: '', department: '', status: '' });
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState({ open: false, form: EMPTY_FORM, editing: null });
  const [confirmDel, setConfirmDel] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    Promise.all([api.teachers(params), api.shifts(), api.departments()])
      .then(([t, s, d]) => { setRows(t.data); setShifts(s.data); setDepartments(d.data); })
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const openCreate = () => setModal({ open: true, form: EMPTY_FORM, editing: null });
  const openEdit = (t) =>
    setModal({
      open: true, editing: t,
      form: {
        zk_user_id: t.zk_user_id, full_name: t.full_name, department: t.department,
        designation: t.designation, shift_id: t.shift_id ?? '', email: t.email || '',
        phone: t.phone || '', status: t.status, pushToDevice: false,
      },
    });

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    const f = modal.form;
    const payload = {
      ...f, shift_id: f.shift_id === '' ? null : Number(f.shift_id),
    };
    try {
      if (modal.editing) {
        await api.updateTeacher(modal.editing.id, payload);
        toast.success(`Updated ${f.full_name}`);
      } else {
        const r = await api.createTeacher(payload);
        if (f.pushToDevice) {
          r.devicePush?.ok
            ? toast.success(`Created ${f.full_name} & enrolled on device`)
            : toast.warning(`Created ${f.full_name}, but device enrollment failed: ${r.devicePush?.error}`);
        } else toast.success(`Created ${f.full_name}`);
      }
      setModal({ open: false, form: EMPTY_FORM, editing: null });
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    try {
      await api.deleteTeacher(confirmDel.id);
      toast.success(`Deleted ${confirmDel.full_name}`);
      setConfirmDel(null);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const pushOne = async (t) => {
    setBusyId(t.id);
    try {
      await api.pushTeacher(t.id);
      toast.success(`Enrolled ${t.full_name} (ZK #${t.zk_user_id}) on the device`);
    } catch (e) {
      toast.error(`Push failed: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const deptList = useMemo(() => departments, [departments]);

  return (
    <div className="anim-in space-y-4">
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="input w-60 pl-9" placeholder="Search name, ZK ID, email…" value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
        </div>
        <select className="input w-44" value={filters.department}
          onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))}>
          <option value="">All departments</option>
          {deptList.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className="input w-36" value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost" onClick={load}><RefreshCw size={15} /></button>
          <button className="btn-primary" onClick={openCreate}><Plus size={15} /> Add Teacher / Staff</button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="th-table">Name</th>
                <th className="th-table">ZKTeco ID</th>
                <th className="th-table">Department</th>
                <th className="th-table">Designation</th>
                <th className="th-table">Shift</th>
                <th className="th-table">Contact</th>
                <th className="th-table">Status</th>
                <th className="th-table text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {Array.from({ length: 8 }).map((__, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 w-3/4 animate-pulse rounded bg-slate-100" /></td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-14 text-center text-sm text-slate-400">No teachers found.</td></tr>
              ) : rows.map((t) => (
                <tr key={t.id} className="border-b border-slate-100 transition hover:bg-slate-50">
                  <td className="td-table">
                    <div className="flex items-center gap-3">
                      <div className="grid h-9 w-9 place-items-center rounded-full bg-indigo-100 text-[12px] font-bold text-indigo-700">
                        {t.full_name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                      </div>
                      <span className="font-semibold text-slate-900">{t.full_name}</span>
                    </div>
                  </td>
                  <td className="td-table">
                    <span className="rounded-md bg-slate-900 px-2 py-1 font-mono text-[12px] font-semibold text-emerald-300">#{t.zk_user_id}</span>
                  </td>
                  <td className="td-table">{t.department}</td>
                  <td className="td-table">
                    <span className={`badge ${t.designation === 'Teacher' ? 'bg-sky-100 text-sky-700' : 'bg-violet-100 text-violet-700'}`}>{t.designation}</span>
                  </td>
                  <td className="td-table">
                    {t.shift_name ? (
                      <>
                        <div className="font-medium">{t.shift_name}</div>
                        <div className="text-[11.5px] text-slate-400">{t.shift_start}–{t.shift_end}</div>
                      </>
                    ) : <span className="text-slate-400">Default</span>}
                  </td>
                  <td className="td-table">
                    <div className="text-[12.5px] text-slate-600">{t.email || '—'}</div>
                    <div className="text-[11.5px] text-slate-400">{t.phone || ''}</div>
                  </td>
                  <td className="td-table">
                    <span className={`badge ${t.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>
                      {t.status === 'active' ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </td>
                  <td className="td-table">
                    <div className="flex items-center justify-end gap-1.5">
                      <IconBtn title="Enroll on device" onClick={() => pushOne(t)} disabled={busyId === t.id}>
                        {busyId === t.id ? <RefreshCw size={15} className="animate-spin" /> : <Fingerprint size={15} />}
                      </IconBtn>
                      <IconBtn title="Edit" onClick={() => openEdit(t)}><Pencil size={15} /></IconBtn>
                      <IconBtn title="Delete" danger onClick={() => setConfirmDel(t)}><Trash2 size={15} /></IconBtn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit modal */}
      <Modal
        open={modal.open}
        onClose={() => setModal({ open: false, form: EMPTY_FORM, editing: null })}
        title={modal.editing ? `Edit — ${modal.editing.full_name}` : 'New Teacher / Staff'}
        subtitle={modal.editing ? 'Changes sync to attendance immediately' : 'ZK User ID must equal the fingerprint enrollment ID on the device'}
      >
        <form onSubmit={save} className="grid grid-cols-2 gap-3">
          <FormField label="ZKTeco User ID *" className="col-span-1">
            <input className="input font-mono" required value={modal.form.zk_user_id}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, zk_user_id: e.target.value.trim() } }))}
              placeholder="e.g. 116" />
          </FormField>
          <FormField label="Full name *" className="col-span-1">
            <input className="input" required value={modal.form.full_name}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, full_name: e.target.value } }))} placeholder="e.g. Sara Ali" />
          </FormField>
          <FormField label="Department">
            <input className="input" list="dept-opts" value={modal.form.department}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, department: e.target.value } }))} placeholder="Science" />
            <datalist id="dept-opts">{deptList.map((d) => <option key={d} value={d} />)}</datalist>
          </FormField>
          <FormField label="Designation">
            <select className="input" value={modal.form.designation}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, designation: e.target.value } }))}>
              <option>Teacher</option><option>Staff</option>
            </select>
          </FormField>
          <FormField label="Shift">
            <select className="input" value={modal.form.shift_id}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, shift_id: e.target.value } }))}>
              <option value="">— Default shift —</option>
              {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_time}–{s.end_time})</option>)}
            </select>
          </FormField>
          <FormField label="Status">
            <select className="input" value={modal.form.status}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, status: e.target.value } }))}>
              <option value="active">Active</option><option value="inactive">Inactive</option>
            </select>
          </FormField>
          <FormField label="Email" className="col-span-1">
            <input type="email" className="input" value={modal.form.email}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, email: e.target.value } }))} placeholder="name@school.edu" />
          </FormField>
          <FormField label="Phone">
            <input className="input" value={modal.form.phone}
              onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, phone: e.target.value } }))} placeholder="+92-300-0000000" />
          </FormField>
          {!modal.editing && (
            <label className="col-span-2 flex cursor-pointer items-center gap-2.5 rounded-xl border border-dashed border-indigo-300 bg-indigo-50/60 px-3.5 py-2.5">
              <input type="checkbox" className="h-4 w-4 accent-indigo-600" checked={modal.form.pushToDevice}
                onChange={(e) => setModal((m) => ({ ...m, form: { ...m.form, pushToDevice: e.target.checked } }))} />
              <span className="text-[13px] font-medium text-indigo-900">
                <UserPlus size={14} className="mr-1 inline -mt-0.5" />
                Also enroll this ID on the ZKTeco device now
              </span>
            </label>
          )}
          <div className="col-span-2 mt-1 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setModal({ open: false, form: EMPTY_FORM, editing: null })}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? <RefreshCw size={15} className="animate-spin" /> : null}
              {modal.editing ? 'Save changes' : 'Create profile'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!confirmDel} onClose={() => setConfirmDel(null)} title="Delete teacher" width="max-w-sm">
        <p className="text-sm text-slate-600">
          Remove <b>{confirmDel?.full_name}</b> (ZK #{confirmDel?.zk_user_id})?
          Their historical raw punches will be kept but unlinked.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirmDel(null)}>Cancel</button>
          <button className="btn-danger" onClick={doDelete}><Trash2 size={15} /> Delete</button>
        </div>
      </Modal>
    </div>
  );
}

function IconBtn({ children, title, onClick, danger, disabled }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      className={`rounded-lg border p-2 transition cursor-pointer disabled:opacity-50 ${
        danger
          ? 'border-rose-200 text-rose-500 hover:bg-rose-50'
          : 'border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-800'
      }`}>
      {children}
    </button>
  );
}

function FormField({ label, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      {children}
    </label>
  );
}
