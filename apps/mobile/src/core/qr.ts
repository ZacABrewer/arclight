// Pairing QR codes / links: arclight://pair?url=<encoded server base URL>
// (the server's web UI shows this QR in Settings). Scanning it with the system camera opens
// the app through the arclight:// URL scheme; scanning it in the app fills the address.

export const PAIR_SCHEME = 'arclight:';

/**
 * Returns the http(s) server URL carried by a pairing link, or null. Also accepts a plain
 * http(s) URL (someone scanning a QR of the server address itself).
 */
export function parsePairingCode(text: string | null | undefined): string | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  let candidate: string | null = null;
  if (/^arclight:/i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    // arclight://pair?url=... parses as host "pair"; arclight:pair?url=... as pathname "pair".
    const action = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
    if (action !== 'pair') return null;
    candidate = u.searchParams.get('url');
  } else if (/^https?:\/\//i.test(raw)) {
    candidate = raw;
  }
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function buildPairingCode(serverUrl: string): string {
  return `arclight://pair?url=${encodeURIComponent(serverUrl)}`;
}
