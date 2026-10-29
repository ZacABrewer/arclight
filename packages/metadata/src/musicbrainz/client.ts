// MusicBrainz WS/2 JSON client. HTTP concerns live in ../http.ts, shaping in ./map.ts.
//
// MusicBrainz asks anonymous clients for a meaningful User-Agent and at most one request per
// second per IP. The default host is therefore locked at 1 req/s on the process-wide limiter;
// a self-hosted mirror (custom `baseUrl`) may be given a higher rate.

import type { FetchLike } from '../tmdb/client.js';
import { MetadataError } from '../types.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import {
  mapArtist,
  mapArtistSearchResult,
  mapRelease,
  mapReleaseGroup,
  mapReleaseGroupDetail,
  mapReleaseSummary,
} from './map.js';
import {
  mbArtistSchema,
  mbArtistSearchSchema,
  mbReleaseBrowseSchema,
  mbReleaseGroupBrowseSchema,
  mbReleaseGroupSchema,
  mbReleaseGroupSearchSchema,
  mbReleaseSchema,
} from './schemas.js';
import type {
  MbArtist,
  MbArtistSearchResult,
  MbRelease,
  MbReleaseGroup,
  MbReleaseGroupDetail,
  MbReleaseSummary,
  MbSearchPage,
} from './types.js';

export const MUSICBRAINZ_DEFAULT_BASE_URL = 'https://musicbrainz.org/ws/2/';
/** Limiter bucket of the public MusicBrainz host. */
export const MUSICBRAINZ_PROVIDER = 'musicbrainz';

const PUBLIC_HOSTS = new Set(['musicbrainz.org', 'www.musicbrainz.org', 'beta.musicbrainz.org']);
const DAY = 24 * 60 * 60 * 1000;

export interface MusicBrainzCacheTtls {
  artist: number;
  search: number;
  releaseGroups: number;
  releases: number;
  release: number;
}

/** TTLs from the design (§5.3). 0 disables caching for that kind. */
export const MUSICBRAINZ_DEFAULT_CACHE_TTLS: MusicBrainzCacheTtls = {
  artist: 7 * DAY,
  search: 60 * 60 * 1000,
  releaseGroups: DAY,
  releases: DAY,
  release: 30 * DAY,
};

/** Release-group primary types accepted by the browse `type` filter. */
export type MbReleaseGroupType = 'album' | 'ep' | 'single' | 'broadcast' | 'other';

export interface MusicBrainzClientOptions {
  /**
   * Required by MusicBrainz: `App/version ( contact-url-or-email )`. See
   * `buildMusicBrainzUserAgent`.
   */
  userAgent: string;
  /** WS/2 root; defaults to the public server. */
  baseUrl?: string;
  /** Requests per second. Ignored (locked at 1) for the public MusicBrainz host. */
  requestsPerSecond?: number;
  /** Defaults to the process-wide limiter. */
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Retries after a 429/503. */
  maxRetries?: number;
  cacheTtls?: Partial<MusicBrainzCacheTtls>;
  /** Priority used when a call passes none. Defaults to `interactive`. */
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

export interface MbSearchOptions extends RequestOptions {
  /** 1–100, default 25. */
  limit?: number;
  offset?: number;
}

export interface MbBrowseReleaseGroupsOptions extends RequestOptions {
  /** Defaults to album, ep and single. */
  types?: readonly MbReleaseGroupType[];
}

export interface MusicBrainzClient {
  /** Limiter bucket this client draws from. */
  readonly providerKey: string;
  searchArtists(query: string, options?: MbSearchOptions): Promise<MbSearchPage<MbArtistSearchResult>>;
  getArtist(mbid: string, options?: RequestOptions): Promise<MbArtist>;
  /** Every release group of the artist (all pages), oldest first. */
  browseReleaseGroups(
    artistMbid: string,
    options?: MbBrowseReleaseGroupsOptions,
  ): Promise<MbReleaseGroup[]>;
  /** Every release of the release group (all pages), with media but no tracks. */
  browseReleases(releaseGroupMbid: string, options?: RequestOptions): Promise<MbReleaseSummary[]>;
  /** One release with media, tracks, artist credits and labels. */
  getRelease(mbid: string, options?: RequestOptions): Promise<MbRelease>;
  /**
   * Release-group search. An object searches the title (and artist) as quoted phrases; a plain
   * string is free text over every indexed field (what a user types into a search box).
   */
  searchReleaseGroups(
    query: string | { artist?: string; title: string },
    options?: MbSearchOptions,
  ): Promise<MbSearchPage<MbReleaseGroup>>;
  /** One release group with its artist credits and genres. */
  getReleaseGroup(mbid: string, options?: RequestOptions): Promise<MbReleaseGroupDetail>;
  clearCache(): void;
}

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BROWSE_LIMIT = 100;
/** Safety stop for paging (100 × 100 = 10 000 entities). */
const MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_TYPES: readonly MbReleaseGroupType[] = ['album', 'ep', 'single'];

export function isMbid(value: string): boolean {
  return MBID_RE.test(value);
}

/** `Arclight/0.4.0 ( https://example.org/project contact@example.org )` */
export function buildMusicBrainzUserAgent(input: {
  app: string;
  version: string;
  /** Project URL and/or contact e-mail. */
  contact: string;
}): string {
  return `${input.app}/${input.version} ( ${input.contact.trim()} )`;
}

/** Escapes Lucene query syntax so user text is searched literally. */
export function escapeLucene(value: string): string {
  return value.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
}

/** Escapes text for use inside a quoted Lucene phrase. */
function quotePhrase(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

function requireMbid(mbid: string, what: string): string {
  if (!isMbid(mbid)) {
    throw new MetadataError('not-found', `${what} "${mbid}" is not a MusicBrainz id`);
  }
  return mbid.toLowerCase();
}

function clampLimit(limit: number | undefined): number {
  return Math.min(100, Math.max(1, Math.round(limit ?? 25)));
}

/** Oldest first; undated last; then title. */
function byReleaseDate(a: MbReleaseGroup, b: MbReleaseGroup): number {
  const da = a.firstReleaseDate ?? '9999';
  const db = b.firstReleaseDate ?? '9999';
  return da.localeCompare(db) || a.title.localeCompare(b.title) || a.mbid.localeCompare(b.mbid);
}

export function createMusicBrainzClient(options: MusicBrainzClientOptions): MusicBrainzClient {
  const userAgent = typeof options?.userAgent === 'string' ? options.userAgent.trim() : '';
  if (userAgent.length === 0) {
    throw new TypeError(
      'MusicBrainz requires a User-Agent such as "Arclight/1.0 ( https://project.url )"',
    );
  }
  const baseUrl = options.baseUrl ?? MUSICBRAINZ_DEFAULT_BASE_URL;
  const root = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const isPublic = PUBLIC_HOSTS.has(root.hostname.toLowerCase());
  const providerKey = isPublic ? MUSICBRAINZ_PROVIDER : `${MUSICBRAINZ_PROVIDER}@${root.host}`;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  const requestsPerSecond = isPublic ? 1 : Math.max(0.01, options.requestsPerSecond ?? 1);
  limiter.configure(providerKey, { requestsPerSecond, burst: 1 });

  const ttls: MusicBrainzCacheTtls = { ...MUSICBRAINZ_DEFAULT_CACHE_TTLS, ...options.cacheTtls };
  const transport = createJsonTransport({
    label: 'MusicBrainz',
    providerKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  function url(path: string, params: Record<string, string | number | undefined>): string {
    const u = new URL(path, root);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) u.searchParams.set(key, String(value));
    }
    u.searchParams.set('fmt', 'json');
    return u.toString();
  }

  function req(options: RequestOptions | undefined, ttlMs: number) {
    return { ...options, ttlMs };
  }

  async function searchArtists(
    query: string,
    options: MbSearchOptions = {},
  ): Promise<MbSearchPage<MbArtistSearchResult>> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return { count: 0, offset: 0, results: [] };
    const { limit, offset, ...rest } = options;
    const body = await transport.get(
      url('artist', { query: escapeLucene(trimmed), limit: clampLimit(limit), offset: offset ?? 0 }),
      mbArtistSearchSchema,
      req(rest, ttls.search),
    );
    return { count: body.count, offset: body.offset, results: body.artists.map(mapArtistSearchResult) };
  }

  async function getArtist(mbid: string, options?: RequestOptions): Promise<MbArtist> {
    const id = requireMbid(mbid, 'Artist');
    const body = await transport.get(
      url(`artist/${id}`, { inc: 'aliases+genres+url-rels' }),
      mbArtistSchema,
      req(options, ttls.artist),
    );
    return mapArtist(body);
  }

  async function browseReleaseGroups(
    artistMbid: string,
    options: MbBrowseReleaseGroupsOptions = {},
  ): Promise<MbReleaseGroup[]> {
    const id = requireMbid(artistMbid, 'Artist');
    const { types = DEFAULT_TYPES, ...rest } = options;
    const out = new Map<string, MbReleaseGroup>();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await transport.get(
        url('release-group', { artist: id, type: types.join('|'), limit: BROWSE_LIMIT, offset }),
        mbReleaseGroupBrowseSchema,
        req(rest, ttls.releaseGroups),
      );
      const items = body['release-groups'];
      for (const item of items) out.set(item.id, mapReleaseGroup(item));
      offset += items.length;
      if (items.length === 0 || offset >= body['release-group-count']) break;
    }
    return [...out.values()].sort(byReleaseDate);
  }

  async function browseReleases(
    releaseGroupMbid: string,
    options?: RequestOptions,
  ): Promise<MbReleaseSummary[]> {
    const id = requireMbid(releaseGroupMbid, 'Release group');
    const out = new Map<string, MbReleaseSummary>();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await transport.get(
        url('release', { 'release-group': id, inc: 'media', limit: BROWSE_LIMIT, offset }),
        mbReleaseBrowseSchema,
        req(options, ttls.releases),
      );
      for (const item of body.releases) out.set(item.id, mapReleaseSummary(item, id));
      offset += body.releases.length;
      if (body.releases.length === 0 || offset >= body['release-count']) break;
    }
    return [...out.values()];
  }

  async function getRelease(mbid: string, options?: RequestOptions): Promise<MbRelease> {
    const id = requireMbid(mbid, 'Release');
    const body = await transport.get(
      url(`release/${id}`, { inc: 'recordings+artist-credits+media+labels' }),
      mbReleaseSchema,
      req(options, ttls.release),
    );
    return mapRelease(body);
  }

  async function searchReleaseGroups(
    query: string | { artist?: string; title: string },
    options: MbSearchOptions = {},
  ): Promise<MbSearchPage<MbReleaseGroup>> {
    let lucene: string;
    if (typeof query === 'string') {
      const trimmed = query.trim();
      if (trimmed.length === 0) return { count: 0, offset: 0, results: [] };
      lucene = escapeLucene(trimmed);
    } else {
      const title = query.title.trim();
      const artist = query.artist?.trim();
      if (title.length === 0) return { count: 0, offset: 0, results: [] };
      lucene = artist
        ? `releasegroup:${quotePhrase(title)} AND artist:${quotePhrase(artist)}`
        : `releasegroup:${quotePhrase(title)}`;
    }
    const { limit, offset, ...rest } = options;
    const body = await transport.get(
      url('release-group', { query: lucene, limit: clampLimit(limit), offset: offset ?? 0 }),
      mbReleaseGroupSearchSchema,
      req(rest, ttls.search),
    );
    return {
      count: body.count,
      offset: body.offset,
      results: body['release-groups'].map(mapReleaseGroup),
    };
  }

  async function getReleaseGroup(mbid: string, options?: RequestOptions): Promise<MbReleaseGroupDetail> {
    const id = requireMbid(mbid, 'Release group');
    const body = await transport.get(
      url(`release-group/${id}`, { inc: 'artist-credits+genres' }),
      mbReleaseGroupSchema,
      req(options, ttls.releaseGroups),
    );
    return mapReleaseGroupDetail(body);
  }

  return {
    providerKey,
    searchArtists,
    getArtist,
    browseReleaseGroups,
    browseReleases,
    getRelease,
    searchReleaseGroups,
    getReleaseGroup,
    clearCache: () => transport.clearCache(),
  };
}
