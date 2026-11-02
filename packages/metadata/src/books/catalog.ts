// BookCatalog: one lookup surface over every book and comic catalogue (docs/books.md "Metadata").
//
//   books:  OpenLibrary, Google Books, Hardcover — asked in parallel, merged by ./merge.ts
//   comics: ComicVine, Metron — linked by Metron's `cv_id`, issues merged by number
//
// No single service is load-bearing. Every source call goes through `ask`: a fresh persistent
// cache entry answers without a request; otherwise the live answer is cached; when the live
// call fails an expired entry is served (`stale`). A lookup only fails when every enabled
// source failed with nothing cached, and only reports `not-found` when every source answered.

import type { FetchLike } from '../tmdb/client.js';
import { MetadataError, isMetadataError } from '../types.js';
import type { RateLimiter } from '../rate-limit.js';
import { createOpenLibraryClient, type OpenLibraryClient } from '../openlibrary/client.js';
import { olidFromKey } from '../openlibrary/map.js';
import type { OlBookSearchResult, OlWork } from '../openlibrary/types.js';
import { normalizeIsbn, normalizePersonName, text, toIsbn13 } from '../audiobook-util.js';
import { createGoogleBooksClient, type GoogleBooksClient } from './google-books.js';
import { createHardcoverClient, type HardcoverClient } from './hardcover.js';
import { createComicVineClient, type ComicVineClient, type ComicVineVolume } from './comicvine.js';
import { createMetronClient, type MetronClient } from './metron.js';
import {
  authorFromOpenLibrary,
  authorFromOpenLibrarySearch,
  bookFromOpenLibraryEdition,
  bookFromOpenLibrarySearchDoc,
  bookFromOpenLibraryWork,
  type OpenLibraryAuthorRef,
} from './map-openlibrary.js';
import {
  bookHasAuthor,
  filterBooksByLanguage,
  mergeAuthorRecords,
  mergeBookRecords,
  mergeComicIssues,
  mergeComicSeries,
} from './merge.js';
import type {
  AuthorWithBooks,
  BookAuthorRecord,
  BookCatalog,
  BookCatalogCache,
  BookCatalogConfig,
  BookRecord,
  BookSourceName,
  BookSourceState,
  BookSourceStatus,
  CatalogResult,
  ComicIssueRecord,
  ComicSeriesRecord,
  ComicSeriesWithIssues,
} from './types.js';

const DAY = 24 * 60 * 60 * 1000;

export interface BookCatalogTtls {
  /** Books, authors, comic series. */
  record: number;
  search: number;
  /** Comic issue lists. */
  issues: number;
}

export const BOOK_CATALOG_DEFAULT_TTLS: BookCatalogTtls = {
  record: 7 * DAY,
  search: DAY,
  issues: DAY,
};

/** `provider` names the catalog uses in the persistent cache. */
export const BOOK_CACHE_PROVIDERS: Readonly<Record<BookSourceName, string>> = {
  openLibrary: 'books-openlibrary',
  googleBooks: 'books-googlebooks',
  hardcover: 'books-hardcover',
  comicVine: 'books-comicvine',
  metron: 'books-metron',
};

const SOURCE_LABELS: Readonly<Record<BookSourceName, string>> = {
  openLibrary: 'OpenLibrary',
  googleBooks: 'Google Books',
  hardcover: 'Hardcover',
  comicVine: 'ComicVine',
  metron: 'Metron',
};

const BOOK_SOURCES: readonly BookSourceName[] = ['openLibrary', 'googleBooks', 'hardcover'];
const COMIC_SOURCES: readonly BookSourceName[] = ['comicVine', 'metron'];
const SEARCH_LIMIT = 20;
const AUTHOR_BOOK_PAGES = 2;
const GOOGLE_PAGE_SIZE = 40;

export interface BookCatalogDeps {
  config: BookCatalogConfig;
  /** Persistent cache; without one every call goes live and nothing can be served stale. */
  cache?: BookCatalogCache;
  fetchImpl?: FetchLike;
  rateLimiter?: RateLimiter;
  /** `App/version ( contact-url )`; OpenLibrary and ComicVine require one. */
  userAgent: string;
  now?: () => Date;
  /** An existing OpenLibrary client; one is created when left out. */
  openLibrary?: OpenLibraryClient;
  ttls?: Partial<BookCatalogTtls>;
}

/** One source call's outcome. `value === null` means the source answered "no such thing". */
interface Outcome<T> {
  source: BookSourceName;
  state: BookSourceState;
  value?: T | null;
  message?: string;
}

interface Clients {
  openLibrary?: OpenLibraryClient;
  googleBooks?: GoogleBooksClient;
  hardcover?: HardcoverClient;
  comicVine?: ComicVineClient;
  metron?: MetronClient;
}

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Round-robin over per-source result lists so every source's best hits come first. */
function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i += 1) for (const list of lists) if (i < list.length) out.push(list[i]!);
  return out;
}

function values<T>(outcomes: readonly Outcome<T>[]): T[] {
  return outcomes.flatMap((o) => (o.value === undefined || o.value === null ? [] : [o.value]));
}

/** Per-source status from all of that source's calls, in `order`. */
function statuses(outcomes: readonly Outcome<unknown>[], order: readonly BookSourceName[]): BookSourceStatus[] {
  const out: BookSourceStatus[] = [];
  for (const source of order) {
    const mine = outcomes.filter((o) => o.source === source);
    if (mine.length === 0) continue;
    const answered = mine.filter((o) => o.state === 'ok' || o.state === 'cached' || o.state === 'stale');
    const failed = mine.find((o) => o.state === 'failed');
    let state: BookSourceState;
    if (answered.length === 0) state = failed ? 'failed' : 'disabled';
    else if (answered.some((o) => o.state === 'stale')) state = 'stale';
    else if (answered.some((o) => o.state === 'ok')) state = 'ok';
    else state = 'cached';
    const message = (failed ?? mine.find((o) => o.message))?.message;
    out.push({ source, state, ...(message ? { message } : {}) });
  }
  return out;
}

/** Throws when every enabled source failed and nothing (not even stale cache) came back. */
function assertSomeAnswered(outcomes: readonly Outcome<unknown>[], what: string): void {
  const enabled = outcomes.filter((o) => o.state !== 'disabled');
  if (enabled.length === 0 || !enabled.every((o) => o.state === 'failed')) return;
  const detail = [...new Map(enabled.map((o) => [o.source, o.message])).entries()]
    .map(([source, message]) => `${SOURCE_LABELS[source]}: ${message ?? 'failed'}`)
    .join('; ');
  throw new MetadataError('unreachable', `${what}: every source failed (${detail})`);
}

function notFound(what: string): MetadataError {
  return new MetadataError('not-found', `No book source knows ${what}`);
}

export function createBookCatalog(deps: BookCatalogDeps): BookCatalog {
  const { config, cache } = deps;
  const now = deps.now ?? (() => new Date());
  const ttls: BookCatalogTtls = { ...BOOK_CATALOG_DEFAULT_TTLS, ...deps.ttls };
  const shared = {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.rateLimiter ? { rateLimiter: deps.rateLimiter } : {}),
    now,
  };
  const userAgent = deps.userAgent;
  const clients: Clients = {};
  const disabledReason: Partial<Record<BookSourceName, string>> = {};

  if (!config.openLibrary) disabledReason.openLibrary = 'switched off';
  else {
    clients.openLibrary =
      deps.openLibrary ??
      createOpenLibraryClient({ userAgent, ...shared, cacheTtls: { record: 0, search: 0, works: 0 } });
  }
  if (!config.googleBooks) disabledReason.googleBooks = 'switched off';
  else {
    clients.googleBooks = createGoogleBooksClient({
      userAgent,
      ...shared,
      cacheTtlMs: 0,
      ...(text(config.googleBooksApiKey) ? { apiKey: config.googleBooksApiKey! } : {}),
    });
  }
  const hardcoverToken = text(config.hardcoverApiKey);
  if (!config.hardcover) disabledReason.hardcover = 'switched off';
  else if (!hardcoverToken) disabledReason.hardcover = 'no API token';
  else clients.hardcover = createHardcoverClient({ token: hardcoverToken, userAgent, ...shared });
  const comicVineKey = text(config.comicVineApiKey);
  if (!config.comicVine) disabledReason.comicVine = 'switched off';
  else if (!comicVineKey) disabledReason.comicVine = 'no API key';
  else clients.comicVine = createComicVineClient({ apiKey: comicVineKey, userAgent, ...shared, cacheTtlMs: 0 });
  const metronUser = text(config.metronUsername);
  if (!config.metron) disabledReason.metron = 'switched off';
  else if (!metronUser || !config.metronPassword) disabledReason.metron = 'no username or password';
  else {
    clients.metron = createMetronClient({
      username: metronUser,
      password: config.metronPassword,
      userAgent,
      ...shared,
      cacheTtlMs: 0,
    });
  }

  function cacheGet<T>(source: BookSourceName, key: string, allowStale: boolean): { body: T; fresh: boolean } | undefined {
    if (!cache) return undefined;
    try {
      const entry = cache.get<T>(BOOK_CACHE_PROVIDERS[source], key, allowStale ? { allowStale: true } : undefined);
      if (!entry) return undefined;
      const fresh = Date.parse(entry.expiresAt) > now().getTime();
      return fresh || allowStale ? { body: entry.body, fresh } : undefined;
    } catch {
      return undefined;
    }
  }

  function cacheSet(source: BookSourceName, key: string, body: unknown, ttlMs: number): void {
    if (!cache || ttlMs <= 0) return;
    try {
      cache.set(BOOK_CACHE_PROVIDERS[source], key, body, ttlMs);
    } catch {
      // A cache that cannot be written only costs a future request.
    }
  }

  /** The one path every source call takes (see the header comment). */
  async function ask<T>(
    source: BookSourceName,
    key: string,
    ttlMs: number,
    run: () => Promise<T | null | undefined>,
    fresh = false,
  ): Promise<Outcome<T>> {
    if (disabledReason[source] !== undefined) {
      return { source, state: 'disabled', message: `${SOURCE_LABELS[source]} is ${disabledReason[source]}` };
    }
    if (!fresh) {
      const hit = cacheGet<T | null>(source, key, false);
      if (hit?.fresh) return { source, state: 'cached', value: hit.body };
    }
    try {
      const value = (await run()) ?? null;
      cacheSet(source, key, value, ttlMs);
      return { source, state: 'ok', value };
    } catch (err) {
      if (isMetadataError(err, 'not-found')) {
        cacheSet(source, key, null, ttlMs);
        return { source, state: 'ok', value: null };
      }
      const message = errorMessage(err);
      const stale = cacheGet<T | null>(source, key, true);
      if (stale) return { source, state: 'stale', value: stale.body, message };
      return { source, state: 'failed', message };
    }
  }

  /** `Promise.allSettled` over source calls; a call that still rejects reads as `failed`. */
  async function all<T>(calls: ReadonlyArray<[BookSourceName, Promise<Outcome<T>>]>): Promise<Outcome<T>[]> {
    const settled = await Promise.allSettled(calls.map(([, p]) => p));
    return settled.map((s, i) =>
      s.status === 'fulfilled' ? s.value : { source: calls[i]![0], state: 'failed', message: errorMessage(s.reason) },
    );
  }

  // -------------------------------------------------------------------------
  // OpenLibrary helpers

  function olAuthorRefs(doc: OlBookSearchResult | undefined): OpenLibraryAuthorRef[] {
    if (!doc) return [];
    return doc.authorNames.map((name, i) => ({ name, ...(doc.authorOlids[i] ? { olid: doc.authorOlids[i] } : {}) }));
  }

  async function olSearchDoc(q: string): Promise<OlBookSearchResult | undefined> {
    try {
      return (await clients.openLibrary!.searchBooks({ q }, { limit: 1 })).results[0];
    } catch {
      return undefined;
    }
  }

  async function olWorkOrUndefined(olid: string | undefined): Promise<OlWork | undefined> {
    if (!olid) return undefined;
    try {
      return await clients.openLibrary!.getWork(olid);
    } catch {
      return undefined;
    }
  }

  /** Edition by ISBN, its work (description, subjects) and its search doc (author names). */
  async function olBookByIsbn(isbn13: string): Promise<BookRecord | null> {
    const edition = await clients.openLibrary!.byIsbn(isbn13);
    if (!edition) return null;
    const [work, doc] = await Promise.all([
      olWorkOrUndefined(edition.workOlids[0]),
      olSearchDoc(`isbn:${isbn13}`),
    ]);
    return bookFromOpenLibraryEdition(edition, {
      ...(work ? { work } : {}),
      authors: olAuthorRefs(doc),
      lookedUpIsbn: isbn13,
    });
  }

  async function olBookById(olid: string): Promise<BookRecord | null> {
    const ol = clients.openLibrary!;
    if (olid.endsWith('M')) {
      const edition = await ol.getEdition(olid);
      const work = await olWorkOrUndefined(edition.workOlids[0]);
      const doc = work ? await olSearchDoc(`key:/works/${work.olid}`) : undefined;
      return bookFromOpenLibraryEdition(edition, { ...(work ? { work } : {}), authors: olAuthorRefs(doc) });
    }
    const [work, doc] = await Promise.all([ol.getWork(olid), olSearchDoc(`key:/works/${olid}`)]);
    const records = [bookFromOpenLibraryWork(work, olAuthorRefs(doc))];
    if (doc && doc.olid === work.olid) records.push(bookFromOpenLibrarySearchDoc(doc));
    return mergeBookRecords(records)[0] ?? null;
  }

  async function olAuthorWithBooks(olid: string): Promise<AuthorWithBooks | null> {
    const ol = clients.openLibrary!;
    // The works list has no dates or ISBNs; the work search by author key has both, so the two
    // are merged per work (the search is best effort: the works list alone still answers).
    const [author, works, docs] = await Promise.all([
      ol.getAuthor(olid),
      ol.allAuthorWorks(olid),
      ol.searchBooks({ q: `author_key:${olid}` }, { limit: 100 }).then((page) => page.results, () => []),
    ]);
    const ref = { name: author.name, olid: author.olid };
    const docByWork = new Map(docs.map((doc) => [doc.olid, doc]));
    const books = works.map((w) => {
      const record = bookFromOpenLibraryWork(w, [ref]);
      const doc = docByWork.get(w.olid);
      return doc ? (mergeBookRecords([record, bookFromOpenLibrarySearchDoc(doc)])[0] ?? record) : record;
    });
    return { author: authorFromOpenLibrary(author), books };
  }

  // -------------------------------------------------------------------------
  // Books

  function askByIsbn(source: BookSourceName, isbn13: string, fresh: boolean): Promise<Outcome<BookRecord>> {
    const key = `book:isbn:${isbn13}`;
    switch (source) {
      case 'openLibrary':
        return ask(source, key, ttls.record, () => olBookByIsbn(isbn13), fresh);
      case 'googleBooks':
        return ask(source, key, ttls.record, () => clients.googleBooks!.byIsbn(isbn13), fresh);
      default:
        return ask(source, key, ttls.record, () => clients.hardcover!.byIsbn(isbn13), fresh);
    }
  }

  /** Books a source finds for a title + author, to enrich a record that has no ISBN-13. */
  function askByTitle(source: BookSourceName, record: BookRecord, fresh: boolean): Promise<Outcome<BookRecord[]>> {
    const author = record.authors[0]?.name;
    const key = `book-match:${normalizeTerm(record.title)}|${normalizeTerm(author ?? '')}`;
    switch (source) {
      case 'openLibrary':
        return ask(
          source,
          key,
          ttls.search,
          async () =>
            (
              await clients.openLibrary!.searchBooks(
                { title: record.title, ...(author ? { author } : {}) },
                { limit: 5 },
              )
            ).results.map(bookFromOpenLibrarySearchDoc),
          fresh,
        );
      case 'googleBooks':
        return ask(
          source,
          key,
          ttls.search,
          async () =>
            (
              await clients.googleBooks!.searchVolumes(
                { title: record.title, ...(author ? { author } : {}) },
                { maxResults: 10 },
              )
            ).records,
          fresh,
        );
      default:
        return ask(
          source,
          key,
          ttls.search,
          () => clients.hardcover!.searchBooks([record.title, author].filter(Boolean).join(' '), { perPage: 10 }),
          fresh,
        );
    }
  }

  /** The merged record that contains `key`, else the first. */
  function pick(records: readonly BookRecord[], key: string): BookRecord | undefined {
    return records.find((r) => r.keys.includes(key)) ?? records[0];
  }

  async function getBookByIsbn(isbn13: string, fresh: boolean): Promise<CatalogResult<BookRecord>> {
    const outcomes = await all(BOOK_SOURCES.map((s) => [s, askByIsbn(s, isbn13, fresh)] as const));
    assertSomeAnswered(outcomes, `Book ${isbn13}`);
    const merged = pick(mergeBookRecords(values(outcomes)), `isbn:${isbn13}`);
    if (!merged) throw notFound(`ISBN ${isbn13}`);
    return { value: merged, sources: statuses(outcomes, BOOK_SOURCES) };
  }

  async function getBookById(source: BookSourceName, id: string, fresh: boolean): Promise<CatalogResult<BookRecord>> {
    const prefix = source === 'openLibrary' ? 'ol' : source === 'googleBooks' ? 'gb' : 'hc';
    const key = `${prefix}:${id}`;
    const primary = await ask<BookRecord>(
      source,
      `book:${key}`,
      ttls.record,
      () =>
        source === 'openLibrary'
          ? olBookById(id)
          : source === 'googleBooks'
            ? clients.googleBooks!.getVolume(id)
            : clients.hardcover!.getBook(id),
      fresh,
    );
    if (primary.state === 'disabled') throw new MetadataError('not-found', `${primary.message}; cannot look up ${key}`);
    assertSomeAnswered([primary], `Book ${key}`);
    const record = primary.value;
    if (!record) throw notFound(key);

    const others = BOOK_SOURCES.filter((s) => s !== source);
    const isbn13 = record.isbn13;
    const enrichment = isbn13
      ? await all(others.map((s) => [s, askByIsbn(s, isbn13, fresh)] as const))
      : await all(others.map((s) => [s, askByTitle(s, record, fresh)] as const));
    const extra = (enrichment as Outcome<BookRecord | BookRecord[]>[]).flatMap((o) =>
      o.value === undefined || o.value === null ? [] : Array.isArray(o.value) ? o.value : [o.value],
    );
    const merged = pick(mergeBookRecords([record, ...extra]), record.key) ?? record;
    return {
      value: merged,
      sources: statuses([primary, ...(enrichment as Outcome<unknown>[])], BOOK_SOURCES),
    };
  }

  // -------------------------------------------------------------------------
  // Authors

  function bestNameMatch(candidates: readonly BookAuthorRecord[], name: string): BookAuthorRecord | undefined {
    const wanted = normalizePersonName(name);
    return candidates
      .filter((c) => normalizePersonName(c.name) === wanted)
      .sort((a, b) => (b.workCount ?? 0) - (a.workCount ?? 0))[0];
  }

  function askAuthorByName(source: BookSourceName, name: string, fresh: boolean): Promise<Outcome<AuthorWithBooks>> {
    const key = `author-name:${normalizePersonName(name)}`;
    switch (source) {
      case 'openLibrary':
        return ask(
          source,
          key,
          ttls.record,
          async () => {
            const page = await clients.openLibrary!.searchAuthors(name, { limit: 5 });
            const match = bestNameMatch(page.results.map(authorFromOpenLibrarySearch), name);
            return match?.olAuthorId ? olAuthorWithBooks(match.olAuthorId) : null;
          },
          fresh,
        );
      case 'hardcover':
        return ask(
          source,
          key,
          ttls.record,
          async () => {
            const match = bestNameMatch(await clients.hardcover!.searchAuthors(name, { perPage: 5 }), name);
            return match?.hardcoverId ? clients.hardcover!.getAuthor(match.hardcoverId) : null;
          },
          fresh,
        );
      default:
        return ask(
          source,
          key,
          ttls.record,
          async () => {
            const books: BookRecord[] = [];
            for (let page = 0; page < AUTHOR_BOOK_PAGES; page += 1) {
              const result = await clients.googleBooks!.searchVolumes(
                { author: name },
                { maxResults: GOOGLE_PAGE_SIZE, startIndex: page * GOOGLE_PAGE_SIZE },
              );
              books.push(...result.records);
              if (result.records.length < GOOGLE_PAGE_SIZE) break;
            }
            return { author: googleAuthor(name), books };
          },
          fresh,
        );
    }
  }

  function googleAuthor(name: string): BookAuthorRecord {
    return { key: `gb-author:${name}`, keys: [`gb-author:${name}`], name, sources: ['googleBooks'] };
  }

  async function getAuthorWithBooks(
    key: string,
    opts: { name?: string; fresh?: boolean } = {},
  ): Promise<CatalogResult<AuthorWithBooks>> {
    const fresh = opts.fresh ?? false;
    const [prefix, ...rest] = key.split(':');
    const id = rest.join(':').trim();
    let primary: Outcome<AuthorWithBooks> | undefined;
    let primarySource: BookSourceName | undefined;
    if (prefix === 'ol') {
      const olid = olidFromKey(id);
      if (!olid?.endsWith('A')) throw notFound(key);
      primarySource = 'openLibrary';
      primary = await ask(primarySource, `author:ol:${olid}`, ttls.record, () => olAuthorWithBooks(olid), fresh);
    } else if (prefix === 'hc') {
      primarySource = 'hardcover';
      primary = await ask(primarySource, `author:hc:${id}`, ttls.record, () => clients.hardcover!.getAuthor(id), fresh);
    } else if (prefix !== 'gb-author' || id.length === 0) {
      throw notFound(key);
    }

    if (primary?.state === 'disabled' && !opts.name) {
      throw new MetadataError('not-found', `${primary.message}; cannot look up ${key}`);
    }
    if (primary?.value === null) throw notFound(key);
    const name = primary?.value?.author.name ?? text(opts.name) ?? (prefix === 'gb-author' ? id : undefined);
    if (!name) {
      assertSomeAnswered(primary ? [primary] : [], `Author ${key}`);
      throw notFound(key);
    }

    const others = BOOK_SOURCES.filter((s) => s !== primarySource);
    const enrichment = await all(others.map((s) => [s, askAuthorByName(s, name, fresh)] as const));
    const outcomes = primary ? [primary, ...enrichment] : enrichment;
    assertSomeAnswered(outcomes, `Author ${key}`);
    const found = values(outcomes);
    if (found.length === 0) throw notFound(key);

    // Every candidate was matched by name, so they are one person: merge them as one.
    const authors = mergeAuthorRecords(found.map((f) => f.author));
    const lead = authors.find((a) => a.keys.includes(key)) ?? authors[0]!;
    const author = authors.length === 1 ? lead : forceMergeAuthors(lead, authors);
    const books = filterBooksByLanguage(
      mergeBookRecords(interleave(found.map((f) => f.books))),
      config.languages,
    ).filter((b) => bookHasAuthor(b, author));
    return { value: { author, books }, sources: statuses(outcomes, BOOK_SOURCES) };
  }

  function forceMergeAuthors(lead: BookAuthorRecord, authors: readonly BookAuthorRecord[]): BookAuthorRecord {
    const rest = authors.filter((a) => a !== lead && normalizePersonName(a.name) === normalizePersonName(lead.name));
    if (rest.length === 0) return lead;
    return mergeAuthorRecords([lead, ...rest.map((a) => ({ ...a, name: lead.name }))])[0] ?? lead;
  }

  // -------------------------------------------------------------------------
  // Comics

  interface ComicSide {
    series?: ComicSeriesRecord;
    issues: ComicIssueRecord[];
  }

  function askCvVolume(id: string, fresh: boolean): Promise<Outcome<ComicVineVolume>> {
    return ask('comicVine', `comic-series:cv:${id}`, ttls.record, () => clients.comicVine!.getVolume(id), fresh);
  }

  function askCvIssues(id: string, fresh: boolean): Promise<Outcome<ComicIssueRecord[]>> {
    return ask('comicVine', `comic-issues:cv:${id}`, ttls.issues, () => clients.comicVine!.listIssues(id), fresh);
  }

  function askMetronSeries(id: string, fresh: boolean): Promise<Outcome<ComicSeriesRecord>> {
    return ask('metron', `comic-series:metron:${id}`, ttls.record, () => clients.metron!.getSeries(id), fresh);
  }

  function askMetronIssues(id: string, fresh: boolean): Promise<Outcome<ComicIssueRecord[]>> {
    return ask('metron', `comic-issues:metron:${id}`, ttls.issues, () => clients.metron!.listIssues(id), fresh);
  }

  function cvSide(volume: Outcome<ComicVineVolume>, issues: Outcome<ComicIssueRecord[]>): ComicSide {
    const v = volume.value ?? undefined;
    // The full issue list failed: the volume's own minimal list still beats nothing.
    const list = issues.value ?? v?.issues ?? [];
    return { ...(v ? { series: v.series } : {}), issues: list };
  }

  function comicResult(cv: ComicSide, metron: ComicSide, outcomes: Outcome<unknown>[], key: string): CatalogResult<ComicSeriesWithIssues> {
    const series = mergeComicSeries([cv.series, metron.series].filter((s): s is ComicSeriesRecord => s !== undefined));
    const merged = series.find((s) => s.keys.includes(key)) ?? series[0];
    if (!merged) throw new MetadataError('not-found', `No comic source knows ${key}`);
    return {
      value: { series: merged, issues: mergeComicIssues(cv.issues, metron.issues) },
      sources: statuses(outcomes, COMIC_SOURCES),
    };
  }

  async function getComicSeries(key: string, opts: { fresh?: boolean } = {}): Promise<CatalogResult<ComicSeriesWithIssues>> {
    const fresh = opts.fresh ?? false;
    const [prefix, ...rest] = key.split(':');
    const id = rest.join(':').trim();
    if (!/^\d+$/.test(id)) throw new MetadataError('not-found', `"${key}" is not a comic series key`);

    if (prefix === 'cv') {
      const [volume, cvIssues, link] = await Promise.all([
        askCvVolume(id, fresh),
        askCvIssues(id, fresh),
        ask('metron', `metron-by-cv:${id}`, ttls.record, () => clients.metron!.seriesByComicVineId(id), fresh),
      ]);
      const metronSeries = link.value ?? undefined;
      const metronIssues = metronSeries?.metronId ? await askMetronIssues(metronSeries.metronId, fresh) : undefined;
      const outcomes: Outcome<unknown>[] = [volume, cvIssues, link, ...(metronIssues ? [metronIssues] : [])];
      if (volume.state === 'disabled' && !metronSeries) {
        throw new MetadataError('not-found', `${volume.message}; cannot look up ${key}`);
      }
      assertSomeAnswered(outcomes, `Comic series ${key}`);
      if (volume.value === null) throw new MetadataError('not-found', `ComicVine has no volume ${id}`);
      return comicResult(
        cvSide(volume, cvIssues),
        { ...(metronSeries ? { series: metronSeries } : {}), issues: metronIssues?.value ?? [] },
        outcomes,
        key,
      );
    }
    if (prefix === 'metron') {
      const [series, issues] = await Promise.all([askMetronSeries(id, fresh), askMetronIssues(id, fresh)]);
      if (series.state === 'disabled') throw new MetadataError('not-found', `${series.message}; cannot look up ${key}`);
      assertSomeAnswered([series, issues], `Comic series ${key}`);
      if (!series.value) throw new MetadataError('not-found', `Metron has no series ${id}`);
      const cvId = series.value.comicVineId;
      const cvCalls = cvId ? await Promise.all([askCvVolume(cvId, fresh), askCvIssues(cvId, fresh)]) : undefined;
      const outcomes: Outcome<unknown>[] = [series, issues, ...(cvCalls ?? [])];
      return comicResult(
        cvCalls ? cvSide(cvCalls[0], cvCalls[1]) : { issues: [] },
        { series: series.value, issues: issues.value ?? [] },
        outcomes,
        key,
      );
    }
    throw new MetadataError('not-found', `"${key}" is not a comic series key`);
  }

  // -------------------------------------------------------------------------

  return {
    async searchBooks(term) {
      const q = normalizeTerm(term);
      if (q.length === 0) return { value: [], sources: [] };
      const isbn = toIsbn13(normalizeIsbn(q));
      if (isbn) {
        try {
          const result = await getBookByIsbn(isbn, false);
          return { value: filterBooksByLanguage([result.value], config.languages), sources: result.sources };
        } catch (err) {
          if (isMetadataError(err, 'not-found')) return { value: [], sources: [] };
          throw err;
        }
      }
      const key = `search-books:${q}`;
      const outcomes = await all<BookRecord[]>([
        [
          'hardcover',
          ask('hardcover', key, ttls.search, () => clients.hardcover!.searchBooks(term, { perPage: SEARCH_LIMIT })),
        ],
        [
          'openLibrary',
          ask('openLibrary', key, ttls.search, async () =>
            (await clients.openLibrary!.searchBooks({ q: term }, { limit: SEARCH_LIMIT })).results.map(
              bookFromOpenLibrarySearchDoc,
            ),
          ),
        ],
        [
          'googleBooks',
          ask('googleBooks', key, ttls.search, async () =>
            (await clients.googleBooks!.searchVolumes({ q: term }, { maxResults: SEARCH_LIMIT })).records,
          ),
        ],
      ]);
      assertSomeAnswered(outcomes, `Book search "${term}"`);
      const books = filterBooksByLanguage(mergeBookRecords(interleave(values(outcomes))), config.languages);
      return { value: books, sources: statuses(outcomes, BOOK_SOURCES) };
    },

    async searchAuthors(term) {
      const q = normalizeTerm(term);
      if (q.length === 0) return { value: [], sources: [] };
      const key = `search-authors:${q}`;
      const outcomes = await all<BookAuthorRecord[]>([
        [
          'openLibrary',
          ask('openLibrary', key, ttls.search, async () =>
            (await clients.openLibrary!.searchAuthors(term, { limit: SEARCH_LIMIT })).results.map(
              authorFromOpenLibrarySearch,
            ),
          ),
        ],
        [
          'hardcover',
          ask('hardcover', key, ttls.search, () => clients.hardcover!.searchAuthors(term, { perPage: SEARCH_LIMIT })),
        ],
      ]);
      assertSomeAnswered(outcomes, `Author search "${term}"`);
      return {
        value: mergeAuthorRecords(interleave(values(outcomes))),
        sources: statuses(outcomes, BOOK_SOURCES),
      };
    },

    getAuthorWithBooks,

    async getBook(key, opts = {}) {
      const fresh = opts.fresh ?? false;
      const trimmed = key.trim();
      const [prefix, ...rest] = trimmed.split(':');
      const id = rest.join(':').trim();
      if (prefix === 'isbn' || rest.length === 0) {
        const isbn13 = toIsbn13(normalizeIsbn(rest.length === 0 ? trimmed : id));
        if (!isbn13) throw notFound(key);
        return getBookByIsbn(isbn13, fresh);
      }
      if (id.length === 0) throw notFound(key);
      if (prefix === 'ol') {
        const olid = olidFromKey(id);
        if (!olid || olid.endsWith('A')) throw notFound(key);
        return getBookById('openLibrary', olid, fresh);
      }
      if (prefix === 'gb') return getBookById('googleBooks', id, fresh);
      if (prefix === 'hc') return getBookById('hardcover', id, fresh);
      throw notFound(key);
    },

    async searchComicSeries(term) {
      const q = normalizeTerm(term);
      if (q.length === 0) return { value: [], sources: [] };
      const key = `comic-search:${q}`;
      const outcomes = await all<ComicSeriesRecord[]>([
        ['comicVine', ask('comicVine', key, ttls.search, () => clients.comicVine!.searchVolumes(term))],
        ['metron', ask('metron', key, ttls.search, () => clients.metron!.searchSeries(term))],
      ]);
      assertSomeAnswered(outcomes, `Comic search "${term}"`);
      return {
        value: mergeComicSeries(interleave(values(outcomes))),
        sources: statuses(outcomes, COMIC_SOURCES),
      };
    },

    getComicSeries,
  };
}
