import { and, asc, desc, eq, inArray, isNull, like, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  dateReleaseMs,
  matchesReleaseFilter,
  type AddAuthorRequest,
  type AudioFile,
  type AudioFileTags,
  type AudiobookImage,
  type AudiobookMonitorOption,
  type Author,
  type AuthorDetails,
  type AuthorListQuery,
  type AuthorStatistics,
  type AuthorSummary,
  type Book,
  type BookAuthorCredit,
  type BookAuthorRole,
  type BookChapter,
  type BookDetails,
  type BookListQuery,
  type BookSeriesDetails,
  type BookSeriesLink,
  type BookSeriesListQuery,
  type BookSeriesSummary,
  type BookStatistics,
  type BulkAuthorUpdateRequest,
  type MonitorNewBooks,
  type QualityProfile,
  type UpdateAuthorRequest,
  type WantedBook,
  type WantedBooksPage,
  type WantedBooksQuery,
  type WantedReleaseFilter,
} from '@arclight/shared';
import { toIsbn13 as isbn13Of, type CatalogAuthor, type CatalogAuthorWithBooks, type CatalogBook } from '@arclight/metadata';
import { isQualityCutoffMet } from '@arclight/profiles-engine';
import type { Db } from '../../db/index.js';
import { listSearchCondition } from '../../db/list-search.js';
import {
  audioFiles,
  audioImportExclusions,
  authors,
  bookAuthors,
  bookSeries,
  bookSeriesEntries,
  books,
  qualityProfiles,
  rootFolders,
  tags as tagsTable,
} from '../../db/schema.js';
import { LibraryError, libraryService } from '../library/index.js';
import { getSection } from '../settings/service.js';
import { booksToMonitor, isReleased, monitorNewBook, positionSortOf } from './monitoring.js';
import { audiobookFileQuality } from './quality.js';
import type { AuthorRescanResult, KnownBook } from './rescan.js';
import { authorStatistics, bookStatistics, type AudiobookDb } from './statistics.js';
import type { AuthorRow, BookRow } from './schema.js';

// Business logic for the audiobook library (authors → books, series, co-author links, audio
// files). Plain functions over a database handle, like the music service: no Fastify, no
// network. The refresher (modules/metadata/audiobook-jobs.ts) fetches from the audiobook catalog
// and writes through these functions.
//
// `audio_files.author_id` / `book_id` carry no foreign key (they predate the audiobook tables),
// so every delete here removes the matching `audio_files` rows itself, in the same transaction.

type AudioFileRow = typeof audioFiles.$inferSelect;

const nowIso = () => new Date().toISOString();

export function audiobooksEnabled(db: AudiobookDb): boolean {
  return getSection(db as Db, 'features').audiobooks;
}

// ---------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function requireAudiobookRootFolder(db: AudiobookDb, path: string): string {
  const match = db
    .select()
    .from(rootFolders)
    .where(eq(rootFolders.mediaType, 'audiobook'))
    .all()
    .find((r) => resolve(r.path) === resolve(path));
  if (!match) throw new LibraryError('VALIDATION', `${path} is not a registered audiobook root folder`);
  return match.path;
}

function requireAudiobookProfile(db: AudiobookDb, id: number | undefined): void {
  if (id === undefined) return;
  const row = db.select({ mediaDomain: qualityProfiles.mediaDomain }).from(qualityProfiles).where(eq(qualityProfiles.id, id)).get();
  if (!row) throw new LibraryError('VALIDATION', `quality profile ${id} does not exist`);
  if (row.mediaDomain !== 'audiobook') {
    throw new LibraryError('VALIDATION', `quality profile ${id} is a ${row.mediaDomain} profile; authors need an audiobook profile`);
  }
}

function requireTags(db: AudiobookDb, ids: readonly number[]): number[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = new Set(db.select({ id: tagsTable.id }).from(tagsTable).where(inArray(tagsTable.id, unique)).all().map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) throw new LibraryError('VALIDATION', `unknown tag ids: ${missing.join(', ')}`);
  return unique.sort((a, b) => a - b);
}

const normLanguages = (list: readonly string[]) => [...new Set(list.map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0))];

/** `<root>/<Author Name>` (naming default `{Author Name}`), folder-safe. */
export function buildAuthorPath(rootFolderPath: string, name: string): string {
  return join(rootFolderPath, libraryService.sanitizeFolderName(name));
}

const NAME_SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv|phd|md)$/i;

/** "Andy Weir" → "Weir, Andy"; "Martin Luther King Jr." → "King, Martin Luther Jr."; one word stays. */
export function authorSortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || name.includes(',')) return name.trim();
  const suffix = parts.length > 2 && NAME_SUFFIX.test(parts[parts.length - 1]!) ? parts.pop()! : null;
  const last = parts.pop()!;
  return `${last}, ${parts.join(' ')}${suffix ? ` ${suffix}` : ''}`;
}

/** The book languages kept for an author: their own list, else the `audiobookMetadata` setting. */
export function effectiveLanguages(db: AudiobookDb, author: Pick<AuthorRow, 'languages'>): string[] {
  const own = normLanguages(author.languages);
  return own.length > 0 ? own : normLanguages(getSection(db as Db, 'audiobookMetadata').languages);
}

function isExcluded(db: AudiobookDb, ids: ReadonlyArray<string | null | undefined>): boolean {
  const list = ids.filter((x): x is string => !!x);
  if (list.length === 0) return false;
  return (
    db
      .select({ id: audioImportExclusions.id })
      .from(audioImportExclusions)
      .where(and(eq(audioImportExclusions.mediaType, 'audiobook'), inArray(audioImportExclusions.foreignId, list)))
      .get() !== undefined
  );
}

/** The catalog book's ASIN or ISBN is on the import exclusion list. */
export function isBookExcluded(db: AudiobookDb, cb: Pick<CatalogBook, 'asin' | 'isbn' | 'isbns'>): boolean {
  return isExcluded(db, [cb.asin?.toUpperCase(), isbn13Of(cb.isbn ?? cb.isbns[0])]);
}

// ---------------------------------------------------------------------------------------
// Catalog → columns
// ---------------------------------------------------------------------------------------

export interface AuthorMetadataInput {
  asin: string | null;
  olAuthorId: string | null;
  name: string;
  overview: string;
  images: AudiobookImage[];
  genres: string[];
}

export function authorMetadataFrom(a: CatalogAuthor): AuthorMetadataInput {
  return {
    asin: a.asin ? a.asin.toUpperCase() : null,
    olAuthorId: a.olid ? a.olid.toUpperCase() : null,
    name: a.name,
    overview: a.description ?? '',
    images: a.image ? [{ coverType: 'headshot', url: a.image, remoteUrl: a.image }] : [],
    genres: a.genres,
  };
}

const ROLE_SUFFIX: ReadonlyArray<readonly [RegExp, BookAuthorRole]> = [
  [/\s+-\s+(translator|traducteur|traductor|tradutor|übersetzer|traduttore)$/i, 'translator'],
  [/\s+-\s+(editor|herausgeber|éditeur)$/i, 'editor'],
  [/\s+-\s+(foreword|introduction|afterword)$/i, 'foreword'],
  [/\s+-\s+(contributor|illustrator|adaptation)$/i, 'contributor'],
];

/** "Nenad Savic - traducteur" → { name: "Nenad Savic", role: "translator" }. */
export function creditRole(name: string): { name: string; role: BookAuthorRole } {
  for (const [re, role] of ROLE_SUFFIX) if (re.test(name)) return { name: name.replace(re, '').trim(), role };
  return { name: name.trim(), role: 'author' };
}

function bookColumns(cb: CatalogBook) {
  const year = cb.releaseDate ? Number(cb.releaseDate.slice(0, 4)) || null : null;
  return {
    asin: cb.asin ? cb.asin.toUpperCase() : null,
    isbn13: isbn13Of(cb.isbn ?? cb.isbns[0]) ?? null,
    olWorkId: cb.olWorkId ?? null,
    region: cb.region ?? null,
    title: cb.title,
    subtitle: cb.subtitle ?? null,
    sortTitle: libraryService.toSortTitle(cb.title),
    cleanTitle: libraryService.toCleanTitle(cb.title),
    narrators: cb.narrators,
    publisher: cb.publisher ?? null,
    language: cb.language ? cb.language.toLowerCase() : null,
    releaseDate: cb.releaseDate ?? null,
    year,
    runtimeMinutes: cb.runtimeMinutes ?? null,
    formatType: cb.formatType ?? null,
    overview: cb.overview ?? '',
    genres: cb.genres,
    images: cb.images.cover ? [{ coverType: 'cover' as const, url: cb.images.cover, remoteUrl: cb.images.cover }] : [],
    ratings: cb.rating !== undefined ? { audible: { votes: 0, value: cb.rating } } : {},
  };
}

// ---------------------------------------------------------------------------------------
// Row → contract
// ---------------------------------------------------------------------------------------

function toAuthor(row: AuthorRow, statistics?: AuthorStatistics): Author {
  return { ...row, ...(statistics ? { statistics } : {}) };
}

function toAuthorSummary(row: AuthorRow): AuthorSummary {
  return { id: row.id, asin: row.asin, name: row.name, sortName: row.sortName, path: row.path, images: row.images };
}

/** Series links per book id, primary first. */
function seriesLinksFor(db: AudiobookDb, bookIds: readonly number[]): Map<number, BookSeriesLink[]> {
  const out = new Map<number, BookSeriesLink[]>();
  if (bookIds.length === 0) return out;
  const rows = db
    .select({ entry: bookSeriesEntries, name: bookSeries.name, asin: bookSeries.asin })
    .from(bookSeriesEntries)
    .innerJoin(bookSeries, eq(bookSeriesEntries.seriesId, bookSeries.id))
    .where(inArray(bookSeriesEntries.bookId, [...bookIds]))
    .orderBy(desc(bookSeriesEntries.isPrimary), asc(bookSeries.name))
    .all();
  for (const r of rows) {
    const list = out.get(r.entry.bookId) ?? [];
    list.push({ ...r.entry, name: r.name, asin: r.asin });
    out.set(r.entry.bookId, list);
  }
  return out;
}

function toBook(row: BookRow, series: BookSeriesLink[], statistics?: BookStatistics): Book {
  return { ...row, series, ...(statistics ? { statistics } : {}) };
}

/** Rows → books with their series links (and statistics unless turned off). */
export function booksFromRows(db: AudiobookDb, rows: readonly BookRow[], opts: { includeStatistics?: boolean } = {}): Book[] {
  const ids = rows.map((r) => r.id);
  const links = seriesLinksFor(db, ids);
  const stats = opts.includeStatistics === false ? undefined : bookStatistics(db, ids);
  return rows.map((r) => toBook(r, links.get(r.id) ?? [], stats?.get(r.id)));
}

export function toAudioFile(row: AudioFileRow): AudioFile {
  return { ...row };
}

function authorRow(db: AudiobookDb, id: number): AuthorRow {
  const row = db.select().from(authors).where(eq(authors.id, id)).get();
  if (!row) throw LibraryError.notFound('author', id);
  return row;
}

function bookRow(db: AudiobookDb, id: number): BookRow {
  const row = db.select().from(books).where(eq(books.id, id)).get();
  if (!row) throw LibraryError.notFound('book', id);
  return row;
}

// ---------------------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------------------

export function findAuthorByAsin(db: AudiobookDb, asin: string): AuthorRow | undefined {
  return db.select().from(authors).where(eq(authors.asin, asin.toUpperCase())).get();
}

export function findAuthorByOlid(db: AudiobookDb, olid: string): AuthorRow | undefined {
  return db.select().from(authors).where(eq(authors.olAuthorId, olid.toUpperCase())).get();
}

/** A library author for a credit: by ASIN, else by OpenLibrary id, else by clean name. */
export function findAuthorForCredit(db: AudiobookDb, credit: { name: string; asin?: string | null; olid?: string | null }): AuthorRow | undefined {
  if (credit.asin) {
    const hit = findAuthorByAsin(db, credit.asin);
    if (hit) return hit;
  }
  if (credit.olid) {
    const hit = findAuthorByOlid(db, credit.olid);
    if (hit) return hit;
  }
  const clean = libraryService.toCleanTitle(creditRole(credit.name).name);
  if (!clean) return undefined;
  const rows = db.select().from(authors).where(eq(authors.cleanName, clean)).all();
  // A name match only counts when the ASINs do not contradict it.
  return rows.find((r) => !credit.asin || !r.asin || r.asin === credit.asin.toUpperCase());
}

/** Library author ids keyed by ASIN and by OpenLibrary id (lookup marks results already added). */
export function authorIdsByForeignId(db: AudiobookDb): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db.select({ id: authors.id, asin: authors.asin, ol: authors.olAuthorId }).from(authors).all()) {
    if (r.asin) out.set(r.asin, r.id);
    if (r.ol) out.set(r.ol, r.id);
  }
  return out;
}

/** Library book ids (and owners) keyed by ASIN. */
export function booksByAsin(db: AudiobookDb, asins: readonly string[]): Map<string, { id: number; authorId: number }> {
  const list = [...new Set(asins.map((a) => a.toUpperCase()))];
  if (list.length === 0) return new Map();
  const rows = db.select({ id: books.id, authorId: books.authorId, asin: books.asin }).from(books).where(inArray(books.asin, list)).all();
  return new Map(rows.map((r) => [r.asin!, { id: r.id, authorId: r.authorId }]));
}

export interface AddAuthorSettings {
  rootFolderPath: string;
  qualityProfileId: number;
  monitored: boolean;
  monitorNewBooks: MonitorNewBooks;
  languages: string[];
  tags: number[];
}

/** Validates an add request against the database (before any network call). */
export function validateAddAuthor(db: AudiobookDb, req: Pick<AddAuthorRequest, 'asin' | 'olAuthorId' | 'rootFolderPath' | 'qualityProfileId' | 'tags'>): { rootFolderPath: string; tags: number[] } {
  if (req.asin && findAuthorByAsin(db, req.asin)) throw new LibraryError('CONFLICT', `author ${req.asin} is already in the library`);
  if (!req.asin && req.olAuthorId && findAuthorByOlid(db, req.olAuthorId)) {
    throw new LibraryError('CONFLICT', `author ${req.olAuthorId} is already in the library`);
  }
  if (isExcluded(db, [req.asin ?? req.olAuthorId])) {
    throw new LibraryError('CONFLICT', `author ${req.asin ?? req.olAuthorId} is on the import exclusion list`);
  }
  const rootFolderPath = requireAudiobookRootFolder(db, req.rootFolderPath);
  requireAudiobookProfile(db, req.qualityProfileId);
  return { rootFolderPath, tags: requireTags(db, req.tags) };
}

/** Inserts the author row (no books yet; the AuthorAdd job fills them). */
export function addAuthor(
  db: Db,
  meta: AuthorMetadataInput,
  req: AddAuthorSettings & Pick<AddAuthorRequest, 'asin' | 'olAuthorId'>,
  now: string = nowIso(),
): Author {
  return db.transaction((tx) => {
    const { rootFolderPath, tags } = validateAddAuthor(tx, req);
    // A record found by ASIN can carry an OpenLibrary id another library author already has.
    const asin = meta.asin ?? req.asin ?? null;
    let olAuthorId = meta.olAuthorId ?? req.olAuthorId ?? null;
    if (asin && findAuthorByAsin(tx, asin)) throw new LibraryError('CONFLICT', `author ${asin} is already in the library`);
    if (olAuthorId && findAuthorByOlid(tx, olAuthorId)) {
      if (!asin) throw new LibraryError('CONFLICT', `author ${olAuthorId} is already in the library`);
      olAuthorId = null;
    }
    const path = buildAuthorPath(rootFolderPath, meta.name);
    if (tx.select({ id: authors.id }).from(authors).where(eq(authors.path, path)).get()) {
      throw new LibraryError('CONFLICT', `an author already uses the path ${path}`);
    }
    const row = tx
      .insert(authors)
      .values({
        asin,
        olAuthorId,
        name: meta.name,
        sortName: authorSortName(meta.name),
        cleanName: libraryService.toCleanTitle(meta.name),
        overview: meta.overview,
        images: meta.images,
        genres: meta.genres,
        aliases: [],
        path,
        rootFolderPath,
        qualityProfileId: req.qualityProfileId,
        monitored: req.monitored,
        monitorNewBooks: req.monitorNewBooks,
        languages: normLanguages(req.languages),
        tags,
        added: now,
        lastRefreshed: null,
        nextRefreshAt: null,
      })
      .returning()
      .get();
    return toAuthor(row, authorStatistics(tx, [row.id]).get(row.id));
  });
}

export function getAuthor(db: AudiobookDb, id: number, opts: { includeStatistics?: boolean } = {}): Author {
  const row = authorRow(db, id);
  return toAuthor(row, opts.includeStatistics === false ? undefined : authorStatistics(db, [id]).get(id));
}

export function getAuthorDetails(db: AudiobookDb, id: number): AuthorDetails {
  const author = getAuthor(db, id);
  return { ...author, books: listBooks(db, { authorId: id, includeStatistics: true }), series: listSeries(db, { authorId: id }) };
}

const authorSort = {
  sortName: authors.sortName,
  added: authors.added,
  qualityProfileId: authors.qualityProfileId,
  path: authors.path,
} as const;

export function listAuthors(db: AudiobookDb, query: AuthorListQuery): Author[] {
  const where: SQL[] = [];
  if (query.monitored !== undefined) where.push(eq(authors.monitored, query.monitored));
  if (query.qualityProfileId !== undefined) where.push(eq(authors.qualityProfileId, query.qualityProfileId));
  if (query.rootFolderPath) where.push(eq(authors.rootFolderPath, query.rootFolderPath));
  if (query.asin) where.push(eq(authors.asin, query.asin.toUpperCase()));
  if (query.olAuthorId) where.push(eq(authors.olAuthorId, query.olAuthorId.toUpperCase()));
  if (query.search) {
    const needle = query.search.toLowerCase();
    where.push(or(like(authors.cleanName, `%${libraryService.toCleanTitle(query.search)}%`), like(authors.aliases, `%${needle}%`))!);
  }
  const byStats = query.sortKey === 'sizeOnDisk' || query.sortKey === 'bookCount';
  const column = query.sortKey === 'sizeOnDisk' || query.sortKey === 'bookCount' ? authors.sortName : authorSort[query.sortKey];
  let rows = db
    .select()
    .from(authors)
    .where(where.length ? and(...where) : undefined)
    .orderBy(query.sortOrder === 'desc' && !byStats ? desc(column) : asc(column), asc(authors.id))
    .all()
    .filter((r) => query.tag === undefined || r.tags.includes(query.tag));
  if (!query.includeStatistics && !byStats) return rows.map((r) => toAuthor(r));
  const stats = authorStatistics(
    db,
    rows.map((r) => r.id),
  );
  if (byStats) {
    const value = (r: AuthorRow) => (query.sortKey === 'sizeOnDisk' ? (stats.get(r.id)?.sizeOnDisk ?? 0) : (stats.get(r.id)?.bookCount ?? 0));
    rows = [...rows].sort((a, b) => (query.sortOrder === 'desc' ? value(b) - value(a) : value(a) - value(b)) || a.id - b.id);
  }
  return rows.map((r) => toAuthor(r, query.includeStatistics ? stats.get(r.id) : undefined));
}

function resolveAuthorPath(
  tx: AudiobookDb,
  current: AuthorRow,
  req: Pick<UpdateAuthorRequest, 'rootFolderPath' | 'path'>,
): { rootFolderPath?: string; path?: string } {
  const out: { rootFolderPath?: string; path?: string } = {};
  if (req.rootFolderPath !== undefined) {
    out.rootFolderPath = requireAudiobookRootFolder(tx, req.rootFolderPath);
    // Moving the folder on disk is the organizer's job; the library records where it lives.
    out.path = req.path ?? buildAuthorPath(out.rootFolderPath, current.name);
  } else if (req.path !== undefined) {
    if (!isAbsolute(req.path)) throw new LibraryError('VALIDATION', 'author path must be absolute');
    out.path = req.path;
  }
  if (out.path && out.path !== current.path) {
    const clash = tx.select({ id: authors.id }).from(authors).where(eq(authors.path, out.path)).get();
    if (clash) throw new LibraryError('CONFLICT', `an author already uses the path ${out.path}`);
  }
  return out;
}

export function updateAuthor(db: Db, id: number, req: UpdateAuthorRequest, now: string = nowIso()): Author {
  return db.transaction((tx) => {
    const current = authorRow(tx, id);
    requireAudiobookProfile(tx, req.qualityProfileId);
    const patch: Partial<typeof authors.$inferInsert> = {};
    if (req.monitored !== undefined) patch.monitored = req.monitored;
    if (req.monitorNewBooks !== undefined) patch.monitorNewBooks = req.monitorNewBooks;
    if (req.qualityProfileId !== undefined) patch.qualityProfileId = req.qualityProfileId;
    if (req.languages !== undefined) patch.languages = normLanguages(req.languages);
    if (req.tags !== undefined) patch.tags = requireTags(tx, req.tags);
    Object.assign(patch, resolveAuthorPath(tx, current, req));
    if (Object.keys(patch).length > 0) tx.update(authors).set(patch).where(eq(authors.id, id)).run();
    if (req.monitorOption) applyAudiobookMonitorOption(tx, id, req.monitorOption, now);
    return getAuthor(tx, id);
  });
}

export function bulkUpdateAuthors(db: Db, req: BulkAuthorUpdateRequest, now: string = nowIso()): Author[] {
  return db.transaction((tx) => {
    const rows = tx.select().from(authors).where(inArray(authors.id, req.ids)).all();
    const found = new Set(rows.map((r) => r.id));
    const missing = req.ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw LibraryError.notFound('author', missing.join(', '));
    requireAudiobookProfile(tx, req.qualityProfileId);
    const rootFolderPath = req.rootFolderPath !== undefined ? requireAudiobookRootFolder(tx, req.rootFolderPath) : undefined;
    if (req.tags) requireTags(tx, [...(req.tags.add ?? []), ...(req.tags.remove ?? [])]);

    for (const row of rows) {
      const patch: Partial<typeof authors.$inferInsert> = {};
      if (req.monitored !== undefined) patch.monitored = req.monitored;
      if (req.monitorNewBooks !== undefined) patch.monitorNewBooks = req.monitorNewBooks;
      if (req.qualityProfileId !== undefined) patch.qualityProfileId = req.qualityProfileId;
      if (rootFolderPath !== undefined) Object.assign(patch, resolveAuthorPath(tx, row, { rootFolderPath }));
      if (req.tags) {
        const next = new Set(row.tags);
        for (const t of req.tags.add ?? []) next.add(t);
        for (const t of req.tags.remove ?? []) next.delete(t);
        patch.tags = [...next].sort((a, b) => a - b);
      }
      if (Object.keys(patch).length > 0) tx.update(authors).set(patch).where(eq(authors.id, row.id)).run();
      if (req.monitorOption) applyAudiobookMonitorOption(tx, row.id, req.monitorOption, now);
    }
    return req.ids.map((id) => getAuthor(tx, id));
  });
}

/** Series no book belongs to any more. */
export function pruneOrphanSeries(db: AudiobookDb): number {
  const used = db.select({ id: bookSeriesEntries.seriesId }).from(bookSeriesEntries);
  return db.delete(bookSeries).where(notInArray(bookSeries.id, used)).returning({ id: bookSeries.id }).all().length;
}

/**
 * Deletes the author with their books, series entries, co-author links and `audio_files` rows
 * (one transaction), prunes orphaned series and optionally writes an import exclusion
 * (foreign id: the ASIN, else the OpenLibrary id) and removes the folder.
 */
export async function deleteAuthor(db: Db, id: number, opts: { deleteFiles?: boolean; addExclusion?: boolean } = {}): Promise<void> {
  const row = authorRow(db, id);
  if (opts.deleteFiles && (resolve(row.path) === resolve(row.rootFolderPath) || !isPathInside(row.rootFolderPath, row.path))) {
    throw new LibraryError('VALIDATION', `refusing to delete ${row.path}: not inside its root folder ${row.rootFolderPath}`);
  }
  db.transaction((tx) => {
    const foreignId = row.asin ?? row.olAuthorId;
    if (opts.addExclusion && foreignId) {
      tx.insert(audioImportExclusions).values({ mediaType: 'audiobook', foreignId, title: row.name, year: null }).onConflictDoNothing().run();
    }
    const owned = tx.select({ id: books.id }).from(books).where(eq(books.authorId, id)).all().map((r) => r.id);
    tx.delete(audioFiles).where(and(eq(audioFiles.mediaType, 'audiobook'), eq(audioFiles.authorId, id))).run();
    if (owned.length > 0) tx.delete(audioFiles).where(and(eq(audioFiles.mediaType, 'audiobook'), inArray(audioFiles.bookId, owned))).run();
    tx.delete(authors).where(eq(authors.id, id)).run(); // cascades to books, series entries, book_authors
    pruneOrphanSeries(tx);
  });
  if (opts.deleteFiles) await rm(row.path, { recursive: true, force: true });
}

/** Writes refreshed author metadata (path and user settings stay). */
export function applyAuthorMetadata(db: AudiobookDb, id: number, meta: AuthorMetadataInput): void {
  const current = authorRow(db, id);
  const patch: Partial<typeof authors.$inferInsert> = {
    name: meta.name,
    sortName: authorSortName(meta.name),
    cleanName: libraryService.toCleanTitle(meta.name),
    overview: meta.overview || current.overview,
    genres: meta.genres.length > 0 ? meta.genres : current.genres,
    ...(meta.images.length > 0 ? { images: meta.images } : {}),
  };
  // Learn ids the row lacks, unless another author already has them.
  if (!current.asin && meta.asin && !findAuthorByAsin(db, meta.asin)) patch.asin = meta.asin;
  if (!current.olAuthorId && meta.olAuthorId && !findAuthorByOlid(db, meta.olAuthorId)) patch.olAuthorId = meta.olAuthorId;
  db.update(authors).set(patch).where(eq(authors.id, id)).run();
}

export function markAuthorRefreshed(db: AudiobookDb, id: number, at: string, nextRefreshAt: string): void {
  db.update(authors).set({ lastRefreshed: at, nextRefreshAt }).where(eq(authors.id, id)).run();
}

// ---------------------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------------------

/** Sets every book's monitored flag of the author from a monitor option; `keep` ids are left as they are. */
export function applyAudiobookMonitorOption(
  db: AudiobookDb,
  authorId: number,
  option: AudiobookMonitorOption,
  now: string = nowIso(),
  keep: ReadonlySet<number> = new Set(),
): void {
  authorRow(db, authorId);
  const rows = db
    .select({ id: books.id, releaseDate: books.releaseDate, monitored: books.monitored, hasFile: books.hasFile })
    .from(books)
    .where(eq(books.authorId, authorId))
    .all();
  const inSeries = new Set(
    rows.length === 0
      ? []
      : db
          .select({ id: bookSeriesEntries.bookId })
          .from(bookSeriesEntries)
          .where(inArray(bookSeriesEntries.bookId, rows.map((r) => r.id)))
          .all()
          .map((r) => r.id),
  );
  const monitor = booksToMonitor(
    option,
    rows.map((r) => ({ id: r.id, releaseDate: r.releaseDate, hasFiles: r.hasFile, inSeries: inSeries.has(r.id) })),
    new Date(now),
  );
  for (const r of rows) {
    if (keep.has(r.id)) continue;
    const monitored = monitor.has(r.id);
    if (monitored !== r.monitored) db.update(books).set({ monitored }).where(eq(books.id, r.id)).run();
  }
}

// ---------------------------------------------------------------------------------------
// Books from the catalog
// ---------------------------------------------------------------------------------------

function seriesIdFor(tx: AudiobookDb, ref: { name: string; asin?: string | undefined }): number {
  const asin = ref.asin ? ref.asin.toUpperCase() : null;
  const cleanName = libraryService.toCleanTitle(ref.name);
  if (asin) {
    const hit = tx.select().from(bookSeries).where(eq(bookSeries.asin, asin)).get();
    if (hit) {
      if (hit.name !== ref.name) tx.update(bookSeries).set({ name: ref.name, cleanName }).where(eq(bookSeries.id, hit.id)).run();
      return hit.id;
    }
    // The same series known by name only (from OpenLibrary, or before Audible listed it).
    const byName = tx.select().from(bookSeries).where(and(eq(bookSeries.cleanName, cleanName), isNull(bookSeries.asin))).get();
    if (byName) {
      tx.update(bookSeries).set({ asin }).where(eq(bookSeries.id, byName.id)).run();
      return byName.id;
    }
  } else {
    const byName = tx.select().from(bookSeries).where(eq(bookSeries.cleanName, cleanName)).orderBy(asc(bookSeries.id)).get();
    if (byName) return byName.id;
  }
  return tx.insert(bookSeries).values({ asin, name: ref.name, cleanName, overview: '' }).returning({ id: bookSeries.id }).get().id;
}

function setBookSeries(tx: AudiobookDb, bookId: number, refs: CatalogBook['series']): void {
  tx.delete(bookSeriesEntries).where(eq(bookSeriesEntries.bookId, bookId)).run();
  const seen = new Set<number>();
  for (const ref of refs) {
    if (!ref.name.trim()) continue;
    const seriesId = seriesIdFor(tx, ref);
    if (seen.has(seriesId)) continue;
    seen.add(seriesId);
    tx.insert(bookSeriesEntries)
      .values({
        seriesId,
        bookId,
        position: ref.position ?? null,
        positionSort: ref.positionNumber ?? positionSortOf(ref.position),
        isPrimary: seen.size === 1,
      })
      .run();
  }
}

/** Credits with library author ids filled in; links every credited library author but the owner. */
function linkCredits(tx: AudiobookDb, bookId: number, ownerId: number, credits: CatalogBook['authors']): BookAuthorCredit[] {
  const out: BookAuthorCredit[] = [];
  for (const c of credits) {
    const { name, role } = creditRole(c.name);
    const hit = findAuthorForCredit(tx, { name, asin: c.asin ?? null, olid: c.olid ?? null });
    out.push({ name, asin: c.asin ?? null, authorId: hit?.id ?? null });
    if (hit && hit.id !== ownerId) tx.insert(bookAuthors).values({ bookId, authorId: hit.id, role }).onConflictDoNothing().run();
  }
  return out;
}

/** The library book a catalog book is: by ASIN, OpenLibrary work, ISBN, else the owner's title. */
function existingBookFor(tx: AudiobookDb, ownerId: number, cols: ReturnType<typeof bookColumns>): BookRow | undefined {
  if (cols.asin) return tx.select().from(books).where(eq(books.asin, cols.asin)).get();
  if (cols.olWorkId) {
    const hit = tx.select().from(books).where(eq(books.olWorkId, cols.olWorkId)).get();
    if (hit) return hit;
  }
  if (cols.isbn13) {
    const hit = tx.select().from(books).where(eq(books.isbn13, cols.isbn13)).get();
    if (hit) return hit;
  }
  return tx
    .select()
    .from(books)
    .where(and(eq(books.authorId, ownerId), isNull(books.asin), eq(books.cleanTitle, cols.cleanTitle)))
    .get();
}

export interface UpsertBookResult {
  id: number;
  created: boolean;
  /** Owned by another library author: this one was linked instead. */
  linked: boolean;
}

/**
 * Inserts or refreshes one catalog book under `ownerId`. A book another library author owns
 * gets a `book_authors` link instead. Existing books keep their monitored flag, files, path and
 * chapters; new ones start with `monitored`.
 */
export function upsertCatalogBook(tx: AudiobookDb, ownerId: number, cb: CatalogBook, monitored: boolean, now: string = nowIso()): UpsertBookResult {
  const cols = bookColumns(cb);
  const existing = existingBookFor(tx, ownerId, cols);
  if (existing && existing.authorId !== ownerId) {
    tx.insert(bookAuthors).values({ bookId: existing.id, authorId: ownerId, role: 'author' }).onConflictDoNothing().run();
    return { id: existing.id, created: false, linked: true };
  }
  if (existing) {
    const { asin: _asin, ...rest } = cols;
    tx.update(books)
      .set({
        ...rest,
        asin: existing.asin ?? cols.asin,
        isbn13: cols.isbn13 ?? existing.isbn13,
        olWorkId: cols.olWorkId ?? existing.olWorkId,
        images: cols.images.length > 0 ? cols.images : existing.images,
        overview: cols.overview || existing.overview,
        lastRefreshed: now,
      })
      .where(eq(books.id, existing.id))
      .run();
    const credits = linkCredits(tx, existing.id, ownerId, cb.authors);
    tx.update(books).set({ authorCredits: credits }).where(eq(books.id, existing.id)).run();
    setBookSeries(tx, existing.id, cb.series);
    return { id: existing.id, created: false, linked: false };
  }
  const id = tx
    .insert(books)
    .values({ ...cols, authorId: ownerId, authorCredits: [], chapters: [], monitored, hasFile: false, path: null, added: now, lastRefreshed: now })
    .returning({ id: books.id })
    .get().id;
  tx.update(books).set({ authorCredits: linkCredits(tx, id, ownerId, cb.authors) }).where(eq(books.id, id)).run();
  setBookSeries(tx, id, cb.series);
  return { id, created: true, linked: false };
}

export type BibliographySyncMode =
  | { kind: 'add'; option: AudiobookMonitorOption; keep?: readonly number[] }
  | { kind: 'refresh'; monitorNewBooks: MonitorNewBooks };

export interface BibliographySyncResult {
  added: number[];
  updated: number;
  linked: number;
  removed: number;
  excluded: number;
}

/**
 * Reconciles the author's books with a catalog bibliography (already filtered by language).
 * New books are monitored by the add option (on add) or by `monitor_new_books` (on refresh).
 * Books that are gone from the bibliography and have no file are removed when unmonitored or in
 * a language the author no longer keeps; monitored ones stay (the catalogue drops titles now and
 * then). Excluded ASINs/ISBNs are skipped. Orphaned series are pruned.
 */
export function syncBibliography(db: Db, authorId: number, data: CatalogAuthorWithBooks, mode: BibliographySyncMode, now: string = nowIso()): BibliographySyncResult {
  return db.transaction((tx) => {
    const author = authorRow(tx, authorId);
    applyAuthorMetadata(tx, authorId, authorMetadataFrom(data.author));
    const result: BibliographySyncResult = { added: [], updated: 0, linked: 0, removed: 0, excluded: 0 };
    const seen = new Set<number>();
    for (const cb of data.books) {
      if (isBookExcluded(tx, cb)) {
        result.excluded++;
        continue;
      }
      const monitored = mode.kind === 'refresh' ? monitorNewBook(mode.monitorNewBooks, cb.series.length > 0) : true;
      const r = upsertCatalogBook(tx, authorId, cb, monitored, now);
      seen.add(r.id);
      if (r.created) result.added.push(r.id);
      else if (r.linked) result.linked++;
      else result.updated++;
    }
    if (data.books.length > 0) {
      const keepLanguages = new Set(effectiveLanguages(tx, author));
      const owned = tx.select().from(books).where(eq(books.authorId, authorId)).all();
      const withFiles = new Set(
        tx
          .select({ id: audioFiles.bookId })
          .from(audioFiles)
          .where(and(eq(audioFiles.mediaType, 'audiobook'), eq(audioFiles.authorId, authorId)))
          .all()
          .map((r) => r.id),
      );
      for (const b of owned) {
        if (seen.has(b.id) || b.hasFile || withFiles.has(b.id)) continue;
        const wrongLanguage = keepLanguages.size > 0 && b.language !== null && !keepLanguages.has(b.language);
        if (b.monitored && !wrongLanguage) continue;
        tx.delete(books).where(eq(books.id, b.id)).run();
        result.removed++;
      }
    }
    if (mode.kind === 'add') applyAudiobookMonitorOption(tx, authorId, mode.option, now, new Set(mode.keep ?? []));
    pruneOrphanSeries(tx);
    return result;
  });
}

export function setBookChapters(db: AudiobookDb, bookId: number, chapters: BookChapter[]): void {
  db.update(books).set({ chapters }).where(eq(books.id, bookId)).run();
}

// ---------------------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------------------

export function listBooks(db: AudiobookDb, query: Partial<BookListQuery>): Book[] {
  const where: SQL[] = [];
  if (query.authorId !== undefined) {
    const linked = db.select({ id: bookAuthors.bookId }).from(bookAuthors).where(eq(bookAuthors.authorId, query.authorId));
    where.push(or(eq(books.authorId, query.authorId), inArray(books.id, linked))!);
  }
  if (query.seriesId !== undefined) {
    where.push(inArray(books.id, db.select({ id: bookSeriesEntries.bookId }).from(bookSeriesEntries).where(eq(bookSeriesEntries.seriesId, query.seriesId))));
  }
  if (query.monitored !== undefined) where.push(eq(books.monitored, query.monitored));
  if (query.hasFile !== undefined) where.push(eq(books.hasFile, query.hasFile));
  if (query.asin) where.push(eq(books.asin, query.asin.toUpperCase()));
  if (query.isbn) where.push(eq(books.isbn13, isbn13Of(query.isbn) ?? query.isbn));
  const rows = db
    .select()
    .from(books)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(books.authorId), asc(books.releaseDate), asc(books.sortTitle), asc(books.id))
    .all();
  return booksFromRows(db, rows, { includeStatistics: query.includeStatistics !== false });
}

export function getBook(db: AudiobookDb, id: number): Book {
  return booksFromRows(db, [bookRow(db, id)])[0]!;
}

export function getBookDetails(db: AudiobookDb, id: number): BookDetails {
  const book = getBook(db, id);
  const owner = authorRow(db, book.authorId);
  const contributors = db
    .select({ author: authors, role: bookAuthors.role })
    .from(bookAuthors)
    .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
    .where(eq(bookAuthors.bookId, id))
    .orderBy(asc(authors.sortName))
    .all()
    .map((r) => ({ ...toAuthorSummary(r.author), role: r.role }));
  const files = db
    .select()
    .from(audioFiles)
    .where(and(eq(audioFiles.mediaType, 'audiobook'), eq(audioFiles.bookId, id)))
    .orderBy(asc(audioFiles.partNumber), asc(audioFiles.path))
    .all()
    .map(toAudioFile);
  return { ...book, author: toAuthorSummary(owner), contributors, files };
}

export function updateBookFlags(db: AudiobookDb, id: number, req: { monitored?: boolean | undefined }): Book {
  bookRow(db, id);
  if (req.monitored !== undefined) db.update(books).set({ monitored: req.monitored }).where(eq(books.id, id)).run();
  return getBook(db, id);
}

export function bulkSetBooksMonitored(db: Db, ids: readonly number[], monitored: boolean): Book[] {
  return db.transaction((tx) => {
    const found = new Set(tx.select({ id: books.id }).from(books).where(inArray(books.id, [...ids])).all().map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw LibraryError.notFound('book', missing.join(', '));
    tx.update(books).set({ monitored }).where(inArray(books.id, [...ids])).run();
    return booksFromRows(tx, tx.select().from(books).where(inArray(books.id, [...ids])).all());
  });
}

/**
 * Deletes one book with its `audio_files` rows (one transaction), prunes orphaned series and
 * optionally writes an import exclusion (the ASIN, else the ISBN) and removes the files: the
 * book folder when it is a folder of its own inside the author folder, else each file.
 */
export async function deleteBook(db: Db, id: number, opts: { deleteFiles?: boolean; addExclusion?: boolean } = {}): Promise<void> {
  const row = bookRow(db, id);
  const owner = authorRow(db, row.authorId);
  const filePaths = db
    .select({ path: audioFiles.path })
    .from(audioFiles)
    .where(and(eq(audioFiles.mediaType, 'audiobook'), eq(audioFiles.bookId, id)))
    .all()
    .map((r) => r.path);
  db.transaction((tx) => {
    const foreignId = row.asin ?? row.isbn13;
    if (opts.addExclusion && foreignId) {
      tx.insert(audioImportExclusions).values({ mediaType: 'audiobook', foreignId, title: row.title, year: row.year }).onConflictDoNothing().run();
    }
    tx.delete(audioFiles).where(and(eq(audioFiles.mediaType, 'audiobook'), eq(audioFiles.bookId, id))).run();
    tx.delete(books).where(eq(books.id, id)).run(); // cascades to series entries and book_authors
    pruneOrphanSeries(tx);
  });
  if (!opts.deleteFiles) return;
  const ownFolder = row.path !== null && resolve(row.path) !== resolve(owner.path) && isPathInside(owner.path, row.path);
  if (ownFolder) await rm(row.path!, { recursive: true, force: true });
  else for (const p of filePaths) if (isPathInside(owner.path, p)) await rm(p, { force: true });
}

// ---------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------

function seriesSummaries(db: AudiobookDb, seriesIds: readonly number[]): BookSeriesSummary[] {
  if (seriesIds.length === 0) return [];
  const rows = db.select().from(bookSeries).where(inArray(bookSeries.id, [...seriesIds])).orderBy(asc(bookSeries.name), asc(bookSeries.id)).all();
  const counts = db
    .select({
      seriesId: bookSeriesEntries.seriesId,
      n: sql<number>`count(*)`,
      available: sql<number>`coalesce(sum(case when ${books.hasFile} then 1 else 0 end), 0)`,
    })
    .from(bookSeriesEntries)
    .innerJoin(books, eq(bookSeriesEntries.bookId, books.id))
    .where(inArray(bookSeriesEntries.seriesId, [...seriesIds]))
    .groupBy(bookSeriesEntries.seriesId)
    .all();
  const byId = new Map(counts.map((c) => [c.seriesId, c]));
  return rows.map((r) => ({ ...r, bookCount: Number(byId.get(r.id)?.n ?? 0), availableBookCount: Number(byId.get(r.id)?.available ?? 0) }));
}

export function listSeries(db: AudiobookDb, query: BookSeriesListQuery): BookSeriesSummary[] {
  let ids: number[];
  if (query.authorId !== undefined) {
    const own = listBooks(db, { authorId: query.authorId, includeStatistics: false }).map((b) => b.id);
    ids =
      own.length === 0
        ? []
        : [...new Set(db.select({ id: bookSeriesEntries.seriesId }).from(bookSeriesEntries).where(inArray(bookSeriesEntries.bookId, own)).all().map((r) => r.id))];
  } else {
    ids = db.select({ id: bookSeries.id }).from(bookSeries).all().map((r) => r.id);
  }
  let out = seriesSummaries(db, ids);
  if (query.search) {
    const needle = libraryService.toCleanTitle(query.search);
    out = out.filter((s) => s.cleanName.includes(needle));
  }
  return out;
}

export function getSeriesDetails(db: AudiobookDb, id: number): BookSeriesDetails {
  const series = db.select().from(bookSeries).where(eq(bookSeries.id, id)).get();
  if (!series) throw LibraryError.notFound('series', id);
  const rows = db
    .select({ book: books, positionSort: bookSeriesEntries.positionSort })
    .from(bookSeriesEntries)
    .innerJoin(books, eq(bookSeriesEntries.bookId, books.id))
    .where(eq(bookSeriesEntries.seriesId, id))
    .all()
    .sort(
      (a, b) =>
        (a.positionSort ?? Number.POSITIVE_INFINITY) - (b.positionSort ?? Number.POSITIVE_INFINITY) ||
        (a.book.releaseDate ?? '').localeCompare(b.book.releaseDate ?? '') ||
        a.book.id - b.book.id,
    );
  const ownerIds = [...new Set(rows.map((r) => r.book.authorId))];
  const owners = ownerIds.length === 0 ? [] : db.select().from(authors).where(inArray(authors.id, ownerIds)).orderBy(asc(authors.sortName)).all();
  return {
    ...series,
    books: booksFromRows(
      db,
      rows.map((r) => r.book),
    ),
    authors: owners.map(toAuthorSummary),
  };
}

// ---------------------------------------------------------------------------------------
// Audio files and rescans
// ---------------------------------------------------------------------------------------

export function listAudiobookFiles(db: AudiobookDb, query: { authorId?: number | undefined; bookId?: number | undefined }): AudioFile[] {
  const where: SQL[] = [eq(audioFiles.mediaType, 'audiobook')];
  if (query.authorId !== undefined) where.push(eq(audioFiles.authorId, query.authorId));
  if (query.bookId !== undefined) where.push(eq(audioFiles.bookId, query.bookId));
  return db.select().from(audioFiles).where(and(...where)).orderBy(asc(audioFiles.path)).all().map(toAudioFile);
}

/** The author's own books as the rescan matcher sees them. */
export function knownBooksFor(db: AudiobookDb, authorId: number): KnownBook[] {
  const rows = db.select().from(books).where(eq(books.authorId, authorId)).all();
  const links = seriesLinksFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    asin: r.asin,
    language: r.language,
    monitored: r.monitored,
    series: (links.get(r.id) ?? []).map((s) => ({ name: s.name, position: s.position ?? null, positionSort: s.positionSort ?? null })),
  }));
}

export interface AuthorRescanWriteResult {
  /** Books with a file after the rescan. */
  books: number;
  files: number;
  added: number;
  updated: number;
  removed: number;
  unmatchedGroups: number;
}

function fileTags(t: NonNullable<AuthorRescanResult['assignments'][number]['files'][number]['tags']>): AudioFileTags {
  return {
    title: t.title,
    artist: t.artist,
    albumArtist: t.albumArtist,
    album: t.album,
    date: t.date,
    trackNo: t.trackNo,
    trackOf: t.trackOf,
    discNo: t.discNo,
    discOf: t.discOf,
    asin: t.asin,
    isbn: t.isbn,
    narrator: t.narrator,
    series: t.series,
    seriesPart: t.seriesPart,
  };
}

type ScannedBookFile = AuthorRescanResult['assignments'][number]['files'][number];

/** The `audio_files` columns of one book part (`index` of `partCount`), read from its scan. */
function bookFileValues(author: Pick<AuthorRow, 'id' | 'path'>, bookId: number, f: ScannedBookFile, index: number, partCount: number) {
  const t = f.tags;
  return {
    mediaType: 'audiobook' as const,
    artistId: null,
    albumId: null,
    authorId: author.id,
    bookId,
    path: f.path,
    relativePath: relative(author.path, f.path),
    sizeBytes: f.sizeBytes,
    mtime: new Date(f.mtimeMs).toISOString(),
    quality: audiobookFileQuality({ codec: t?.codec ?? null, container: t?.container ?? f.extension.replace(/^\./, ''), bitrateKbps: t?.bitrateKbps ?? null }),
    codec: t?.codec ?? null,
    container: t?.container ?? null,
    bitrateKbps: t?.bitrateKbps != null ? Math.round(t.bitrateKbps) : null,
    sampleRateHz: t?.sampleRateHz ?? null,
    bitDepth: t?.bitDepth ?? null,
    channels: t?.channels ?? null,
    durationMs: t?.durationMs != null ? Math.round(t.durationMs) : null,
    discNumber: t?.discNo ?? f.discFromFolder,
    trackNumber: t?.trackNo ?? null,
    partNumber: partCount > 1 ? index + 1 : null,
    chapterCount: t?.chapters ? t.chapters.length : null,
    tags: t ? fileTags(t) : null,
    mediaInfo: {
      source: t?.source ?? null,
      lossless: t?.lossless ?? null,
      ...(t?.chapters && t.chapters.length > 0 ? { chapters: t.chapters.map((c) => ({ title: c.title, startMs: Math.round(c.startMs) })) } : {}),
    },
  };
}

/** Chapters of a single chaptered file, for a book whose catalogue entry has none. */
function chaptersOfSingleFile(parts: readonly ScannedBookFile[]): BookChapter[] | null {
  const t = parts.length === 1 ? parts[0]!.tags : null;
  if (!t?.chapters || t.chapters.length === 0) return null;
  return t.chapters.map((c) => ({
    title: c.title,
    startMs: Math.round(c.startMs),
    lengthMs: c.endMs !== null ? Math.max(0, Math.round(c.endMs - c.startMs)) : null,
  }));
}

/**
 * Writes a rescan of the author folder: one `audio_files` row per matched file (inserted or
 * refreshed by path, `media_type = 'audiobook'`), `books.has_file` / `path` from the assignments,
 * chapters from a chaptered file when the catalogue had none, and rows of files that are gone or
 * now match another book removed. Rows the scan cannot speak for stay: files outside the author
 * folder (linked in place by a library import) and files it found but could not match (linked
 * by hand), so a rescan never undoes a manual decision.
 */
export function applyAuthorRescan(db: Db, authorId: number, result: AuthorRescanResult, now: string = nowIso()): AuthorRescanWriteResult {
  return db.transaction((tx) => {
    const author = authorRow(tx, authorId);
    const owned = new Map(tx.select().from(books).where(eq(books.authorId, authorId)).all().map((b) => [b.id, b]));
    const existing = new Map(
      tx
        .select()
        .from(audioFiles)
        .where(and(eq(audioFiles.mediaType, 'audiobook'), eq(audioFiles.authorId, authorId)))
        .all()
        .map((r) => [r.path, r]),
    );
    const out: AuthorRescanWriteResult = { books: 0, files: 0, added: 0, updated: 0, removed: 0, unmatchedGroups: result.unmatched.length };
    const seen = new Set<string>();
    const withFiles = new Set<number>();
    for (const a of result.assignments) {
      const book = owned.get(a.bookId);
      if (!book) continue;
      const parts = a.files.filter((f) => f.tags !== null || f.error === null);
      if (parts.length === 0) continue;
      withFiles.add(book.id);
      parts.forEach((f, index) => {
        const values = bookFileValues(author, book.id, f, index, parts.length);
        const prior = existing.get(f.path) ?? tx.select().from(audioFiles).where(eq(audioFiles.path, f.path)).get();
        if (prior) {
          tx.update(audioFiles).set(values).where(eq(audioFiles.id, prior.id)).run();
          out.updated++;
        } else {
          tx.insert(audioFiles).values({ ...values, dateAdded: now }).run();
          out.added++;
        }
        seen.add(f.path);
        out.files++;
      });
      const patch: Partial<typeof books.$inferInsert> = { hasFile: true, path: a.folder };
      const fileChapters = chaptersOfSingleFile(parts);
      if (book.chapters.length === 0 && fileChapters) patch.chapters = fileChapters;
      tx.update(books).set(patch).where(eq(books.id, book.id)).run();
    }
    const unmatched = new Set(result.unmatched.flatMap((g) => g.files.map((f) => f.path)));
    for (const [path, row] of existing) {
      if (seen.has(path)) continue;
      if (row.bookId !== null && owned.has(row.bookId) && (unmatched.has(path) || !isPathInside(author.path, path))) {
        withFiles.add(row.bookId);
        continue;
      }
      tx.delete(audioFiles).where(eq(audioFiles.id, row.id)).run();
      out.removed++;
    }
    for (const b of owned.values()) {
      if (b.hasFile && !withFiles.has(b.id)) tx.update(books).set({ hasFile: false }).where(eq(books.id, b.id)).run();
    }
    out.books = withFiles.size;
    return out;
  });
}

export interface LinkBookFilesResult {
  /** `audio_files` ids, in part order. */
  fileIds: number[];
  added: number;
  updated: number;
}

/**
 * Links files to a book where they are (library import, in place): one `audio_files` row per
 * file in the given (part) order, inserted or refreshed by path. The book gets `has_file`, its
 * folder as `path`, `monitored`, and chapters from a single chaptered file when it has none.
 * Files without readable tags are linked too (quality from the extension). Other files of the
 * book stay.
 */
export function linkBookFiles(db: Db, bookId: number, folder: string, files: readonly ScannedBookFile[], now: string = nowIso()): LinkBookFilesResult {
  return db.transaction((tx) => {
    const book = bookRow(tx, bookId);
    const author = authorRow(tx, book.authorId);
    const out: LinkBookFilesResult = { fileIds: [], added: 0, updated: 0 };
    const takenFrom = new Set<number>();
    files.forEach((f, index) => {
      const values = bookFileValues(author, book.id, f, index, files.length);
      const prior = tx.select().from(audioFiles).where(eq(audioFiles.path, f.path)).get();
      if (prior?.bookId != null && prior.bookId !== book.id) takenFrom.add(prior.bookId);
      if (prior) {
        tx.update(audioFiles).set(values).where(eq(audioFiles.id, prior.id)).run();
        out.fileIds.push(prior.id);
        out.updated++;
      } else {
        out.fileIds.push(tx.insert(audioFiles).values({ ...values, dateAdded: now }).returning({ id: audioFiles.id }).get().id);
        out.added++;
      }
    });
    const patch: Partial<typeof books.$inferInsert> = { hasFile: files.length > 0 || book.hasFile, path: folder, monitored: true };
    const fileChapters = chaptersOfSingleFile(files);
    if (book.chapters.length === 0 && fileChapters) patch.chapters = fileChapters;
    tx.update(books).set(patch).where(eq(books.id, book.id)).run();
    // A book a rescan had (wrongly) given these files keeps `has_file` only with files left.
    for (const id of takenFrom) {
      if (!tx.select({ id: audioFiles.id }).from(audioFiles).where(eq(audioFiles.bookId, id)).get()) tx.update(books).set({ hasFile: false }).where(eq(books.id, id)).run();
    }
    return out;
  });
}


// ---------------------------------------------------------------------------------------
// Wanted
// ---------------------------------------------------------------------------------------

function paginate<T>(items: T[], q: WantedBooksQuery): { page: number; pageSize: number; totalRecords: number; records: T[] } {
  const start = (q.page - 1) * q.pageSize;
  return { page: q.page, pageSize: q.pageSize, totalRecords: items.length, records: items.slice(start, start + q.pageSize) };
}

/**
 * The `q` text search of the Wanted book lists: title, subtitle, the owning author's name, every
 * credited author and the series the book belongs to.
 */
export function wantedBookSearchCondition(q: string | null | undefined): SQL | undefined {
  return listSearchCondition(q, [
    books.title,
    books.subtitle,
    authors.name,
    sql`(select group_concat(q_a.name, ' | ') from book_authors q_ba join authors q_a on q_a.id = q_ba.author_id where q_ba.book_id = ${books.id})`,
    sql`(select group_concat(q_s.name, ' | ') from book_series_entries q_e join book_series q_s on q_s.id = q_e.series_id where q_e.book_id = ${books.id})`,
  ]);
}

function monitoredBooksOfMonitoredAuthors(db: AudiobookDb, search?: string) {
  return db
    .select({ book: books, author: authors })
    .from(books)
    .innerJoin(authors, eq(books.authorId, authors.id))
    .where(and(eq(books.monitored, true), eq(authors.monitored, true), wantedBookSearchCondition(search)))
    .orderBy(desc(books.releaseDate), asc(authors.sortName), asc(books.sortTitle), asc(books.id))
    .all();
}

function toWanted(db: AudiobookDb, rows: ReadonlyArray<{ book: BookRow; author: AuthorRow }>): WantedBook[] {
  const list = booksFromRows(
    db,
    rows.map((r) => r.book),
  );
  return list.map((b, i) => ({ ...b, authorName: rows[i]!.author.name, qualityProfileId: rows[i]!.author.qualityProfileId }));
}

/** The Wanted release filter on book rows: the book's release / publish date (release-dates.ts). */
function bookReleaseFilter(q: WantedReleaseFilter, now: Date) {
  return (r: { book: BookRow }) => matchesReleaseFilter(dateReleaseMs(r.book), isReleased(r.book.releaseDate, now), q);
}

/**
 * Monitored books (of monitored authors) that have no file: released ones by default
 * (`released` filter; `unreleased` = release date in the future or unknown). Newest first.
 */
export function listMissingBooks(db: AudiobookDb, q: WantedBooksQuery, now: Date = new Date()): WantedBooksPage {
  const rows = monitoredBooksOfMonitoredAuthors(db, q.q).filter((r) => !r.book.hasFile).filter(bookReleaseFilter(q, now));
  const page = paginate(rows, q);
  return { ...page, records: toWanted(db, page.records) };
}

/** Monitored books with files whose lowest file quality is below the author's profile cutoff. */
export function listCutoffUnmetBooks(db: AudiobookDb, q: WantedBooksQuery, profiles: readonly QualityProfile[], now: Date = new Date()): WantedBooksPage {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const rows = monitoredBooksOfMonitoredAuthors(db, q.q).filter((r) => r.book.hasFile).filter(bookReleaseFilter(q, now));
  if (rows.length === 0) return paginate([], q);
  const files = db
    .select({ bookId: audioFiles.bookId, quality: audioFiles.quality })
    .from(audioFiles)
    .where(and(eq(audioFiles.mediaType, 'audiobook'), inArray(audioFiles.bookId, rows.map((r) => r.book.id))))
    .all();
  const byBook = new Map<number, typeof files>();
  for (const f of files) if (f.bookId !== null) byBook.set(f.bookId, [...(byBook.get(f.bookId) ?? []), f]);
  const unmet = rows.filter((r) => {
    const own = byBook.get(r.book.id);
    const profile = byId.get(r.author.qualityProfileId);
    if (!own || own.length === 0 || !profile) return false;
    return own.some((f) => !isQualityCutoffMet(profile, f.quality));
  });
  const page = paginate(unmet, q);
  return { ...page, records: toWanted(db, page.records) };
}

export { authorRow, bookRow, toAuthorSummary };
