import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export type ToastType = 'success' | 'info' | 'warning' | 'error';

export interface Toast {
  id: string;
  title: string;
  message?: string;
  type: ToastType;
}

interface Props {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

export function Toasts({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-6 bottom-6 z-[9999] flex flex-col gap-2.5">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  const dismiss = useCallback(() => onDismiss(toast.id), [toast.id, onDismiss]);

  useEffect(() => {
    const timer = setTimeout(dismiss, 4500);
    return () => clearTimeout(timer);
  }, [dismiss]);

  return (
    <div
      className={`pointer-events-auto flex max-w-[380px] min-w-[280px] animate-toast-in items-start gap-2.5 rounded-[10px] border p-3 backdrop-blur-md ${TYPE_CLASSES[toast.type]}`}
      role="alert"
    >
      <div className="shrink-0 text-base leading-none">{ICONS[toast.type]}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-foreground">
          {toast.title}
        </span>
        {toast.message && (
          <span className="truncate text-xs text-body">{toast.message}</span>
        )}
      </div>
      <button
        type="button"
        className="shrink-0 cursor-pointer border-none bg-transparent px-0.5 text-xs leading-none text-muted hover:text-foreground"
        onClick={dismiss}
        aria-label={t('toasts.dismiss')}
      >
        ✕
      </button>
    </div>
  );
}

const TYPE_CLASSES: Record<ToastType, string> = {
  success: 'border-success/25 bg-success/10',
  info: 'border-primary/25 bg-primary/10',
  warning: 'border-warning/25 bg-warning/10',
  error: 'border-danger/25 bg-danger/10',
};

const ICONS: Record<ToastType, string> = {
  success: '✅',
  info: '💬',
  warning: '⚠️',
  error: '🔴',
};

// ── Hook ──────────────────────────────────────────────────────────────────────

import { useState } from 'react';

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]); // max 5
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, push, dismiss };
}
