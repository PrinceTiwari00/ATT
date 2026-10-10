import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Save, Loader2, Database, FolderOpen, FileText, RefreshCw, HardDriveDownload,
  MonitorCog, Power, ShieldCheck, Trash2, RotateCcw, Info, KeyRound, ShieldAlert,
} from 'lucide-react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

const desktop = typeof window !== 'undefined' ? window.att : undefined;
const isDesktop = Boolean(desktop);

function Card({ title, subtitle, icon: Icon, children, right }) {
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-bold text-slate-800">{title}</h2>
          <p className="text-[12px] text-slate-500">{subtitle}</p>
        </div>
        {right}
      </header>
      <div className="space-y-4 p-5">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 h-6 w-11 shrink-0 rounded-full p-0.5 transition ${checked ? 'bg-indigo-600' : 'bg-slate-300'}`}
      >
        <span className={`block h-5 w-5 rounded-full bg-white shadow transition ${checked ? 'translate-x-5' : ''}`} />
      </button>
      <span>
        <span className="block text-[13px] font-semibold text-slate-700">{label}</span>
        {hint && <span className="block text-[12px] leading-snug text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

function Row({ k, v, mono }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-[12.5px]">
      <span className="shrink-0 text-slate-500">{k}</span>
      <span className={`truncate text-right text-slate-700 ${mono ? 'font-mono' : 'font-medium'}`} title={v}>{v}</span>
    </div>
  );
}

export default function Settings() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [schema, setSchema] = useState([]);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  // Terminal password (Comm Key) — what ATT presents to the device.
  const [keyState, setKeyState] = useState(null);
  const [keyValue, setKeyValue] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [checkingKey, setCheckingKey] = useState(false);

  const [info, setInfo] = useState(null);
  const [shell, setShell] = useState(null); // desktop shell info (window.att)
  const [autostart, setAutostart] = useState(false);
  const [service, setService] = useState(null);
  const [serviceBusy, setServiceBusy] = useState(false);

  const [backups, setBackups] = useState(null);
  const [backingUp, setBackingUp] = useState(false);
  const [logs, setLogs] = useState(null);
  const [logsBusy, setLogsBusy] = useState(false);

  const load = useCallback(() => {
    api.systemSettings().then((r) => {
      setSettings(r.data.settings);
      setSchema(r.data.schema || []);
      setForm({
        intervalMinutes: r.data.settings.poll?.intervalMinutes,
        pollEnabled: r.data.settings.poll?.enabled,
        timeoutMs: r.data.settings.device?.timeoutMs,
        mode: r.data.settings.device?.mode,
      });
    }).catch((e) => toast.error(e.message));
    // Settings-only: reading the key must never open a session on the terminal.
    api.commKey().then((r) => {
      setKeyState(r.data);
      setKeyValue((v) => (v === '' ? String(r.data?.configured ?? 0) : v));
    }).catch(() => {});
    api.systemInfo().then((r) => setInfo(r.data)).catch(() => {});
    api.backups().then((r) => setBackups(r.data)).catch(() => {});
    if (isDesktop) {
      desktop.info().then(setShell).catch(() => {});
      desktop.autostart.get().then(setAutostart).catch(() => {});
      desktop.service.status().then(setService).catch(() => {});
    } else {
      api.serviceStatus().then((r) => setService(r.data)).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const patch = {
        'poll.intervalMinutes': Number(form.intervalMinutes),
        'poll.enabled': Boolean(form.pollEnabled),
        'device.timeoutMs': Number(form.timeoutMs),
      };
      const r = await api.saveSettings(patch);
      setSettings(r.data.settings);
      toast.success(
        r.data.requiresRestart
          ? 'Saved — a restart is needed for the new port'
          : r.data.actions?.some((a) => a.action === 'poller-restarted')
            ? 'Saved — sync schedule updated'
            : 'Saved'
      );
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Save the key ATT uses. This deliberately does NOT touch the terminal — the
   * verified write-and-rollback flow lives on the Device page, because changing
   * a device password is not something a settings form should do as a side
   * effect of "Save".
   */
  const saveCommKey = async () => {
    const numeric = Number(String(keyValue).trim());
    if (!Number.isFinite(numeric) || Math.trunc(numeric) !== numeric || numeric < 0) {
      return toast.error('The Comm Key must be a whole number (0 or more)');
    }
    if (numeric > 999999) return toast.error('Use at most 6 digits — you may have to type it on the keypad one day');
    setSavingKey(true);
    try {
      const r = await api.saveSettings({ 'device.commKey': numeric });
      setSettings(r.data.settings);
      setKeyState((k) => ({ ...(k || {}), configured: numeric, set: numeric !== 0, source: 'settings-file', device: null }));
      toast.success(
        numeric === 0
          ? 'Saved — ATT now connects without a password (the terminal is open to any program on the LAN)'
          : `Saved — ATT now connects with Comm Key ${numeric} (applied live, no restart)`
      );
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingKey(false);
    }
  };

  /** One real session: ask the terminal which key it actually has. */
  const checkCommKey = async () => {
    setCheckingKey(true);
    try {
      const r = await api.commKey({ device: true });
      setKeyState(r.data);
      const d = r.data.device;
      if (d?.supported) {
        d.matches
          ? toast.success(`Terminal reports Comm Key ${d.deviceValue} — matches ATT`)
          : toast.error(`Terminal reports Comm Key ${d.deviceValue} but ATT is using ${r.data.configured}`);
      } else if (d?.ok === false) {
        toast.warning(d.error);
      } else {
        toast.warning('This firmware does not report its Comm Key over the network');
      }
    } catch (e) {
      e.status === 409 ? toast.warning(e.message) : toast.error(e.message);
    } finally {
      setCheckingKey(false);
    }
  };

  const savePassword = async (value) => {
    setSaving(true);
    try {
      await api.saveSettings({ 'security.appPassword': value });
      setSettings((s) => ({ ...s, security: { ...s.security, appPassword: value ? '••••••••' : '' } }));
      toast.success(value ? 'Password set — staff must sign in to open ATT' : 'Password removed — LAN-trusted mode');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleShell = async (key, value) => {
    try {
      await desktop.settings.set({ [key]: value });
    } catch (_) { /* the shell setting below still applies */ }
    if (key === 'desktop.autostart') {
      const ok = await desktop.autostart.set(value);
      setAutostart(ok ? value : autostart);
      toast[ok ? 'success' : 'error'](ok ? (value ? 'ATT starts with Windows' : 'ATT no longer starts with Windows') : 'Could not change autostart');
    } else {
      toast.success('Saved');
    }
  };

  const serviceAction = async (action) => {
    setServiceBusy(true);
    try {
      const result = isDesktop
        ? await desktop.service.control(action)
        : (await api.serviceControl(action)).data;
      if (result.needsElevation) toast.warning('Administrator rights are required — approve the Windows prompt.');
      else if (result.cancelled) toast.warning('The Windows prompt was cancelled.');
      else if (result.ok) toast.success(`Service ${action} done`);
      else if (result.error) toast.error(result.error);
      if (isDesktop) desktop.service.status().then(setService).catch(() => {});
      else api.serviceStatus().then((r) => setService(r.data)).catch(() => {});
    } catch (e) {
      toast.error(e.message);
    } finally {
      setServiceBusy(false);
    }
  };

  const backup = async () => {
    setBackingUp(true);
    try {
      const r = await api.backupNow('manual');
      toast.success(`Backup saved (${(r.data.bytes / 1048576).toFixed(2)} MB)`);
      api.backups().then((x) => setBackups(x.data));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBackingUp(false);
    }
  };

  const loadLogs = async () => {
    setLogsBusy(true);
    try {
      const r = await api.systemLogs(400);
      setLogs(r.data);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLogsBusy(false);
    }
  };

  const field = (key) => schema.find((f) => f.key === key);

  const keyField = field('device.commKey');
  // Locked only when an operator-owned ZK_COMM_KEY env var decides the key on
  // this host (cloud/systemd). The store's own env var does NOT lock it — that
  // is what `editable`/`savable` say, and why `persisted` is not used here.
  const keyLocked = keyState?.savable === false || (keyField ? keyField.editable === false : false);
  const keyConfigured = Number(keyState?.configured ?? settings?.device?.commKey ?? 0);
  const keyIsSet = keyConfigured !== 0;
  const deviceReading = keyState?.device && keyState.device.supported ? keyState.device : null;

  return (
    <div className="anim-in mx-auto grid max-w-4xl grid-cols-1 gap-4">
      {/* ── sync engine ─────────────────────────────── */}
      <Card title="Sync engine" subtitle="How often this computer pulls punches from the terminal." icon={RefreshCw}
        right={
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
          </button>
        }
      >
        <Toggle
          checked={Boolean(form.pollEnabled)}
          onChange={(v) => setForm((f) => ({ ...f, pollEnabled: v }))}
          label="Automatic background sync"
          hint="Keep this on: punches are pulled without anyone touching the app."
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Sync every (minutes)</span>
            <input
              type="number" min="0.2" max="1440" step="0.5" className="input"
              value={form.intervalMinutes ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, intervalMinutes: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Device timeout (ms)</span>
            <input
              type="number" min="1000" max="120000" step="500" className="input"
              value={form.timeoutMs ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, timeoutMs: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Connection mode</span>
            <input className="input" value={form.mode || ''} readOnly title="Change the mode in the Connect Device wizard" />
          </label>
        </div>
        <p className="text-[11.5px] text-slate-400">
          Device address and port are edited in <b>Connect Device</b>. Settings are stored in{' '}
          <span className="font-mono">{info?.paths?.settingsFile || 'config.json'}</span>.
        </p>
      </Card>

      {/* ── terminal password ───────────────────────── */}
      <Card
        title="Terminal password (Comm Key)"
        subtitle="What ATT presents to the ZKTeco terminal — the device's Menu → COMM → Comm Key."
        icon={KeyRound}
        right={
          <button className="btn btn-primary" onClick={saveCommKey} disabled={savingKey || keyLocked}>
            {savingKey ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
          </button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${keyIsSet ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
            {keyIsSet ? `Comm Key ${keyConfigured} in use` : 'no key (0) — terminal answers any program'}
          </span>
          {deviceReading && (
            <span className={`badge ${deviceReading.matches ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
              {deviceReading.matches ? `terminal agrees (${deviceReading.deviceValue})` : `terminal has ${deviceReading.deviceValue} — MISMATCH`}
            </span>
          )}
          <button className="btn btn-ghost" onClick={checkCommKey} disabled={checkingKey || keyLocked === 'busy'}
            title="Opens one session on the terminal to read the key it has">
            <RefreshCw size={15} className={checkingKey ? 'animate-spin' : ''} />
            {checkingKey ? 'Asking the terminal…' : 'Check against terminal'}
          </button>
          <Link className="btn btn-ghost" to="/device">
            <KeyRound size={15} /> Change it on the terminal…
          </Link>
        </div>

        <label className="block sm:max-w-xs">
          <span className="mb-1 block text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">
            Comm Key {keyField ? `(${keyField.min}–999999)` : ''}
          </span>
          <input
            type="number" min="0" max="999999" step="1" className="input font-mono"
            value={keyValue}
            disabled={Boolean(keyLocked)}
            onChange={(e) => setKeyValue(e.target.value)}
            placeholder="0"
          />
        </label>

        {keyLocked && (
          <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-[12px] text-slate-600">
            <Info size={14} className="mt-0.5 shrink-0" />
            Fixed by the <span className="font-mono">ZK_COMM_KEY</span> environment variable on this host — change it
            there (or in the Windows service's environment) instead of in the UI.
          </p>
        )}

        {keyState?.device?.ok === false && (
          <p className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[12px] leading-snug text-rose-700">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" />
            <span>
              <b>Could not read the terminal:</b> {keyState.device.error}
              {keyState.device.hint ? <span className="mt-1 block text-[11.5px]">{keyState.device.hint}</span> : null}
            </span>
          </p>
        )}

        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-[11.5px] leading-relaxed text-slate-600">
          <b>What this does:</b> changes the key <b>ATT</b> uses, live — no restart. It does <b>not</b> write anything to
          the device. If the two sides disagree, every command is refused
          (<span className="font-mono">TIMEOUT_ON_WRITING_MESSAGE</span>), so use <b>Check against terminal</b> after a
          keypad change, or <Link to="/device" className="font-semibold text-indigo-600 underline">Device &amp; Sync →
          Terminal password</Link> to write a new key to the device — that flow verifies the new key by logging in again
          and rolls the terminal back if it fails.
          <br />
          <b>Why set one:</b> the terminal serves a single management session. With <span className="font-mono">0</span>,
          ZKTime or a second ATT install can take that session and interrupt a sync
          (<span className="font-mono">ECONNRESET</span> / “Another device is connecting…”). With a key, they are refused
          at the handshake instead. ATT's own operations are already serialised — one session at a time — and a caller
          that finds the device in use is told <span className="font-mono">the terminal is busy</span> rather than
          colliding with the sync in progress.
        </div>
      </Card>

      {/* ── access ──────────────────────────────────── */}
      <Card title="Access control" subtitle="Protect the dashboard with a password when it leaves the office LAN." icon={ShieldCheck}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={`badge ${settings?.security?.appPassword ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
            {settings?.security?.appPassword ? 'password protected' : 'LAN-trusted (no password)'}
          </span>
          {!settings?.security?.appPassword ? (
            <button className="btn btn-ghost" onClick={() => {
              const pw = window.prompt('Set a password for opening ATT (min 8 characters):');
              if (pw && pw.length >= 8) savePassword(pw);
              else if (pw) toast.error('Use at least 8 characters');
            }}>
              <ShieldCheck size={15} /> Set password
            </button>
          ) : (
            <button className="btn btn-danger" onClick={() => savePassword(null)}>
              <Trash2 size={15} /> Remove password
            </button>
          )}
        </div>
        <p className="text-[11.5px] leading-relaxed text-slate-500">
          Other staff PCs on the school network can open this dashboard at{' '}
          <span className="font-mono">http://{'{this-computer}'}:{settings?.server?.port || 4000}</span>. If this PC is ever
          reachable from the internet, set a password first.
        </p>
      </Card>

      {/* ── desktop shell ───────────────────────────── */}
      {isDesktop && (
        <Card title="Windows app" subtitle="Startup behaviour, tray and the background sync service." icon={MonitorCog}>
          <Toggle
            checked={autostart}
            onChange={(v) => toggleShell('desktop.autostart', v)}
            label="Start ATT when Windows starts"
            hint="Recommended: the poller should be live before the first teacher arrives."
          />
          <Toggle
            checked={Boolean(settings?.desktop?.closeToTray)}
            onChange={(v) => toggleShell('desktop.closeToTray', v)}
            label="Keep running when the window is closed"
            hint="Closing the window hides ATT to the tray; syncing continues."
          />
          <Toggle
            checked={Boolean(settings?.desktop?.minimizeToTray)}
            onChange={(v) => toggleShell('desktop.minimizeToTray', v)}
            label="Minimise to tray instead of the taskbar"
          />

          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Power size={16} className={service?.running ? 'text-emerald-600' : 'text-slate-400'} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-slate-700">
                  Background service: {service?.supported === false ? 'not available on this platform' : service?.installed ? (service.running ? 'running' : `installed (${service.state?.toLowerCase()})`) : 'not installed'}
                </div>
                <div className="text-[11.5px] text-slate-500">
                  The Windows service keeps pulling punches at boot, while the PC is locked and when nobody is signed in.
                  {service?.homeIsMachineWide === false ? ' Your data folder is per-user, so the service cannot be installed here.' : ''}
                </div>
              </div>
              <div className="flex gap-2">
                {!service?.installed ? (
                  <button className="btn btn-primary" disabled={serviceBusy || !service?.supported} onClick={() => serviceAction('install')}>
                    {serviceBusy ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />} Install service
                  </button>
                ) : (
                  <>
                    {service?.running ? (
                      <button className="btn btn-ghost" disabled={serviceBusy} onClick={() => serviceAction('stop')}>Stop</button>
                    ) : (
                      <button className="btn btn-ghost" disabled={serviceBusy} onClick={() => serviceAction('start')}>Start</button>
                    )}
                    <button className="btn btn-danger" disabled={serviceBusy} onClick={() => serviceAction('uninstall')}>Uninstall</button>
                  </>
                )}
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              Installing or changing the service asks Windows for administrator permission once.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" onClick={() => desktop.paths.open('data')}><FolderOpen size={15} /> Data folder</button>
            <button className="btn btn-ghost" onClick={() => desktop.paths.open('logs')}><FolderOpen size={15} /> Log folder</button>
            <button className="btn btn-ghost" onClick={() => desktop.paths.open('backups')}><FolderOpen size={15} /> Backups</button>
            <button className="btn btn-ghost" onClick={async () => { await desktop.backend.restart(); toast.success('Restarting the attendance engine'); }}>
              <RotateCcw size={15} /> Restart engine
            </button>
          </div>
        </Card>
      )}

      {/* ── data & backups ──────────────────────────── */}
      <Card
        title="Data & backups"
        subtitle="Everything ATT knows lives in one SQLite file on this computer."
        icon={Database}
        right={
          <button className="btn btn-primary" onClick={backup} disabled={backingUp}>
            {backingUp ? <Loader2 size={15} className="animate-spin" /> : <HardDriveDownload size={15} />} Backup now
          </button>
        }
      >
        {info?.paths && (
          <div className="rounded-xl border border-slate-200 px-4 py-2">
            <Row k="Database" v={info.paths.dbFile} mono />
            <Row k="Settings" v={info.paths.settingsFile} mono />
            <Row k="Log file" v={info.paths.logFile} mono />
            <Row k="Backups" v={info.paths.backupDir} mono />
          </div>
        )}
        {backups?.backups?.length ? (
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
            {backups.backups.map((b) => (
              <div key={b.name} className="flex items-center justify-between gap-3 bg-white px-4 py-2 text-[12.5px]">
                <span className="truncate font-mono text-slate-700">{b.name}</span>
                <span className="shrink-0 text-slate-500">
                  {(b.bytes / 1048576).toFixed(2)} MB · {new Date(b.at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-slate-500">No backups yet — the last 10 snapshots are kept automatically.</p>
        )}
      </Card>

      {/* ── logs ────────────────────────────────────── */}
      <Card
        title="Engine log"
        subtitle="Last 400 lines of the attendance engine (what support will ask for)."
        icon={FileText}
        right={
          <button className="btn btn-ghost" onClick={loadLogs} disabled={logsBusy}>
            {logsBusy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
          </button>
        }
      >
        {logs ? (
          <pre className="max-h-72 overflow-auto rounded-xl bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-200">
            {logs.lines?.length ? logs.lines.join('\n') : '(log file is empty)'}
          </pre>
        ) : (
          <p className="text-[12px] text-slate-500">Press Refresh to load the log.</p>
        )}
      </Card>

      {/* ── about ───────────────────────────────────── */}
      <Card title="About this installation" subtitle="" icon={Info}>
        <div className="rounded-xl border border-slate-200 px-4 py-2">
          <Row k="ATT version" v={`${info?.app?.version || '—'}${info?.app?.packaged ? ' (installed app)' : ' (source run)'}`} />
          <Row k="Computer" v={`${info?.app?.hostname || '—'} · ${info?.app?.platform || ''} ${info?.app?.arch || ''}`} />
          <Row k="Node.js" v={info?.app?.node || '—'} mono />
          {shell && <Row k="Electron" v={`${shell.app?.electron || '—'} · Chromium ${shell.app?.chrome || '—'}`} mono />}
          <Row k="Backend" v={shell?.backend ? `${shell.backend.url} (${shell.backend.mode}${shell.backend.attached ? ', attached' : ''})` : info ? 'running in this process' : '—'} mono />
          <Row k="Time zone" v={info?.tz || '—'} />
          <Row k="Uptime" v={info ? `${Math.round(info.app.uptimeSec / 60)} min` : '—'} />
        </div>
      </Card>
    </div>
  );
}
