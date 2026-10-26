export type ToastTone = 'info' | 'ok' | 'warning' | 'error';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string | undefined;
}

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  message?: string | undefined;
  /** ms before auto-dismiss; 0 keeps it until closed. */
  durationMs?: number;
}

export interface ToastStore {
  list(): readonly Toast[];
  push(input: ToastInput): number;
  error(title: string, message?: string): number;
  dismiss(id: number): void;
  subscribe(listener: () => void): () => void;
}

const DEFAULT_DURATION_MS = 6_000;
const MAX_TOASTS = 5;

/**
 * A tiny external store so non-React code (the QueryClient's MutationCache) can raise toasts.
 * React reads it through ToastProvider / useToast.
 */
export function createToastStore(): ToastStore {
  let toasts: readonly Toast[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };

  const store: ToastStore = {
    list: () => toasts,
    push({ tone = 'info', title, message, durationMs = DEFAULT_DURATION_MS }) {
      const id = nextId++;
      toasts = [...toasts, { id, tone, title, message }].slice(-MAX_TOASTS);
      emit();
      if (durationMs > 0) setTimeout(() => store.dismiss(id), durationMs);
      return id;
    },
    error: (title, message) => store.push({ tone: 'error', title, message, durationMs: 10_000 }),
    dismiss(id) {
      const next = toasts.filter((t) => t.id !== id);
      if (next.length !== toasts.length) {
        toasts = next;
        emit();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}

/** The app-wide store. Tests create their own with createToastStore(). */
export const toasts = createToastStore();
