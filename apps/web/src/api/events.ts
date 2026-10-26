import { ServerEvent } from '@arclight/shared';
import { API_BASE } from './client.js';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

export interface EventStreamHandlers {
  onEvent: (event: ServerEvent) => void;
  onState?: (state: ConnectionState, info: { attempt: number; retryInMs: number | null }) => void;
  /** Fired on every successful open; `reconnected` is true after the first. */
  onOpen?: (info: { reconnected: boolean }) => void;
}

const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** Exponential backoff with a little jitter: ~1s, 2s, 4s ... capped at 30s. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.85 + random() * 0.3));
}

export function eventsUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${loc.host}${API_BASE}/events`;
}

/**
 * Opens the /api/v1/events WebSocket and keeps it open: reconnects with backoff on close and
 * resets the backoff after a successful open. Returns a disposer.
 */
export function connectEvents(handlers: EventStreamHandlers): () => void {
  let socket: WebSocket | null = null;
  let disposed = false;
  let attempt = 0;
  let everOpened = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    handlers.onState?.(attempt === 0 ? 'connecting' : 'reconnecting', { attempt, retryInMs: null });
    socket = new WebSocket(eventsUrl());
    socket.onopen = () => {
      attempt = 0;
      handlers.onState?.('open', { attempt, retryInMs: null });
      handlers.onOpen?.({ reconnected: everOpened });
      everOpened = true;
    };
    socket.onmessage = (msg) => {
      let data: unknown;
      try {
        data = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      const parsed = ServerEvent.safeParse(data);
      if (parsed.success) handlers.onEvent(parsed.data);
    };
    socket.onclose = () => {
      if (disposed) return;
      attempt += 1;
      const delay = backoffDelay(attempt);
      handlers.onState?.('reconnecting', { attempt, retryInMs: delay });
      timer = setTimeout(open, delay);
    };
  };
  open();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
