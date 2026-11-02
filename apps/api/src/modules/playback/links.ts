import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed stream links for clients that cannot send the session cookie (cast receivers, native
// players, download managers). A link names the user, the file and an expiry, and carries an
// HMAC-SHA256 over the three with a key derived from the install's API key: regenerating the API
// key ends every link. The stream route also re-checks the user's access on every request, and
// ending all of a user's sessions ends their links (streamLinkUsable).

export interface SignedLink {
  userId: number;
  fileId: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/** The signing key; derived so the API key itself never signs anything. */
export function linkKey(apiKey: string): Buffer {
  return createHmac('sha256', apiKey).update('arclight stream links v1').digest();
}

function mac(key: Buffer, link: SignedLink): string {
  return createHmac('sha256', key).update(`audio:${link.userId}:${link.fileId}:${link.exp}`).digest('base64url');
}

export function signLink(key: Buffer, link: SignedLink): string {
  return mac(key, link);
}

/** The query string for a link (`u=&exp=&sig=`). */
export function linkQuery(key: Buffer, link: SignedLink): string {
  return `u=${link.userId}&exp=${link.exp}&sig=${signLink(key, link)}`;
}

export type LinkCheck = { ok: true; userId: number } | { ok: false; reason: 'MALFORMED' | 'EXPIRED' | 'BAD_SIGNATURE' };

/** Checks a link's query for `fileId` at `nowMs`. Signature first, then expiry. */
export function verifyLink(key: Buffer, fileId: number, query: { u?: unknown; exp?: unknown; sig?: unknown }, nowMs: number): LinkCheck {
  const userId = Number(query.u);
  const exp = Number(query.exp);
  const sig = typeof query.sig === 'string' ? query.sig : '';
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(exp) || exp <= 0 || !/^[A-Za-z0-9_-]{43}$/.test(sig)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const expected = Buffer.from(mac(key, { userId, fileId, exp }));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (exp * 1000 <= nowMs) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, userId };
}

/** True when the request carries signed-link parameters (the route then answers without a cookie). */
export function hasLinkParams(query: unknown): boolean {
  const q = (query ?? {}) as Record<string, unknown>;
  return typeof q['sig'] === 'string' && q['u'] !== undefined && q['exp'] !== undefined;
}
