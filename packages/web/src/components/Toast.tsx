import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type ToastKind = 'success' | 'info' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(() => {
  console.error('[toast] useToast used outside ToastProvider');
});

const TOAST_MS = 6000;

/** Success/info toasts use a polite status region, errors an alert region; all auto-dismiss after 6 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  const show = useCallback((text: string, kind: ToastKind = 'success') => {
    const id = nextId.current++;
    setToasts((ts) => [...ts, { id, kind, text }]);
    timers.current.push(
      window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), TOAST_MS),
    );
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts">
        <div className="toasts__group" role="status" aria-live="polite">
          {toasts
            .filter((t) => t.kind !== 'error')
            .map((t) => (
              <div key={t.id} className={`toast toast--${t.kind}`}>
                {t.text}
              </div>
            ))}
        </div>
        <div className="toasts__group" role="alert">
          {toasts
            .filter((t) => t.kind === 'error')
            .map((t) => (
              <div key={t.id} className="toast toast--error">
                {t.text}
              </div>
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, kind?: ToastKind) => void {
  return useContext(ToastContext);
}
