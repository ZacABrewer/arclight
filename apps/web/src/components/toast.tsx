import { createContext, useContext, type ReactNode } from 'react';
import { ToastViewport } from '../arclight/index.js';
import { toasts as defaultStore, type ToastStore } from '../lib/toast.js';

const ToastContext = createContext<ToastStore>(defaultStore);

/** Provides the toast store and renders the Arclight toast stack (bottom-right, max 3). */
export function ToastProvider({ store = defaultStore, children }: { store?: ToastStore; children: ReactNode }) {
  return (
    <ToastContext.Provider value={store}>
      {children}
      <ToastViewport store={store} />
    </ToastContext.Provider>
  );
}

/** `const toast = useToast(); toast.error('Save failed', err.message)` */
export function useToast(): ToastStore {
  return useContext(ToastContext);
}
