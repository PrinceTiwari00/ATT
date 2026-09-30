import { useCallback, useEffect, useState } from 'react';
import {
  Wifi, WifiOff, RefreshCw, Zap, CloudDownload, CloudUpload, Users,
  Fingerprint, Activity, Database, AlertTriangle, Server, CheckCircle2,
} from 'lucide-react';
import { api, fmtTime } from '../api/client';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

export default function Device() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [unknown, setUnknown] = useState([]);
  const [logs, setLogs] = useState([]);
  const [importModal, setImportModal] = useState(null); // { users: [...] }

  const load = useCallback(() => {
    api.deviceStatus().then((r) => setStatus(r.data)).catch((e) => toast.error(e.message));
    api.unknownUsers().then((r) => setUnknown(r.data)).catch(() => {});
    api.rawLogs({ limit: 60 }).then((r) => setLogs(r.data)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [load]);

  const runTest = async () => {
    setTesting(true);
    try {
      const r = await api.deviceTest();
      setTestResult(r.data);
      r.data.ok ? toast.success('Connection OK') : toast.error(`Unreachable: ${r.data.error}`);
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
      toast.error(e.message);
    } finally {
      setTesting(false);
      load();
    }
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const r = await api.syncNow();
      r.data.ok
        ? toast.success(`Pulled ${r.data.fetched} logs from device — ${r.data.inserted} new`)
        : toast.warning(r.data.reason || r.data.error || 'Sync skipped');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSyncing(false);
      load();
    }
  };

  const pushAll = async () => {
    setPushing(true);
    try {
      const r = await api.pushAllTeachers();
      toast.success(`Enrollment pushed: ${r.data.pushed}/${r.data.total} teachers enrolled on device`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setPushing(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const r = await api.deviceUsers();
      setImportModal({ users: r.data, selection: new Set(r.data.filter((u) => !u.registered).map((u) => u.userId)) });
    } catch (e) {
      toast.error(e.message);
    }
  };

  const ok = status && !status.error && status.circuit !== 'open';

  return (
    <div className="anim-in grid grid-cols-1 gap-4 xl:grid-cols-3">
      {/* ── Link panel ─────────────────────────── */}
      <div className="card overflow-hidden xl:col-span-1">
        <div className={`p-5 text-white ${ok ? 'bg-gradient-to-br from-slate-900 to-indigo-950' : 'bg-gradient-to-br from-rose-900 to-rose-950'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`grid h-12 w-12 place-items-center rounded-2xl ${ok ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/25 text-rose-200'}`}>
                {ok ? <Wifi size={24} /> : <WifiOff size={24} />}
              </div>
              <div>
                <div className="text-[15px] font-bold">{ok ? 'Device Linked' : 'Link Down'}</div>
                <div className="font-mono text-[12px] opacity-80">
                  {status ? `${status.target.ip}:${status.target.port}` : '—'}
                </div>
              </div>
            </div>
            {status && (
              <span className={`badge ${status.mode === 'mock' ? 'bg-amber-400/20 text-amber-200' : 'bg-emerald-400/20 text-emerald-200'}`}>
                {status.mode === 'mock' ? 'SIMULATOR' : 'HARDWARE'}
              </span>
            )}
          </div>

          {testResult && (
            <div className={`mt-4 rounded-xl border p-3 text-[12.5px] ${testResult.ok ? 'border-emerald-400/30 bg-emerald-400/10' : 'border-rose-400/30 bg-rose-400/10'}`}>
              {testResult.ok ? (
                <>
                  <div className="flex items-center gap-1.5 font-semibold text-emerald-300"><CheckCircle2 size={14} /> Handshake OK</div>
                  <div className="mt-1 font-mono text-[11.5px] opacity-85">
                    {testResult.device?.deviceName || 'ZKTeco terminal'} · fw {testResult.device?.firmware || 'n/a'} · SN {testResult.device?.serialNumber || 'n/a'}
                  </div>
                </>
              ) : (
                <div className="font-semibold text-rose-200">✕ {testResult.error}</div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-3 p-5">
          <StatusRow icon={Activity} label="Circuit breaker" value={status?.circuit || '—'}
            tone={status?.circuit === 'open' ? 'text-rose-600' : 'text-emerald-600'}
            sub={status?.nextProbeAt ? `probe at ${new Date(status.nextProbeAt).toLocaleTimeString()}` : `${status?.consecutiveFailures ?? 0} consecutive failures`} />
          <StatusRow icon={RefreshCw} label="Poller" value={`every ${status?.pollIntervalMinutes ?? '—'} min`}
            sub={status?.lastSyncAt ? `last ${new Date(status.lastSyncAt).toLocaleTimeString()}` : 'not synced yet'}
            tone={status?.pollerBusy ? 'text-indigo-600' : 'text-slate-700'} />
          <StatusRow icon={Database} label="Raw logs stored" value={status?.counts?.rawLogs ?? '—'}
            sub={`${status?.counts?.processedDays ?? 0} days processed`} tone="text-slate-700" />
          <StatusRow icon={Server} label="Today's device punches" value={status?.counts?.todayLogs ?? '—'} tone="text-slate-700" />
          {status?.lastError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-700">
              <b>{status.lastError.op}</b>: {status.lastError.message}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 pt-1">
            <button className="btn-ghost" onClick={runTest} disabled={testing}>
              <Zap size={15} className={testing ? 'animate-pulse' : ''} /> Test link
            </button>
            <button className="btn-primary" onClick={runSync} disabled={syncing}>
              <CloudDownload size={15} className={syncing ? 'animate-bounce' : ''} /> {syncing ? 'Syncing…' : 'Fetch logs now'}
            </button>
          </div>
          {status?.lastSyncResult && (
            <p className="text-center font-mono text-[11px] text-slate-400">
              last sync: {status.lastSyncResult.ok ? 'ok' : 'failed'} · fetched {status.lastSyncResult.fetched ?? 0} · inserted {status.lastSyncResult.inserted ?? 0} · {status.lastSyncResult.durationMs}ms
            </p>
          )}
        </div>
      </div>

      {/* ── Enrollment + unknown IDs + raw ledger ── */}
      <div className="space-y-4 xl:col-span-2">
        <div className="card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[15px] font-bold text-slate-900">Enrollment Sync</h3>
              <p className="text-xs text-slate-500">Push teacher IDs to device memory, or import IDs already on the terminal.</p>
            </div>
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={fetchUsers}><CloudDownload size={15} /> Fetch device users</button>
              <button className="btn-success" onClick={pushAll} disabled={pushing}>
                <CloudUpload size={15} className={pushing ? 'animate-pulse' : ''} /> {pushing ? 'Pushing…' : 'Push all teachers → device'}
              </button>
            </div>
          </div>

          {unknown.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-center gap-2 text-[13px] font-bold text-amber-800">
                <AlertTriangle size={15} /> {unknown.length} unknown device ID{unknown.length !== 1 ? 's' : ''} punching
              </div>
              <p className="mt-1 text-[12px] text-amber-700">These ZK IDs appear in the attendance memory but have no teacher profile. Import them to link the punches.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {unknown.map((u) => (
                  <button key={u.zk_user_id}
                    className="badge cursor-pointer bg-white text-amber-800 ring-1 ring-amber-300 hover:bg-amber-100"
                    title={`${u.punches} punches · last ${u.last_seen}`}
                    onClick={() =>
                      setImportModal({
                        users: [{ userId: u.zk_user_id, name: '' }],
                        selection: new Set([u.zk_user_id]),
                      })
                    }>
                    <Fingerprint size={12} /> #{u.zk_user_id} · {u.punches} punches
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Raw ledger preview */}
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <h3 className="text-[15px] font-bold text-slate-900">Raw Punch Ledger <span className="ml-1 text-xs font-medium text-slate-400">(latest {logs.length})</span></h3>
            <button className="btn-ghost !py-1.5 !text-xs" onClick={load}><RefreshCw size={13} /> Refresh</button>
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="th-table">Punch time</th>
                  <th className="th-table">ZK ID</th>
                  <th className="th-table">Teacher</th>
                  <th className="th-table">Source</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                    <td className="td-table font-mono text-[12.5px] tabular-nums">{l.punch_time.replace('T', ' ')}</td>
                    <td className="td-table"><span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300">#{l.zk_user_id}</span></td>
                    <td className="td-table">{l.full_name || <span className="italic text-amber-600">unmatched</span>}</td>
                    <td className="td-table text-slate-400">{l.source}</td>
                  </tr>
                ))}
                {logs.length === 0 && <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-400">No raw logs yet — run “Fetch logs now”.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Import-users modal */}
      {importModal && (
        <ImportModal
          initial={importModal}
          onClose={() => setImportModal(null)}
          onImported={() => { setImportModal(null); load(); }}
        />
      )}
    </div>
  );
}

function StatusRow({ icon: Icon, label, value, sub, tone }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3.5 py-2.5">
      <span className="flex items-center gap-2 text-[12.5px] font-medium text-slate-500"><Icon size={15} className="text-slate-400" /> {label}</span>
      <span className="text-right">
        <span className={`block text-[13px] font-bold capitalize ${tone}`}>{value}</span>
        {sub && <span className="block text-[10.5px] text-slate-400">{sub}</span>}
      </span>
    </div>
  );
}

function ImportModal({ initial, onClose, onImported }) {
  const toast = useToast();
  const [selection, setSelection] = useState(initial.selection);
  const [names, setNames] = useState(() => Object.fromEntries(initial.users.map((u) => [u.userId, u.name || ''])));
  const [saving, setSaving] = useState(false);

  const toggle = (id) =>
    setSelection((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const doImport = async () => {
    const users = [...selection].map((id) => ({ userId: id, name: names[id] || `Teacher ${id}` }));
    if (users.length === 0) return toast.warning('Select at least one user');
    setSaving(true);
    try {
      const r = await api.importDeviceUsers(users);
      toast.success(`Imported ${r.imported} profile(s)`);
      onImported();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Import users from device"
      subtitle="Creates teacher profiles bound to these ZKTeco enrollment IDs" width="max-w-xl">
      <div className="space-y-2">
        {initial.users.map((u) => (
          <div key={u.userId} className={`flex items-center gap-3 rounded-xl border p-3 transition ${selection.has(u.userId) ? 'border-indigo-300 bg-indigo-50/50' : 'border-slate-200'}`}>
            <input type="checkbox" className="h-4 w-4 accent-indigo-600 cursor-pointer"
              checked={selection.has(u.userId)} onChange={() => toggle(u.userId)} />
            <span className="rounded-md bg-slate-900 px-2 py-1 font-mono text-[12px] font-bold text-emerald-300">#{u.userId}</span>
            {u.registered ? (
              <span className="text-[13px] font-medium text-slate-500">{u.name} · <span className="text-emerald-600">already registered</span></span>
            ) : (
              <input className="input !py-1.5" placeholder="Full name…" value={names[u.userId]}
                onChange={(e) => setNames((n) => ({ ...n, [u.userId]: e.target.value }))} />
            )}
          </div>
        ))}
        {initial.users.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No users found on the device.</p>}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={doImport} disabled={saving}>
          <Users size={15} /> {saving ? 'Importing…' : `Import ${selection.size} user${selection.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </Modal>
  );
}
