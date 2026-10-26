import { useSyncExternalStore } from 'react';
import type { ConnectionState } from '../api/events.js';

export interface ConnectionSnapshot {
  state: ConnectionState;
  attempt: number;
  retryInMs: number | null;
  /** ISO time of the last successful open, if any. */
  connectedAt: string | null;
}

// Module-level store for the WebSocket feed status: written by the live layer, read by the
// top bar indicator (and anything else that wants to know whether data is live).
let snapshot: ConnectionSnapshot = { state: 'connecting', attempt: 0, retryInMs: null, connectedAt: null };
const listeners = new Set<() => void>();

export const connectionStore = {
  get: () => snapshot,
  set(state: ConnectionState, info: { attempt: number; retryInMs: number | null }) {
    snapshot = {
      state,
      attempt: info.attempt,
      retryInMs: info.retryInMs,
      connectedAt: state === 'open' ? new Date().toISOString() : snapshot.connectedAt,
    };
    for (const l of listeners) l();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useConnection(): ConnectionSnapshot {
  return useSyncExternalStore(connectionStore.subscribe, connectionStore.get, connectionStore.get);
}
