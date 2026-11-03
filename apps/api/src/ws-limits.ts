import type { RequestAuth } from './modules/auth/service.js';

/** The parts of a ws socket these helpers use (the ws types are not a direct dependency). */
export interface LimitedSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  once(event: 'close' | 'error', listener: () => void): unknown;
}

// WebSocket limits (DATA-36). Every live feed in the API only sends; a client that stops
// reading would otherwise make the server buffer without end, and a client opening sockets in
// a loop would hold a bus subscription per socket.

/** Largest frame a client may send (the feeds expect none beyond pings). */
export const WS_MAX_PAYLOAD = 64 * 1024;
/** A socket whose unsent backlog passes this is closed as a slow consumer. */
export const WS_MAX_BUFFERED = 1024 * 1024;
/** Open sockets per signed-in user (or per credential for API keys). */
export const WS_MAX_PER_OWNER = 10;

/** Send unless the client has fallen too far behind; then close it (it may reconnect). */
export function sendBounded(socket: LimitedSocket, data: string): void {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > WS_MAX_BUFFERED) {
    socket.close(1013, 'too far behind');
    return;
  }
  socket.send(data);
}

const open = new Map<string, number>();

function ownerKey(auth: RequestAuth | undefined | null): string {
  if (auth?.user) return `user:${auth.user.id}`;
  return `via:${auth?.via ?? 'none'}`;
}

/**
 * Count a socket against its owner. Returns false (after closing the socket) when the owner
 * already has the maximum open; the slot is released when the socket closes.
 */
export function admitSocket(socket: LimitedSocket, auth: RequestAuth | undefined | null, max = WS_MAX_PER_OWNER): boolean {
  const key = ownerKey(auth);
  const n = open.get(key) ?? 0;
  if (n >= max) {
    socket.close(1013, 'too many open connections');
    return false;
  }
  open.set(key, n + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (open.get(key) ?? 1) - 1;
    if (left <= 0) open.delete(key);
    else open.set(key, left);
  };
  socket.once('close', release);
  socket.once('error', release);
  return true;
}
