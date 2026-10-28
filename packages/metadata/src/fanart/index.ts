// Fanart.tv music images (`/v3/music/{mbid}`): artist thumbs, backgrounds, logos, banners
// and per-album covers. Optional: only constructed when the user supplies an API key.

import { z } from 'zod';
import type { FetchLike } from '../tmdb/client.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';

export const FANART_DEFAULT_BASE_URL = 'https://webservice.fanart.tv/v3';
export const FANART_PROVIDER = 'fanart';

const DAY = 24 * 60 * 60 * 1000;
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FanartClientOptions {
  /** Project API key (required). */
  apiKey: string;
  /** Optional personal key; gives access to newer images. */
  clientKey?: string;
  baseUrl?: string;
  /** Defaults to 2 req/s. */
  requestsPerSecond?: number;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  /** Defaults to 7 days. */
  cacheTtlMs?: number;
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

export interface FanartImage {
  id: string;
  url: string;
  likes: number;
}

export interface FanartAlbumImages {
  covers: FanartImage[];
  cdArt: FanartImage[];
}

export interface FanartArtistImages {
  artistMbid: string;
  name?: string;
  /** Square artist pictures, most liked first. */
  thumbs: FanartImage[];
  /** 16:9 wallpapers. */
  backgrounds: FanartImage[];
  /** HD (transparent PNG) logos first, then legacy logos. */
  logos: FanartImage[];
  banners: FanartImage[];
  /** Keyed by release-group MBID. */
  albums: Record<string, FanartAlbumImages>;
}

export interface FanartClient {
  /** Images for an artist; undefined when Fanart.tv has none. */
  getArtistImages(artistMbid: string, options?: RequestOptions): Promise<FanartArtistImages | undefined>;
  clearCache(): void;
}

const imageSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    url: z.string(),
    likes: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .loose();

const imageList = z.array(imageSchema).nullable().optional();

const musicResponseSchema = z
  .object({
    name: z.string().nullable().optional(),
    mbid_id: z.string().nullable().optional(),
    artistthumb: imageList,
    artistbackground: imageList,
    hdmusiclogo: imageList,
    musiclogo: imageList,
    musicbanner: imageList,
    albums: z
      .record(z.string(), z.object({ albumcover: imageList, cdart: imageList }).loose())
      .nullable()
      .optional(),
  })
  .loose();

function mapImages(list: z.infer<typeof imageList>): FanartImage[] {
  return (list ?? [])
    .map((img) => {
      const likes = Number(img.likes ?? 0);
      return { id: String(img.id), url: img.url, likes: Number.isFinite(likes) ? likes : 0 };
    })
    .sort((a, b) => b.likes - a.likes);
}

export function mapFanartMusic(
  artistMbid: string,
  body: z.infer<typeof musicResponseSchema>,
): FanartArtistImages {
  const albums: Record<string, FanartAlbumImages> = {};
  for (const [mbid, album] of Object.entries(body.albums ?? {})) {
    albums[mbid] = { covers: mapImages(album.albumcover), cdArt: mapImages(album.cdart) };
  }
  return {
    artistMbid,
    ...(body.name ? { name: body.name } : {}),
    thumbs: mapImages(body.artistthumb),
    backgrounds: mapImages(body.artistbackground),
    logos: [...mapImages(body.hdmusiclogo), ...mapImages(body.musiclogo)],
    banners: mapImages(body.musicbanner),
    albums,
  };
}

export function createFanartClient(options: FanartClientOptions): FanartClient {
  const apiKey = typeof options?.apiKey === 'string' ? options.apiKey.trim() : '';
  if (apiKey.length === 0) throw new TypeError('Fanart.tv needs an API key');
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(FANART_PROVIDER, {
    requestsPerSecond: Math.max(0.01, options.requestsPerSecond ?? 2),
  });
  const root = (options.baseUrl ?? FANART_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const ttlMs = options.cacheTtlMs ?? 7 * DAY;
  const transport = createJsonTransport({
    label: 'Fanart.tv',
    providerKey: FANART_PROVIDER,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers: { Accept: 'application/json' },
    timeoutMs: options.timeoutMs ?? 15_000,
    maxRetries: options.maxRetries ?? 3,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'background',
  });

  async function getArtistImages(
    artistMbid: string,
    requestOptions?: RequestOptions,
  ): Promise<FanartArtistImages | undefined> {
    if (!MBID_RE.test(artistMbid)) return undefined;
    const id = artistMbid.toLowerCase();
    const url = new URL(`${root}/music/${id}`);
    url.searchParams.set('api_key', apiKey);
    if (options.clientKey) url.searchParams.set('client_key', options.clientKey);
    const body = await transport.getOptional(url.toString(), musicResponseSchema, {
      ...requestOptions,
      ttlMs,
    });
    return body ? mapFanartMusic(id, body) : undefined;
  }

  return { getArtistImages, clearCache: () => transport.clearCache() };
}
