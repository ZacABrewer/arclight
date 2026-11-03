// Hardcover client (`https://api.hardcover.app/v1/graphql`). GraphQL over POST with a personal
// API token (`authorization: Bearer <token>`). Hardcover's schema is young and still moves,
// so every document lives in HARDCOVER_QUERIES with a minimal twin: when the server rejects a
// full document as invalid (a field was renamed or removed) the client retries the minimal one,
// and the Zod schemas below accept almost anything so missing fields only drop data.
// `search` answers loosely-typed JSON (a Typesense result), validated defensively.

import { z } from 'zod';
import type { FetchLike } from '../tmdb/client.js';
import type { RequestOptions } from '../http.js';
import { MetadataError } from '../types.js';
import {
  defaultRateLimiter,
  isThrottleStatus,
  type RateLimiter,
  type RequestPriority,
} from '../rate-limit.js';
import { maybe, normalizeIsbn, stripHtml, text, toIsbn13, uniqueStrings } from '../audiobook-util.js';
import type { BookAuthorRecord, BookRecord, BookSeriesRef } from './types.js';
import {
  bookRecordKey,
  bookRecordKeys,
  genreList,
  httpsUrl,
  idString,
  isbn13List,
  numberFrom,
  partialDate,
} from './util.js';
import { readLimitedJson } from '../body.js';

export const HARDCOVER_DEFAULT_URL = 'https://api.hardcover.app/v1/graphql';
export const HARDCOVER_PROVIDER = 'hardcover';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// GraphQL documents (the only place Hardcover field names are spelled out)

const BOOK_FIELDS = `
  id title subtitle description release_date release_year pages rating
  cached_contributors cached_tags
  contributions { contribution author { id name } }
  book_series { position series { id name } }
  editions(limit: 25) { isbn_13 isbn_10 }
  image { url }`;

const BOOK_FIELDS_MINIMAL = `
  id title subtitle description release_date pages rating
  contributions { author { id name } }
  image { url }`;

const AUTHOR_BOOK_FIELDS = `
  id title subtitle release_date release_year pages rating
  contributions { contribution author { id name } }
  book_series { position series { id name } }
  image { url }`;

export const HARDCOVER_QUERIES = {
  search: `query ArclightSearch($query: String!, $type: String!, $perPage: Int!) {
  search(query: $query, query_type: $type, per_page: $perPage, page: 1) { results }
}`,
  bookById: `query ArclightBook($id: Int!) {
  books(where: { id: { _eq: $id } }, limit: 1) { ${BOOK_FIELDS} }
}`,
  bookByIdMinimal: `query ArclightBookMinimal($id: Int!) {
  books(where: { id: { _eq: $id } }, limit: 1) { ${BOOK_FIELDS_MINIMAL} }
}`,
  bookByIsbn: `query ArclightBookByIsbn($isbn: String!) {
  editions(where: { isbn_13: { _eq: $isbn } }, limit: 1) { isbn_13 book { ${BOOK_FIELDS} } }
}`,
  bookByIsbnMinimal: `query ArclightBookByIsbnMinimal($isbn: String!) {
  editions(where: { isbn_13: { _eq: $isbn } }, limit: 1) { isbn_13 book { ${BOOK_FIELDS_MINIMAL} } }
}`,
  authorById: `query ArclightAuthor($id: Int!) {
  authors(where: { id: { _eq: $id } }, limit: 1) {
    id name bio books_count image { url }
    contributions(limit: 500) { contribution book { ${AUTHOR_BOOK_FIELDS} } }
  }
}`,
  authorByIdMinimal: `query ArclightAuthorMinimal($id: Int!) {
  authors(where: { id: { _eq: $id } }, limit: 1) {
    id name bio image { url }
    contributions { book { id title release_date } }
  }
}`,
} as const;

// ---------------------------------------------------------------------------
// Wire schemas (all optional; Hardcover ids are ints, search documents use strings)

const optString = z.string().nullable().optional();
const optNumber = z.number().nullable().optional();
const idSchema = z.union([z.number(), z.string()]).nullable().optional();
const imageSchema = z.object({ url: optString }).loose().nullable().optional();

const contributionSchema = z
  .object({
    contribution: optString,
    author: z.object({ id: idSchema, name: optString }).loose().nullable().optional(),
  })
  .loose();

const hcBookSchema = z
  .object({
    id: idSchema,
    title: optString,
    subtitle: optString,
    description: optString,
    release_date: optString,
    release_year: optNumber,
    pages: optNumber,
    rating: optNumber,
    cached_contributors: z.unknown().optional(),
    cached_tags: z.unknown().optional(),
    contributions: z.array(contributionSchema).nullable().optional(),
    book_series: z
      .array(
        z
          .object({
            position: z.union([z.number(), z.string()]).nullable().optional(),
            series: z.object({ id: idSchema, name: optString }).loose().nullable().optional(),
          })
          .loose(),
      )
      .nullable()
      .optional(),
    editions: z
      .array(z.object({ isbn_13: optString, isbn_10: optString }).loose())
      .nullable()
      .optional(),
    image: imageSchema,
  })
  .loose();
export type HardcoverBookWire = z.infer<typeof hcBookSchema>;

const hcAuthorSchema = z
  .object({
    id: idSchema,
    name: optString,
    bio: optString,
    books_count: optNumber,
    image: imageSchema,
    contributions: z
      .array(z.object({ contribution: optString, book: hcBookSchema.nullable().optional() }).loose())
      .nullable()
      .optional(),
  })
  .loose();
export type HardcoverAuthorWire = z.infer<typeof hcAuthorSchema>;

const envelopeSchema = z
  .object({
    data: z.unknown().optional(),
    errors: z
      .array(
        z
          .object({
            message: optString,
            extensions: z.object({ code: optString }).loose().nullable().optional(),
          })
          .loose(),
      )
      .nullable()
      .optional(),
  })
  .loose();

const booksDataSchema = z.object({ books: z.array(hcBookSchema).nullable().optional() }).loose();
const editionsDataSchema = z
  .object({
    editions: z
      .array(z.object({ isbn_13: optString, book: hcBookSchema.nullable().optional() }).loose())
      .nullable()
      .optional(),
  })
  .loose();
const authorsDataSchema = z.object({ authors: z.array(hcAuthorSchema).nullable().optional() }).loose();
const searchDataSchema = z
  .object({ search: z.object({ results: z.unknown().optional() }).loose().nullable().optional() })
  .loose();

const searchBookDocSchema = z
  .object({
    id: idSchema,
    title: optString,
    subtitle: optString,
    description: optString,
    author_names: z.array(z.string()).nullable().optional(),
    contributions: z.array(contributionSchema).nullable().optional(),
    isbns: z.array(z.string()).nullable().optional(),
    release_date: optString,
    release_year: optNumber,
    pages: optNumber,
    rating: optNumber,
    image: imageSchema,
    genres: z.array(z.string()).nullable().optional(),
    series_names: z.array(z.string()).nullable().optional(),
    featured_series: z
      .object({
        position: z.union([z.number(), z.string()]).nullable().optional(),
        series: z.object({ name: optString }).loose().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

const searchAuthorDocSchema = z
  .object({
    id: idSchema,
    name: optString,
    books: z.array(z.string()).nullable().optional(),
    books_count: optNumber,
    image: imageSchema,
  })
  .loose();

/** Typesense hits (`{ hits: [{ document }] }`); anything else reads as no hits. */
function searchDocuments(results: unknown): unknown[] {
  const value = typeof results === 'string' ? safeJson(results) : results;
  if (!value || typeof value !== 'object') return [];
  const hits = (value as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => (h && typeof h === 'object' ? (h as { document?: unknown }).document : undefined));
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Mapping

const AUTHOR_ROLES = new Set(['', 'author', 'writer']);

type ContributionWire = z.infer<typeof contributionSchema>;

/** Primary authors only (no narrators, translators, illustrators, editors). */
function primaryAuthors(contributions: readonly ContributionWire[]): Array<{ name: string; key?: string }> {
  const people = contributions.flatMap((c) => {
    const name = text(c.author?.name);
    if (!name) return [];
    const id = idString(c.author?.id);
    const role = (text(c.contribution) ?? '').toLowerCase();
    return [{ name, role, ...maybe('key', id ? `hc:${id}` : undefined) }];
  });
  const authors = people.filter((p) => AUTHOR_ROLES.has(p.role));
  const chosen = authors.length > 0 ? authors : people.slice(0, 1);
  const seen = new Set<string>();
  return chosen.flatMap(({ role: _role, ...p }) => {
    const k = p.name.toLowerCase();
    if (seen.has(k)) return [];
    seen.add(k);
    return [p];
  });
}

function cachedContributions(value: unknown): ContributionWire[] {
  const parsed = z.array(contributionSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function tagGenres(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const genre = (value as Record<string, unknown>).Genre;
  if (!Array.isArray(genre)) return [];
  return genre.flatMap((t) => {
    const tag = t && typeof t === 'object' ? (t as { tag?: unknown }).tag : undefined;
    return typeof tag === 'string' ? [tag] : [];
  });
}

function position(value: number | string | null | undefined): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  return text(value);
}

function rating(value: number | null | undefined): number | undefined {
  const r = numberFrom(value);
  return r === undefined ? undefined : Math.min(5, r);
}

/** Maps a Hardcover `books` row. `isbn13` pins the edition the caller looked up. */
export function bookFromHardcover(wire: HardcoverBookWire, opts: { isbn13?: string } = {}): BookRecord | undefined {
  const id = idString(wire.id);
  const title = text(wire.title);
  if (!id || !title) return undefined;
  const contributions = wire.contributions?.length
    ? wire.contributions
    : cachedContributions(wire.cached_contributors);
  const isbns = isbn13List([
    opts.isbn13,
    ...(wire.editions ?? []).flatMap((e) => [e.isbn_13, e.isbn_10]),
  ]);
  const isbn13 = toIsbn13(opts.isbn13) ?? isbns[0];
  const series: BookSeriesRef[] = (wire.book_series ?? []).flatMap((s) => {
    const name = text(s.series?.name);
    return name ? [{ name, ...maybe('position', position(s.position)) }] : [];
  });
  const base = { isbns, hardcoverId: id, ...maybe('isbn13', isbn13) };
  return {
    key: bookRecordKey(base),
    keys: bookRecordKeys(base),
    title,
    ...maybe('subtitle', text(wire.subtitle)),
    authors: primaryAuthors(contributions),
    ...base,
    ...maybe('releaseDate', partialDate(wire.release_date) ?? partialDate(wire.release_year)),
    ...maybe('pageCount', numberFrom(wire.pages)),
    ...maybe('overview', stripHtml(wire.description)),
    genres: genreList(tagGenres(wire.cached_tags)),
    ...maybe('coverUrl', httpsUrl(wire.image?.url)),
    ...maybe('rating', rating(wire.rating)),
    series,
    sources: ['hardcover'],
  };
}

/** Maps a book document of `search(query_type: "Book")`. */
export function bookFromHardcoverSearchDoc(doc: unknown): BookRecord | undefined {
  const parsed = searchBookDocSchema.safeParse(doc);
  if (!parsed.success) return undefined;
  const d = parsed.data;
  const id = idString(d.id);
  const title = text(d.title);
  if (!id || !title) return undefined;
  const fromContributions = primaryAuthors(d.contributions ?? []);
  const authors =
    fromContributions.length > 0
      ? fromContributions
      : uniqueStrings(d.author_names ?? []).map((name) => ({ name }));
  const featured = text(d.featured_series?.series?.name);
  const series: BookSeriesRef[] = featured
    ? [{ name: featured, ...maybe('position', position(d.featured_series?.position)) }]
    : uniqueStrings(d.series_names ?? []).map((name) => ({ name }));
  const base = { isbns: isbn13List(d.isbns ?? []), hardcoverId: id };
  return {
    key: bookRecordKey(base),
    keys: bookRecordKeys(base),
    title,
    ...maybe('subtitle', text(d.subtitle)),
    authors,
    ...base,
    ...maybe('releaseDate', partialDate(d.release_date) ?? partialDate(d.release_year)),
    ...maybe('pageCount', numberFrom(d.pages)),
    ...maybe('overview', stripHtml(d.description)),
    genres: genreList(d.genres ?? []),
    ...maybe('coverUrl', httpsUrl(d.image?.url)),
    ...maybe('rating', rating(d.rating)),
    series,
    sources: ['hardcover'],
  };
}

export function authorFromHardcover(wire: HardcoverAuthorWire): BookAuthorRecord | undefined {
  const id = idString(wire.id);
  const name = text(wire.name);
  if (!id || !name) return undefined;
  return {
    key: `hc:${id}`,
    keys: [`hc:${id}`],
    name,
    ...maybe('overview', stripHtml(wire.bio)),
    ...maybe('imageUrl', httpsUrl(wire.image?.url)),
    ...maybe('workCount', numberFrom(wire.books_count)),
    hardcoverId: id,
    sources: ['hardcover'],
  };
}

/** Maps an author document of `search(query_type: "Author")`. */
export function authorFromHardcoverSearchDoc(doc: unknown): BookAuthorRecord | undefined {
  const parsed = searchAuthorDocSchema.safeParse(doc);
  if (!parsed.success) return undefined;
  const d = parsed.data;
  const id = idString(d.id);
  const name = text(d.name);
  if (!id || !name) return undefined;
  return {
    key: `hc:${id}`,
    keys: [`hc:${id}`],
    name,
    ...maybe('imageUrl', httpsUrl(d.image?.url)),
    ...maybe('topWork', text(d.books?.[0])),
    ...maybe('workCount', numberFrom(d.books_count)),
    hardcoverId: id,
    sources: ['hardcover'],
  };
}

// ---------------------------------------------------------------------------
// Client

export interface HardcoverClientOptions {
  /** API token from the Hardcover account settings, with or without `Bearer `. */
  token: string;
  userAgent?: string;
  url?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  defaultPriority?: RequestPriority;
}

export interface HardcoverSearchOptions extends RequestOptions {
  /** Default 20, max 50. */
  perPage?: number;
}

export interface HardcoverAuthorWithBooks {
  author: BookAuthorRecord;
  books: BookRecord[];
}

export interface HardcoverClient {
  readonly providerKey: string;
  searchBooks(term: string, options?: HardcoverSearchOptions): Promise<BookRecord[]>;
  searchAuthors(term: string, options?: HardcoverSearchOptions): Promise<BookAuthorRecord[]>;
  /** Undefined when Hardcover has no such book. */
  getBook(id: string, options?: RequestOptions): Promise<BookRecord | undefined>;
  byIsbn(isbn: string, options?: RequestOptions): Promise<BookRecord | undefined>;
  /** The author and the books they wrote (not narrated or translated). Undefined when unknown. */
  getAuthor(id: string, options?: RequestOptions): Promise<HardcoverAuthorWithBooks | undefined>;
}

/** `Bearer <token>` from a token pasted with or without the prefix. */
export function hardcoverAuthorization(token: string): string {
  const bare = token.trim().replace(/^bearer\s+/i, '').trim();
  return `Bearer ${bare}`;
}

function intId(id: string): number | undefined {
  const raw = id.trim().replace(/^hc:/, '');
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

const SCHEMA_DRIFT_CODES = new Set(['validation-failed', 'parse-failed']);
const AUTH_CODES = new Set(['invalid-jwt', 'invalid-headers', 'access-denied', 'unauthorized']);

class SchemaDriftError extends MetadataError {}

export function createHardcoverClient(options: HardcoverClientOptions): HardcoverClient {
  const token = text(options?.token?.replace(/^bearer\s+/i, ''));
  if (!token) throw new TypeError('Hardcover requires an API token');
  const endpoint = options.url ?? HARDCOVER_DEFAULT_URL;
  const providerKey = HARDCOVER_PROVIDER;
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  // Hardcover allows 60 requests per minute per token.
  limiter.configure(providerKey, { requestsPerSecond: 1, burst: 2 });
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const defaultPriority = options.defaultPriority ?? 'interactive';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    authorization: hardcoverAuthorization(token),
  };
  const userAgent = text(options.userAgent);
  if (userAgent) headers['User-Agent'] = userAgent;

  async function send(body: string, signal: AbortSignal | undefined): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await fetchImpl(endpoint, { method: 'POST', headers, body, signal: combined });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new MetadataError(
        'unreachable',
        timedOut ? `Hardcover request timed out after ${timeoutMs}ms` : 'Hardcover is unreachable',
        { cause },
      );
    }
  }

  async function query(document: string, variables: Record<string, unknown>, request: RequestOptions = {}): Promise<unknown> {
    const { signal } = request;
    const priority = request.priority ?? defaultPriority;
    const body = JSON.stringify({ query: document, variables });
    const response = await limiter.schedule(
      providerKey,
      () => send(body, signal),
      signal ? { priority, signal, maxRetries } : { priority, maxRetries },
    );
    if (isThrottleStatus(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new MetadataError('rate-limited', `Hardcover is throttling requests (HTTP ${response.status})`, {
        httpStatus: response.status,
      });
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new MetadataError('unauthorized', 'Hardcover rejected the API token', {
        httpStatus: response.status,
      });
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      throw new MetadataError('bad-response', 'Hardcover has no GraphQL endpoint at this URL', { httpStatus: 404 });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new MetadataError('bad-response', `Hardcover answered HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }
    let json: unknown;
    try {
      json = await readLimitedJson(response);
    } catch (cause) {
      throw new MetadataError('bad-response', 'Hardcover returned non-JSON content', { cause });
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new MetadataError('bad-response', 'Hardcover answer has unexpected shape', { cause: envelope.error });
    }
    const errors = envelope.data.errors ?? [];
    if (errors.length > 0) {
      const first = errors[0]!;
      const code = (text(first.extensions?.code) ?? '').toLowerCase();
      const message = text(first.message) ?? 'unknown error';
      if (AUTH_CODES.has(code) || /jwt|token|unauthori[sz]ed/i.test(message)) {
        throw new MetadataError('unauthorized', `Hardcover rejected the API token: ${message}`);
      }
      if (SCHEMA_DRIFT_CODES.has(code) || /not found in type|field .* not found/i.test(message)) {
        throw new SchemaDriftError('bad-response', `Hardcover rejected the query: ${message}`);
      }
      throw new MetadataError('bad-response', `Hardcover answered an error: ${message}`);
    }
    return envelope.data.data ?? {};
  }

  /** Runs the full document, then the minimal one when the schema has drifted. */
  async function queryWithFallback(
    full: string,
    minimal: string,
    variables: Record<string, unknown>,
    request?: RequestOptions,
  ): Promise<unknown> {
    try {
      return await query(full, variables, request);
    } catch (err) {
      if (!(err instanceof SchemaDriftError)) throw err;
      return query(minimal, variables, request);
    }
  }

  async function search(term: string, type: 'Book' | 'Author', opts: HardcoverSearchOptions = {}): Promise<unknown[]> {
    const trimmed = term.trim();
    if (trimmed.length === 0) return [];
    const { perPage, ...request } = opts;
    const data = searchDataSchema.safeParse(
      await query(
        HARDCOVER_QUERIES.search,
        { query: trimmed, type, perPage: Math.min(50, Math.max(1, Math.round(perPage ?? 20))) },
        request,
      ),
    );
    return data.success ? searchDocuments(data.data.search?.results) : [];
  }

  return {
    providerKey,
    async searchBooks(term, opts) {
      return (await search(term, 'Book', opts))
        .map(bookFromHardcoverSearchDoc)
        .filter((b): b is BookRecord => b !== undefined);
    },
    async searchAuthors(term, opts) {
      return (await search(term, 'Author', opts))
        .map(authorFromHardcoverSearchDoc)
        .filter((a): a is BookAuthorRecord => a !== undefined);
    },
    async getBook(id, opts) {
      const numeric = intId(id);
      if (numeric === undefined) return undefined;
      const data = booksDataSchema.safeParse(
        await queryWithFallback(HARDCOVER_QUERIES.bookById, HARDCOVER_QUERIES.bookByIdMinimal, { id: numeric }, opts),
      );
      const row = data.success ? data.data.books?.[0] : undefined;
      return row ? bookFromHardcover(row) : undefined;
    },
    async byIsbn(isbn, opts) {
      const isbn13 = toIsbn13(normalizeIsbn(isbn));
      if (!isbn13) return undefined;
      const data = editionsDataSchema.safeParse(
        await queryWithFallback(
          HARDCOVER_QUERIES.bookByIsbn,
          HARDCOVER_QUERIES.bookByIsbnMinimal,
          { isbn: isbn13 },
          opts,
        ),
      );
      const book = data.success ? data.data.editions?.[0]?.book : undefined;
      return book ? bookFromHardcover(book, { isbn13 }) : undefined;
    },
    async getAuthor(id, opts) {
      const numeric = intId(id);
      if (numeric === undefined) return undefined;
      const data = authorsDataSchema.safeParse(
        await queryWithFallback(
          HARDCOVER_QUERIES.authorById,
          HARDCOVER_QUERIES.authorByIdMinimal,
          { id: numeric },
          opts,
        ),
      );
      const row = data.success ? data.data.authors?.[0] : undefined;
      const author = row ? authorFromHardcover(row) : undefined;
      if (!row || !author) return undefined;
      const seen = new Set<string>();
      const books = (row.contributions ?? []).flatMap((c) => {
        const role = (text(c.contribution) ?? '').toLowerCase();
        if (!AUTHOR_ROLES.has(role) || !c.book) return [];
        const book = bookFromHardcover(c.book);
        if (!book || seen.has(book.hardcoverId!)) return [];
        seen.add(book.hardcoverId!);
        // The minimal document has no per-book contributors: credit the author we asked for.
        return [book.authors.length > 0 ? book : { ...book, authors: [{ name: author.name, key: author.key }] }];
      });
      return { author, books };
    },
  };
}
