// The server and device token every request goes to. One active session at a time; switching
// accounts (core/accounts.ts) swaps it. Kept outside React so the API client, the player engine
// and the offline queue all read the same value.

export interface Session {
  /** Account id in the account list (core/accounts.ts). */
  accountId: string;
  /** Server base URL, no trailing slash ("https://music.example.com" or "http://192.168.1.20:7878"). */
  serverUrl: string;
  /** Device token (`alt_…`), sent as `Authorization: Bearer`. */
  token: string;
  /** Server-side device id (from sign-in). */
  deviceId: number | null;
}

type Listener = (session: Session | null) => void;

let current: Session | null = null;
const listeners = new Set<Listener>();

export function getSession(): Session | null {
  return current;
}

export function setSession(next: Session | null): void {
  current = next;
  for (const l of [...listeners]) l(next);
}

export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** "https://host:8443/arclight" → "https://host:8443" (artwork and stream paths already carry the base path). */
export function originOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl.replace(/\/+$/, '');
  }
}

/** A server-relative URL ("/api/v1/...") made absolute against the session's server. Absolute URLs pass through. */
export function absoluteUrl(url: string, serverUrl: string | undefined = current?.serverUrl): string {
  if (!serverUrl || !url.startsWith('/') || url.startsWith('//')) return url;
  return `${originOf(serverUrl)}${url}`;
}
