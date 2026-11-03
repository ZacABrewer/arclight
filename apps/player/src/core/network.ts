import { Network, type ConnectionStatus } from '@capacitor/network';

// Online / offline and metered or not. Offline, the app shows downloads only and queues progress;
// on cellular it streams at the cellular quality.

export interface NetState {
  online: boolean;
  /** Cellular (assume metered). */
  cellular: boolean;
}

type Listener = (s: NetState) => void;

let state: NetState = { online: typeof navigator === 'undefined' ? true : navigator.onLine !== false, cellular: false };
const listeners = new Set<Listener>();
let started = false;

function fromStatus(s: ConnectionStatus): NetState {
  return { online: s.connected, cellular: s.connectionType === 'cellular' };
}

function set(next: NetState): void {
  if (next.online === state.online && next.cellular === state.cellular) return;
  state = next;
  for (const l of [...listeners]) l(state);
}

/** Starts watching (idempotent). */
export async function startNetworkWatch(): Promise<void> {
  if (started) return;
  started = true;
  try {
    set(fromStatus(await Network.getStatus()));
    await Network.addListener('networkStatusChange', (s) => set(fromStatus(s)));
  } catch {
    // Browser without the plugin: navigator.onLine.
    window.addEventListener('online', () => set({ ...state, online: true }));
    window.addEventListener('offline', () => set({ ...state, online: false }));
  }
}

export function netState(): NetState {
  return state;
}

export function onNetChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests. */
export function setNetStateForTests(next: NetState): void {
  set(next);
}
