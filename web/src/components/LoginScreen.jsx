import { useState } from 'react';
import { Fingerprint, Lock, Loader2 } from 'lucide-react';
import { api, setToken } from '../api/client';

/** Shown only when the backend has APP_PASSWORD configured. */
export default function LoginScreen({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.authLogin(password);
      if (r.data.authDisabled) return onSuccess();
      setToken(r.data.token);
      await api.authCheck();
      onSuccess();
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center bg-gradient-to-br from-slate-100 via-indigo-50/40 to-slate-100 p-4">
      <form onSubmit={submit} className="anim-in card w-full max-w-sm p-7 shadow-xl">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-indigo-600 shadow-lg shadow-indigo-600/30">
          <Fingerprint size={26} className="text-white" />
        </div>
        <h1 className="text-center text-lg font-extrabold tracking-tight text-slate-900">ATT · Attendance</h1>
        <p className="mb-5 mt-1 text-center text-[12.5px] text-slate-500">Restricted access — enter the admin password</p>

        <label className="relative block">
          <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="password"
            className="input pl-9"
            placeholder="Password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] font-medium text-rose-600">{error}</p>}

        <button type="submit" className="btn-primary mt-4 w-full" disabled={busy || !password}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />}
          {busy ? 'Verifying…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
