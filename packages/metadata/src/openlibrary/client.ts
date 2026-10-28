// OpenLibrary client (`https://openlibrary.org`). Keyless; OpenLibrary asks API users for an
// identifying User-Agent and a gentle rate (1 req/s here), so construction fails without one.
// HTTP concerns live in ../http.ts, shaping in ./map.ts.

import type { FetchLike } from '../tmdb/client.js';
import { MetadataError } from '../types.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import { normalizeIsbn } from '../audiobook-util.js';
import {
  mapAuthor,
  mapAuthorSearchDoc,
  mapBookSearchDoc,
  mapEdition,
  mapWork,
  olidFromKey,
} from './map.js';
import {
  olAuthorSchema,
  olAuthorSearchSchema,
  olBookSearchSchema,
  olEditionSchema,
  olWorkSchema,
  olWorksPageSchema,
} from './schemas.js';
import type {
  OlAuthor,
  OlAuthorSearchResult,
  OlBookSearchResult,
  OlEdition,
  OlPage,
  OlWork,
} from './types.js';

export const OPENLIBRARY_DEFAULT_BASE_URL = 'https://openlibrary.org';
export const OPENLIBRARY_PROVIDER = 'openlibrary';

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const WORKS_PAGE_SIZE = 100;
/** Safety stop for `allAuthorWorks` (50 × 100 = 5 000 works). */
const MAX_PAGES = 50;
const SEARCH_FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'author_key',
  'first_publish_year',
  'isbn',
  'cover_i',
  'language',
  'publisher',
  'edition_count',
  'subject',
  'id_amazon',
].join(',');

export interface OpenLibraryCacheTtls {
  /** Authors, works, editions. */
  record: number;
  search: number;
  works: number;
}

/** TTLs from the design (§5.3: OpenLibrary 30 d); searches are kept 1 d. */
export const OPENLIBRARY_DEFAULT_CACHE_TTLS: OpenLibraryCacheTtls = {
  record: 30 * DAY,
  search: DAY,
  works: 30 * DAY,
};

export interface OpenLibraryClientOptions {
  /** Required: `App/version ( contact-url )`. */
  userAgent: string;
  baseUrl?: string;
  /** Requests per second. Defaults to 1. */
  requestsPerSecond?: number;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  cacheTtls?: Partial<OpenLibraryCacheTtls>;
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

export interface OlPageOptions extends RequestOptions {
  /** Default 20 for searches, 100 for works; max 100 / 1000. */
  limit?: number;
  offset?: number;
}

export interface OlBookQuery {
  title?: string;
  author?: string;
  /** Free text. */
  q?: string;
}

export interface OpenLibraryClient {
  readonly providerKey: string;
  searchAuthors(name: string, options?: OlPageOptions): Promise<OlPage<OlAuthorSearchResult>>;
  /** Work search (one result per work, with all its editions' ISBNs). */
  searchBooks(query: OlBookQuery, options?: OlPageOptions): Promise<OlPage<OlBookSearchResult>>;
  getAuthor(olid: string, options?: RequestOptions): Promise<OlAuthor>;
  /** One page of the author's works. */
  authorWorks(olid: string, options?: OlPageOptions): Promise<OlPage<OlWork>>;
  /** Every work of the author (all pages). */
  allAuthorWorks(olid: string, options?: RequestOptions): Promise<OlWork[]>;
  getWork(olid: string, options?: RequestOptions): Promise<OlWork>;
  getEdition(olid: string, options?: RequestOptions): Promise<OlEdition>;
  /** The edition with this ISBN-10/13, or undefined when OpenLibrary has none. */
  byIsbn(isbn: string, options?: RequestOptions): Promise<OlEdition | undefined>;
  clearCache(): void;
}

function requireOlid(value: string, suffix: 'A' | 'W' | 'M', what: string): string {
  const olid = olidFromKey(value);
  if (!olid || !olid.endsWith(suffix)) {
    throw new MetadataError('not-found', `${what} "${value}" is not an OpenLibrary id`);
  }
  return olid;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, Math.round(value ?? fallback)));
}

export function createOpenLibraryClient(options: OpenLibraryClientOptions): OpenLibraryClient {
  const userAgent = typeof options?.userAgent === 'string' ? options.userAgent.trim() : '';
  if (userAgent.length === 0) {
    throw new TypeError(
      'OpenLibrary requires a User-Agent such as "Arclight/1.0 ( https://project.url )"',
    );
  }
  const baseUrl = options.baseUrl ?? OPENLIBRARY_DEFAULT_BASE_URL;
  const root = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const isPublic = root.hostname.toLowerCase() === 'openlibrary.org';
  const providerKey = isPublic ? OPENLIBRARY_PROVIDER : `${OPENLIBRARY_PROVIDER}@${root.host}`;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(providerKey, {
    requestsPerSecond: Math.max(0.01, options.requestsPerSecond ?? 1),
    burst: 1,
  });

  const ttls: OpenLibraryCacheTtls = { ...OPENLIBRARY_DEFAULT_CACHE_TTLS, ...options.cacheTtls };
  const transport = createJsonTransport({
    label: 'OpenLibrary',
    providerKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  function url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(path, root);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') u.searchParams.set(key, String(value));
    }
    return u.toString();
  }

  async function authorWorks(olid: string, opts: OlPageOptions = {}): Promise<OlPage<OlWork>> {
    const id = requireOlid(olid, 'A', 'Author');
    const { limit, offset = 0, ...request } = opts;
    const body = await transport.get(
      url(`authors/${id}/works.json`, { limit: clamp(limit, WORKS_PAGE_SIZE, 1000), offset }),
      olWorksPageSchema,
      { ...request, ttlMs: ttls.works },
    );
    const entries = body.entries ?? [];
    return {
      total: Math.max(entries.length + offset, body.size ?? 0),
      offset,
      results: entries.map(mapWork),
    };
  }

  return {
    providerKey,
    async searchAuthors(name, opts = {}) {
      const trimmed = name.trim();
      if (trimmed.length === 0) return { total: 0, offset: 0, results: [] };
      const { limit, offset = 0, ...request } = opts;
      const body = await transport.get(
        url('search/authors.json', { q: trimmed, limit: clamp(limit, 20, 100), offset }),
        olAuthorSearchSchema,
        { ...request, ttlMs: ttls.search },
      );
      return {
        total: Math.max(0, body.numFound ?? 0),
        offset: body.start ?? offset,
        results: (body.docs ?? [])
          .map(mapAuthorSearchDoc)
          .filter((a): a is OlAuthorSearchResult => a !== undefined),
      };
    },
    async searchBooks(query, opts = {}) {
      const params = { title: query.title?.trim(), author: query.author?.trim(), q: query.q?.trim() };
      if (!Object.values(params).some((v) => v)) return { total: 0, offset: 0, results: [] };
      const { limit, offset = 0, ...request } = opts;
      const body = await transport.get(
        url('search.json', { ...params, fields: SEARCH_FIELDS, limit: clamp(limit, 20, 100), offset }),
        olBookSearchSchema,
        { ...request, ttlMs: ttls.search },
      );
      return {
        total: Math.max(0, body.numFound ?? 0),
        offset: body.start ?? offset,
        results: (body.docs ?? [])
          .map(mapBookSearchDoc)
          .filter((b): b is OlBookSearchResult => b !== undefined),
      };
    },
    async getAuthor(olid, opts) {
      const id = requireOlid(olid, 'A', 'Author');
      const body = await transport.get(url(`authors/${id}.json`), olAuthorSchema, {
        ...opts,
        ttlMs: ttls.record,
      });
      return mapAuthor(body);
    },
    authorWorks,
    async allAuthorWorks(olid, opts = {}) {
      const out = new Map<string, OlWork>();
      let offset = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await authorWorks(olid, { ...opts, limit: WORKS_PAGE_SIZE, offset });
        for (const work of result.results) if (!out.has(work.olid)) out.set(work.olid, work);
        offset += result.results.length;
        if (result.results.length === 0 || offset >= result.total) break;
      }
      return [...out.values()];
    },
    async getWork(olid, opts) {
      const id = requireOlid(olid, 'W', 'Work');
      const body = await transport.get(url(`works/${id}.json`), olWorkSchema, {
        ...opts,
        ttlMs: ttls.record,
      });
      return mapWork(body);
    },
    async getEdition(olid, opts) {
      const id = requireOlid(olid, 'M', 'Edition');
      const body = await transport.get(url(`books/${id}.json`), olEditionSchema, {
        ...opts,
        ttlMs: ttls.record,
      });
      return mapEdition(body);
    },
    async byIsbn(isbn, opts) {
      const normalized = normalizeIsbn(isbn);
      if (!normalized) return undefined;
      // OpenLibrary redirects /isbn/{isbn}.json to /books/{olid}.json; fetch follows it.
      const body = await transport.getOptional(url(`isbn/${normalized}.json`), olEditionSchema, {
        ...opts,
        ttlMs: ttls.record,
      });
      return body ? mapEdition(body) : undefined;
    },
    clearCache: () => transport.clearCache(),
  };
}
