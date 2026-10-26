import {
  ContentRestrictions,
  MOVIE_CERTIFICATIONS,
  TV_CERTIFICATIONS,
  type MediaType,
  type MovieCertification,
  type TvCertification,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { RequestsError } from './errors.js';
import type { Actor } from './permissions.js';
import type { TitleSource } from './service.js';
import { findUserRow } from './users.js';

// Kids / certification caps (users.settings.contentRestrictions). Certifications come from
// TMDB through the metadata client (region rating, else US) and are cached per title.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

/** Visitors of the public portal: no caps, adult content hidden. */
export const ANONYMOUS_RESTRICTIONS: ContentRestrictions = { maxCertification: { movie: null, tv: null }, hideAdultContent: true };

/** A rating as a movie certification; unknown or foreign values count as NR (unrated). */
export function movieRating(raw: string | null | undefined): MovieCertification {
  const c = (raw ?? '').trim().toUpperCase();
  return (MOVIE_CERTIFICATIONS as readonly string[]).includes(c) ? (c as MovieCertification) : 'NR';
}

/** A rating as a TV guideline, or null when unrated / not a US guideline. */
export function tvRating(raw: string | null | undefined): TvCertification | null {
  const c = (raw ?? '').trim().toUpperCase();
  return (TV_CERTIFICATIONS as readonly string[]).includes(c) ? (c as TvCertification) : null;
}

/** Why `rating` is not allowed under `r`, or null when it is. */
export function restrictionReason(r: ContentRestrictions, type: MediaType, rating: string | null): string | null {
  if (type === 'movie') {
    const cert = movieRating(rating);
    if (r.hideAdultContent && cert === 'NC-17') return 'adult content is hidden for this account';
    const cap = r.maxCertification.movie;
    if (cap && MOVIE_CERTIFICATIONS.indexOf(cert) > MOVIE_CERTIFICATIONS.indexOf(cap)) {
      return cert === 'NR' ? `unrated titles are above this account's limit (${cap})` : `rated ${cert}, above this account's limit (${cap})`;
    }
    return null;
  }
  const cert = tvRating(rating);
  if (r.hideAdultContent && cert === 'TV-MA') return 'adult content is hidden for this account';
  const cap = r.maxCertification.tv;
  if (cap) {
    if (cert === null) return `unrated series are above this account's limit (${cap})`;
    if (TV_CERTIFICATIONS.indexOf(cert) > TV_CERTIFICATIONS.indexOf(cap)) return `rated ${cert}, above this account's limit (${cap})`;
  }
  return null;
}

export function isUnrestricted(r: ContentRestrictions): boolean {
  return !r.hideAdultContent && r.maxCertification.movie === null && r.maxCertification.tv === null;
}

/** A user's stored restrictions (defaults: none). */
export function restrictionsOfSettings(settings: unknown): ContentRestrictions {
  const raw = ((settings ?? {}) as Record<string, unknown>)['contentRestrictions'];
  const parsed = ContentRestrictions.safeParse(raw ?? {});
  return parsed.success ? parsed.data : ContentRestrictions.parse({});
}

export interface CertificationGuardOptions {
  db: Db;
  titles: TitleSource;
  now?: () => Date;
  ttlMs?: number;
}

/** Looks up (and caches) certifications and applies an actor's caps. */
export class CertificationGuard {
  private readonly db: Db;
  private readonly titles: TitleSource;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { rating: string | null; at: number }>();

  constructor(opts: CertificationGuardOptions) {
    this.db = opts.db;
    this.titles = opts.titles;
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? DAY_MS;
  }

  /** The caps that apply to `actor`: the stored ones, the portal's for anonymous visitors, none for system callers. */
  restrictionsFor(actor: Actor): ContentRestrictions | null {
    if (actor.anonymous) return ANONYMOUS_RESTRICTIONS;
    if (actor.userId === null) return null;
    return this.restrictionsForUser(actor.userId);
  }

  restrictionsForUser(userId: number): ContentRestrictions | null {
    const row = findUserRow(this.db, userId);
    if (!row) return null;
    const r = restrictionsOfSettings(row.settings);
    return isUnrestricted(r) ? null : r;
  }

  /** TMDB certification of a title (null: none or lookup failed; failures are cached briefly). */
  async rating(type: MediaType, tmdbId: number): Promise<string | null> {
    const key = `${type}:${tmdbId}`;
    const now = this.now().getTime();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.rating;
    let rating: string | null = null;
    let ok = true;
    try {
      const client = this.titles.client();
      const meta = type === 'movie' ? await client.getMovie(tmdbId) : await client.getSeries(tmdbId);
      rating = meta.certification?.trim() || null;
    } catch {
      ok = false;
    }
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    // A failed lookup is retried after a minute instead of a day.
    this.cache.set(key, { rating, at: ok ? now : now - this.ttlMs + 60_000 });
    return rating;
  }

  /** Throws FORBIDDEN when the actor may not see or request the title. */
  async assertAllowed(actor: Actor, type: MediaType, tmdbId: number): Promise<void> {
    const r = this.restrictionsFor(actor);
    if (r) await this.assertAllowedUnder(r, type, tmdbId);
  }

  async assertAllowedUnder(r: ContentRestrictions, type: MediaType, tmdbId: number): Promise<void> {
    const reason = restrictionReason(r, type, await this.rating(type, tmdbId));
    if (reason) throw RequestsError.forbidden(`this title is not available: ${reason}`);
  }

  /** Drops the items the actor may not see (discover lists). */
  async filter<T extends { mediaType: MediaType; tmdbId: number }>(actor: Actor, items: readonly T[]): Promise<T[]> {
    const r = this.restrictionsFor(actor);
    if (!r) return [...items];
    const ratings = await Promise.all(items.map((i) => this.rating(i.mediaType, i.tmdbId)));
    return items.filter((item, i) => restrictionReason(r, item.mediaType, ratings[i] ?? null) === null);
  }
}
