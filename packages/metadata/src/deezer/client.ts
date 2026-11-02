// Deezer public API client for reading one public playlist (no key, no sign-in):
//
//   GET https://api.deezer.com/playlist/{id}                    title, description, creator
//   GET https://api.deezer.com/playlist/{id}/tracks?index=&limit= paged tracks
//
// Deezer answers errors with HTTP 200 and `{ error: { type, message, code } }`: code 800 is
// "no data" (unknown or private playlist), 4 the request quota (50 per 5 s). Durations are
// seconds; track lists carry an ISRC on most entries.

import { z } from 'zod';
import type { FetchLike } from '../tmdb/client.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import { MetadataError } from '../types.js';
import { cleanIsrc, cleanText, type SourcePlaylist, type SourcePlaylistTrack } from '../playlist-types.js';

export const DEEZER_DEFAULT_BASE_URL = 'https://api.deezer.com/';
export const DEEZER_PROVIDER = 'deezer';

const PAGE = 100;
const MAX_PAGES = 100;

export interface DeezerClientOptions {
  baseUrl?: string;
  /** Requests per second. Defaults to 5 (Deezer allows 50 per 5 seconds). */
  requestsPerSecond?: number;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

export interface DeezerClient {
  readonly providerKey: string;
  getPlaylist(idOrUrl: string, options?: RequestOptions): Promise<SourcePlaylist>;
}

/** The id of `https://www.deezer.com/<lang>/playlist/<id>` or a bare numeric id. */
export function parseDeezerPlaylistId(value: string): string | undefined {
  const v = value.trim();
  if (/^\d{1,20}$/.test(v)) return v;
  try {
    const url = new URL(v);
    if (!/(^|\.)deezer\.com$/i.test(url.hostname)) return undefined;
    const match = /\/playlist\/(\d{1,20})(?:\/|$)/.exec(url.pathname);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

const optString = z.string().nullable().optional();
const errorField = z.object({ type: optString, message: optString, code: z.number().nullable().optional() }).loose().nullable().optional();

const playlistSchema = z
  .object({
    error: errorField,
    id: z.union([z.number(), z.string()]).nullable().optional(),
    title: optString,
    description: optString,
    creator: z.object({ name: optString }).loose().nullable().optional(),
  })
  .loose();

const trackWire = z
  .object({
    id: z.union([z.number(), z.string()]).nullable().optional(),
    type: optString,
    title: optString,
    readable: z.boolean().nullable().optional(),
    duration: z.number().nullable().optional(),
    isrc: optString,
    artist: z.object({ name: optString }).loose().nullable().optional(),
    album: z.object({ title: optString, type: optString }).loose().nullable().optional(),
  })
  .loose();
export type DeezerTrackWire = z.infer<typeof trackWire>;

const tracksSchema = z
  .object({ error: errorField, data: z.array(trackWire).nullable().optional(), next: optString, total: z.number().nullable().optional() })
  .loose();

export function mapDeezerTrack(wire: DeezerTrackWire): SourcePlaylistTrack | undefined {
  if (wire.type && wire.type !== 'track') return undefined;
  const title = cleanText(wire.title);
  const artist = cleanText(wire.artist?.name);
  if (!title || !artist) return undefined;
  const album = cleanText(wire.album?.title);
  const isrc = cleanIsrc(wire.isrc);
  const id = wire.id === null || wire.id === undefined ? undefined : String(wire.id);
  return {
    title,
    artist,
    ...(album ? { album } : {}),
    ...(typeof wire.duration === 'number' && wire.duration > 0 ? { durationMs: Math.round(wire.duration * 1000) } : {}),
    ...(isrc ? { isrc } : {}),
    ...(id ? { sourceId: id } : {}),
  };
}

function check(error: z.infer<typeof errorField>, id: string): void {
  if (!error) return;
  if (error.code === 800) throw new MetadataError('not-found', `Deezer has no public playlist ${id}`);
  if (error.code === 4) throw new MetadataError('rate-limited', 'Deezer request quota exceeded');
  throw new MetadataError('bad-response', `Deezer: ${error.message ?? error.type ?? 'error'}`);
}

export function createDeezerClient(options: DeezerClientOptions = {}): DeezerClient {
  const root = new URL(options.baseUrl ?? DEEZER_DEFAULT_BASE_URL);
  const providerKey = DEEZER_PROVIDER;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(providerKey, { requestsPerSecond: Math.max(0.1, options.requestsPerSecond ?? 5), burst: 2 });
  const transport = createJsonTransport({
    label: 'Deezer',
    providerKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers: { Accept: 'application/json' },
    timeoutMs: options.timeoutMs ?? 20_000,
    maxRetries: options.maxRetries ?? 2,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  async function getPlaylist(idOrUrl: string, opts: RequestOptions = {}): Promise<SourcePlaylist> {
    const id = parseDeezerPlaylistId(idOrUrl);
    if (!id) throw new MetadataError('not-found', `Not a Deezer playlist link or id: ${idOrUrl}`);
    const info = await transport.get(new URL(`playlist/${id}`, root).toString(), playlistSchema, { ...opts, ttlMs: 0 });
    check(info.error, id);
    const tracks: SourcePlaylistTrack[] = [];
    let index = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const u = new URL(`playlist/${id}/tracks`, root);
      u.searchParams.set('index', String(index));
      u.searchParams.set('limit', String(PAGE));
      const body = await transport.get(u.toString(), tracksSchema, { ...opts, ttlMs: 0 });
      check(body.error, id);
      const data = body.data ?? [];
      for (const wire of data) {
        const t = mapDeezerTrack(wire);
        if (t) tracks.push(t);
      }
      index += data.length;
      if (data.length === 0 || !body.next) break;
    }
    const description = cleanText(info.description);
    const owner = cleanText(info.creator?.name);
    return { id, title: cleanText(info.title) ?? id, ...(description ? { description } : {}), ...(owner ? { owner } : {}), tracks };
  }

  return { providerKey, getPlaylist };
}
