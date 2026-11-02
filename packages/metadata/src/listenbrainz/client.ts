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
import { MetadataError, isMetadataError } from '../types.js';
import {
  lbFreshReleasesResponseSchema,
  lbPlaylistListResponseSchema,
  lbPlaylistResponseSchema,
  lbSimilarArtistsResponseSchema,
  lbTopReleaseGroupsResponseSchema,
  type LbFreshReleaseWire,
  type LbJspfPlaylistWire,
  type LbJspfTrackWire,
  type LbSimilarArtistRowWire,
  type LbTopReleaseGroupWire,
} from './schemas.js';
import { cleanText, mbidFrom, type SourcePlaylist, type SourcePlaylistTrack } from '../playlist-types.js';

export const LISTENBRAINZ_DEFAULT_BASE_URL = 'https://api.listenbrainz.org/';
export const LISTENBRAINZ_PROVIDER = 'listenbrainz';
export const LISTENBRAINZ_LABS_BASE_URL = 'https://labs.api.listenbrainz.org/';
/** The similar-artists dataset the labs API documents as its example. */
export const LISTENBRAINZ_SIMILAR_ARTISTS_ALGORITHM = 'session_based_days_1825_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30';

const JSPF_TRACK_EXT = 'https://musicbrainz.org/doc/jspf#track';
const JSPF_PLAYLIST_EXT = 'https://musicbrainz.org/doc/jspf#playlist';

const HOUR = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListenBrainzClientOptions {
  /** `App/version ( contact )`, like MusicBrainz. */
  userAgent: string;
  baseUrl?: string;
  /** The labs API (similar artists). */
  labsBaseUrl?: string;
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

/** A playlist ListenBrainz generated for a user (weekly jams, weekly exploration, ...). */
export interface LbPlaylistSummary {
  mbid: string;
  title: string;
  date?: string;
  /** The generator's `source_patch` ("weekly-jams", "weekly-exploration", ...), when given. */
  sourcePatch?: string;
}

export interface LbSimilarArtist {
  mbid: string;
  name: string;
  comment?: string;
  type?: string;
  /** Raw dataset score (higher = more similar). */
  score: number;
}

export interface ListenBrainzClient {
  readonly providerKey: string;
  freshReleases(query?: LbFreshReleasesQuery, options?: RequestOptions): Promise<LbReleaseGroup[]>;
  sitewideReleaseGroups(query?: LbSitewideQuery, options?: RequestOptions): Promise<LbReleaseGroup[]>;
  /** Playlists generated for `user` (public, keyless), newest first. */
  createdForPlaylists(user: string, options?: RequestOptions & { count?: number }): Promise<LbPlaylistSummary[]>;
  /** One playlist with its tracks (recording MBIDs). */
  getPlaylist(mbid: string, options?: RequestOptions): Promise<SourcePlaylist>;
  /** Similar artists from the labs dataset, most similar first. */
  similarArtists(artistMbid: string, options?: RequestOptions & { algorithm?: string; limit?: number }): Promise<LbSimilarArtist[]>;
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function mapJspfTrack(wire: LbJspfTrackWire): SourcePlaylistTrack | undefined {
  const title = cleanText(wire.title);
  const artist = cleanText(wire.creator);
  if (!title || !artist) return undefined;
  const ids = Array.isArray(wire.identifier) ? wire.identifier : wire.identifier ? [wire.identifier] : [];
  const recordingMbid = ids.map(mbidFrom).find((v) => v !== undefined);
  const ext = record(record(wire.extension)[JSPF_TRACK_EXT]);
  const artistMbids = (Array.isArray(ext['artist_identifiers']) ? ext['artist_identifiers'] : [])
    .map((v) => (typeof v === 'string' ? mbidFrom(v) : undefined))
    .filter((v): v is string => v !== undefined);
  const releaseMbid = typeof ext['release_identifier'] === 'string' ? mbidFrom(ext['release_identifier']) : undefined;
  const album = cleanText(wire.album);
  return {
    title,
    artist,
    ...(album ? { album } : {}),
    ...(typeof wire.duration === 'number' && wire.duration > 0 ? { durationMs: Math.round(wire.duration) } : {}),
    ...(recordingMbid ? { recordingMbid } : {}),
    ...(releaseMbid ? { releaseMbid } : {}),
    ...(artistMbids.length > 0 ? { artistMbids } : {}),
  };
}

function sourcePatch(wire: LbJspfPlaylistWire): string | undefined {
  const ext = record(record(wire.extension)[JSPF_PLAYLIST_EXT]);
  const algorithm = record(record(ext['additional_metadata'])['algorithm_metadata']);
  const patch = algorithm['source_patch'];
  return typeof patch === 'string' && patch.trim() ? patch.trim() : undefined;
}

export function mapSimilarArtistRow(row: LbSimilarArtistRowWire): LbSimilarArtist | undefined {
  const mbid = mbidFrom(row.artist_mbid);
  const name = cleanText(row.name);
  if (!mbid || !name) return undefined;
  const comment = cleanText(row.comment);
  const type = cleanText(row.type);
  return { mbid, name, ...(comment ? { comment } : {}), ...(type ? { type } : {}), score: typeof row.score === 'number' ? row.score : 0 };
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

  const labsKey = `${providerKey}-labs`;
  limiter.configure(labsKey, { requestsPerSecond: 1, burst: 1 });
  const labsRoot = new URL(options.labsBaseUrl ?? LISTENBRAINZ_LABS_BASE_URL);
  const labs = createJsonTransport({
    label: 'ListenBrainz labs',
    providerKey: labsKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  async function createdForPlaylists(user: string, opts: RequestOptions & { count?: number } = {}): Promise<LbPlaylistSummary[]> {
    const name = user.trim();
    if (!name) return [];
    const { count, ...rest } = opts;
    const body = await transport.get(
      url(`1/user/${encodeURIComponent(name)}/playlists/createdfor`, { count: Math.min(100, Math.max(1, count ?? 25)), offset: 0 }),
      lbPlaylistListResponseSchema,
      { ...rest, ttlMs },
    );
    return (body.playlists ?? []).flatMap(({ playlist }): LbPlaylistSummary[] => {
      const mbid = mbidFrom(playlist.identifier);
      if (!mbid) return [];
      const date = text(playlist.date);
      const patch = sourcePatch(playlist);
      return [{ mbid, title: text(playlist.title) ?? mbid, ...(date ? { date } : {}), ...(patch ? { sourcePatch: patch } : {}) }];
    });
  }

  async function getPlaylist(mbid: string, opts: RequestOptions = {}): Promise<SourcePlaylist> {
    const id = mbidFrom(mbid);
    if (!id) throw new MetadataError('not-found', `Not a ListenBrainz playlist id: ${mbid}`);
    const body = await transport.get(url(`1/playlist/${id}`, {}), lbPlaylistResponseSchema, { ...opts, ttlMs: 0 });
    const p = body.playlist;
    const tracks = (p.track ?? []).map(mapJspfTrack).filter((t): t is SourcePlaylistTrack => t !== undefined);
    const description = text(p.annotation)?.replace(/<[^>]+>/g, '').trim();
    const owner = text(p.creator);
    return { id, title: text(p.title) ?? id, ...(description ? { description } : {}), ...(owner ? { owner } : {}), tracks };
  }

  async function similarArtists(artistMbid: string, opts: RequestOptions & { algorithm?: string; limit?: number } = {}): Promise<LbSimilarArtist[]> {
    const id = mbidFrom(artistMbid);
    if (!id) return [];
    const { algorithm, limit, ...rest } = opts;
    const u = new URL('similar-artists/json', labsRoot);
    u.searchParams.set('artist_mbids', id);
    u.searchParams.set('algorithm', algorithm ?? LISTENBRAINZ_SIMILAR_ARTISTS_ALGORITHM);
    const body = await labs.get(u.toString(), lbSimilarArtistsResponseSchema, { ...rest, ttlMs: 24 * HOUR });
    const rows = body.flatMap((entry): LbSimilarArtistRowWire[] => ('data' in entry && Array.isArray(entry.data) ? entry.data : [entry as LbSimilarArtistRowWire]));
    const seen = new Set<string>([id]);
    const out: LbSimilarArtist[] = [];
    for (const row of rows) {
      const a = mapSimilarArtistRow(row);
      if (!a || seen.has(a.mbid)) continue;
      seen.add(a.mbid);
      out.push(a);
    }
    return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit ?? 30));
  }

  return {
    providerKey,
    freshReleases,
    sitewideReleaseGroups,
    createdForPlaylists,
    getPlaylist,
    similarArtists,
    clearCache: () => {
      transport.clearCache();
      labs.clearCache();
    },
  };
}
