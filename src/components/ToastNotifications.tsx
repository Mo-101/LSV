import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle, X } from 'lucide-react';

interface SentinelEvent {
  type: string;
  title: string;
  detail: string;
  level: 'info' | 'success' | 'warning' | 'error';
  timestamp: string;
}

interface ToastItem extends SentinelEvent {
  id: string;
}

const LEVEL_STYLES: Record<SentinelEvent['level'], { border: string; icon: React.ReactNode; text: string }> = {
  info: { border: 'border-indigo-500/50', text: 'text-indigo-300', icon: <Info className="w-4 h-4 text-indigo-400" /> },
  success: { border: 'border-emerald-500/50', text: 'text-emerald-300', icon: <CheckCircle2 className="w-4 h-4 text-emerald-400" /> },
  warning: { border: 'border-amber-500/50', text: 'text-amber-300', icon: <AlertTriangle className="w-4 h-4 text-amber-400" /> },
  error: { border: 'border-red-500/50', text: 'text-red-300', icon: <XCircle className="w-4 h-4 text-red-400" /> },
};

const AUTO_DISMISS_MS = 8000;
const MAX_TOASTS = 5;

export function ToastNotifications() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      const es = new EventSource('/api/events');
      sourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const data: SentinelEvent = JSON.parse(event.data);
          const toast: ToastItem = { ...data, id: `${data.timestamp}-${Math.random().toString(36).slice(2, 8)}` };
          setToasts((prev) => [toast, ...prev].slice(0, MAX_TOASTS));
        } catch {
          // ignore malformed events
        }
      };

      es.onerror = () => {
        es.close();
        reconnectTimer = setTimeout(connect, 5000);
      };
    }

    connect();
    return () => {
      sourceRef.current?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, AUTO_DISMISS_MS)
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  const dismiss = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2rem)] pointer-events-none">
      {toasts.map((toast) => {
        const style = LEVEL_STYLES[toast.level];
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto bg-zinc-900/95 backdrop-blur-md border ${style.border} rounded-xl shadow-lg px-3.5 py-3 flex items-start gap-2.5`}
          >
            <div className="mt-0.5 flex-shrink-0">{style.icon}</div>
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-mono font-bold ${style.text} truncate`}>{toast.title}</div>
              <div className="text-[11px] text-zinc-400 font-mono mt-0.5 leading-snug">{toast.detail}</div>
            </div>
            <button
              onClick={() => dismiss(toast.id)}
              className="flex-shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
