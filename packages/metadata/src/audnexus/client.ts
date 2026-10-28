// Audnexus client (`https://api.audnex.us`, self-hostable). Keyless; canonical Audible book,
// chapter and author records by ASIN, plus an author name search. HTTP concerns live in
// ../http.ts, shaping in ./map.ts.

import type { FetchLike } from '../tmdb/client.js';
import { MetadataError } from '../types.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import { normalizeAsin, requireAudibleRegion, type AudibleRegion } from '../audible/regions.js';
import { mapAuthor, mapAuthorSearch, mapBook, mapChapters } from './map.js';
import {
  anxAuthorSchema,
  anxAuthorSearchSchema,
  anxBookSchema,
  anxChaptersSchema,
} from './schemas.js';
import type { AnxAuthor, AnxAuthorSearchResult, AnxBook, AnxChapters } from './types.js';

export const AUDNEXUS_DEFAULT_BASE_URL = 'https://api.audnex.us';
/** Limiter bucket of the public Audnexus host. */
export const AUDNEXUS_PROVIDER = 'audnexus';

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

export interface AudnexusCacheTtls {
  book: number;
  chapters: number;
  author: number;
  search: number;
}

/** TTLs from the design (§5.3: Audnexus book 7 d). 0 disables caching for that kind. */
export const AUDNEXUS_DEFAULT_CACHE_TTLS: AudnexusCacheTtls = {
  book: 7 * DAY,
  chapters: 7 * DAY,
  author: 7 * DAY,
  search: DAY,
};

export interface AudnexusClientOptions {
  /** Defaults to the public instance; point it at a self-hosted one. */
  baseUrl?: string;
  /** Sent when given, e.g. `Arclight/0.6 ( https://project.url )`. */
  userAgent?: string;
  /** Default region for calls that pass none. Defaults to `us`. */
  region?: AudibleRegion;
  /** Requests per second. Defaults to 1. */
  requestsPerSecond?: number;
  /** Defaults to the process-wide limiter. */
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Retries after a 429/503. */
  maxRetries?: number;
  cacheTtls?: Partial<AudnexusCacheTtls>;
  /** Priority used when a call passes none. Defaults to `interactive`. */
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

export interface AudnexusRequestOptions extends RequestOptions {
  region?: AudibleRegion;
}

export interface AudnexusClient {
  /** Limiter bucket this client draws from. */
  readonly providerKey: string;
  /** One audiobook by ASIN. Throws `not-found` when the region has no such title. */
  getBook(asin: string, options?: AudnexusRequestOptions): Promise<AnxBook>;
  getChapters(asin: string, options?: AudnexusRequestOptions): Promise<AnxChapters>;
  getAuthor(asin: string, options?: AudnexusRequestOptions): Promise<AnxAuthor>;
  /** Authors whose name matches, one entry per ASIN. */
  searchAuthors(name: string, options?: AudnexusRequestOptions): Promise<AnxAuthorSearchResult[]>;
  clearCache(): void;
}

function requireAsin(value: string, what: string): string {
  const asin = normalizeAsin(value);
  if (!asin) throw new MetadataError('not-found', `${what} "${value}" is not an ASIN`);
  return asin;
}

export function createAudnexusClient(options: AudnexusClientOptions = {}): AudnexusClient {
  const baseUrl = options.baseUrl ?? AUDNEXUS_DEFAULT_BASE_URL;
  const root = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const isPublic = root.hostname.toLowerCase() === new URL(AUDNEXUS_DEFAULT_BASE_URL).hostname;
  const providerKey = isPublic ? AUDNEXUS_PROVIDER : `${AUDNEXUS_PROVIDER}@${root.host}`;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(providerKey, {
    requestsPerSecond: Math.max(0.01, options.requestsPerSecond ?? 1),
    burst: 1,
  });
  const defaultRegion = requireAudibleRegion(options.region);

  const headers: Record<string, string> = { Accept: 'application/json' };
  const userAgent = options.userAgent?.trim();
  if (userAgent) headers['User-Agent'] = userAgent;

  const ttls: AudnexusCacheTtls = { ...AUDNEXUS_DEFAULT_CACHE_TTLS, ...options.cacheTtls };
  const transport = createJsonTransport({
    label: 'Audnexus',
    providerKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  function split(opts: AudnexusRequestOptions | undefined, ttlMs: number) {
    const { region, ...rest } = opts ?? {};
    return { region: requireAudibleRegion(region ?? defaultRegion), request: { ...rest, ttlMs } };
  }

  function url(path: string, params: Record<string, string>): string {
    const u = new URL(path, root);
    for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
    return u.toString();
  }

  return {
    providerKey,
    async getBook(asin, opts) {
      const id = requireAsin(asin, 'Book');
      const { region, request } = split(opts, ttls.book);
      const body = await transport.get(url(`books/${id}`, { region }), anxBookSchema, request);
      return mapBook(body, region);
    },
    async getChapters(asin, opts) {
      const id = requireAsin(asin, 'Book');
      const { region, request } = split(opts, ttls.chapters);
      const body = await transport.get(
        url(`books/${id}/chapters`, { region }),
        anxChaptersSchema,
        request,
      );
      return mapChapters(body, region);
    },
    async getAuthor(asin, opts) {
      const id = requireAsin(asin, 'Author');
      const { region, request } = split(opts, ttls.author);
      const body = await transport.get(url(`authors/${id}`, { region }), anxAuthorSchema, request);
      return mapAuthor(body, region);
    },
    async searchAuthors(name, opts) {
      const trimmed = name.trim();
      if (trimmed.length === 0) return [];
      const { region, request } = split(opts, ttls.search);
      const body = await transport.getOptional(
        url('authors', { name: trimmed, region }),
        anxAuthorSearchSchema,
        request,
      );
      return body ? mapAuthorSearch(body) : [];
    },
    clearCache: () => transport.clearCache(),
  };
}
