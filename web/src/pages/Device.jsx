import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wifi, WifiOff, RefreshCw, Zap, CloudDownload, CloudUpload, Users,
  Fingerprint, Activity, Database, AlertTriangle, Server, CheckCircle2, Radar,
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
  const [commKey, setCommKey] = useState(null);
  const [commKeyModal, setCommKeyModal] = useState(false);
  const [checkingKey, setCheckingKey] = useState(false);

  const load = useCallback(() => {
    api.deviceStatus().then((r) => setStatus(r.data)).catch((e) => toast.error(e.message));
    api.unknownUsers().then((r) => setUnknown(r.data)).catch(() => {});
    api.rawLogs({ limit: 60 }).then((r) => setLogs(r.data)).catch(() => {});
    // Settings-only view: this must never open a session on the terminal just
    // because somebody looked at the page (that is how ATT used to fight itself).
    api.commKey().then((r) => setCommKey(r.data)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = Boolean(status?.busy);

  useEffect(() => {
    load();
    // Poll faster while the terminal is locked so the banner clears promptly.
    const id = setInterval(load, busy ? 3000 : 20000);
    return () => clearInterval(id);
  }, [load, busy]);

  /** Ask the TERMINAL what key it has — one real session, refused while busy. */
  const checkKeyOnDevice = async () => {
    setCheckingKey(true);
    try {
      const r = await api.commKey({ device: true });
      setCommKey(r.data);
      const d = r.data.device;
      if (d?.supported) {
        toast.success(`Terminal reports Comm Key ${d.deviceValue}${d.matches ? ' — matches ATT' : ' — DOES NOT match ATT'}`);
      } else if (d?.ok === false) {
        toast.warning(d.error);
      } else {
        toast.warning('This firmware does not report its Comm Key over the network');
      }
    } catch (e) {
      toast.warning(e.message);
    } finally {
      setCheckingKey(false);
      load();
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const r = await api.deviceTest();
      setTestResult(r.data);
      if (r.data.ok) toast.success('Connection OK');
      else if (r.data.busy) toast.warning(r.data.error); // 409 — ATT is mid-session
      else toast.error(`Unreachable: ${r.data.error}`);
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
      e.status === 409 ? toast.warning(e.message) : toast.error(e.message);
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
      e.status === 409 ? toast.warning(e.message) : toast.error(e.message);
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

  const bridgeOnline = status?.mode !== 'bridge' || status?.bridge?.online;
  const ok = Boolean(status && bridgeOnline && status.circuit !== 'open');
  // false = the connected library genuinely has no user-enrollment API
  // (node-zklib 1.x); null/undefined = unknown (bridge) → still offer the action.
  const caps = status?.capabilities;
  const canWriteUsers = !caps || caps.canWriteUsers !== false;

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
              <span className={`badge ${status.mode === 'mock' ? 'bg-amber-400/20 text-amber-200' : status.mode === 'bridge' && !status.bridge?.online ? 'bg-amber-400/20 text-amber-200' : 'bg-emerald-400/20 text-emerald-200'}`}>
                {status.mode === 'mock' ? 'SIMULATOR' : status.mode === 'bridge' ? 'SITE BRIDGE' : 'HARDWARE'}
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
          {busy && (
            <div className="flex items-start gap-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-[12px] leading-snug text-indigo-800">
              <Lock size={14} className="mt-0.5 shrink-0" />
              <span>
                <b>Terminal in use — {status?.busyReason}</b>. Device buttons are refused (not queued)
                until it finishes, so ATT never opens a second session and knocks itself off the terminal.
                {status?.deviceLock?.waiting?.length > 0 && (
                  <> {status.deviceLock.waiting.length} request(s) waiting.</>
                )}
              </span>
            </div>
          )}
          <StatusRow
            icon={status?.deviceLock?.locked ? Lock : Unlock}
            label="Device session"
            value={status?.deviceLock?.locked ? 'locked' : 'idle'}
            tone={status?.deviceLock?.locked ? 'text-indigo-600' : 'text-emerald-600'}
            sub={
              status?.deviceLock?.locked
                ? `${status.deviceLock.owner?.label || 'device op'} · ${((status.deviceLock.owner?.heldMs || 0) / 1000).toFixed(1)}s`
                : `one at a time · ${status?.deviceLock?.policy?.gapMs ?? 0}ms gap between sessions`
            }
          />
          <StatusRow icon={Activity} label="Circuit breaker" value={status?.circuit || '—'}
            tone={status?.circuit === 'open' ? 'text-rose-600' : 'text-emerald-600'}
            sub={status?.nextProbeAt ? `probe at ${new Date(status.nextProbeAt).toLocaleTimeString()}` : `${status?.consecutiveFailures ?? 0} consecutive failures`} />
          {status?.mode === 'bridge' && (
            <StatusRow icon={Server} label="School LAN agent" value={status.bridge?.online ? 'online' : 'offline'}
              tone={status.bridge?.online ? 'text-emerald-600' : 'text-rose-600'}
              sub={status.bridge?.lastSeenAt ? `last seen ${new Date(status.bridge.lastSeenAt).toLocaleTimeString()}` : 'waiting for the agent'} />
          )}
          <StatusRow icon={RefreshCw} label="Poller" value={`every ${status?.pollIntervalMinutes ?? '—'} min`}
            sub={status?.lastSyncAt ? `last ${new Date(status.lastSyncAt).toLocaleTimeString()}` : 'not synced yet'}
            tone={status?.pollerBusy ? 'text-indigo-600' : 'text-slate-700'} />
          <StatusRow icon={Database} label="Raw logs stored" value={status?.counts?.rawLogs ?? '—'}
            sub={`${status?.counts?.processedDays ?? 0} days processed`} tone="text-slate-700" />
          <StatusRow icon={Server} label="Today's device punches" value={status?.counts?.todayLogs ?? '—'} tone="text-slate-700" />
          {status?.lastError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-700">
              <b>{status.lastError.op}</b>: {status.lastError.message}
              {status.lastError.hint && (
                <p className="mt-1.5 border-t border-rose-200/70 pt-1.5 text-[11.5px] leading-snug text-rose-600">
                  <b>What this usually means:</b> {status.lastError.hint}
                </p>
              )}
            </div>
          )}

          {!ok && (
            <ConnectionChecklist
              mode={status?.mode}
              ip={status?.target.ip}
              port={status?.target.port}
              bridgeEnabled={status?.bridge?.enabled}
              bridgeOnline={status?.bridge?.online}
            />
          )}

          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              className="btn-ghost"
              onClick={runTest}
              disabled={testing || (busy && !testing)}
              title={busy ? 'The terminal is busy with another ATT operation — only one session at a time' : undefined}
            >
              <Zap size={15} className={testing ? 'animate-pulse' : ''} /> Test link
            </button>
            <button
              className="btn-primary"
              onClick={runSync}
              disabled={syncing || (busy && !syncing)}
              title={busy ? 'The terminal is busy with another ATT operation — only one session at a time' : undefined}
            >
              <CloudDownload size={15} className={syncing ? 'animate-bounce' : ''} /> {syncing ? 'Syncing…' : busy ? 'Terminal busy…' : 'Fetch logs now'}
            </button>
          </div>
          <Link to="/connect?diagnose=1" className="btn-ghost mt-2 w-full">
            <Radar size={15} /> Connection wizard & network diagnostics
          </Link>
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
              <button
                className="btn-success"
                onClick={pushAll}
                disabled={pushing || !canWriteUsers}
                title={canWriteUsers ? undefined : caps.writeUsersHint}
              >
                <CloudUpload size={15} className={pushing ? 'animate-pulse' : ''} /> {pushing ? 'Pushing…' : 'Push all teachers → device'}
              </button>
            </div>
          </div>

          {!canWriteUsers && (
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] leading-snug text-amber-800">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                <b>Enrollment from ATT is unavailable with the connected library</b> ({caps.library}{caps.libraryVersion ? ` v${caps.libraryVersion}` : ''}).
                Enroll people on the terminal instead — <b>Menu → User Mgt → New User</b> — then pull them in with <b>Fetch device users → Import</b>.
                Pulling punches is unaffected.
              </span>
            </div>
          )}

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

        <CommKeyCard
          state={commKey}
          busy={busy}
          checking={checkingKey}
          onChange={() => setCommKeyModal(true)}
          onCheck={checkKeyOnDevice}
        />

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

      {commKeyModal && (
        <CommKeyModal
          state={commKey}
          onClose={() => setCommKeyModal(false)}
          onSaved={(data) => {
            setCommKeyModal(false);
            // Reflect the new key at once, drop any stale device-side reading
            // (it was taken with the previous key), then re-read the truth.
            setCommKey((k) => ({ ...(k || {}), configured: data.key, set: data.key !== 0, device: null }));
            load();
          }}
        />
      )}

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

/** Shown whenever the terminal can't be reached — the real-world fix list. */
function ConnectionChecklist({ mode, ip, port, bridgeEnabled, bridgeOnline }) {
  const items = mode === 'bridge'
    ? [
        bridgeOnline
          ? <><b>LAN bridge agent is online.</b> Verify the terminal is reachable from that machine at <code className="font-mono">{ip}:{port}</code>.</>
          : <><b>Start the LAN bridge agent</b> on an always-on school PC that can reach the terminal.</>,
        <>Set <code className="font-mono">ATT_API_URL</code> to this Render URL and configure the same <code className="font-mono">DEVICE_BRIDGE_TOKEN</code> on Render and the agent{!bridgeEnabled ? ' (the server token is not configured yet)' : ''}.</>,
        <>From the agent host, verify it can reach the terminal over TCP and the school network allows outbound HTTPS.</>,
        <>Do not port-forward the ZKTeco port. The agent connects outward to Render; device traffic stays on the school LAN.</>,
      ]
    : [
        <>Device has a <b>static IP</b> set under <b>Menu → COMM → Ethernet</b> (currently expecting <code className="font-mono">{ip}:{port}</code>)</>,
        <>The <b>Comm Key</b> matches on both sides (<b>Menu → COMM → Comm Key</b> on the terminal vs. “Terminal password” below). A key ATT does not know accepts the socket and then refuses every command — and a non-zero key is what keeps other software off the terminal.</>,
        <>The server host can <b>ping {ip}</b> — both machines on the same LAN / routable VLAN</>,
        <>No AP <b>client isolation</b>; the server host can open outbound <b>TCP {port}</b> to the terminal</>,
        <>Device clock is accurate (punches are stored in device-local time)</>,
      ];
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="mb-2 text-[12px] font-bold uppercase tracking-wider text-slate-500">Device unreachable — checklist</div>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-snug text-slate-600">
            <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-500">{i + 1}</span>
            {it}
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[11px] text-slate-400">
        Full walkthrough: <code className="rounded bg-slate-200 px-1 py-0.5 font-mono text-[10.5px]">{mode === 'bridge' ? 'docs/RENDER.md' : 'docs/HARDWARE_SETUP.md'}</code>
      </p>
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

/**
 * ── Terminal password (Comm Key) ────────────────────────────────────────────
 * A ZKTeco terminal serves ONE management session. With Comm Key = 0 anything on
 * the LAN can take it, and whoever connects second kills whoever was there
 * first — the "Another device is connecting to the device so the connection is
 * interrupted" failure. A non-zero key makes every client that does not know it
 * fail the handshake instead.
 */
function CommKeyCard({ state, busy, checking, onChange, onCheck }) {
  const configured = state?.configured ?? 0;
  const isSet = configured !== 0;
  const device = state?.device;
  const mismatch = device && device.supported && device.matches === false;
  const readFailed = device && device.ok === false;

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${isSet ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
            {isSet ? <ShieldCheck size={18} /> : <KeyRound size={18} />}
          </div>
          <div>
            <h3 className="text-[15px] font-bold text-slate-900">Terminal password (Comm Key)</h3>
            <p className="max-w-xl text-xs leading-snug text-slate-500">
              The device's <b>Menu → COMM → Comm Key</b>. Any program that does not know it is refused,
              so it cannot steal the terminal's single session from ATT.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost !py-1.5 !text-xs" onClick={onCheck} disabled={checking || busy}
            title={busy ? 'The terminal is busy with another ATT operation' : 'Ask the terminal what key it has (one session)'}>
            <RefreshCw size={13} className={checking ? 'animate-spin' : ''} /> {checking ? 'Asking…' : 'Check against terminal'}
          </button>
          <button className="btn-primary !py-1.5 !text-xs" onClick={onChange}
            disabled={state?.savable === false}
            title={state?.savable === false ? 'ZK_COMM_KEY is set in this host\'s environment — change it there' : 'Change the key ATT uses, and optionally write it to the terminal'}>
            <KeyRound size={13} /> {isSet ? 'Change key' : 'Set a key'}
          </button>
        </div>
      </div>

      <div className={`mt-4 rounded-xl border p-3 text-[12.5px] leading-snug ${
        mismatch || readFailed
          ? 'border-rose-200 bg-rose-50 text-rose-700'
          : isSet
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-amber-200 bg-amber-50 text-amber-800'
      }`}>
        {isSet ? (
          <b>Comm Key {configured} is in use by ATT</b>
        ) : (
          <b>No Comm Key (0)</b>
        )}
        {isSet
          ? ' — ZKTime, a second ATT install and any other LAN software now fail the handshake instead of interrupting a sync.'
          : ' — the terminal answers any client on the LAN. Close every other ZK program, or set a key to lock them out for good.'}
        {state?.source && state.source !== 'default' && (
          <span className="mt-1 block text-[11px] opacity-75">
            saved in {state.source === 'environment' ? 'the ZK_COMM_KEY environment variable' : 'ATT settings'}
          </span>
        )}
        {state?.savable === false && (
          <span className="mt-1 block text-[11px] opacity-90">
            Fixed by the <b>ZK_COMM_KEY</b> environment variable on this host — change it there, not in ATT.
          </span>
        )}

        {mismatch && (
          <p className="mt-2 border-t border-rose-200 pt-2">
            <b>The terminal reports Comm Key {device.deviceValue}, ATT is using {configured}.</b> Every command will be
            refused until they match. Save the value from the keypad with “ATT only”, or write a new key to the device.
          </p>
        )}
        {readFailed && (
          <p className="mt-2 border-t border-rose-200 pt-2">
            <b>Could not read the terminal:</b> {device.error}
            {device.hint && <span className="mt-1 block text-[11.5px]">{device.hint}</span>}
          </p>
        )}
        {device?.supported && !mismatch && (
          <p className="mt-1 text-[11px] opacity-75">Terminal reports {device.deviceValue} via “{device.name}” — matches ATT.</p>
        )}
      </div>
    </div>
  );
}

const STEP_LABELS = {
  persist: 'Saved the new key in ATT',
  'read-device': 'Read the key currently on the terminal',
  'write-device': 'Wrote the new key to the terminal',
  verify: 'Logged in again with the new key',
  apply: 'ATT switched over to the new key',
  rollback: 'Rolled the terminal back',
  restore: 'Restored the previous key in ATT',
};

function CommKeyModal({ state, onClose, onSaved }) {
  const toast = useToast();
  const current = state?.configured ?? 0;
  const [key, setKey] = useState(String(current || 1));
  const [writeToDevice, setWriteToDevice] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null); // { ok, steps } | { error, steps }

  const canWrite = state?.supportedByLibrary !== false;

  const submit = async () => {
    const numeric = Number(String(key).trim());
    if (!Number.isFinite(numeric) || numeric < 0 || Math.trunc(numeric) !== numeric) {
      return toast.error('The Comm Key must be a whole number');
    }
    if (numeric > 999999) return toast.error('Use at most 6 digits — you may have to type it on the keypad one day');
    setSaving(true);
    setResult(null);
    try {
      const r = await api.setCommKey(numeric, writeToDevice && canWrite);
      setResult({ ok: true, steps: r.data.steps || [] });
      toast.success(
        r.data.writeToDevice
          ? `Comm Key ${numeric} written to the terminal and verified`
          : `ATT is now using Comm Key ${numeric}`
      );
      if (r.data.rebootRecommended) {
        toast.warning('Reboot the terminal once so any client still holding the old session is dropped');
      }
      onSaved(r.data);
    } catch (e) {
      const steps = e.body?.data?.steps || [];
      setResult({ ok: false, error: e.message, steps });
      e.status === 409 ? toast.warning(e.message) : toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Terminal password (Comm Key)"
      subtitle={`Currently ${current === 0 ? 'not set (0)' : `set to ${current}`} · Menu → COMM → Comm Key`}
      width="max-w-xl">
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-slate-600">New Comm Key</label>
          <div className="flex items-center gap-2">
            <input
              className="input font-mono"
              type="number"
              min="0"
              max="999999"
              step="1"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="1"
            />
            <button className="btn-ghost shrink-0" onClick={() => setKey('1')} title="The usual choice: short and typeable on the keypad">Use 1</button>
            <button className="btn-ghost shrink-0" onClick={() => setKey('0')} title="0 removes the password">Remove (0)</button>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-snug text-slate-500">
            <b>0</b> = the terminal answers any program on the LAN. <b>Any other number</b> = only a client that knows
            it can talk to the device, so ZKTime / a second ATT install can no longer interrupt a sync.
            Keep it short — you may need to type it on the keypad to recover the device.
          </p>
        </div>

        <div className="space-y-2 rounded-xl border border-slate-200 p-3">
          <label className={`flex items-start gap-2.5 ${canWrite ? 'cursor-pointer' : 'opacity-50'}`}>
            <input type="radio" className="mt-1 accent-indigo-600" checked={writeToDevice && canWrite}
              disabled={!canWrite} onChange={() => setWriteToDevice(true)} />
            <span>
              <span className="block text-[13px] font-semibold text-slate-700">Write it to the terminal too <span className="font-normal text-slate-400">(recommended)</span></span>
              <span className="block text-[12px] leading-snug text-slate-500">
                ATT reads the current key, writes the new one, then <b>logs in again to verify it</b>. If that login
                fails it puts the old key back and changes nothing — so this cannot lock you out.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="radio" className="mt-1 accent-indigo-600" checked={!writeToDevice || !canWrite}
              onChange={() => setWriteToDevice(false)} />
            <span>
              <span className="block text-[13px] font-semibold text-slate-700">ATT only — I already typed it on the keypad</span>
              <span className="block text-[12px] leading-snug text-slate-500">
                Saves the key ATT uses without touching the device. Use this when the terminal is unreachable, or when
                its firmware refuses remote option writes.
              </span>
            </span>
          </label>
          {!canWrite && (
            <p className="text-[11.5px] text-amber-700">
              This device link cannot change the key remotely — the terminal itself must be set on the keypad.
            </p>
          )}
        </div>

        {Number(key) !== 0 && writeToDevice && canWrite && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-[12px] leading-snug text-indigo-800">
            <b>After the change:</b> any other software pointing at this terminal (ZKTime, an old ATT copy, a
            vendor demo tool) stops working until it is given the same key. That is the point — but tell whoever
            runs it. A terminal reboot drops any session that was already open.
          </div>
        )}

        {result && (
          <div className={`rounded-xl border p-3 text-[12px] ${result.ok ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
            {result.ok ? (
              <div className="flex items-center gap-1.5 font-semibold text-emerald-700">
                <CheckCircle2 size={14} /> Comm Key updated
              </div>
            ) : (
              <div className="font-semibold text-rose-700">✕ {result.error}</div>
            )}
            {result.steps?.length > 0 && (
              <ol className="mt-2 space-y-1">
                {result.steps.map((st, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11.5px] text-slate-600">
                    <span className={st.ok === false ? 'text-rose-600' : 'text-emerald-600'}>
                      {st.ok === false ? '✕' : '✓'}
                    </span>
                    <span>
                      {STEP_LABELS[st.step] || st.step}
                      {st.name ? ` (${st.name})` : ''}
                      {st.value !== undefined && st.value !== null ? ` → ${st.value}` : ''}
                      {st.error ? ` — ${st.error}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>{result?.ok ? 'Done' : 'Cancel'}</button>
        <button className="btn-primary" onClick={submit} disabled={saving}>
          <KeyRound size={15} /> {saving ? 'Working…' : Number(key) === 0 ? 'Remove the password' : 'Save Comm Key'}
        </button>
      </div>
    </Modal>
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
