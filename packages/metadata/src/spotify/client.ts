// Spotify Web API client for reading one playlist with the user's own app credentials
// (client-credentials flow: no Spotify account sign-in, public and shared playlists only).
//
//   POST https://accounts.spotify.com/api/token      grant_type=client_credentials (Basic auth)
//   GET  /v1/playlists/{id}?fields=...               name, description, owner
//   GET  /v1/playlists/{id}/tracks?limit=100&offset  paged items (track name, artists, album, ISRC)
//
// The token is cached until shortly before it expires; a 401 drops it and retries once.
// Spotify-curated algorithmic playlists may answer 404 to third-party apps.

import { z } from 'zod';
import type { FetchLike } from '../tmdb/client.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import { MetadataError, isMetadataError } from '../types.js';
import { cleanIsrc, cleanText, type SourcePlaylist, type SourcePlaylistTrack } from '../playlist-types.js';

export const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/';
export const SPOTIFY_ACCOUNTS_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_PROVIDER = 'spotify';

const PAGE = 100;
/** Safety stop: 100 pages of 100 tracks. */
const MAX_PAGES = 100;
const TOKEN_MARGIN_MS = 60_000;
const ID_RE = /^[A-Za-z0-9]{22}$/;

export interface SpotifyClientOptions {
  clientId: string;
  clientSecret: string;
  apiBaseUrl?: string;
  accountsUrl?: string;
  /** Requests per second. Defaults to 5 (Spotify's limit is a rolling 30 s window). */
  requestsPerSecond?: number;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

export interface SpotifyClient {
  readonly providerKey: string;
  /** The playlist with every track (episodes and local files are skipped). */
  getPlaylist(idOrUrl: string, options?: RequestOptions): Promise<SourcePlaylist>;
}

/**
 * The playlist id of `https://open.spotify.com/playlist/<id>?si=...`, `spotify:playlist:<id>`
 * or a bare id; undefined otherwise.
 */
export function parseSpotifyPlaylistId(value: string): string | undefined {
  const v = value.trim();
  if (ID_RE.test(v)) return v;
  const uri = /^spotify:(?:user:[^:]+:)?playlist:([A-Za-z0-9]{22})$/.exec(v);
  if (uri) return uri[1];
  try {
    const url = new URL(v);
    if (!/(^|\.)spotify\.com$/i.test(url.hostname)) return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    const at = parts.indexOf('playlist');
    const id = at >= 0 ? parts[at + 1] : undefined;
    return id && ID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

const optString = z.string().nullable().optional();

const tokenSchema = z.object({ access_token: z.string(), expires_in: z.number().optional() }).loose();

const playlistSchema = z
  .object({
    id: z.string(),
    name: optString,
    description: optString,
    owner: z.object({ display_name: optString, id: optString }).loose().nullable().optional(),
  })
  .loose();

const trackSchema = z
  .object({
    id: optString,
    type: optString,
    name: optString,
    duration_ms: z.number().nullable().optional(),
    is_local: z.boolean().nullable().optional(),
    external_ids: z.object({ isrc: optString }).loose().nullable().optional(),
    artists: z.array(z.object({ name: optString }).loose()).nullable().optional(),
    album: z
      .object({ name: optString, album_type: optString, release_date: optString })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();
export type SpotifyTrackWire = z.infer<typeof trackSchema>;

const tracksPageSchema = z
  .object({
    items: z.array(z.object({ track: trackSchema.nullable().optional() }).loose()),
    next: optString,
    total: z.number().nullable().optional(),
  })
  .loose();

export function mapSpotifyTrack(wire: SpotifyTrackWire): SourcePlaylistTrack | undefined {
  if ((wire.type && wire.type !== 'track') || wire.is_local) return undefined;
  const title = cleanText(wire.name);
  const names = (wire.artists ?? []).map((a) => cleanText(a.name)).filter((n): n is string => n !== undefined);
  if (!title || names.length === 0) return undefined;
  const album = cleanText(wire.album?.name);
  const albumType = cleanText(wire.album?.album_type);
  const releaseDate = cleanText(wire.album?.release_date);
  const isrc = cleanIsrc(wire.external_ids?.isrc);
  const id = cleanText(wire.id);
  return {
    title,
    artist: names.join(', '),
    ...(album ? { album } : {}),
    ...(albumType ? { albumType } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    ...(typeof wire.duration_ms === 'number' && wire.duration_ms > 0 ? { durationMs: Math.round(wire.duration_ms) } : {}),
    ...(isrc ? { isrc } : {}),
    ...(id ? { sourceId: id } : {}),
  };
}

export function createSpotifyClient(options: SpotifyClientOptions): SpotifyClient {
  const clientId = options.clientId?.trim() ?? '';
  const clientSecret = options.clientSecret?.trim() ?? '';
  if (!clientId || !clientSecret) throw new TypeError('Spotify needs a client id and client secret');
  const root = new URL(options.apiBaseUrl ?? SPOTIFY_API_BASE_URL);
  const accountsUrl = options.accountsUrl ?? SPOTIFY_ACCOUNTS_URL;
  const providerKey = SPOTIFY_PROVIDER;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(providerKey, { requestsPerSecond: Math.max(0.1, options.requestsPerSecond ?? 5), burst: 2 });
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRetries = options.maxRetries ?? 2;
  const transport = createJsonTransport({
    label: 'Spotify',
    providerKey,
    limiter,
    fetchImpl,
    headers: { Accept: 'application/json' },
    timeoutMs,
    maxRetries,
    now,
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(signal?: AbortSignal): Promise<string> {
    if (token && token.expiresAt > now().getTime()) return token.value;
    const basic = btoa(`${clientId}:${clientSecret}`);
    const send = () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      return fetchImpl(accountsUrl, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'grant_type=client_credentials',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }).catch((cause: unknown) => {
        if (signal?.aborted) throw cause;
        throw new MetadataError('unreachable', 'Spotify accounts service is unreachable', { cause });
      });
    };
    const response = await limiter.schedule(providerKey, send, { maxRetries, ...(signal ? { signal } : {}) });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new MetadataError('unauthorized', 'Spotify rejected the client id or secret', { httpStatus: response.status });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new MetadataError('bad-response', `Spotify token request answered HTTP ${response.status}`, { httpStatus: response.status });
    }
    const parsed = tokenSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new MetadataError('bad-response', 'Spotify token response has unexpected shape');
    const lifetime = (parsed.data.expires_in ?? 3600) * 1000;
    token = { value: parsed.data.access_token, expiresAt: now().getTime() + Math.max(0, lifetime - TOKEN_MARGIN_MS) };
    return token.value;
  }

  async function authed<S extends z.ZodType>(url: string, schema: S, opts: RequestOptions): Promise<z.infer<S>> {
    for (let attempt = 0; ; attempt += 1) {
      const bearer = await accessToken(opts.signal);
      try {
        return await transport.get(url, schema, { ...opts, ttlMs: 0, headers: { Authorization: `Bearer ${bearer}` } });
      } catch (err) {
        // An expired or revoked token: fetch a new one once.
        if (attempt === 0 && isMetadataError(err, 'unauthorized') && err.httpStatus === 401) {
          token = null;
          continue;
        }
        throw err;
      }
    }
  }

  async function getPlaylist(idOrUrl: string, opts: RequestOptions = {}): Promise<SourcePlaylist> {
    const id = parseSpotifyPlaylistId(idOrUrl);
    if (!id) throw new MetadataError('not-found', `Not a Spotify playlist link or id: ${idOrUrl}`);
    const meta = new URL(`v1/playlists/${id}`, root);
    meta.searchParams.set('fields', 'id,name,description,owner(display_name,id)');
    const info = await authed(meta.toString(), playlistSchema, opts);
    const tracks: SourcePlaylistTrack[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const u = new URL(`v1/playlists/${id}/tracks`, root);
      u.searchParams.set('limit', String(PAGE));
      u.searchParams.set('offset', String(offset));
      u.searchParams.set('additional_types', 'track');
      const body = await authed(u.toString(), tracksPageSchema, opts);
      for (const item of body.items) {
        const track = item.track ? mapSpotifyTrack(item.track) : undefined;
        if (track) tracks.push(track);
      }
      offset += body.items.length;
      if (body.items.length === 0 || !body.next) break;
    }
    const title = cleanText(info.name) ?? id;
    const description = cleanText(info.description);
    const owner = cleanText(info.owner?.display_name) ?? cleanText(info.owner?.id);
    return { id, title, ...(description ? { description } : {}), ...(owner ? { owner } : {}), tracks };
  }

  return { providerKey, getPlaylist };
}
