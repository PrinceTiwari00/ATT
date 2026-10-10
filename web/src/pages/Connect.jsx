import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import {
  Radar, Network, Cable, PlugZap, CheckCircle2, XCircle, AlertTriangle, Minus,
  Loader2, Save, RefreshCw, Fingerprint, MonitorSmartphone, ArrowRight, ShieldCheck,
  Search, Stethoscope,
} from 'lucide-react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

const STEP_STYLES = {
  pass: { icon: CheckCircle2, cls: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  warn: { icon: AlertTriangle, cls: 'text-amber-600 bg-amber-50 border-amber-200' },
  fail: { icon: XCircle, cls: 'text-rose-600 bg-rose-50 border-rose-200' },
  skipped: { icon: Minus, cls: 'text-slate-500 bg-slate-50 border-slate-200' },
};

function StepRow({ step }) {
  const [open, setOpen] = useState(false);
  const S = STEP_STYLES[step.status] || STEP_STYLES.skipped;
  const hints = step.hints?.length ? step.hints : [];
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${S.cls.split(' ').slice(1).join(' ')}`}>
      <button className="flex w-full items-start gap-3 text-left cursor-pointer" onClick={() => hints.length && setOpen(!open)}>
        <S.icon size={17} className={`mt-0.5 shrink-0 ${S.cls.split(' ')[0]}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-semibold text-slate-800">{step.label}</span>
            <span className="badge bg-white/70 text-slate-600 uppercase tracking-wide">{step.status}</span>
          </div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-slate-600">{step.detail}</div>
          {open && hints.length > 0 && (
            <ul className="mt-2 space-y-1 border-l-2 border-slate-200 pl-3 text-[12px] leading-relaxed text-slate-600">
              {hints.map((h, i) => (
                <li key={i}>• {h}</li>
              ))}
            </ul>
          )}
        </div>
        {hints.length > 0 && (
          <span className="text-[11px] font-medium text-slate-400">{open ? 'hide fixes' : `${hints.length} fixes`}</span>
        )}
      </button>
    </div>
  );
}

function Section({ n, title, subtitle, icon: Icon, children, right }) {
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-bold text-slate-800">
            <span className="mr-2 inline-grid h-5 w-5 place-items-center rounded-md bg-slate-900 text-[11px] font-bold text-white">{n}</span>
            {title}
          </h2>
          <p className="text-[12px] text-slate-500">{subtitle}</p>
        </div>
        {right}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export default function Connect() {
  const toast = useToast();
  const [params] = useSearchParams();

  const [network, setNetwork] = useState(null);
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);

  const [ip, setIp] = useState('');
  const [port, setPort] = useState('4370');
  const [mode, setMode] = useState('real');

  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState(null);

  const [diagnosing, setDiagnosing] = useState(false);
  const [report, setReport] = useState(null);

  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState(null);

  const [saving, setSaving] = useState(false);
  const [connected, setConnected] = useState(null); // {fetched, inserted}

  const target = { ip: ip || settings?.device?.ip || '', port: Number(port || settings?.device?.port || 4370) };

  const load = useCallback(() => {
    api.systemNetwork().then((r) => setNetwork(r.data)).catch(() => setNetwork({ error: true }));
    api.systemSettings().then((r) => {
      setSettings(r.data.settings);
      setIp((cur) => cur || r.data.settings.device?.ip || '');
      setPort((cur) => (cur === '4370' && r.data.settings.device?.port ? String(r.data.settings.device.port) : cur));
      setMode(r.data.settings.device?.mode || 'real');
    }).catch(() => {});
    api.deviceStatus().then((r) => setStatus(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* tray → "Run connection diagnostics" */
  useEffect(() => {
    if (params.get('diagnose') === '1') runDiagnostics();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runScan = async () => {
    setScanning(true);
    setScan(null);
    try {
      const r = await api.discover({ port: target.port, timeoutMs: 1200, identify: true });
      setScan(r.data);
      if (r.data.found === 0) {
        toast.warning(`Scanned ${r.data.scanned} addresses — nothing is listening on port ${target.port}.`);
      } else {
        toast.success(`Found ${r.data.found} device${r.data.found > 1 ? 's' : ''} on port ${target.port}`);
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setScanning(false);
    }
  };

  const runDiagnostics = async () => {
    if (!target.ip) return toast.error('Enter the device IP address first');
    setDiagnosing(true);
    setReport(null);
    try {
      const r = await api.diagnose({ ip: target.ip, port: target.port });
      setReport(r.data);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDiagnosing(false);
    }
  };

  const runProbe = async () => {
    if (!target.ip) return toast.error('Enter the device IP address first');
    setProbing(true);
    setProbe(null);
    try {
      const r = await api.probeDevice({ ip: target.ip, port: target.port, timeoutMs: 6000 });
      setProbe(r.data);
      r.data.ok ? toast.success('ZKTeco handshake succeeded') : toast.error(r.data.error || 'Handshake failed');
    } catch (e) {
      setProbe({ ok: false, error: e.message });
      toast.error(e.message);
    } finally {
      setProbing(false);
    }
  };

  const saveAndConnect = async () => {
    if (!target.ip) return toast.error('Enter the device IP address first');
    setSaving(true);
    try {
      await api.saveSettings({ 'device.ip': target.ip, 'device.port': target.port, 'device.mode': mode });
      const sync = await api.syncNow().catch(() => null);
      setConnected({
        at: new Date().toISOString(),
        fetched: sync?.data?.fetched ?? null,
        inserted: sync?.data?.inserted ?? null,
        syncError: sync?.data?.error || null,
      });
      toast.success(`Connected — ATT now pulls punches from ${target.ip}:${target.port}`);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const link = network?.link;
  const usable = network?.usable || [];
  const sameSubnet = Boolean(link?.sameSubnet);

  return (
    <div className="anim-in mx-auto grid max-w-5xl grid-cols-1 gap-4">
      {/* ── current state ─────────────────────────── */}
      <div className="card flex flex-wrap items-center gap-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className={`grid h-11 w-11 place-items-center rounded-2xl ${status?.circuit === 'open' ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-600'}`}>
            <PlugZap size={22} />
          </div>
          <div>
            <div className="text-[14px] font-bold text-slate-800">
              {status ? (status.circuit === 'open' ? 'Device link is down' : 'Device link is live') : 'Checking link…'}
            </div>
            <div className="font-mono text-[12px] text-slate-500">
              {status ? `${status.mode} · ${status.target.ip}:${status.target.port}` : ''}
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {sameSubnet ? (
            <span className="badge bg-emerald-100 text-emerald-700"><ShieldCheck size={12} /> same network as device</span>
          ) : link ? (
            <span className="badge bg-amber-100 text-amber-700"><Network size={12} /> device on another network</span>
          ) : null}
          <button className="btn btn-ghost" onClick={load} title="Refresh">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {mode !== 'real' && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          This installation is in <b>{mode}</b> mode. To talk to a terminal on this computer's network directly, set the
          mode to <b>real</b> below (or stay in <b>bridge</b> if ATT runs in the cloud with a school-side agent).
        </div>
      )}

      {/* ── 1 · this computer ───────────────────────── */}
      <Section
        n="1"
        icon={MonitorSmartphone}
        title="This computer on the network"
        subtitle="ATT connects to the terminal over the LAN — the PC and the terminal must be able to see each other."
      >
        {network?.error ? (
          <div className="text-[13px] text-rose-600">Could not read the network interfaces of this computer.</div>
        ) : usable.length === 0 ? (
          <div className="text-[13px] text-amber-700">
            No usable IPv4 connection detected. Plug in the Ethernet cable (or join the school Wi-Fi) and refresh.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {usable.map((i) => (
              <div key={i.name} className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-slate-700">{i.name}</span>
                  <span className="badge bg-white text-slate-500 border border-slate-200">{i.cidr}</span>
                </div>
                <div className="mt-1 font-mono text-[15px] font-semibold text-slate-800">{i.address}</div>
                <div className="text-[11.5px] text-slate-500">
                  mask {i.netmask}
                  {network?.gateways?.find((g) => g.interfaceAddress === i.address || g.interface === i.name)
                    ? ` · gateway ${network.gateways.find((g) => g.interfaceAddress === i.address || g.interface === i.name).gateway}`
                    : ''}
                </div>
              </div>
            ))}
          </div>
        )}
        {network && (
          <p className="mt-3 text-[12px] leading-relaxed text-slate-500">
            The terminal should have a <b>static IP</b> in one of the networks above (device keypad:
            <span className="font-mono"> Menu → COMM → Ethernet</span>, DHCP off). If it lives on a different
            subnet/VLAN, traffic is routed and many school routers block that.
          </p>
        )}
      </Section>

      {/* ── 2 · locate the terminal ─────────────────── */}
      <Section
        n="2"
        icon={Radar}
        title="Locate the ZKTeco terminal"
        subtitle="Type its IP, or sweep this network to find every device answering on the attendance port."
        right={
          <button className="btn btn-primary" onClick={runScan} disabled={scanning}>
            {scanning ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            {scanning ? 'Scanning…' : 'Scan my network'}
          </button>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_130px_auto]">
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Device IP address</span>
            <input className="input font-mono" value={ip} placeholder="192.168.1.110" onChange={(e) => setIp(e.target.value.trim())} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Port</span>
            <input className="input font-mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Mode</span>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="real">real (direct LAN)</option>
              <option value="bridge">bridge (cloud + agent)</option>
              <option value="mock">mock (simulator)</option>
            </select>
          </label>
        </div>

        {scanning && (
          <div className="mt-4 flex items-center gap-2 text-[13px] text-slate-500">
            <Loader2 size={15} className="animate-spin" /> Probing every address of your network on port {target.port}…
          </div>
        )}

        {scan && !scanning && (
          <div className="mt-4">
            <div className="mb-2 text-[12px] text-slate-500">
              Scanned <b>{scan.scanned}</b> addresses in {(scan.durationMs / 1000).toFixed(1)}s —{' '}
              <b>{scan.found}</b> answered on port {scan.port}.
            </div>
            {scan.devices.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-[12.5px] text-slate-500">
                Nothing found. Check the terminal's static IP on its keypad (Menu → COMM → Ethernet) and that it is
                powered on and wired to the same switch/VLAN as this PC.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
                {scan.devices.map((d) => (
                  <div key={d.ip} className="flex flex-wrap items-center gap-3 bg-white px-4 py-3">
                    <Fingerprint size={17} className={d.zk?.ok ? 'text-emerald-600' : 'text-slate-400'} />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[13.5px] font-semibold text-slate-800">{d.ip}:{d.port}</div>
                      <div className="text-[11.5px] text-slate-500">
                        {d.zk?.ok
                          ? `${d.zk.device?.productName || 'ZKTeco terminal'} · SN ${d.zk.device?.serialNumber || 'n/a'} · fw ${d.zk.device?.version || d.zk.device?.firmwareVersion || 'n/a'}`
                          : d.zk?.ok === false
                            ? `open port, but no ZK handshake (${d.zk.error || 'unknown'})`
                            : `answered in ${d.rttMs} ms`}
                      </div>
                    </div>
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setIp(d.ip);
                        setPort(String(d.port));
                        toast.success(`Using ${d.ip}:${d.port} — now run the diagnostics below`);
                        document.getElementById('att-diagnose-btn')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}
                    >
                      Use this device <ArrowRight size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ── 3 · verify & connect ────────────────────── */}
      <Section
        n="3"
        icon={Stethoscope}
        title="Verify the link, then connect"
        subtitle="Diagnostics checks this PC's route, ICMP, the TCP port and the ZKTeco protocol — with the exact fix for each failure."
        right={
          <div className="flex gap-2">
            <button id="att-diagnose-btn" className="btn btn-ghost" onClick={runDiagnostics} disabled={diagnosing}>
              {diagnosing ? <Loader2 size={15} className="animate-spin" /> : <Stethoscope size={15} />}
              Diagnostics
            </button>
            <button className="btn btn-ghost" onClick={runProbe} disabled={probing}>
              {probing ? <Loader2 size={15} className="animate-spin" /> : <Cable size={15} />}
              Test handshake
            </button>
            <button className="btn btn-primary" onClick={saveAndConnect} disabled={saving}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Save & connect
            </button>
          </div>
        }
      >
        {probe && (
          <div className={`mb-4 rounded-xl border px-4 py-3 text-[13px] ${probe.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>
            {probe.ok ? (
              <>
                <b>Handshake OK</b> —{' '}
                {probe.device?.productName || 'ZKTeco terminal'} · SN {probe.device?.serialNumber || 'n/a'} · fw{' '}
                {probe.device?.version || probe.device?.firmwareVersion || 'n/a'} · {probe.durationMs} ms
              </>
            ) : (
              <>
                <b>Handshake failed:</b> {probe.error}
              </>
            )}
          </div>
        )}

        {report ? (
          <div className="space-y-2">
            {report.steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
            <div className={`rounded-xl px-4 py-3 text-[13px] font-semibold ${report.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
              {report.verdict}
            </div>
          </div>
        ) : diagnosing ? (
          <div className="flex items-center gap-2 py-6 text-[13px] text-slate-500">
            <Loader2 size={15} className="animate-spin" /> Probing {target.ip}:{target.port} …
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-[12.5px] text-slate-500">
            Run <b>Diagnostics</b> to see a step-by-step verdict, or <b>Save &amp; connect</b> to start syncing right away.
          </div>
        )}

        {connected && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800">
            <div className="font-bold">Connected ✓</div>
            <div className="mt-0.5">
              {connected.fetched != null
                ? `First pull: ${connected.fetched} punches on the device, ${connected.inserted} stored as new.`
                : connected.syncError
                  ? `Saved. First sync reported: ${connected.syncError}`
                  : 'Saved. The poller will pull punches on its next tick.'}{' '}
              Next: <Link className="font-semibold underline" to="/teachers">map device IDs to teachers</Link>.
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
