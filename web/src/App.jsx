import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, CalendarClock, Users, Clock3, Fingerprint, Wifi, WifiOff, Loader2,
} from 'lucide-react';
import { api } from './api/client';
import Dashboard from './pages/Dashboard';
import Attendance from './pages/Attendance';
import Teachers from './pages/Teachers';
import Shifts from './pages/Shifts';
import Device from './pages/Device';
import LoginScreen from './components/LoginScreen';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/attendance', label: 'Attendance Log', icon: CalendarClock },
  { to: '/teachers', label: 'Teachers & Staff', icon: Users },
  { to: '/shifts', label: 'Shifts', icon: Clock3 },
  { to: '/device', label: 'Device & Sync', icon: Fingerprint },
];

function useDeviceStatus() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let dead = false;
    const load = () =>
      api.deviceStatus()
        .then((r) => !dead && setStatus(r.data))
        .catch(() => !dead && setStatus({ error: true }));
    load();
    const id = setInterval(load, 30000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, []);
  return status;
}

function DevicePill() {
  const status = useDeviceStatus();
  if (!status) {
    return (
      <span className="badge bg-slate-100 text-slate-500">
        <Loader2 size={12} className="animate-spin" /> connecting…
      </span>
    );
  }
  if (status.error || status.circuit === 'open') {
    return (
      <span className="badge bg-rose-100 text-rose-700" title={status.lastError?.message || 'API unreachable'}>
        <WifiOff size={12} /> Device Offline
      </span>
    );
  }
  return (
    <span
      className="badge bg-emerald-100 text-emerald-700"
      title={`${status.mode === 'mock' ? 'Simulated' : 'ZKTeco'} @ ${status.target.ip}:${status.target.port}`}
    >
      <Wifi size={12} className="pulse-dot" />
      {status.mode === 'mock' ? 'SIM·Linked' : 'ZKTeco·Linked'} {status.target.ip}
    </span>
  );
}

const TITLES = {
  '/dashboard': ['Dashboard', 'Today at a glance'],
  '/attendance': ['Attendance Log', 'Daily punches & statuses'],
  '/teachers': ['Teachers & Staff', 'Profiles mapped to ZKTeco enrollment IDs'],
  '/shifts': ['Shifts', 'Schedules & grace periods'],
  '/device': ['Device & Sync', 'ZKTeco link, poller & enrollment'],
};

export default function App() {
  const { pathname } = useLocation();
  const [title, sub] = TITLES[pathname] || ['ATT', ''];
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Auth gate — pass-through instantly when the server has no APP_PASSWORD.
  const [auth, setAuth] = useState('checking'); // checking | need | ok
  useEffect(() => {
    const check = () =>
      api.authCheck().then(() => setAuth('ok')).catch(() => setAuth('need'));
    check();
    const onKick = () => setAuth('need');
    window.addEventListener('att:unauthorized', onKick);
    return () => window.removeEventListener('att:unauthorized', onKick);
  }, []);

  if (auth === 'checking') {
    return <div className="grid h-full place-items-center"><div className="h-10 w-10 animate-spin rounded-full border-[3px] border-indigo-200 border-t-indigo-600" /></div>;
  }
  if (auth === 'need') {
    return <LoginScreen onSuccess={() => setAuth('ok')} />;
  }

  return (
    <div className="flex h-full">
      {/* ── Sidebar ─────────────────────────────── */}
      <aside className="hidden w-60 shrink-0 flex-col bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 text-slate-300 md:flex">
        <div className="flex items-center gap-3 px-5 pb-5 pt-6">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-600 shadow-lg shadow-indigo-600/40">
            <Fingerprint size={22} className="text-white" />
          </div>
          <div>
            <div className="text-[15px] font-extrabold tracking-tight text-white">ATT</div>
            <div className="text-[10.5px] font-medium uppercase tracking-widest text-slate-400">ZKTeco Attendance</div>
          </div>
        </div>

        <nav className="mt-2 flex-1 space-y-1 px-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                  isActive
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950/40'
                    : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <Icon size={17} strokeWidth={2.1} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mx-4 mb-5 rounded-xl border border-white/10 bg-white/5 p-3 text-[11px] leading-relaxed text-slate-400">
          <div className="font-semibold text-slate-200">Biometric source</div>
          ZKTeco terminal · TCP 4370
          <br />
          Poller syncs every minute.
        </div>
      </aside>

      {/* ── Main ─────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex items-center justify-between gap-4 border-b border-slate-200/70 bg-white/85 px-5 py-3.5 backdrop-blur">
          <div>
            <h1 className="text-[17px] font-bold tracking-tight text-slate-900">{title}</h1>
            <p className="text-[12.5px] text-slate-500">{sub}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-[12.5px] font-medium text-slate-500 sm:block">{today}</span>
            <DevicePill />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/attendance" element={<Attendance />} />
            <Route path="/teachers" element={<Teachers />} />
            <Route path="/shifts" element={<Shifts />} />
            <Route path="/device" element={<Device />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
