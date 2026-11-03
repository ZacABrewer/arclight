import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LinkCheck } from '../links.js';

// Signed HLS links: the master and media playlists, init and media segments, and the health
// route of one session carry `u=[&p=]&exp=&sig=` with an HMAC over `vhls:<user>[:<profile>]:<session>:<exp>`
// (the stream-link key). Another session id, file link or artwork link never verifies here.

export interface HlsLink {
  userId: number;
  profileId?: number | null;
  sessionId: string;
  exp: number;
}

function mac(key: Buffer, link: HlsLink): string {
  const p = link.profileId ?? null;
  const text = p === null ? `vhls:${link.userId}:${link.sessionId}:${link.exp}` : `vhls:${link.userId}:${p}:${link.sessionId}:${link.exp}`;
  return createHmac('sha256', key).update(text).digest('base64url');
}

export function hlsLinkQuery(key: Buffer, link: HlsLink): string {
  const p = link.profileId === null || link.profileId === undefined ? '' : `&p=${link.profileId}`;
  return `u=${link.userId}${p}&exp=${link.exp}&sig=${mac(key, link)}`;
}

export function verifyHlsLink(key: Buffer, sessionId: string, query: { u?: unknown; p?: unknown; exp?: unknown; sig?: unknown }, nowMs: number): LinkCheck {
  const userId = Number(query.u);
  const exp = Number(query.exp);
  const rawP = query.p;
  const profileId = rawP === undefined || rawP === null || rawP === '' ? null : Number.isInteger(Number(rawP)) && Number(rawP) > 0 ? Number(rawP) : undefined;
  const sig = typeof query.sig === 'string' ? query.sig : '';
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(exp) || exp <= 0 || profileId === undefined || !/^[A-Za-z0-9_-]{43}$/.test(sig) || !/^[0-9a-f]{32}$/.test(sessionId)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const expected = Buffer.from(mac(key, { userId, profileId, sessionId, exp }));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (exp * 1000 <= nowMs) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, userId, profileId };
}
