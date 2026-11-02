import { inArray, or } from 'drizzle-orm';
import { dirname, join } from 'node:path';
import {
  AddComicSeriesRequest,
  AddEbookAuthorRequest,
  AddEbookRequest,
  type BooksSourceStatus,
  type ComicLookupResult,
  type ComicSeries,
  type Ebook,
  type EbookAuthor,
  type EbookAuthorLookupResult,
  type EbookLookupResult,
} from '@arclight/shared';
import {
  MetadataError,
  createBookCatalog,
  defaultRateLimiter,
  type AuthorWithBooks,
  type BookCatalog,
  type BookRecord,
  type BookSourceStatus,
  type CatalogResult,
  type FetchLike,
  type RateLimiter,
} from '@arclight/metadata';
import { NamingFormatError, comicRelativePath } from '@arclight/organizer';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Db } from '../../db/index.js';
import { VERSION } from '../../version.js';
import { createMetadataCacheStore } from '../metadata/cache.js';
import { PROJECT_URL } from '../metadata/music-service.js';
import { getSection } from '../settings/service.js';
import { BooksError } from './errors.js';
import {
  authorRow,
  comicSeriesRow,
  findAuthor,
  findComicSeries,
  getAuthor,
  getComicSeries,
  getEbook,
  insertAuthor,
  insertComicSeries,
  requireRootFolder,
  syncAuthorBooks,
  syncComicIssues,
  updateAuthorMetadata,
  updateComicSeriesMetadata,
} from './library.js';
import { ebooks } from './schema.js';

// Book and comic metadata for the library (docs/books.md "Metadata"): the BookCatalog of
// @arclight/metadata built from the `books.metadata` settings (rebuilt when they change), with
// `metadata_cache` as its persistent cache so a source outage serves stale answers. This file
// turns catalogue answers into add-screen candidates and library rows (add, refresh).
//
// Author keys: the catalog knows `ol:`, `hc:` and `gb-author:`; the add screen may also send
// `name:<name>` (a candidate with no id), which is looked up as `gb-author:<name>`.

/** Test seams: no live network in tests. */
export interface BooksCatalogOverrides {
  /** Replaces the whole catalog (tests that script answers). */
  catalog?: BookCatalog;
  fetchImpl?: FetchLike;
  rateLimiter?: RateLimiter;
  now?: () => Date;
}

function toSources(list: readonly BookSourceStatus[]): BooksSourceStatus[] {
  return list.map((s) => ({ source: s.source, state: s.state, ...(s.message ? { message: s.message } : {}) }));
}

/** MetadataError → BooksError (`not-found` 404, anything else 503). */
export function catalogError(err: unknown, what: string): never {
  if (err instanceof BooksError) throw err;
  if (err instanceof MetadataError) {
    if (err.code === 'not-found') throw new BooksError('NOT_FOUND', `${what} was not found in any book source`, { cause: err });
    throw new BooksError('UNAVAILABLE', err.message, { cause: err });
  }
  throw err;
}

/** `name:X` → `gb-author:X`; other keys unchanged. */
export function catalogAuthorKey(foreignId: string): { key: string; name?: string } {
  const m = /^name:(.+)$/i.exec(foreignId.trim());
  if (m) return { key: `gb-author:${m[1]!.trim()}`, name: m[1]!.trim() };
  return { key: foreignId.trim() };
}

export class BooksCatalogService {
  private built: { key: string; catalog: BookCatalog } | null = null;

  constructor(private readonly deps: { db: Db; log: Logger; overrides?: BooksCatalogOverrides }) {}

  private now(): Date {
    return this.deps.overrides?.now?.() ?? new Date();
  }

  /** The catalog for the current `books.metadata` settings. */
  catalog(): BookCatalog {
    const o = this.deps.overrides ?? {};
    if (o.catalog) return o.catalog;
    const m = getSection(this.deps.db, 'books').metadata;
    const key = JSON.stringify(m);
    if (this.built?.key === key) return this.built.catalog;
    const catalog = createBookCatalog({
      config: {
        openLibrary: m.openLibrary,
        googleBooks: m.googleBooks,
        googleBooksApiKey: m.googleBooksApiKey,
        hardcover: m.hardcover,
        hardcoverApiKey: m.hardcoverApiKey,
        comicVine: m.comicVine,
        comicVineApiKey: m.comicVineApiKey,
        metron: m.metron,
        metronUsername: m.metronUsername,
        metronPassword: m.metronPassword,
        languages: m.languages,
      },
      cache: createMetadataCacheStore(this.deps.db, o.now),
      rateLimiter: o.rateLimiter ?? defaultRateLimiter,
      userAgent: `Arclight/${VERSION} ( ${PROJECT_URL} )`,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    this.built = { key, catalog };
    return catalog;
  }

  private async call<T>(what: string, fn: (c: BookCatalog) => Promise<CatalogResult<T>>): Promise<CatalogResult<T>> {
    try {
      return await fn(this.catalog());
    } catch (err) {
      return catalogError(err, what);
    }
  }

  // -------------------------------------------------------------------------------------
  // Lookups (add screens, requests)
  // -------------------------------------------------------------------------------------

  async lookupAuthors(term: string): Promise<EbookAuthorLookupResult> {
    const { value, sources } = await this.call(`"${term}"`, (c) => c.searchAuthors(term));
    const db = this.deps.db;
    return {
      sources: toSources(sources),
      results: value.map((a) => ({
        foreignId: a.key,
        name: a.name,
        overview: a.overview ?? '',
        imageUrl: a.imageUrl ?? null,
        topWork: a.topWork ?? null,
        workCount: a.workCount ?? null,
        sources: a.sources,
        libraryId: findAuthor(db, a)?.id ?? null,
      })),
    };
  }

  /** The library ebook for a catalogue book (shared key or ISBN), if any. */
  libraryEbookId(b: Pick<BookRecord, 'key' | 'keys' | 'isbn13' | 'isbns'>): number | null {
    const keys = [...new Set([b.key, ...b.keys])];
    const isbns = [...new Set([...(b.isbn13 ? [b.isbn13] : []), ...b.isbns])];
    const db = this.deps.db;
    const direct = db
      .select({ id: ebooks.id })
      .from(ebooks)
      .where(isbns.length > 0 ? or(inArray(ebooks.foreignId, keys), inArray(ebooks.isbn13, isbns)) : inArray(ebooks.foreignId, keys))
      .get();
    if (direct) return direct.id;
    // Keys merged in by later refreshes live in the `keys` JSON array.
    const wanted = new Set(keys);
    const hit = db
      .select({ id: ebooks.id, keys: ebooks.keys })
      .from(ebooks)
      .all()
      .find((r) => r.keys.some((k) => wanted.has(k)));
    return hit?.id ?? null;
  }

  async lookupBooks(term: string): Promise<EbookLookupResult> {
    const { value, sources } = await this.call(`"${term}"`, (c) => c.searchBooks(term));
    return {
      sources: toSources(sources),
      results: value.map((b) => ({
        foreignId: b.key,
        title: b.title,
        subtitle: b.subtitle ?? null,
        authorName: b.authors[0]?.name ?? null,
        authorForeignId: b.authors[0]?.key ?? null,
        isbn13: b.isbn13 ?? null,
        year: b.releaseDate ? Number(b.releaseDate.slice(0, 4)) || null : null,
        publisher: b.publisher ?? null,
        overview: b.overview ?? '',
        coverUrl: b.coverUrl ?? null,
        series: b.series.map((s) => ({ name: s.name, position: s.position ?? null })),
        sources: b.sources,
        libraryId: this.libraryEbookId(b),
      })),
    };
  }

  async lookupComics(term: string): Promise<ComicLookupResult> {
    const { value, sources } = await this.call(`"${term}"`, (c) => c.searchComicSeries(term));
    const db = this.deps.db;
    return {
      sources: toSources(sources),
      results: value.map((s) => ({
        foreignId: s.key,
        title: s.title,
        publisher: s.publisher ?? null,
        startYear: s.startYear ?? null,
        issueCount: s.issueCount ?? null,
        overview: s.overview ?? '',
        coverUrl: s.coverUrl ?? null,
        sources: s.sources,
        libraryId: findComicSeries(db, s)?.id ?? null,
      })),
    };
  }

  // -------------------------------------------------------------------------------------
  // Add
  // -------------------------------------------------------------------------------------

  private async authorWithBooks(foreignId: string, name: string | undefined, fresh = false): Promise<AuthorWithBooks> {
    const mapped = catalogAuthorKey(foreignId);
    const nameHint = name ?? mapped.name;
    const { value } = await this.call(`author ${foreignId}`, (c) =>
      c.getAuthorWithBooks(mapped.key, { ...(nameHint ? { name: nameHint } : {}), ...(fresh ? { fresh } : {}) }),
    );
    return value;
  }

  /** Adds an author with their catalogue books (monitored per `monitorOption`). */
  async addAuthor(raw: AddEbookAuthorRequest): Promise<EbookAuthor> {
    const req = parseBody(AddEbookAuthorRequest, raw);
    const db = this.deps.db;
    requireRootFolder(db, req.rootFolderPath, 'ebook');
    const found = await this.authorWithBooks(req.foreignId, req.name);
    const now = this.now();
    const row = db.transaction((tx) =>
      insertAuthor(
        tx,
        {
          foreignId: found.author.key,
          record: found.author,
          rootFolderPath: req.rootFolderPath,
          formatProfileId: req.formatProfileId,
          monitored: req.monitored,
          monitorNewBooks: req.monitorNewBooks,
          tags: req.tags,
        },
        now,
      ),
    );
    syncAuthorBooks(db, row.id, found.books, { monitorOption: req.monitored ? req.monitorOption : 'none' }, now);
    return getAuthor(db, row.id);
  }

  /**
   * Adds one book. A new author is created with their whole bibliography, only this book
   * monitored; an existing author gets the book (monitored) next to their others.
   */
  async addEbook(raw: AddEbookRequest): Promise<Ebook> {
    const req = parseBody(AddEbookRequest, raw);
    const db = this.deps.db;
    requireRootFolder(db, req.rootFolderPath, 'ebook');
    const { value: book } = await this.call(`book ${req.foreignId}`, (c) => c.getBook(req.foreignId));
    const already = this.libraryEbookId(book);
    if (already !== null) throw new BooksError('CONFLICT', `${book.title} is already in the library`);
    const credited = book.authors[0];
    if (!credited) throw new BooksError('VALIDATION', `${book.title} has no author in the catalogue`);
    const now = this.now();
    const bookKeys = [book.key, ...book.keys];

    const existing = findAuthor(db, { key: credited.key ?? `gb-author:${credited.name}`, keys: credited.key ? [credited.key] : [], name: credited.name });
    if (existing) {
      syncAuthorBooks(db, existing.id, [book], { onlyKeys: bookKeys }, now);
      return getEbook(db, this.libraryEbookIdOrThrow(book));
    }

    let found: AuthorWithBooks;
    try {
      found = await this.authorWithBooks(credited.key ?? `name:${credited.name}`, credited.name);
    } catch (err) {
      if (!(err instanceof BooksError) || err.code !== 'NOT_FOUND') throw err;
      // No source has the author's page: create them from the book's credit alone.
      const key = credited.key ?? `gb-author:${credited.name}`;
      found = { author: { key, keys: [key], name: credited.name, sources: book.sources }, books: [] };
    }
    const records = found.books.some((b) => [b.key, ...b.keys].some((k) => bookKeys.includes(k))) ? found.books : [...found.books, book];
    const row = db.transaction((tx) => {
      const clash = findAuthor(tx, found.author);
      if (clash) return clash;
      return insertAuthor(
        tx,
        {
          foreignId: found.author.key,
          record: found.author,
          rootFolderPath: req.rootFolderPath,
          formatProfileId: req.formatProfileId,
          monitored: true,
          monitorNewBooks: 'none',
          tags: req.tags,
        },
        now,
      );
    });
    syncAuthorBooks(db, row.id, records, { onlyKeys: bookKeys }, now);
    return getEbook(db, this.libraryEbookIdOrThrow(book));
  }

  private libraryEbookIdOrThrow(book: BookRecord): number {
    const id = this.libraryEbookId(book);
    if (id === null) throw new BooksError('NOT_FOUND', `${book.title} could not be added`);
    return id;
  }

  /** The series folder from the comic folder format (sample issue 1, `cbz`). */
  comicSeriesPath(root: string, series: { title: string; startYear?: number | null; publisher?: string | null }): string {
    const naming = getSection(this.deps.db, 'books').naming;
    try {
      const rel = comicRelativePath(
        { folderFormat: naming.comicFolderFormat, fileFormat: naming.comicFileFormat },
        { seriesTitle: series.title, seriesYear: series.startYear ?? undefined, publisher: series.publisher ?? undefined, issueNumber: '1', format: 'cbz' },
      );
      return join(root, dirname(rel));
    } catch (err) {
      if (err instanceof NamingFormatError) throw new BooksError('VALIDATION', `comic folder format: ${err.message}`, { cause: err });
      throw err;
    }
  }

  async addComicSeries(raw: AddComicSeriesRequest): Promise<ComicSeries> {
    const req = parseBody(AddComicSeriesRequest, raw);
    const db = this.deps.db;
    const root = requireRootFolder(db, req.rootFolderPath, 'comic');
    const { value } = await this.call(`comic series ${req.foreignId}`, (c) => c.getComicSeries(req.foreignId));
    const now = this.now();
    const row = db.transaction((tx) =>
      insertComicSeries(
        tx,
        {
          foreignId: value.series.key,
          record: value.series,
          path: this.comicSeriesPath(root, value.series),
          rootFolderPath: root,
          formatProfileId: req.formatProfileId,
          seriesType: req.seriesType,
          monitored: req.monitored,
          monitorNewIssues: req.monitorNewIssues,
          tags: req.tags,
        },
        now,
      ),
    );
    syncComicIssues(db, row.id, value.issues, { monitorOption: req.monitored ? req.monitorOption : 'none' }, now);
    return getComicSeries(db, row.id);
  }

  // -------------------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------------------

  /** Re-reads an author and their books; returns the ids of books that are new. */
  async refreshAuthor(id: number, opts: { fresh?: boolean } = {}): Promise<number[]> {
    const db = this.deps.db;
    const row = authorRow(db, id);
    const found = await this.authorWithBooks(row.foreignId, row.name, opts.fresh ?? false);
    const now = this.now();
    updateAuthorMetadata(db, id, found.author, now);
    return syncAuthorBooks(db, id, found.books, {}, now);
  }

  /** Re-reads a comic series and its issues; returns the ids of issues that are new. */
  async refreshComicSeries(id: number, opts: { fresh?: boolean } = {}): Promise<number[]> {
    const db = this.deps.db;
    const row = comicSeriesRow(db, id);
    const { value } = await this.call(`comic series ${row.foreignId}`, (c) => c.getComicSeries(row.foreignId, opts.fresh ? { fresh: true } : {}));
    const now = this.now();
    updateComicSeriesMetadata(db, id, value.series, now);
    return syncComicIssues(db, id, value.issues, {}, now);
  }
}

/** Body validation with a VALIDATION error listing the issues. */
export function parseBody<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new BooksError('VALIDATION', r.error.issues.map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
