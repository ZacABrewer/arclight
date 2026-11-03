import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed stream links for clients that cannot send the session cookie (cast receivers, native
// players, download managers). A link names the user, the household profile (optional; absent
// means the owner profile, which is how links made before profiles read), the file and an expiry,
// and carries an HMAC-SHA256 over them with a key derived from the install's API key: regenerating the API
// key ends every link. The stream route also re-checks the user's access on every request, and
// ending all of a user's sessions ends their links (streamLinkUsable).

export interface SignedLink {
  userId: number;
  /** The household profile the link plays as; null/absent: the owner profile (no `p=` in the link). */
  profileId?: number | null;
  fileId: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/** The signing key; derived so the API key itself never signs anything. */
export function linkKey(apiKey: string): Buffer {
  return createHmac('sha256', apiKey).update('arclight stream links v1').digest();
}

/**
 * Audio files sign as `audio:`, video files (media_files ids) as `video:`, scrub-thumbnail sheets
 * of a video file as `trickplay:`: one never opens another.
 */
export type LinkDomain = 'audio' | 'video' | 'trickplay';

/** `profileId` present: it is part of the MAC, so a link cannot be moved to another profile. */
function mac(key: Buffer, link: SignedLink, domain: LinkDomain = 'audio'): string {
  const p = link.profileId ?? null;
  const text = p === null ? `${domain}:${link.userId}:${link.fileId}:${link.exp}` : `${domain}:${link.userId}:${p}:${link.fileId}:${link.exp}`;
  return createHmac('sha256', key).update(text).digest('base64url');
}

function profileParam(profileId: number | null | undefined): string {
  return profileId === null || profileId === undefined ? '' : `&p=${profileId}`;
}

/** `p` absent: null (owner). Present: a positive integer, else undefined (malformed). */
function parseProfile(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function signLink(key: Buffer, link: SignedLink, domain: LinkDomain = 'audio'): string {
  return mac(key, link, domain);
}

/** The query string for a link (`u=[&p=]&exp=&sig=`). */
export function linkQuery(key: Buffer, link: SignedLink, domain: LinkDomain = 'audio'): string {
  return `u=${link.userId}${profileParam(link.profileId)}&exp=${link.exp}&sig=${signLink(key, link, domain)}`;
}

/** `profileId` null: the link names no profile (the owner's). */
export type LinkCheck = { ok: true; userId: number; profileId: number | null } | { ok: false; reason: 'MALFORMED' | 'EXPIRED' | 'BAD_SIGNATURE' };

type LinkParams = { u?: unknown; p?: unknown; exp?: unknown; sig?: unknown };

/** Checks a link's query for `fileId` at `nowMs`. Signature first, then expiry. */
export function verifyLink(key: Buffer, fileId: number, query: LinkParams, nowMs: number, domain: LinkDomain = 'audio'): LinkCheck {
  const userId = Number(query.u);
  const exp = Number(query.exp);
  const profileId = parseProfile(query.p);
  const sig = typeof query.sig === 'string' ? query.sig : '';
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(exp) || exp <= 0 || profileId === undefined || !/^[A-Za-z0-9_-]{43}$/.test(sig)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const expected = Buffer.from(mac(key, { userId, profileId, fileId, exp }, domain));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (exp * 1000 <= nowMs) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, userId, profileId };
}

/** True when the request carries signed-link parameters (the route then answers without a cookie). */
export function hasLinkParams(query: unknown): boolean {
  const q = (query ?? {}) as Record<string, unknown>;
  return typeof q['sig'] === 'string' && q['u'] !== undefined && q['exp'] !== undefined;
}

// Artwork links: one signature per user and expiry opens every artwork URL (image loaders such as
// <img> in the Arclight app cannot send a Bearer header). A different MAC domain from streams, so
// neither kind of signature works as the other.

export interface ArtworkLink {
  userId: number;
  /** As for SignedLink: null/absent is the owner profile. */
  profileId?: number | null;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

function artworkMac(key: Buffer, link: ArtworkLink): string {
  const p = link.profileId ?? null;
  const text = p === null ? `art:${link.userId}:${link.exp}` : `art:${link.userId}:${p}:${link.exp}`;
  return createHmac('sha256', key).update(text).digest('base64url');
}

/** The query string that opens artwork URLs (`u=[&p=]&exp=&sig=`). */
export function artworkLinkQuery(key: Buffer, link: ArtworkLink): string {
  return `u=${link.userId}${profileParam(link.profileId)}&exp=${link.exp}&sig=${artworkMac(key, link)}`;
}

/** Checks an artwork link's query at `nowMs`. */
export function verifyArtworkLink(key: Buffer, query: LinkParams, nowMs: number): LinkCheck {
  const userId = Number(query.u);
  const exp = Number(query.exp);
  const profileId = parseProfile(query.p);
  const sig = typeof query.sig === 'string' ? query.sig : '';
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(exp) || exp <= 0 || profileId === undefined || !/^[A-Za-z0-9_-]{43}$/.test(sig)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const expected = Buffer.from(artworkMac(key, { userId, profileId, exp }));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (exp * 1000 <= nowMs) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, userId, profileId };
}
