import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { toasts as defaultStore, type ToastStore } from '../lib/toast.js';

const ToastContext = createContext<ToastStore>(defaultStore);

/** Provides the toast store and renders the toast stack. */
export function ToastProvider({ store = defaultStore, children }: { store?: ToastStore; children: ReactNode }) {
  return (
    <ToastContext.Provider value={store}>
      {children}
      <ToastViewport />
    </ToastContext.Provider>
  );
}

/** `const toast = useToast(); toast.error('Save failed', err.message)` */
export function useToast(): ToastStore {
  return useContext(ToastContext);
}

function ToastViewport() {
  const store = useToast();
  const list = useSyncExternalStore(store.subscribe, store.list, store.list);
  return (
    <div className="toast-viewport" aria-live="polite" aria-relevant="additions">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          <div className="toast-text">
            <strong className="toast-title">{t.title}</strong>
            {t.message ? <span className="toast-message">{t.message}</span> : null}
          </div>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => store.dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
