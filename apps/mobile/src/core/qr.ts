// Pairing QR codes / links: arclight-admin://pair?url=<encoded server base URL>
// (the server's web UI shows this QR in Settings). Scanning it with the system camera opens
// the app through the arclight-admin:// URL scheme; scanning it in the app fills the address.
// The older arclight://pair form (servers before the app became "Arclight Admin") is still
// read when scanned in the app; the arclight:// scheme itself now belongs to the player app.

export const PAIR_SCHEME = 'arclight-admin:';

/**
 * Returns the http(s) server URL carried by a pairing link, or null. Also accepts a plain
 * http(s) URL (someone scanning a QR of the server address itself).
 */
export function parsePairingCode(text: string | null | undefined): string | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  let candidate: string | null = null;
  if (/^arclight(-admin)?:/i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    // arclight-admin://pair?url=... parses as host "pair"; arclight-admin:pair?url=... as pathname "pair".
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
  return `arclight-admin://pair?url=${encodeURIComponent(serverUrl)}`;
}
