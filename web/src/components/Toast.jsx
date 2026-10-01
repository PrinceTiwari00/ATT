import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, X } from 'lucide-react';

const ToastCtx = createContext(null);

const STYLES = {
  success: { icon: CheckCircle2, cls: 'border-emerald-200 bg-emerald-50 text-emerald-800', iconCls: 'text-emerald-500' },
  error:   { icon: XCircle,      cls: 'border-rose-200 bg-rose-50 text-rose-800',          iconCls: 'text-rose-500' },
  warning: { icon: AlertTriangle, cls: 'border-amber-200 bg-amber-50 text-amber-800',      iconCls: 'text-amber-500' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const push = useCallback((type, message, ms = 3800) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  const value = {
    success: (m) => push('success', m),
    error: (m) => push('error', m, 5200),
    warning: (m) => push('warning', m, 4500),
  };

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => {
          const S = STYLES[t.type] || STYLES.success;
          return (
            <div key={t.id} className={`toast-in flex items-start gap-2.5 rounded-xl border px-3.5 py-3 shadow-lg backdrop-blur ${S.cls}`}>
              <S.icon size={18} className={`mt-0.5 shrink-0 ${S.iconCls}`} />
              <div className="text-sm font-medium leading-snug">{t.message}</div>
              <button
                className="ml-1 opacity-60 hover:opacity-100 cursor-pointer"
                onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
              >
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
