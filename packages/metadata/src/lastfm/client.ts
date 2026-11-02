// Last.fm API 2.0 client (the user's own API key) for playlists from listening data, similar
// artists and artist biographies:
//
//   user.getTopTracks / user.getLovedTracks / user.getTopAlbums   a user's charts and loves
//   artist.getSimilar / artist.getInfo                            by MusicBrainz id or name
//
// Last.fm reports errors as `{ error, message }`, sometimes with HTTP 200; code 6 is "not
// found", 10/26 a bad or suspended key, 29 rate limiting. Durations are seconds on the wire.

import { z } from 'zod';
import type { FetchLike } from '../tmdb/client.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import { MetadataError, isMetadataError } from '../types.js';
import { cleanText, mbidFrom, type SourcePlaylistTrack } from '../playlist-types.js';

export const LASTFM_DEFAULT_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
export const LASTFM_PROVIDER = 'lastfm';

const HOUR = 60 * 60 * 1000;
const PAGE = 200;

export type LastfmPeriod = 'overall' | '7day' | '1month' | '3month' | '6month' | '12month';

export interface LastfmClientOptions {
  apiKey: string;
  userAgent?: string;
  baseUrl?: string;
  /** Requests per second. Defaults to 2 (Last.fm asks for at most 5 on average). */
  requestsPerSecond?: number;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  cacheTtlMs?: number;
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

export interface LastfmTopAlbum {
  title: string;
  artist: string;
  albumMbid?: string;
  artistMbid?: string;
  playcount?: number;
}

export interface LastfmSimilarArtist {
  name: string;
  mbid?: string;
  /** 0..1 */
  match: number;
}

export interface LastfmArtistBio {
  name: string;
  mbid?: string;
  /** Plain text (HTML and the "Read more on Last.fm" link stripped). */
  summary: string;
  content: string;
  url?: string;
}

export interface LastfmUserQuery {
  user: string;
  /** Defaults to 50; at most 1000. */
  limit?: number;
}

export interface LastfmClient {
  readonly providerKey: string;
  topTracks(query: LastfmUserQuery & { period?: LastfmPeriod }, options?: RequestOptions): Promise<SourcePlaylistTrack[]>;
  lovedTracks(query: LastfmUserQuery, options?: RequestOptions): Promise<SourcePlaylistTrack[]>;
  topAlbums(query: LastfmUserQuery & { period?: LastfmPeriod }, options?: RequestOptions): Promise<LastfmTopAlbum[]>;
  similarArtists(artist: { mbid?: string; name?: string }, options?: RequestOptions & { limit?: number }): Promise<LastfmSimilarArtist[]>;
  /** The artist's biography; undefined when Last.fm has none. */
  artistBio(artist: { mbid?: string; name?: string }, options?: RequestOptions & { lang?: string }): Promise<LastfmArtistBio | undefined>;
  clearCache(): void;
}

const optString = z.string().nullable().optional();
const numberish = z.union([z.number(), z.string()]).nullable().optional();
/** Last.fm turns one-element lists into an object. */
function listOf<T extends z.ZodType>(item: T) {
  return z.union([z.array(item), item]).nullable().optional();
}
function asList<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const artistRef = z.union([z.object({ name: optString, '#text': optString, mbid: optString }).loose(), z.string()]);
const trackWire = z
  .object({ name: optString, mbid: optString, duration: numberish, artist: artistRef.nullable().optional(), album: z.object({ '#text': optString, mbid: optString }).loose().nullable().optional() })
  .loose();
const errorFields = { error: z.number().nullable().optional(), message: optString };

const topTracksSchema = z.object({ ...errorFields, toptracks: z.object({ track: listOf(trackWire) }).loose().nullable().optional() }).loose();
const lovedTracksSchema = z.object({ ...errorFields, lovedtracks: z.object({ track: listOf(trackWire) }).loose().nullable().optional() }).loose();
const topAlbumsSchema = z
  .object({
    ...errorFields,
    topalbums: z
      .object({ album: listOf(z.object({ name: optString, mbid: optString, playcount: numberish, artist: artistRef.nullable().optional() }).loose()) })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();
const similarSchema = z
  .object({
    ...errorFields,
    similarartists: z.object({ artist: listOf(z.object({ name: optString, mbid: optString, match: numberish }).loose()) }).loose().nullable().optional(),
  })
  .loose();
const infoSchema = z
  .object({
    ...errorFields,
    artist: z
      .object({ name: optString, mbid: optString, url: optString, bio: z.object({ summary: optString, content: optString }).loose().nullable().optional() })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

function num(value: number | string | null | undefined): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function artistName(ref: z.infer<typeof artistRef> | null | undefined): string | undefined {
  if (!ref) return undefined;
  if (typeof ref === 'string') return cleanText(ref);
  return cleanText(ref.name) ?? cleanText(ref['#text']);
}

/** Bio text without HTML, entities and the trailing "Read more on Last.fm" link. */
export function plainBio(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/User-contributed text is available under the Creative Commons[^.]*\.?/i, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function mapLastfmTrack(wire: z.infer<typeof trackWire>): SourcePlaylistTrack | undefined {
  const title = cleanText(wire.name);
  const artist = artistName(wire.artist);
  if (!title || !artist) return undefined;
  const recordingMbid = mbidFrom(wire.mbid);
  const artistMbid = typeof wire.artist === 'object' && wire.artist ? mbidFrom(wire.artist.mbid) : undefined;
  const seconds = num(wire.duration);
  const album = cleanText(wire.album?.['#text']);
  return {
    title,
    artist,
    ...(album ? { album } : {}),
    ...(seconds && seconds > 0 ? { durationMs: Math.round(seconds * 1000) } : {}),
    ...(recordingMbid ? { recordingMbid } : {}),
    ...(artistMbid ? { artistMbids: [artistMbid] } : {}),
  };
}

export function createLastfmClient(options: LastfmClientOptions): LastfmClient {
  const apiKey = options.apiKey?.trim() ?? '';
  if (!apiKey) throw new TypeError('Last.fm needs an API key');
  const root = new URL(options.baseUrl ?? LASTFM_DEFAULT_BASE_URL);
  const providerKey = LASTFM_PROVIDER;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(providerKey, { requestsPerSecond: Math.max(0.1, options.requestsPerSecond ?? 2), burst: 2 });
  const ttlMs = options.cacheTtlMs ?? HOUR;
  const transport = createJsonTransport({
    label: 'Last.fm',
    providerKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers: { Accept: 'application/json', 'User-Agent': options.userAgent ?? 'Arclight' },
    timeoutMs: options.timeoutMs ?? 20_000,
    maxRetries: options.maxRetries ?? 2,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  function url(method: string, params: Record<string, string | number | undefined>): string {
    const u = new URL(root);
    u.searchParams.set('method', method);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    u.searchParams.set('api_key', apiKey);
    u.searchParams.set('format', 'json');
    return u.toString();
  }

  /** Last.fm error codes as MetadataError; HTTP 4xx bodies carry the same codes. */
  function check(body: { error?: number | null | undefined; message?: string | null | undefined }): void {
    if (typeof body.error !== 'number') return;
    const message = `Last.fm: ${body.message ?? `error ${body.error}`}`;
    if (body.error === 6) throw new MetadataError('not-found', message);
    if (body.error === 10 || body.error === 26) throw new MetadataError('unauthorized', message);
    if (body.error === 29) throw new MetadataError('rate-limited', message);
    throw new MetadataError('bad-response', message);
  }

  async function get<S extends z.ZodType<{ error?: number | null | undefined; message?: string | null | undefined }>>(u: string, schema: S, opts: RequestOptions): Promise<z.infer<S>> {
    try {
      const body = await transport.get(u, schema, { ...opts, ttlMs });
      check(body);
      return body;
    } catch (err) {
      // Bad parameters answer HTTP 400 with an `{ error: 6 }` body (unknown user / artist).
      if (isMetadataError(err, 'bad-response') && err.httpStatus === 400 && /not found|no such|invalid/i.test(err.message)) {
        throw new MetadataError('not-found', err.message, { httpStatus: 400 });
      }
      throw err;
    }
  }

  const limitOf = (limit: number | undefined, fallback: number) => Math.min(1000, Math.max(1, Math.round(limit ?? fallback)));

  async function pagedTracks(method: string, key: 'toptracks' | 'lovedtracks', query: LastfmUserQuery & { period?: LastfmPeriod }, opts: RequestOptions) {
    const want = limitOf(query.limit, 50);
    const out: SourcePlaylistTrack[] = [];
    for (let page = 1; out.length < want && page <= Math.ceil(want / PAGE); page += 1) {
      const u = url(method, { user: query.user, period: query.period, limit: Math.min(PAGE, want), page });
      const list =
        key === 'toptracks' ? asList((await get(u, topTracksSchema, opts)).toptracks?.track) : asList((await get(u, lovedTracksSchema, opts)).lovedtracks?.track);
      for (const wire of list) {
        const t = mapLastfmTrack(wire);
        if (t) out.push(t);
      }
      if (list.length < Math.min(PAGE, want)) break;
    }
    return out.slice(0, want);
  }

  function artistParams(artist: { mbid?: string; name?: string }) {
    const mbid = mbidFrom(artist.mbid);
    if (mbid) return { mbid };
    const name = cleanText(artist.name);
    if (!name) throw new MetadataError('not-found', 'Last.fm artist lookup needs a MusicBrainz id or a name');
    return { artist: name, autocorrect: 1 };
  }

  return {
    providerKey,
    topTracks: (query, opts = {}) => pagedTracks('user.gettoptracks', 'toptracks', { ...query, period: query.period ?? 'overall' }, opts),
    lovedTracks: (query, opts = {}) => pagedTracks('user.getlovedtracks', 'lovedtracks', query, opts),
    async topAlbums(query, opts = {}) {
      const body = await get(url('user.gettopalbums', { user: query.user, period: query.period ?? 'overall', limit: limitOf(query.limit, 50) }), topAlbumsSchema, opts);
      return asList(body.topalbums?.album).flatMap((a): LastfmTopAlbum[] => {
        const title = cleanText(a.name);
        const artist = artistName(a.artist);
        if (!title || !artist) return [];
        const albumMbid = mbidFrom(a.mbid);
        const artistMbid = typeof a.artist === 'object' && a.artist ? mbidFrom(a.artist.mbid) : undefined;
        const playcount = num(a.playcount);
        return [{ title, artist, ...(albumMbid ? { albumMbid } : {}), ...(artistMbid ? { artistMbid } : {}), ...(playcount !== undefined ? { playcount } : {}) }];
      });
    },
    async similarArtists(artist, opts = {}) {
      const { limit, ...rest } = opts;
      const body = await get(url('artist.getsimilar', { ...artistParams(artist), limit: limitOf(limit, 30) }), similarSchema, rest);
      return asList(body.similarartists?.artist).flatMap((a): LastfmSimilarArtist[] => {
        const name = cleanText(a.name);
        if (!name) return [];
        const mbid = mbidFrom(a.mbid);
        return [{ name, ...(mbid ? { mbid } : {}), match: Math.max(0, Math.min(1, num(a.match) ?? 0)) }];
      });
    },
    async artistBio(artist, opts = {}) {
      const { lang, ...rest } = opts;
      let body: z.infer<typeof infoSchema>;
      try {
        body = await get(url('artist.getinfo', { ...artistParams(artist), lang }), infoSchema, rest);
      } catch (err) {
        if (isMetadataError(err, 'not-found')) return undefined;
        throw err;
      }
      const a = body.artist;
      const name = cleanText(a?.name);
      if (!a || !name) return undefined;
      const summary = plainBio(a.bio?.summary);
      const content = plainBio(a.bio?.content) || summary;
      if (!summary && !content) return undefined;
      const mbid = mbidFrom(a.mbid);
      const link = cleanText(a.url);
      return { name, ...(mbid ? { mbid } : {}), summary: summary || content, content, ...(link ? { url: link } : {}) };
    },
    clearCache: () => transport.clearCache(),
  };
}
