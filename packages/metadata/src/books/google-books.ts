// Google Books client (`https://www.googleapis.com/books/v1`). Works keyless at a low shared
// quota; an API key (`key=`) raises it. Volume search takes `intitle:` / `inauthor:` / `isbn:`
// qualifiers in `q`. Volumes are editions, so one work often comes back several times; the
// catalog's merge folds them together.

import { z } from 'zod';
import type { FetchLike } from '../tmdb/client.js';
import { createJsonTransport, type RequestOptions } from '../http.js';
import { defaultRateLimiter, type RateLimiter, type RequestPriority } from '../rate-limit.js';
import { MetadataError, isMetadataError } from '../types.js';
import { maybe, normalizeIsbn, stripHtml, text, toIsbn13, uniqueStrings } from '../audiobook-util.js';
import type { BookRecord } from './types.js';
import {
  bookLanguageCode,
  bookRecordKey,
  bookRecordKeys,
  genreList,
  httpsUrl,
  numberFrom,
  partialDate,
} from './util.js';

export const GOOGLE_BOOKS_DEFAULT_BASE_URL = 'https://www.googleapis.com/books/v1';
export const GOOGLE_BOOKS_PROVIDER = 'googlebooks';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

const optString = z.string().nullable().optional();

const googleVolumeSchema = z
  .object({
    id: z.string(),
    volumeInfo: z
      .object({
        title: optString,
        subtitle: optString,
        authors: z.array(z.string()).nullable().optional(),
        publisher: optString,
        publishedDate: optString,
        description: optString,
        industryIdentifiers: z
          .array(z.object({ type: optString, identifier: optString }).loose())
          .nullable()
          .optional(),
        pageCount: z.number().nullable().optional(),
        categories: z.array(z.string()).nullable().optional(),
        averageRating: z.number().nullable().optional(),
        language: optString,
        imageLinks: z.record(z.string(), z.string()).nullable().optional(),
        seriesInfo: z.unknown().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();
export type GoogleVolumeWire = z.infer<typeof googleVolumeSchema>;

const googleVolumesSchema = z
  .object({
    totalItems: z.number().nullable().optional(),
    items: z.array(googleVolumeSchema).nullable().optional(),
  })
  .loose();

/** Biggest image first; Google's `thumbnail` is the one nearly every volume has. */
const IMAGE_ORDER = ['extraLarge', 'large', 'medium', 'small', 'thumbnail', 'smallThumbnail'];

function coverFrom(links: Record<string, string> | null | undefined): string | undefined {
  if (!links) return undefined;
  for (const size of IMAGE_ORDER) {
    const url = httpsUrl(links[size]);
    if (url) return url.replace(/&edge=curl/g, '');
  }
  return undefined;
}

/** Maps one Google Books volume to a BookRecord (`gb:<id>`, `isbn:` when it has an ISBN-13). */
export function bookFromGoogleVolume(volume: GoogleVolumeWire): BookRecord | undefined {
  const info = volume.volumeInfo ?? {};
  const title = text(info.title);
  if (!title) return undefined;
  const identifiers = info.industryIdentifiers ?? [];
  const isbn13 =
    identifiers.map((i) => (i.type === 'ISBN_13' ? normalizeIsbn(i.identifier) : undefined)).find(Boolean) ??
    identifiers.map((i) => (i.type === 'ISBN_10' ? toIsbn13(i.identifier) : undefined)).find(Boolean);
  const base = {
    isbns: isbn13 ? [isbn13] : [],
    googleVolumeId: volume.id,
    ...maybe('isbn13', isbn13),
  };
  const rating = numberFrom(info.averageRating);
  return {
    key: bookRecordKey(base),
    keys: bookRecordKeys(base),
    title,
    ...maybe('subtitle', text(info.subtitle)),
    authors: uniqueStrings(info.authors ?? []).map((name) => ({ name })),
    ...base,
    ...maybe('publisher', text(info.publisher)),
    ...maybe('language', bookLanguageCode(info.language)),
    ...maybe('releaseDate', partialDate(info.publishedDate)),
    ...maybe('pageCount', numberFrom(info.pageCount)),
    ...maybe('overview', stripHtml(info.description)),
    genres: genreList(info.categories ?? []),
    ...maybe('coverUrl', coverFrom(info.imageLinks)),
    ...maybe('rating', rating === undefined ? undefined : Math.min(5, rating)),
    // Google's seriesInfo carries series ids and order numbers but no series names, so it
    // cannot be turned into a BookSeriesRef.
    series: [],
    sources: ['googleBooks'],
  };
}

export interface GoogleBooksQuery {
  /** Free text. */
  q?: string;
  title?: string;
  author?: string;
  isbn?: string;
}

export interface GoogleBooksSearchOptions extends RequestOptions {
  /** 1–40, default 20. */
  maxResults?: number;
  startIndex?: number;
}

export interface GoogleBooksPage {
  total: number;
  records: BookRecord[];
}

export interface GoogleBooksClientOptions {
  apiKey?: string;
  userAgent?: string;
  baseUrl?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  /** In-memory response cache; 0 turns it off (the book catalog keeps its own). */
  cacheTtlMs?: number;
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

export interface GoogleBooksClient {
  readonly providerKey: string;
  searchVolumes(query: GoogleBooksQuery, options?: GoogleBooksSearchOptions): Promise<GoogleBooksPage>;
  /** Throws `not-found` for an unknown volume id. */
  getVolume(id: string, options?: RequestOptions): Promise<BookRecord>;
  /** The first volume with this ISBN, or undefined. */
  byIsbn(isbn: string, options?: RequestOptions): Promise<BookRecord | undefined>;
}

function qualifier(name: string, value: string | undefined): string | undefined {
  const v = text(value)?.replace(/"/g, '');
  if (!v) return undefined;
  return /\s/.test(v) ? `${name}:"${v}"` : `${name}:${v}`;
}

/** The `q` parameter for a query: free text plus `intitle:` / `inauthor:` / `isbn:`. */
export function googleBooksQueryString(query: GoogleBooksQuery): string {
  const isbn = normalizeIsbn(query.isbn);
  return [
    text(query.q),
    qualifier('intitle', query.title),
    qualifier('inauthor', query.author),
    isbn ? `isbn:${isbn}` : undefined,
  ]
    .filter((p): p is string => p !== undefined)
    .join(' ');
}

export function createGoogleBooksClient(options: GoogleBooksClientOptions = {}): GoogleBooksClient {
  const baseUrl = (options.baseUrl ?? GOOGLE_BOOKS_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const providerKey = GOOGLE_BOOKS_PROVIDER;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  limiter.configure(providerKey, { requestsPerSecond: 1, burst: 2 });
  const apiKey = text(options.apiKey);
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const userAgent = text(options.userAgent);
  if (userAgent) headers['User-Agent'] = userAgent;
  const transport = createJsonTransport({
    label: 'Google Books',
    providerKey,
    limiter,
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    headers,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    now: options.now ?? (() => new Date()),
    defaultPriority: options.defaultPriority ?? 'interactive',
  });

  function url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${baseUrl}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') u.searchParams.set(key, String(value));
    }
    if (apiKey) u.searchParams.set('key', apiKey);
    return u.toString();
  }

  async function searchVolumes(
    query: GoogleBooksQuery,
    opts: GoogleBooksSearchOptions = {},
  ): Promise<GoogleBooksPage> {
    const q = googleBooksQueryString(query);
    if (q.length === 0) return { total: 0, records: [] };
    const { maxResults, startIndex, ...request } = opts;
    const body = await transport.get(
      url('volumes', {
        q,
        maxResults: Math.min(40, Math.max(1, Math.round(maxResults ?? 20))),
        startIndex: startIndex && startIndex > 0 ? startIndex : undefined,
        printType: 'books',
      }),
      googleVolumesSchema,
      { ...request, ttlMs },
    );
    return {
      total: Math.max(0, body.totalItems ?? 0),
      records: (body.items ?? [])
        .map(bookFromGoogleVolume)
        .filter((r): r is BookRecord => r !== undefined),
    };
  }

  return {
    providerKey,
    searchVolumes,
    async getVolume(id, opts) {
      const body = await transport.get(
        url(`volumes/${encodeURIComponent(id)}`),
        googleVolumeSchema,
        { ...opts, ttlMs },
      );
      const record = bookFromGoogleVolume(body);
      if (!record) throw new MetadataError('not-found', `Google Books volume ${id} has no title`);
      return record;
    },
    async byIsbn(isbn, opts) {
      const normalized = normalizeIsbn(isbn);
      if (!normalized) return undefined;
      try {
        const page = await searchVolumes({ isbn: normalized }, { ...opts, maxResults: 5 });
        const isbn13 = toIsbn13(normalized);
        return page.records.find((r) => r.isbn13 === isbn13) ?? page.records[0];
      } catch (err) {
        if (isMetadataError(err, 'not-found')) return undefined;
        throw err;
      }
    },
  };
}
