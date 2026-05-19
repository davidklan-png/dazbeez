"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "info" | "success" | "warn" | "error";

export type Toast = {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  /** Milliseconds before auto-dismiss. 0 = persistent. */
  ttl?: number;
};

type ToastInput = Omit<Toast, "id"> & { id?: string };

type ToasterContextValue = {
  toast: (t: ToastInput) => string;
  dismiss: (id: string) => void;
};

const ToasterContext = createContext<ToasterContextValue | null>(null);

const TONE_CLASSES: Record<
  ToastTone,
  { bar: string; iconBg: string; icon: ReactNode }
> = {
  info: {
    bar: "border-l-blue-400",
    iconBg: "bg-blue-100 text-blue-700",
    icon: "i",
  },
  success: {
    bar: "border-l-green-500",
    iconBg: "bg-green-100 text-green-700",
    icon: "✓",
  },
  warn: {
    bar: "border-l-amber-500",
    iconBg: "bg-amber-100 text-amber-700",
    icon: "!",
  },
  error: {
    bar: "border-l-red-500",
    iconBg: "bg-red-100 text-red-700",
    icon: "✕",
  },
};

export function ToasterProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id =
        input.id ??
        (typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const next: Toast = {
        id,
        tone: input.tone,
        title: input.title,
        body: input.body,
        ttl: input.ttl ?? (input.tone === "error" ? 6000 : 3500),
      };
      setToasts((list) => [...list.filter((t) => t.id !== id), next]);
      if (next.ttl && next.ttl > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), next.ttl),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const handle of t.values()) clearTimeout(handle);
      t.clear();
    };
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToasterContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((t) => {
          const tone = TONE_CLASSES[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === "error" ? "alert" : "status"}
              className={`pointer-events-auto flex items-start gap-3 rounded-xl border border-gray-200 border-l-4 bg-white p-3 shadow-lg ${tone.bar}`}
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full text-sm font-bold ${tone.iconBg}`}
              >
                {tone.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-gray-900">
                  {t.title}
                </div>
                {t.body ? (
                  <div className="mt-0.5 text-[12px] text-gray-600">{t.body}</div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="text-gray-400 transition-colors hover:text-gray-700"
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </ToasterContext.Provider>
  );
}

/**
 * Push toasts from any client component. Safe to call from a component that
 * is mounted outside the provider — falls back to a no-op so legacy pages
 * that haven't adopted the toaster don't throw.
 */
export function useToast(): ToasterContextValue {
  const ctx = useContext(ToasterContext);
  if (ctx) return ctx;
  return {
    toast: () => "",
    dismiss: () => {},
  };
}
