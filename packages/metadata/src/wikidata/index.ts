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
  /** Wikipedia REST host for a language. Defaults to `https://<lang>.wikipedia.org`. */
  wikipediaBaseUrl?: (lang: string) => string;
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

export interface ArtistSummary {
  /** Plain-text lead section of the Wikipedia article. */
  text: string;
  /** The article, for attribution ("from Wikipedia"). */
  pageUrl: string;
  lang: string;
}

export interface WikidataClient {
  /**
   * Plain-text Wikipedia summary for an artist from its MusicBrainz url-rels: a direct
   * `wikipedia` link in `lang`, else the Wikidata entity's `<lang>wiki` sitelink (English as the
   * fallback language). Undefined when there is no article.
   */
  resolveArtistSummary?(links: readonly { type: string; url: string }[], options?: RequestOptions & { lang?: string }): Promise<ArtistSummary | undefined>;
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

const sitelinksResponseSchema = z
  .object({
    entities: z
      .record(z.string(), z.object({ sitelinks: z.record(z.string(), z.object({ title: z.string() }).loose()).optional() }).loose())
      .optional(),
  })
  .loose();

const summaryResponseSchema = z
  .object({
    type: z.string().optional(),
    extract: z.string().optional(),
    content_urls: z.object({ desktop: z.object({ page: z.string().optional() }).loose().optional() }).loose().optional(),
  })
  .loose();

const LANG_RE = /^[a-z]{2,3}(?:-[a-z]+)?$/;

/** Language and title of a Wikipedia article URL (`https://en.wikipedia.org/wiki/Example_Band`). */
export function wikipediaArticleFromUrl(url: string): { lang: string; title: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = /^([a-z]{2,3}(?:-[a-z]+)?)\.(?:m\.)?wikipedia\.org$/i.exec(parsed.hostname);
  const path = /^\/wiki\/(.+)$/.exec(parsed.pathname);
  if (!host?.[1] || !path?.[1]) return undefined;
  return { lang: host[1].toLowerCase(), title: decodeURIComponent(path[1]).replace(/_/g, ' ') };
}

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

  const wikipediaBase = options.wikipediaBaseUrl ?? ((lang: string) => `https://${lang}.wikipedia.org`);

  async function wikipediaSummary(lang: string, title: string, requestOptions?: RequestOptions): Promise<ArtistSummary | undefined> {
    if (!LANG_RE.test(lang)) return undefined;
    const url = `${wikipediaBase(lang).replace(/\/+$/, '')}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const body = await transport.getOptional(url, summaryResponseSchema, { ...requestOptions, ttlMs });
    const text = body?.extract?.trim();
    // Disambiguation pages are lists of links, not a biography.
    if (!body || !text || body.type === 'disambiguation') return undefined;
    return { text, lang, pageUrl: body.content_urls?.desktop?.page ?? `${wikipediaBase(lang)}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` };
  }

  async function resolveArtistSummary(
    links: readonly { type: string; url: string }[],
    summaryOptions: RequestOptions & { lang?: string } = {},
  ): Promise<ArtistSummary | undefined> {
    const { lang: wanted = 'en', ...requestOptions } = summaryOptions;
    const langs = [...new Set([wanted.toLowerCase(), 'en'])];
    const direct = links.filter((l) => l.type === 'wikipedia').flatMap((l) => wikipediaArticleFromUrl(l.url) ?? []);
    for (const lang of langs) {
      const article = direct.find((a) => a.lang === lang);
      if (article) {
        const found = await wikipediaSummary(lang, article.title, requestOptions);
        if (found) return found;
      }
    }
    const qid = findWikidataId(links);
    if (!qid) return undefined;
    const url = new URL(apiUrl);
    url.searchParams.set('action', 'wbgetentities');
    url.searchParams.set('ids', qid);
    url.searchParams.set('props', 'sitelinks');
    url.searchParams.set('sitefilter', langs.map((l) => `${l.replace(/-/g, '_')}wiki`).join('|'));
    url.searchParams.set('format', 'json');
    const body = await transport.getOptional(url.toString(), sitelinksResponseSchema, { ...requestOptions, ttlMs });
    const sitelinks = body?.entities?.[qid]?.sitelinks ?? {};
    for (const lang of langs) {
      const title = sitelinks[`${lang.replace(/-/g, '_')}wiki`]?.title;
      if (!title) continue;
      const found = await wikipediaSummary(lang, title, requestOptions);
      if (found) return found;
    }
    return undefined;
  }

  return { getImageFileName, resolveArtistImage, resolveArtistSummary, clearCache: () => transport.clearCache() };
}
