// ListenBrainz client for the two keyless, read-only endpoints behind music Discover:
//
//   GET /1/explore/fresh-releases          recent releases (MusicBrainz release-group ids)
//   GET /1/stats/sitewide/release-groups   the most listened release groups of a period
//
// Both answer release-group MBIDs, names, artist names/MBIDs and usually a Cover Art Archive
// image id, so a Discover page needs no per-item MusicBrainz call. The sitewide statistics
// answer 204 No Content while they are being recomputed; that reads as an empty list.

import type { FetchLike } from '../tmdb/client.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import { isMetadataError } from '../types.js';
import {
  lbFreshReleasesResponseSchema,
  lbTopReleaseGroupsResponseSchema,
  type LbFreshReleaseWire,
  type LbTopReleaseGroupWire,
} from './schemas.js';

export const LISTENBRAINZ_DEFAULT_BASE_URL = 'https://api.listenbrainz.org/';
export const LISTENBRAINZ_PROVIDER = 'listenbrainz';

const HOUR = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListenBrainzClientOptions {
  /** `App/version ( contact )`, like MusicBrainz. */
  userAgent: string;
  baseUrl?: string;
  /** Requests per second. Defaults to 1. */
  requestsPerSecond?: number;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  /** In-memory cache of both endpoints. Defaults to 1 hour. */
  cacheTtlMs?: number;
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

/** A release group as ListenBrainz lists it. */
export interface LbReleaseGroup {
  releaseGroupMbid: string;
  title: string;
  artistName?: string;
  /** Credited artists, first = primary. */
  artistMbids: string[];
  /** "Album", "EP", "Single"... (fresh releases only). */
  primaryType?: string;
  secondaryType?: string;
  /** `YYYY-MM-DD` (fresh releases only). */
  releaseDate?: string;
  /** Cover Art Archive image id and the release it belongs to, when known. */
  caaId?: number;
  caaReleaseMbid?: string;
  listenCount?: number;
}

export interface LbFreshReleasesQuery {
  /** Look-back window, 1–90 days. Defaults to 14. */
  days?: number;
  /** Defaults to release_date. */
  sort?: 'release_date' | 'artist_credit_name' | 'release_name';
  /** Include releases dated in the future. Defaults to false. */
  future?: boolean;
}

export interface LbSitewideQuery {
  /** Defaults to week. */
  range?: 'this_week' | 'this_month' | 'this_year' | 'week' | 'month' | 'year' | 'all_time';
  /** 1–100. Defaults to 25. */
  count?: number;
}

export interface ListenBrainzClient {
  readonly providerKey: string;
  freshReleases(query?: LbFreshReleasesQuery, options?: RequestOptions): Promise<LbReleaseGroup[]>;
  sitewideReleaseGroups(query?: LbSitewideQuery, options?: RequestOptions): Promise<LbReleaseGroup[]>;
  clearCache(): void;
}

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function mbids(values: readonly string[] | null | undefined): string[] {
  return (values ?? []).filter((v) => MBID_RE.test(v)).map((v) => v.toLowerCase());
}

function common(wire: LbFreshReleaseWire | LbTopReleaseGroupWire) {
  const caaRelease = text(wire.caa_release_mbid);
  return {
    artistMbids: mbids(wire.artist_mbids),
    ...(typeof wire.caa_id === 'number' ? { caaId: wire.caa_id } : {}),
    ...(caaRelease && MBID_RE.test(caaRelease) ? { caaReleaseMbid: caaRelease.toLowerCase() } : {}),
    ...(typeof wire.listen_count === 'number' ? { listenCount: wire.listen_count } : {}),
  };
}

export function mapFreshRelease(wire: LbFreshReleaseWire): LbReleaseGroup | undefined {
  const id = text(wire.release_group_mbid);
  const title = text(wire.release_name);
  if (!id || !MBID_RE.test(id) || !title) return undefined;
  const artistName = text(wire.artist_credit_name);
  const primaryType = text(wire.release_group_primary_type);
  const secondaryType = text(wire.release_group_secondary_type);
  const releaseDate = text(wire.release_date);
  return {
    releaseGroupMbid: id.toLowerCase(),
    title,
    ...(artistName ? { artistName } : {}),
    ...(primaryType ? { primaryType } : {}),
    ...(secondaryType ? { secondaryType } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    ...common(wire),
  };
}

export function mapTopReleaseGroup(wire: LbTopReleaseGroupWire): LbReleaseGroup | undefined {
  const id = text(wire.release_group_mbid);
  const title = text(wire.release_group_name);
  if (!id || !MBID_RE.test(id) || !title) return undefined;
  const artistName = text(wire.artist_name);
  return { releaseGroupMbid: id.toLowerCase(), title, ...(artistName ? { artistName } : {}), ...common(wire) };
}

export function createListenBrainzClient(options: ListenBrainzClientOptions): ListenBrainzClient {
  const userAgent = typeof options?.userAgent === 'string' ? options.userAgent.trim() : '';
  if (userAgent.length === 0) throw new TypeError('ListenBrainz requires a User-Agent such as "Arclight/1.0 ( https://project.url )"');
  const baseUrl = options.baseUrl ?? LISTENBRAINZ_DEFAULT_BASE_URL;
  const root = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const providerKey = LISTENBRAINZ_PROVIDER;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(providerKey, { requestsPerSecond: Math.max(0.01, options.requestsPerSecond ?? 1), burst: 1 });
  const ttlMs = options.cacheTtlMs ?? HOUR;
  const transport = createJsonTransport({
    label: 'ListenBrainz',
    providerKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  function url(path: string, params: Record<string, string | number | boolean>): string {
    const u = new URL(path, root);
    for (const [key, value] of Object.entries(params)) u.searchParams.set(key, String(value));
    return u.toString();
  }

  /** 204 No Content (statistics being recomputed) reads as nothing. */
  async function orEmpty<T>(load: () => Promise<T[]>): Promise<T[]> {
    try {
      return await load();
    } catch (err) {
      if (isMetadataError(err, 'bad-response') && err.httpStatus === 204) return [];
      throw err;
    }
  }

  async function freshReleases(query: LbFreshReleasesQuery = {}, opts: RequestOptions = {}): Promise<LbReleaseGroup[]> {
    const days = Math.min(90, Math.max(1, Math.round(query.days ?? 14)));
    return orEmpty(async () => {
      const body = await transport.get(
        url('1/explore/fresh-releases', { days, sort: query.sort ?? 'release_date', future: query.future ?? false }),
        lbFreshReleasesResponseSchema,
        { ...opts, ttlMs },
      );
      return (body.payload.releases ?? []).map(mapFreshRelease).filter((r): r is LbReleaseGroup => r !== undefined);
    });
  }

  async function sitewideReleaseGroups(query: LbSitewideQuery = {}, opts: RequestOptions = {}): Promise<LbReleaseGroup[]> {
    const count = Math.min(100, Math.max(1, Math.round(query.count ?? 25)));
    return orEmpty(async () => {
      const body = await transport.get(
        url('1/stats/sitewide/release-groups', { range: query.range ?? 'week', count }),
        lbTopReleaseGroupsResponseSchema,
        { ...opts, ttlMs },
      );
      return (body.payload.release_groups ?? []).map(mapTopReleaseGroup).filter((r): r is LbReleaseGroup => r !== undefined);
    });
  }

  return { providerKey, freshReleases, sitewideReleaseGroups, clearCache: () => transport.clearCache() };
}
