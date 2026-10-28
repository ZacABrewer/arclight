// Unofficial Audible catalog client (`https://api.audible.<tld>/1.0/catalog/products`).
//
// The endpoint answers anonymous requests but is undocumented and may change or close without
// notice, so callers only see the `AudibleCatalogClient` interface and every wire field is
// optional. Two quirks seen on the live API: `page` is 0-based (page=1 skips the first page),
// and `author_asin` is ignored, so a bibliography is a search by author name filtered on the
// author ASIN afterwards.

import type { FetchLike } from '../tmdb/client.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import { isAudiobookProduct, mapProduct } from './map.js';
import {
  audibleApiBaseUrl,
  normalizeAsin,
  requireAudibleRegion,
  type AudibleRegion,
} from './regions.js';
import { audProductsResponseSchema } from './schemas.js';
import type { AudiblePage, AudibleProduct } from './types.js';
import { normalizePersonName } from '../audiobook-util.js';

/** Limiter bucket shared by every Audible marketplace. */
export const AUDIBLE_PROVIDER = 'audible';

/** Response groups needed for series, contributors, summaries, media and ratings. */
export const AUDIBLE_RESPONSE_GROUPS = [
  'contributors',
  'product_desc',
  'product_attrs',
  'media',
  'rating',
  'series',
  'category_ladders',
] as const;

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
/** Largest `num_results` the catalog accepts. */
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;
/** Safety stop for bibliography paging. */
const MAX_PAGES = 20;
const IMAGE_SIZES = '500,1024';

export interface AudibleCacheTtls {
  search: number;
  bibliography: number;
}

/** TTLs from the design (§5.3: Audible search 1 d). */
export const AUDIBLE_DEFAULT_CACHE_TTLS: AudibleCacheTtls = { search: DAY, bibliography: DAY };

export interface AudibleClientOptions {
  /** Marketplace; picks `api.audible.<tld>`. Defaults to `us`. */
  region?: AudibleRegion;
  /** Overrides the marketplace host (tests, proxies). */
  baseUrl?: string;
  userAgent?: string;
  /** Requests per second. Defaults to 2. */
  requestsPerSecond?: number;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  cacheTtls?: Partial<AudibleCacheTtls>;
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

export type AudibleSort = 'relevance' | 'newest' | 'oldest' | 'title';

export interface AudibleSearchQuery {
  title?: string;
  author?: string;
  narrator?: string;
  keywords?: string;
  /** 1-based. Defaults to 1. */
  page?: number;
  /** 1–50, default 20. */
  pageSize?: number;
  /** Defaults to relevance. */
  sort?: AudibleSort;
}

export interface AudibleSearchOptions extends RequestOptions {
  /** Keep podcasts and episodes. Defaults to false. */
  includeNonBooks?: boolean;
}

export interface AudibleBibliographyOptions extends AudibleSearchOptions {
  /** Products per request, 1–50. Defaults to 50. */
  pageSize?: number;
}

export interface AudibleAuthorRef {
  /** Author name as Audible spells it. Required: the catalog cannot filter by ASIN. */
  name: string;
  /** When given, only products credited to this ASIN are kept. */
  asin?: string;
}

export interface AudibleCatalogClient {
  readonly providerKey: string;
  readonly region: AudibleRegion;
  /** Marketplace root, e.g. `https://api.audible.co.uk`. */
  readonly baseUrl: string;
  searchProducts(
    query: AudibleSearchQuery,
    options?: AudibleSearchOptions,
  ): Promise<AudiblePage<AudibleProduct>>;
  /** Every audiobook credited to the author (all pages), newest first. */
  authorBibliography(
    author: string | AudibleAuthorRef,
    options?: AudibleBibliographyOptions,
  ): Promise<AudibleProduct[]>;
  clearCache(): void;
}

const SORTS: Record<AudibleSort, string> = {
  relevance: 'Relevance',
  newest: '-ReleaseDate',
  oldest: 'ReleaseDate',
  title: 'Title',
};

export function createAudibleClient(options: AudibleClientOptions = {}): AudibleCatalogClient {
  const region = requireAudibleRegion(options.region);
  const baseUrl = (options.baseUrl ?? audibleApiBaseUrl(region)).replace(/\/+$/, '');
  const endpoint = new URL(`${baseUrl}/1.0/catalog/products`);
  const providerKey = AUDIBLE_PROVIDER;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(providerKey, {
    requestsPerSecond: Math.max(0.01, options.requestsPerSecond ?? 2),
    burst: 1,
  });

  const headers: Record<string, string> = { Accept: 'application/json' };
  const userAgent = options.userAgent?.trim();
  if (userAgent) headers['User-Agent'] = userAgent;

  const ttls: AudibleCacheTtls = { ...AUDIBLE_DEFAULT_CACHE_TTLS, ...options.cacheTtls };
  const transport = createJsonTransport({
    label: 'Audible',
    providerKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  function url(params: Record<string, string | number | undefined>): string {
    const u = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') u.searchParams.set(key, String(value));
    }
    u.searchParams.set('response_groups', AUDIBLE_RESPONSE_GROUPS.join(','));
    u.searchParams.set('image_sizes', IMAGE_SIZES);
    return u.toString();
  }

  async function fetchPage(
    params: Record<string, string | undefined>,
    page: number,
    pageSize: number,
    sort: AudibleSort,
    opts: AudibleSearchOptions,
    ttlMs: number,
  ): Promise<{ total: number; raw: number; results: AudibleProduct[] }> {
    const { includeNonBooks = false, ...request } = opts;
    const body = await transport.get(
      url({
        ...params,
        num_results: pageSize,
        // Audible pages from 0.
        page: page - 1,
        products_sort_by: SORTS[sort],
      }),
      audProductsResponseSchema,
      { ...request, ttlMs },
    );
    const products = body.products ?? [];
    const results = products
      .map((p) => mapProduct(p, region))
      .filter((p): p is AudibleProduct => p !== undefined)
      .filter((p) => includeNonBooks || isAudiobookProduct(p));
    return { total: Math.max(0, body.total_results ?? 0), raw: products.length, results };
  }

  async function searchProducts(
    query: AudibleSearchQuery,
    opts: AudibleSearchOptions = {},
  ): Promise<AudiblePage<AudibleProduct>> {
    const params = {
      title: query.title?.trim(),
      author: query.author?.trim(),
      narrator: query.narrator?.trim(),
      keywords: query.keywords?.trim(),
    };
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE)));
    if (!Object.values(params).some((v) => v)) return { total: 0, page, pageSize, results: [] };
    const { total, results } = await fetchPage(
      params,
      page,
      pageSize,
      query.sort ?? 'relevance',
      opts,
      ttls.search,
    );
    return { total, page, pageSize, results };
  }

  async function authorBibliography(
    author: string | AudibleAuthorRef,
    options: AudibleBibliographyOptions = {},
  ): Promise<AudibleProduct[]> {
    const { pageSize: size, ...opts } = options;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(size ?? MAX_PAGE_SIZE)));
    const ref = typeof author === 'string' ? { name: author } : author;
    const name = ref.name.trim();
    if (name.length === 0) return [];
    const asin = ref.asin ? normalizeAsin(ref.asin) : undefined;
    const wanted = normalizePersonName(name);
    const out = new Map<string, AudibleProduct>();
    let seen = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { total, raw, results } = await fetchPage(
        { author: name },
        page,
        pageSize,
        'newest',
        opts,
        ttls.bibliography,
      );
      for (const product of results) {
        // The author search is fuzzy ("Andy Weir" also finds "Andy Weir bush"); keep products
        // credited to this ASIN, or to this exact name when the ASIN is unknown.
        const credited = product.authors.some((a) =>
          asin && a.asin ? a.asin === asin : normalizePersonName(a.name) === wanted,
        );
        if (credited && !out.has(product.asin)) out.set(product.asin, product);
      }
      seen += raw;
      if (raw === 0 || seen >= total) break;
    }
    return [...out.values()];
  }

  return {
    providerKey,
    region,
    baseUrl,
    searchProducts,
    authorBibliography,
    clearCache: () => transport.clearCache(),
  };
}
