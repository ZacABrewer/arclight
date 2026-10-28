// Artist images from Wikidata/Wikimedia Commons, keyless. A MusicBrainz artist carries a
// "wikidata" url-rel; the entity's P18 ("image") claim names a Commons file, and Commons'
// Special:FilePath serves a scaled thumbnail of it without another API call.

import { z } from 'zod';
import type { FetchLike } from '../tmdb/client.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';

export const WIKIDATA_DEFAULT_API_URL = 'https://www.wikidata.org/w/api.php';
export const COMMONS_BASE_URL = 'https://commons.wikimedia.org';
export const WIKIDATA_PROVIDER = 'wikidata';

const DAY = 24 * 60 * 60 * 1000;
const QID_RE = /^Q[1-9]\d*$/;
const DEFAULT_WIDTH = 1000;

export interface WikidataClientOptions {
  /** Wikimedia asks every client for a descriptive User-Agent with contact information. */
  userAgent: string;
  apiUrl?: string;
  commonsBaseUrl?: string;
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

export interface ArtistImage {
  wikidataId: string;
  /** Commons file name, e.g. "Example band 2020.jpg". */
  fileName: string;
  /** Thumbnail URL (redirects to upload.wikimedia.org). */
  url: string;
  /** Commons file page, for attribution. */
  pageUrl: string;
}

export interface ResolveImageOptions extends RequestOptions {
  /** Thumbnail width in pixels. Defaults to 1000. */
  width?: number;
}

export interface WikidataClient {
  /** Commons file name of the entity's P18 image, if any. */
  getImageFileName(wikidataId: string, options?: RequestOptions): Promise<string | undefined>;
  /** Image for an artist from its MusicBrainz url-rels; undefined when there is none. */
  resolveArtistImage(
    links: readonly { type: string; url: string }[],
    options?: ResolveImageOptions,
  ): Promise<ArtistImage | undefined>;
  clearCache(): void;
}

const claimSchema = z
  .object({
    rank: z.string().optional(),
    mainsnak: z
      .object({
        snaktype: z.string().optional(),
        datavalue: z.object({ value: z.unknown() }).loose().optional(),
      })
      .loose(),
  })
  .loose();

const claimsResponseSchema = z
  .object({
    claims: z.record(z.string(), z.array(claimSchema)).optional(),
    error: z.object({ code: z.string().optional(), info: z.string().optional() }).loose().optional(),
  })
  .loose();

/** "Q44190" from a Wikidata entity URL (wiki page, entity URI or mobile page). */
export function wikidataIdFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!/(^|\.)wikidata\.org$/i.test(parsed.hostname)) return undefined;
  const match = /\/(?:wiki|entity)\/(?:Special:EntityPage\/)?(Q[1-9]\d*)\/?$/.exec(parsed.pathname);
  return match?.[1];
}

/** First Wikidata id among MusicBrainz url-rels. */
export function findWikidataId(
  links: readonly { type: string; url: string }[],
): string | undefined {
  for (const link of links) {
    if (link.type !== 'wikidata') continue;
    const id = wikidataIdFromUrl(link.url);
    if (id) return id;
  }
  return undefined;
}

function commonsName(fileName: string): string {
  return encodeURIComponent(fileName.replace(/ /g, '_'));
}

/** Scaled thumbnail URL of a Commons file via Special:FilePath. */
export function commonsThumbnailUrl(
  fileName: string,
  width: number = DEFAULT_WIDTH,
  baseUrl: string = COMMONS_BASE_URL,
): string {
  const root = baseUrl.replace(/\/+$/, '');
  const w = Math.max(1, Math.round(width));
  return `${root}/wiki/Special:FilePath/${commonsName(fileName)}?width=${w}`;
}

export function commonsFilePageUrl(fileName: string, baseUrl: string = COMMONS_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, '')}/wiki/File:${commonsName(fileName)}`;
}

/** Preferred-rank P18 first, then normal; deprecated and value-less claims are skipped. */
function pickImage(claims: z.infer<typeof claimSchema>[]): string | undefined {
  const rankOrder = (rank: string | undefined) => (rank === 'preferred' ? 0 : 1);
  const usable = claims
    .filter((c) => c.rank !== 'deprecated' && (c.mainsnak.snaktype ?? 'value') === 'value')
    .sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank));
  for (const claim of usable) {
    const value = claim.mainsnak.datavalue?.value;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function createWikidataClient(options: WikidataClientOptions): WikidataClient {
  const userAgent = typeof options?.userAgent === 'string' ? options.userAgent.trim() : '';
  if (userAgent.length === 0) {
    throw new TypeError('Wikidata requests need a descriptive User-Agent');
  }
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(WIKIDATA_PROVIDER, {
    requestsPerSecond: Math.max(0.01, options.requestsPerSecond ?? 2),
  });
  const apiUrl = options.apiUrl ?? WIKIDATA_DEFAULT_API_URL;
  const commonsBase = options.commonsBaseUrl ?? COMMONS_BASE_URL;
  const ttlMs = options.cacheTtlMs ?? 7 * DAY;
  const transport = createJsonTransport({
    label: 'Wikidata',
    providerKey: WIKIDATA_PROVIDER,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    timeoutMs: options.timeoutMs ?? 15_000,
    maxRetries: options.maxRetries ?? 3,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'background',
  });

  async function getImageFileName(
    wikidataId: string,
    requestOptions?: RequestOptions,
  ): Promise<string | undefined> {
    if (!QID_RE.test(wikidataId)) return undefined;
    const url = new URL(apiUrl);
    url.searchParams.set('action', 'wbgetclaims');
    url.searchParams.set('entity', wikidataId);
    url.searchParams.set('property', 'P18');
    url.searchParams.set('format', 'json');
    const body = await transport.getOptional(url.toString(), claimsResponseSchema, {
      ...requestOptions,
      ttlMs,
    });
    if (!body || body.error) return undefined;
    return pickImage(body.claims?.P18 ?? []);
  }

  async function resolveArtistImage(
    links: readonly { type: string; url: string }[],
    resolveOptions: ResolveImageOptions = {},
  ): Promise<ArtistImage | undefined> {
    const wikidataId = findWikidataId(links);
    if (!wikidataId) return undefined;
    const { width, ...requestOptions } = resolveOptions;
    const fileName = await getImageFileName(wikidataId, requestOptions);
    if (!fileName) return undefined;
    return {
      wikidataId,
      fileName,
      url: commonsThumbnailUrl(fileName, width ?? DEFAULT_WIDTH, commonsBase),
      pageUrl: commonsFilePageUrl(fileName, commonsBase),
    };
  }

  return { getImageFileName, resolveArtistImage, clearCache: () => transport.clearCache() };
}
