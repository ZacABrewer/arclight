import { useSyncExternalStore, type ReactNode } from 'react';
import { TOAST_LIMIT } from '../tokens.js';

/** Arclight toast tones. The app's existing store tones map onto them (see toToastTone). */
export type ToastTone = 'default' | 'warn' | 'danger';

export interface ToastData {
  id: string | number;
  title: ReactNode;
  /** Second line: the object and the fact ("WEB-DL 2160p · 6.0 GB", "Nyaa · retrying at 20:55"). */
  description?: ReactNode | undefined;
  tone?: ToastTone | string | undefined;
  /** One short verb ("View", "Details", "Fix"). */
  action?: { label: string; onClick: () => void } | undefined;
}

/**
 * Accepts both Arclight tones and the existing store's tones (info / ok / warning / error),
 * so the current `lib/toast` store can feed the new stack unchanged.
 */
export function toToastTone(tone: string | undefined): ToastTone {
  switch (tone) {
    case 'warn':
    case 'warning':
      return 'warn';
    case 'danger':
    case 'error':
      return 'danger';
    default:
      return 'default';
  }
}

/** The newest `limit` toasts, oldest first (the visible stack). */
export function visibleToasts<T>(list: readonly T[], limit = TOAST_LIMIT): T[] {
  return list.slice(-limit);
}

export interface ToastProps {
  toast: ToastData;
  onDismiss?: ((id: ToastData['id']) => void) | undefined;
}

/** `.al-toast` — 2px left bar in the tone colour, square dot, title + description, action. */
export function Toast({ toast, onDismiss }: ToastProps) {
  const tone = toToastTone(typeof toast.tone === 'string' ? toast.tone : undefined);
  return (
    <div className="al-toast" data-tone={tone === 'default' ? undefined : tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="al-toast__dot" aria-hidden="true" />
      <div className="al-toast__text">
        <div className="al-toast__title">{toast.title}</div>
        {toast.description ? <div className="al-toast__desc">{toast.description}</div> : null}
      </div>
      {toast.action ? (
        <button type="button" className="al-toast__action" onClick={toast.action.onClick}>
          {toast.action.label}
        </button>
      ) : null}
      {onDismiss ? (
        <button type="button" className="al-toast__close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
          ✕
        </button>
      ) : null}
    </div>
  );
}

export interface ToastStackProps {
  toasts: readonly ToastData[];
  onDismiss?: ((id: ToastData['id']) => void) | undefined;
  /** Max visible (kit: 3). Older toasts wait off-screen until newer ones go. */
  limit?: number | undefined;
  /** Render in flow instead of fixed bottom-right (gallery). */
  inline?: boolean | undefined;
}

/** Bottom-right toast stack, max 3 visible. */
export function ToastStack({ toasts, onDismiss, limit = TOAST_LIMIT, inline }: ToastStackProps) {
  const shown = visibleToasts(toasts, limit);
  return (
    <div
      className={inline ? undefined : 'al-toast-stack'}
      style={inline ? { display: 'flex', flexDirection: 'column', gap: 10 } : undefined}
      aria-live="polite"
      aria-relevant="additions"
    >
      {shown.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/** Shape of the app's existing toast store (`lib/toast.ts`), duplicated to avoid a cross-folder import. */
export interface ToastStoreLike {
  list(): ReadonlyArray<{ id: number; tone: string; title: string; message?: string | undefined }>;
  dismiss(id: number): void;
  subscribe(listener: () => void): () => void;
}

/** Renders the existing toast store through the Arclight stack (drop-in for ToastViewport). */
export function ToastViewport({ store }: { store: ToastStoreLike }) {
  const list = useSyncExternalStore(store.subscribe, store.list, store.list);
  const toasts: ToastData[] = list.map((t) => ({ id: t.id, tone: t.tone, title: t.title, description: t.message }));
  return <ToastStack toasts={toasts} onDismiss={(id) => store.dismiss(Number(id))} />;
}
