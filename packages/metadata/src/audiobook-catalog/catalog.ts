// AudiobookCatalog: one lookup surface over the three audiobook sources (design §5.2).
//
//   Audible catalog — search and author bibliographies (series, narrators, runtimes)
//   Audnexus        — canonical book, author and chapter records by ASIN
//   OpenLibrary     — fallback for books/authors Audible does not know, and ISBN enrichment
//
// Results from several sources are merged with `dedupeBooks` (ASIN → ISBN → title + author).
// Persistent caching (`metadata_cache`) belongs to the API module; each client keeps its own
// in-memory TTL cache.

import type { FetchLike } from '../tmdb/client.js';
import type { RequestOptions } from '../http.js';
import { MetadataError, isMetadataError } from '../types.js';
import type { RateLimiter, RequestPriority } from '../rate-limit.js';
import {
  createAudibleClient,
  type AudibleCatalogClient,
  type AudibleSearchQuery,
} from '../audible/client.js';
import { normalizeAsin, requireAudibleRegion, type AudibleRegion } from '../audible/regions.js';
import { createAudnexusClient, type AudnexusClient } from '../audnexus/client.js';
import { createOpenLibraryClient, type OpenLibraryClient } from '../openlibrary/client.js';
import { openLibraryAuthorPhotoUrl } from '../openlibrary/covers.js';
import type { OlEdition, OlWork } from '../openlibrary/types.js';
import {
  maybe,
  normalizeIsbn,
  normalizeLanguage,
  normalizePersonName,
  toIsbn13,
} from '../audiobook-util.js';
import {
  authorFromAudnexus,
  authorFromOpenLibrary,
  authorFromOpenLibrarySearch,
  bookFromAudible,
  bookFromAudnexus,
  bookFromOpenLibrarySearch,
  bookFromOpenLibraryWork,
  dedupeAuthors,
  dedupeBooks,
  groupSeries,
  mergeAuthors,
  mergeBooks,
} from './map.js';
import type {
  CatalogAuthor,
  CatalogAuthorWithBooks,
  CatalogBook,
  CatalogChapters,
  CatalogPersonRef,
} from './types.js';

export interface CatalogRequestOptions extends RequestOptions {
  /** Audible marketplace for this call; defaults to the catalog's region. */
  region?: AudibleRegion;
  /** Overrides the catalog's language filter for this call. */
  languages?: readonly string[];
  /** Overrides the catalog's OpenLibrary fallback switch for this call. */
  openLibraryFallback?: boolean;
}

export interface CatalogSearchOptions extends CatalogRequestOptions {
  /** 1-based Audible page. */
  page?: number;
  pageSize?: number;
}

/** Orders `browseBooks` offers. */
export type CatalogBrowseSort = 'bestsellers' | 'newest';

export type CatalogBookQuery =string | { title?: string; author?: string; keywords?: string };

export interface CatalogAuthorRef {
  asin?: string;
  olid?: string;
  name?: string;
}

export interface CatalogBookRef {
  asin?: string;
  isbn?: string;
  olWorkId?: string;
}

export interface AudiobookCatalog {
  /** Audible search; OpenLibrary when Audible finds nothing (or fails). */
  searchBooks(query: CatalogBookQuery, options?: CatalogSearchOptions): Promise<CatalogBook[]>;
  /** The Audible catalogue in one order, without search terms (Discover); no OpenLibrary fallback. */
  browseBooks(sort: CatalogBrowseSort, options?: CatalogSearchOptions): Promise<CatalogBook[]>;
  /** Audnexus author search; OpenLibrary when it finds nothing (or fails). */
  searchAuthors(name: string, options?: CatalogRequestOptions): Promise<CatalogAuthor[]>;
  /** The author (Audnexus) and their books (Audible bibliography, else OpenLibrary works). */
  getAuthorWithBooks(
    ref: string | CatalogAuthorRef,
    options?: CatalogRequestOptions,
  ): Promise<CatalogAuthorWithBooks>;
  /**
   * Canonical book: Audnexus by ASIN, enriched from OpenLibrary by ISBN; OpenLibrary by ISBN or
   * work id when Audnexus has no record. A bare string is an ASIN, or an ISBN when it is one.
   * Throws `not-found` when no source knows the book.
   */
  getBook(ref: string | CatalogBookRef, options?: CatalogRequestOptions): Promise<CatalogBook>;
  getChapters(asin: string, options?: CatalogRequestOptions): Promise<CatalogChapters>;
}

export interface AudiobookCatalogDeps {
  audnexus: AudnexusClient;
  /** Audible client for a marketplace (the catalog asks once per region and keeps it). */
  audible: (region: AudibleRegion) => AudibleCatalogClient;
  /** Leave out to disable the OpenLibrary fallback entirely. */
  openLibrary?: OpenLibraryClient;
  /** Default marketplace. Defaults to `us`. */
  region?: AudibleRegion;
  /** Keep only books in these languages ("english", "eng", "en" all work). Empty = all. */
  languages?: readonly string[];
  /** Defaults to true. */
  openLibraryFallback?: boolean;
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError') && !isMetadataError(err))
  );
}

/**
 * A bare id: ISBN-13 → isbn; anything ASIN-shaped → asin (an ISBN-10 is also kept as isbn,
 * since Audible reuses ISBN-10s as ASINs for some titles).
 */
function parseBookRef(value: string): CatalogBookRef {
  const isbn = normalizeIsbn(value);
  if (isbn?.length === 13) return { isbn };
  const asin = normalizeAsin(value);
  if (asin) return { asin, ...maybe('isbn', isbn) };
  return { ...maybe('isbn', isbn ?? value) };
}

function requestPart(options: CatalogRequestOptions | undefined): RequestOptions {
  const out: RequestOptions = {};
  if (options?.priority) out.priority = options.priority;
  if (options?.signal) out.signal = options.signal;
  return out;
}

export function createAudiobookCatalog(deps: AudiobookCatalogDeps): AudiobookCatalog {
  const defaultRegion = requireAudibleRegion(deps.region);
  const audibleClients = new Map<AudibleRegion, AudibleCatalogClient>();
  const ol = deps.openLibrary;

  function audible(region: AudibleRegion): AudibleCatalogClient {
    let client = audibleClients.get(region);
    if (!client) {
      client = deps.audible(region);
      audibleClients.set(region, client);
    }
    return client;
  }

  function settings(options: CatalogRequestOptions | undefined) {
    const region = requireAudibleRegion(options?.region ?? defaultRegion);
    const languages = new Set(
      (options?.languages ?? deps.languages ?? [])
        .map((l) => normalizeLanguage(l))
        .filter((l): l is string => l !== undefined),
    );
    const fallback =
      ol !== undefined && (options?.openLibraryFallback ?? deps.openLibraryFallback ?? true);
    return { region, languages, fallback, request: requestPart(options) };
  }

  function languageFilter(languages: ReadonlySet<string>) {
    return (book: CatalogBook): boolean =>
      languages.size === 0 || book.language === undefined || languages.has(book.language);
  }

  /** Runs `fn`; a non-abort failure becomes `undefined` and is remembered in `errors`. */
  async function attempt<T>(
    errors: unknown[],
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      errors.push(err);
      return undefined;
    }
  }

  /** The first real failure, else a not-found error. */
  function failure(errors: readonly unknown[], message: string): unknown {
    return errors.find((e) => !isMetadataError(e, 'not-found')) ?? new MetadataError('not-found', message);
  }

  async function searchBooks(
    query: CatalogBookQuery,
    options: CatalogSearchOptions = {},
  ): Promise<CatalogBook[]> {
    const { region, languages, fallback, request } = settings(options);
    const q = typeof query === 'string' ? { keywords: query } : query;
    if (![q.title, q.author, q.keywords].some((v) => v?.trim())) return [];
    const keep = languageFilter(languages);
    const errors: unknown[] = [];

    const audibleQuery: AudibleSearchQuery = {
      ...maybe('title', q.title),
      ...maybe('author', q.author),
      ...maybe('keywords', q.keywords),
      ...maybe('page', options.page),
      ...maybe('pageSize', options.pageSize),
    };
    const page = await attempt(errors, request.signal, () =>
      audible(region).searchProducts(audibleQuery, request),
    );
    const fromAudible = (page?.results ?? []).map(bookFromAudible).filter(keep);
    if (fromAudible.length > 0 || !fallback || !ol) {
      if (!page && errors.length > 0) throw errors[0];
      return dedupeBooks(fromAudible);
    }

    const olPage = await attempt(errors, request.signal, () =>
      ol.searchBooks(
        {
          ...maybe('title', q.title),
          ...maybe('author', q.author),
          ...maybe('q', q.keywords),
        },
        request,
      ),
    );
    if (!page && !olPage) throw errors[0];
    return dedupeBooks((olPage?.results ?? []).map(bookFromOpenLibrarySearch).filter(keep));
  }

  async function searchAuthors(
    name: string,
    options: CatalogRequestOptions = {},
  ): Promise<CatalogAuthor[]> {
    const trimmed = name.trim();
    if (trimmed.length === 0) return [];
    const { region, fallback, request } = settings(options);
    const errors: unknown[] = [];
    const found = await attempt(errors, request.signal, () =>
      deps.audnexus.searchAuthors(trimmed, { ...request, region }),
    );
    const authors: CatalogAuthor[] = (found ?? []).map((a) => ({
      name: a.name,
      asin: a.asin,
      genres: [],
      similar: [],
      region,
      sources: ['audnexus'],
    }));
    if (authors.length > 0 || !fallback || !ol) {
      if (!found && errors.length > 0) throw errors[0];
      return dedupeAuthors(authors);
    }
    const olPage = await attempt(errors, request.signal, () => ol.searchAuthors(trimmed, request));
    if (!found && !olPage) throw errors[0];
    return dedupeAuthors((olPage?.results ?? []).map(authorFromOpenLibrarySearch));
  }

  /** OpenLibrary author (by id, else best name match) with all their works. */
  async function openLibraryAuthor(
    ref: { olid?: string; name?: string; asin?: string },
    request: RequestOptions,
    errors: unknown[],
  ): Promise<{ author: CatalogAuthor; books: CatalogBook[] } | undefined> {
    if (!ol) return undefined;
    let olid = ref.olid;
    if (!olid && ref.name) {
      const wanted = normalizePersonName(ref.name);
      const page = await attempt(errors, request.signal, () =>
        ol.searchAuthors(ref.name!, { ...request, limit: 10 }),
      );
      const match = page?.results.find((a) => normalizePersonName(a.name) === wanted);
      olid = match?.olid;
    }
    if (!olid) return undefined;
    const id = olid;
    const olAuthor = await attempt(errors, request.signal, () => ol.getAuthor(id, request));
    if (!olAuthor) return undefined;
    const author = authorFromOpenLibrary(olAuthor, (photo) =>
      openLibraryAuthorPhotoUrl({ id: photo }, { size: 'L' }),
    );
    const works = (await attempt(errors, request.signal, () => ol.allAuthorWorks(id, request))) ?? [];
    const credit: CatalogPersonRef = {
      name: author.name,
      olid: author.olid ?? id,
      ...maybe('asin', ref.asin ?? author.asin),
    };
    return {
      author,
      books: works.map((work) => bookFromOpenLibraryWork(work, undefined, [credit])),
    };
  }

  async function getAuthorWithBooks(
    ref: string | CatalogAuthorRef,
    options: CatalogRequestOptions = {},
  ): Promise<CatalogAuthorWithBooks> {
    const { region, languages, fallback, request } = settings(options);
    const r: CatalogAuthorRef =
      typeof ref === 'string' ? (normalizeAsin(ref) ? { asin: ref } : { name: ref }) : ref;
    const errors: unknown[] = [];
    const keep = languageFilter(languages);

    // 1. Resolve the Audible author (ASIN given, or best name match on Audnexus).
    let asin = r.asin ? normalizeAsin(r.asin) : undefined;
    if (!asin && r.name && !r.olid) {
      const wanted = normalizePersonName(r.name);
      const found = await attempt(errors, request.signal, () =>
        deps.audnexus.searchAuthors(r.name!, { ...request, region }),
      );
      asin = (found ?? []).find((a) => normalizePersonName(a.name) === wanted)?.asin;
    }
    let author: CatalogAuthor | undefined;
    if (asin) {
      const id = asin;
      const anx = await attempt(errors, request.signal, () =>
        deps.audnexus.getAuthor(id, { ...request, region }),
      );
      if (anx) author = authorFromAudnexus(anx);
    }

    // 2. Their Audible bibliography.
    let books: CatalogBook[] = [];
    const name = author?.name ?? r.name;
    if (name && (asin || !r.olid)) {
      const products = await attempt(errors, request.signal, () =>
        audible(region).authorBibliography({ name, ...maybe('asin', asin) }, request),
      );
      books = dedupeBooks((products ?? []).map(bookFromAudible).filter(keep));
    }

    // 3. OpenLibrary when Audible has nothing (or the author is only known there).
    if (fallback && (books.length === 0 || !author)) {
      const olRef = { ...maybe('olid', r.olid), ...maybe('name', name), ...maybe('asin', asin) };
      const fromOl = await openLibraryAuthor(olRef, request, errors);
      if (fromOl) {
        author = author ? mergeAuthors(author, fromOl.author) : fromOl.author;
        if (books.length === 0) books = dedupeBooks(fromOl.books.filter(keep));
      }
    }

    if (!author) {
      throw failure(errors, `No source knows the author ${r.asin ?? r.olid ?? r.name ?? ''}`.trim());
    }
    return { author, books, series: groupSeries(books) };
  }

  async function enrichFromIsbn(
    book: CatalogBook,
    request: RequestOptions,
    errors: unknown[],
  ): Promise<CatalogBook> {
    if (!ol) return book;
    for (const isbn of book.isbns.slice(0, 3)) {
      const edition = await attempt(errors, request.signal, () => ol.byIsbn(isbn, request));
      if (!edition) continue;
      return mergeBooks(book, await bookFromEdition(edition, request, errors));
    }
    return book;
  }

  async function bookFromEdition(
    edition: OlEdition,
    request: RequestOptions,
    errors: unknown[],
  ): Promise<CatalogBook> {
    const workId = edition.workOlids[0];
    let work: OlWork | undefined;
    if (workId && ol) work = await attempt(errors, request.signal, () => ol.getWork(workId, request));
    return bookFromOpenLibraryWork(work, edition);
  }

  async function getBook(
    ref: string | CatalogBookRef,
    options: CatalogRequestOptions = {},
  ): Promise<CatalogBook> {
    const { region, fallback, request } = settings(options);
    const r = typeof ref === 'string' ? parseBookRef(ref) : ref;
    const errors: unknown[] = [];

    if (r.asin) {
      const asin = r.asin;
      const anx = await attempt(errors, request.signal, () =>
        deps.audnexus.getBook(asin, { ...request, region }),
      );
      if (anx) {
        let book = bookFromAudnexus(anx);
        const extraIsbn = toIsbn13(r.isbn);
        if (extraIsbn && !book.isbns.includes(extraIsbn)) {
          book = { ...book, isbns: [...book.isbns, extraIsbn] };
        }
        return fallback ? enrichFromIsbn(book, request, errors) : book;
      }
    }

    if (fallback && ol) {
      const isbn = r.isbn ? normalizeIsbn(r.isbn) : undefined;
      if (isbn) {
        const edition = await attempt(errors, request.signal, () => ol.byIsbn(isbn, request));
        if (edition) {
          const book = await bookFromEdition(edition, request, errors);
          return r.asin ? { ...book, asin: normalizeAsin(r.asin) ?? r.asin } : book;
        }
      }
      if (r.olWorkId) {
        const workId = r.olWorkId;
        const work = await attempt(errors, request.signal, () => ol.getWork(workId, request));
        if (work) return bookFromOpenLibraryWork(work, undefined);
      }
    }

    throw failure(errors, `No source knows the book ${r.asin ?? r.isbn ?? r.olWorkId ?? ''}`.trim());
  }

  async function browseBooks(sort: CatalogBrowseSort, options: CatalogSearchOptions = {}): Promise<CatalogBook[]> {
    const { region, languages, request } = settings(options);
    const page = await audible(region).browseProducts(
      { sort, ...maybe('page', options.page), ...maybe('pageSize', options.pageSize) },
      request,
    );
    return dedupeBooks(page.results.map(bookFromAudible).filter(languageFilter(languages)));
  }

  return {
    searchBooks,
    searchAuthors,
    browseBooks,
    getAuthorWithBooks,
    getBook,
    getChapters(asin, options = {}) {
      const { region, request } = settings(options);
      return deps.audnexus.getChapters(asin, { ...request, region });
    },
  };
}

export interface DefaultAudiobookCatalogOptions {
  /** Sent to every source; required by OpenLibrary. `App/version ( project-url )`. */
  userAgent: string;
  /** Default Audible marketplace (`audiobookMetadata.audibleRegion`). */
  region?: AudibleRegion;
  /** Self-hosted Audnexus (`audiobookMetadata.audnexusBaseUrl`). */
  audnexusBaseUrl?: string;
  /** Overrides the Audible host per region (tests, proxies). */
  audibleBaseUrl?: (region: AudibleRegion) => string;
  openLibraryBaseUrl?: string;
  /** `audiobookMetadata.openLibraryFallback`. Defaults to true. */
  openLibraryFallback?: boolean;
  /** `audiobookMetadata.languages`. */
  languages?: readonly string[];
  requestsPerSecond?: { audnexus?: number; audible?: number; openLibrary?: number };
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  defaultPriority?: RequestPriority;
  now?: () => Date;
}

/** The §5.2 default: Audible + Audnexus + OpenLibrary on the shared rate limiter. */
export function createDefaultAudiobookCatalog(
  options: DefaultAudiobookCatalogOptions,
): AudiobookCatalog {
  const userAgent = typeof options?.userAgent === 'string' ? options.userAgent.trim() : '';
  if (userAgent.length === 0) {
    throw new TypeError('The audiobook catalog requires a User-Agent (OpenLibrary asks for one)');
  }
  const shared = {
    userAgent,
    ...maybe('rateLimiter', options.rateLimiter),
    ...maybe('fetchImpl', options.fetchImpl),
    ...maybe('timeoutMs', options.timeoutMs),
    ...maybe('maxRetries', options.maxRetries),
    ...maybe('defaultPriority', options.defaultPriority),
    ...maybe('now', options.now),
  };
  const rates = options.requestsPerSecond ?? {};
  const audnexus = createAudnexusClient({
    ...shared,
    ...maybe('baseUrl', options.audnexusBaseUrl),
    ...maybe('region', options.region),
    ...maybe('requestsPerSecond', rates.audnexus),
  });
  const openLibrary =
    options.openLibraryFallback === false
      ? undefined
      : createOpenLibraryClient({
          ...shared,
          ...maybe('baseUrl', options.openLibraryBaseUrl),
          ...maybe('requestsPerSecond', rates.openLibrary),
        });
  return createAudiobookCatalog({
    audnexus,
    audible: (region) =>
      createAudibleClient({
        ...shared,
        region,
        ...maybe('baseUrl', options.audibleBaseUrl?.(region)),
        ...maybe('requestsPerSecond', rates.audible),
      }),
    ...maybe('openLibrary', openLibrary),
    ...maybe('region', options.region),
    ...maybe('languages', options.languages),
    ...maybe('openLibraryFallback', options.openLibraryFallback),
  });
}
