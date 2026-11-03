// Pairing links / QR codes. The web player shows
//   arclight://pair?server=<encoded server base URL>&code=<pair code>
// Scanning it with the system camera opens the app (arclight:// URL scheme); scanning it in the
// app does the same. Older links carry only the server (`?url=`), and a plain http(s) address
// (a QR of the server address itself) is accepted too: those fill the address, then sign in.

export interface PairingLink {
  /** Server base URL (http/https, no trailing slash). */
  server: string;
  /** Pair code ("ABCDEFGH"), when the link carries one. */
  code: string | null;
}

/** Upper-case, no spaces or dashes ("abcd-efgh" → "ABCDEFGH"); the server's rule. */
export function normalisePairCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}

/** Pair codes are 8 characters without look-alikes (no 0/O, 1/I/L). */
export const PAIR_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

function cleanServer(candidate: string | null): string | null {
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

export function parsePairingLink(text: string | null | undefined): PairingLink | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  if (/^arclight:/i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    // arclight://pair?… parses with host "pair"; arclight:pair?… with pathname "pair".
    const action = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
    if (action !== 'pair') return null;
    const server = cleanServer(u.searchParams.get('server') ?? u.searchParams.get('url'));
    if (!server) return null;
    const rawCode = u.searchParams.get('code');
    const code = rawCode ? normalisePairCode(rawCode) : null;
    return { server, code: code && PAIR_CODE_PATTERN.test(code) ? code : null };
  }
  if (/^https?:\/\//i.test(raw)) {
    const server = cleanServer(raw);
    return server ? { server, code: null } : null;
  }
  return null;
}
