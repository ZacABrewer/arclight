import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  BooksWantedQuery,
  type BooksCalendarEntry,
  type BooksCalendarQuery,
  type BooksFile,
  type BooksFormat,
  type BooksKind,
  type BooksOverview,
  type BooksWantedItem,
  type BooksWantedPage,
  type ComicIssue,
  type ComicMonitorOption,
  type ComicSeries,
  type ComicSeriesDetails,
  type Ebook,
  type EbookAuthor,
  type EbookAuthorDetails,
  type EbookMonitorOption,
  type EbookSeriesDetails,
  type EbookSeriesLink,
  type MonitorNewEbooks,
} from '@arclight/shared';
import { comicIssueNumberKey, type BookAuthorRecord, type BookRecord, type ComicIssueRecord, type ComicSeriesRecord } from '@arclight/metadata';
import { bookTitleKey } from '@arclight/parser';
import type { Db } from '../../db/index.js';
import { authors as audiobookAuthors, bookSeries, bookSeriesEntries, rootFolders, tags as tagsTable } from '../../db/schema.js';
import { authorSortName, seriesIdFor } from '../audiobooks/service.js';
import { booksToMonitor, isReleased, monitorNewBook, nextAuthorRefreshAt, positionSortOf, releaseDateMs } from '../audiobooks/monitoring.js';
import { libraryService } from '../library/index.js';
import { BooksError } from './errors.js';
import { requireFormatProfile } from './profiles.js';
import {
  bookFiles,
  bookFormatProfiles,
  comicIssues,
  comicSeries,
  ebookAuthors,
  ebookSeriesEntries,
  ebooks,
  type BookFileRow,
  type ComicIssueRow,
  type ComicSeriesRow,
  type EbookAuthorRow,
  type EbookRow,
} from './schema.js';

// The ebook and comic library (docs/books.md "Library"): authors and their books, comic series
// and their issues, statistics, monitoring, Wanted, the calendar and the overview. Catalogue
// records come in through `syncAuthorBooks` / `syncComicIssues` (catalog.ts calls them on add
// and refresh); everything here is synchronous SQL except deleting folders.
//
// Matching a catalogue book to a library row on refresh: any shared key (`isbn:`, `ol:`, `gb:`,
// `hc:`), else a shared ISBN, else the same title key. Issues match on the normalized issue
// number (`issueKeyOf`), so "001" and "1" are one issue.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** The database or a transaction on it. */
export type BooksDb = Db | Tx;

const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (now: Date = new Date()) => now.toISOString();

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A registered root folder of the kind (`ebook` / `comic`), or VALIDATION. */
export function requireRootFolder(db: BooksDb, path: string, kind: BooksKind): string {
  const match = db
    .select()
    .from(rootFolders)
    .where(eq(rootFolders.mediaType, kind))
    .all()
    .find((r) => resolve(r.path) === resolve(path));
  if (!match) throw new BooksError('VALIDATION', `${path} is not a registered ${kind} root folder`);
  return match.path;
}

function requireTags(db: BooksDb, ids: readonly number[]): number[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = new Set(db.select({ id: tagsTable.id }).from(tagsTable).where(inArray(tagsTable.id, unique)).all().map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) throw new BooksError('VALIDATION', `unknown tag ids: ${missing.join(', ')}`);
  return unique.sort((a, b) => a - b);
}

/** Normalized issue number for matching: `001` → `1`, `#12.10` → `12.1`, `Annual 02` → `annual 2`. */
export function issueKeyOf(issueNumber: string, annual = false): string {
  const raw = issueNumber.trim().replace(/^#\s*/, '');
  const m = /^annual\s*#?\s*(.+)$/i.exec(raw);
  if (m) return `annual ${comicIssueNumberKey(m[1]!)}`;
  const key = comicIssueNumberKey(raw);
  return annual ? `annual ${key}` : key;
}

function issueSortOf(issueNumber: string): number | null {
  const n = Number.parseFloat(issueNumber.replace(/^#/, ''));
  if (Number.isFinite(n) && /^\s*#?-?\d/.test(issueNumber)) return n;
  if (issueNumber.trim() === '½') return 0.5;
  return null;
}

function yearOf(date: string | null | undefined): number | null {
  const m = date ? /^(\d{4})/.exec(date) : null;
  return m ? Number(m[1]) : null;
}

/** The date an issue counts as released on: on-sale date, else the cover date. */
export function issueReleaseDate(issue: Pick<ComicIssueRow, 'storeDate' | 'coverDate'>): string | null {
  return issue.storeDate ?? issue.coverDate;
}

// ---------------------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------------------

export function toBooksFile(row: BookFileRow): BooksFile {
  return {
    id: row.id,
    kind: row.kind,
    ebookId: row.ebookId,
    comicIssueId: row.comicIssueId,
    path: row.path,
    relativePath: row.relativePath,
    sizeBytes: row.sizeBytes,
    format: row.format,
    releaseGroup: row.releaseGroup,
    sceneName: row.sceneName,
    dateAdded: row.dateAdded,
  };
}

function filesByEbook(db: BooksDb, ids: readonly number[]): Map<number, BookFileRow> {
  const out = new Map<number, BookFileRow>();
  if (ids.length === 0) return out;
  for (const f of db.select().from(bookFiles).where(inArray(bookFiles.ebookId, [...ids])).orderBy(asc(bookFiles.id)).all()) out.set(f.ebookId!, f);
  return out;
}

function filesByIssue(db: BooksDb, ids: readonly number[]): Map<number, BookFileRow> {
  const out = new Map<number, BookFileRow>();
  if (ids.length === 0) return out;
  for (const f of db.select().from(bookFiles).where(inArray(bookFiles.comicIssueId, [...ids])).orderBy(asc(bookFiles.id)).all()) out.set(f.comicIssueId!, f);
  return out;
}

function seriesLinks(db: BooksDb, ebookIds: readonly number[]): Map<number, Array<EbookSeriesLink & { positionSort: number | null }>> {
  const out = new Map<number, Array<EbookSeriesLink & { positionSort: number | null }>>();
  if (ebookIds.length === 0) return out;
  const rows = db
    .select({ ebookId: ebookSeriesEntries.ebookId, seriesId: ebookSeriesEntries.seriesId, name: bookSeries.name, position: ebookSeriesEntries.position, positionSort: ebookSeriesEntries.positionSort })
    .from(ebookSeriesEntries)
    .innerJoin(bookSeries, eq(bookSeries.id, ebookSeriesEntries.seriesId))
    .where(inArray(ebookSeriesEntries.ebookId, [...ebookIds]))
    .all();
  for (const r of rows) {
    const list = out.get(r.ebookId) ?? [];
    list.push({ seriesId: r.seriesId, name: r.name, position: r.position, positionSort: r.positionSort });
    out.set(r.ebookId, list);
  }
  return out;
}

/** Ebook resources for rows (series links, files and author names batched). */
export function toEbooks(db: BooksDb, rows: readonly EbookRow[]): Ebook[] {
  const ids = rows.map((r) => r.id);
  const files = filesByEbook(db, ids);
  const links = seriesLinks(db, ids);
  const authorIds = [...new Set(rows.map((r) => r.authorId))];
  const names = new Map(
    authorIds.length === 0 ? [] : db.select({ id: ebookAuthors.id, name: ebookAuthors.name }).from(ebookAuthors).where(inArray(ebookAuthors.id, authorIds)).all().map((a) => [a.id, a.name] as const),
  );
  return rows.map((r) => {
    const file = files.get(r.id);
    return {
      id: r.id,
      authorId: r.authorId,
      authorName: names.get(r.authorId) ?? '',
      title: r.title,
      subtitle: r.subtitle,
      sortTitle: r.sortTitle,
      isbn13: r.isbn13,
      olWorkId: r.olWorkId,
      googleVolumeId: r.googleVolumeId,
      hardcoverId: r.hardcoverId,
      publisher: r.publisher,
      language: r.language,
      releaseDate: r.releaseDate,
      year: r.year,
      pageCount: r.pageCount,
      overview: r.overview,
      genres: r.genres,
      coverUrl: r.coverUrl,
      rating: r.rating,
      monitored: r.monitored,
      hasFile: r.hasFile,
      series: (links.get(r.id) ?? []).map(({ seriesId, name, position }) => ({ seriesId, name, position })),
      file: file ? toBooksFile(file) : null,
      lastSearchedAt: r.lastSearchedAt,
      added: r.added,
    };
  });
}

function authorStatistics(db: BooksDb, authorIds: readonly number[]): Map<number, EbookAuthor['statistics']> {
  const out = new Map<number, EbookAuthor['statistics']>();
  for (const id of authorIds) out.set(id, { bookCount: 0, monitoredCount: 0, availableCount: 0, seriesCount: 0, sizeOnDisk: 0 });
  if (authorIds.length === 0) return out;
  const rows = db
    .select({
      authorId: ebooks.authorId,
      books: sql<number>`count(*)`,
      monitored: sql<number>`sum(case when ${ebooks.monitored} then 1 else 0 end)`,
      available: sql<number>`sum(case when ${ebooks.hasFile} then 1 else 0 end)`,
    })
    .from(ebooks)
    .where(inArray(ebooks.authorId, [...authorIds]))
    .groupBy(ebooks.authorId)
    .all();
  for (const r of rows) Object.assign(out.get(r.authorId)!, { bookCount: r.books, monitoredCount: r.monitored ?? 0, availableCount: r.available ?? 0 });
  const series = db
    .select({ authorId: ebooks.authorId, n: sql<number>`count(distinct ${ebookSeriesEntries.seriesId})` })
    .from(ebookSeriesEntries)
    .innerJoin(ebooks, eq(ebooks.id, ebookSeriesEntries.ebookId))
    .where(inArray(ebooks.authorId, [...authorIds]))
    .groupBy(ebooks.authorId)
    .all();
  for (const r of series) out.get(r.authorId)!.seriesCount = r.n;
  const sizes = db
    .select({ authorId: ebooks.authorId, size: sql<number>`coalesce(sum(${bookFiles.sizeBytes}), 0)` })
    .from(bookFiles)
    .innerJoin(ebooks, eq(ebooks.id, bookFiles.ebookId))
    .where(inArray(ebooks.authorId, [...authorIds]))
    .groupBy(ebooks.authorId)
    .all();
  for (const r of sizes) out.get(r.authorId)!.sizeOnDisk = r.size;
  return out;
}

export function toAuthors(db: BooksDb, rows: readonly EbookAuthorRow[]): EbookAuthor[] {
  const stats = authorStatistics(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sortName: r.sortName,
    olAuthorId: r.olAuthorId,
    hardcoverId: r.hardcoverId,
    overview: r.overview,
    imageUrl: r.imageUrl,
    path: r.path,
    rootFolderPath: r.rootFolderPath,
    formatProfileId: r.formatProfileId,
    monitored: r.monitored,
    monitorNewBooks: r.monitorNewBooks,
    tags: r.tags,
    audiobookAuthorId: r.audiobookAuthorId,
    added: r.added,
    lastRefreshed: r.lastRefreshed,
    statistics: stats.get(r.id)!,
  }));
}

function comicStatistics(db: BooksDb, seriesIds: readonly number[]): Map<number, ComicSeries['statistics']> {
  const out = new Map<number, ComicSeries['statistics']>();
  for (const id of seriesIds) out.set(id, { issueCount: 0, monitoredCount: 0, availableCount: 0, sizeOnDisk: 0 });
  if (seriesIds.length === 0) return out;
  const rows = db
    .select({
      seriesId: comicIssues.seriesId,
      issues: sql<number>`count(*)`,
      monitored: sql<number>`sum(case when ${comicIssues.monitored} then 1 else 0 end)`,
      available: sql<number>`sum(case when ${comicIssues.hasFile} then 1 else 0 end)`,
    })
    .from(comicIssues)
    .where(inArray(comicIssues.seriesId, [...seriesIds]))
    .groupBy(comicIssues.seriesId)
    .all();
  for (const r of rows) Object.assign(out.get(r.seriesId)!, { issueCount: r.issues, monitoredCount: r.monitored ?? 0, availableCount: r.available ?? 0 });
  const sizes = db
    .select({ seriesId: comicIssues.seriesId, size: sql<number>`coalesce(sum(${bookFiles.sizeBytes}), 0)` })
    .from(bookFiles)
    .innerJoin(comicIssues, eq(comicIssues.id, bookFiles.comicIssueId))
    .where(inArray(comicIssues.seriesId, [...seriesIds]))
    .groupBy(comicIssues.seriesId)
    .all();
  for (const r of sizes) out.get(r.seriesId)!.sizeOnDisk = r.size;
  return out;
}

export function toComicSeries(db: BooksDb, rows: readonly ComicSeriesRow[]): ComicSeries[] {
  const stats = comicStatistics(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    sortTitle: r.sortTitle,
    publisher: r.publisher,
    startYear: r.startYear,
    seriesType: r.seriesType,
    comicVineId: r.comicVineId,
    metronId: r.metronId,
    overview: r.overview,
    coverUrl: r.coverUrl,
    status: r.status,
    path: r.path,
    rootFolderPath: r.rootFolderPath,
    formatProfileId: r.formatProfileId,
    monitored: r.monitored,
    monitorNewIssues: r.monitorNewIssues,
    tags: r.tags,
    added: r.added,
    lastRefreshed: r.lastRefreshed,
    statistics: stats.get(r.id)!,
  }));
}

export function toIssues(db: BooksDb, rows: readonly ComicIssueRow[]): ComicIssue[] {
  const files = filesByIssue(db, rows.map((r) => r.id));
  const seriesIds = [...new Set(rows.map((r) => r.seriesId))];
  const titles = new Map(
    seriesIds.length === 0 ? [] : db.select({ id: comicSeries.id, title: comicSeries.title }).from(comicSeries).where(inArray(comicSeries.id, seriesIds)).all().map((s) => [s.id, s.title] as const),
  );
  return rows.map((r) => {
    const file = files.get(r.id);
    return {
      id: r.id,
      seriesId: r.seriesId,
      seriesTitle: titles.get(r.seriesId) ?? '',
      issueNumber: r.issueNumber,
      issueSort: r.issueSort,
      title: r.title,
      coverDate: r.coverDate,
      storeDate: r.storeDate,
      comicVineId: r.comicVineId,
      metronId: r.metronId,
      overview: r.overview,
      coverUrl: r.coverUrl,
      monitored: r.monitored,
      hasFile: r.hasFile,
      file: file ? toBooksFile(file) : null,
      lastSearchedAt: r.lastSearchedAt,
    };
  });
}

// ---------------------------------------------------------------------------------------
// Ebook authors
// ---------------------------------------------------------------------------------------

export function authorRow(db: BooksDb, id: number): EbookAuthorRow {
  const row = db.select().from(ebookAuthors).where(eq(ebookAuthors.id, id)).get();
  if (!row) throw BooksError.notFound('author', id);
  return row;
}

export function ebookRow(db: BooksDb, id: number): EbookRow {
  const row = db.select().from(ebooks).where(eq(ebooks.id, id)).get();
  if (!row) throw BooksError.notFound('ebook', id);
  return row;
}

export function listAuthors(db: BooksDb): EbookAuthor[] {
  return toAuthors(db, db.select().from(ebookAuthors).orderBy(asc(ebookAuthors.sortName)).all());
}

export function getAuthor(db: BooksDb, id: number): EbookAuthor {
  return toAuthors(db, [authorRow(db, id)])[0]!;
}

function sortBooks(list: Ebook[]): Ebook[] {
  return list.sort((a, b) => (releaseDateMs(a.releaseDate) ?? Infinity) - (releaseDateMs(b.releaseDate) ?? Infinity) || a.sortTitle.localeCompare(b.sortTitle));
}

export function getAuthorDetails(db: BooksDb, id: number): EbookAuthorDetails {
  const author = getAuthor(db, id);
  const books = sortBooks(toEbooks(db, db.select().from(ebooks).where(eq(ebooks.authorId, id)).all()));
  const series = new Map<number, { id: number; name: string; bookCount: number; availableCount: number }>();
  for (const b of books) {
    for (const s of b.series) {
      const entry = series.get(s.seriesId) ?? { id: s.seriesId, name: s.name, bookCount: 0, availableCount: 0 };
      entry.bookCount += 1;
      if (b.hasFile) entry.availableCount += 1;
      series.set(s.seriesId, entry);
    }
  }
  return { ...author, books, series: [...series.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** `<root>/<Author Name>`, folder-safe (the default folder format starts with the author). */
export function buildEbookAuthorPath(rootFolderPath: string, name: string): string {
  return join(rootFolderPath, libraryService.sanitizeFolderName(name));
}

/** The audiobook author for the same person: OpenLibrary id first, else the clean name. */
export function audiobookAuthorIdFor(db: BooksDb, author: { olAuthorId: string | null; name: string }): number | null {
  if (author.olAuthorId) {
    const hit = db.select({ id: audiobookAuthors.id }).from(audiobookAuthors).where(eq(audiobookAuthors.olAuthorId, author.olAuthorId)).get();
    if (hit) return hit.id;
  }
  const hit = db.select({ id: audiobookAuthors.id }).from(audiobookAuthors).where(eq(audiobookAuthors.cleanName, libraryService.toCleanTitle(author.name))).get();
  return hit?.id ?? null;
}

/** Re-links every ebook author to the audiobook library (idempotent backfill; startup and refresh). */
export function linkAudiobookAuthors(db: BooksDb): number {
  let changed = 0;
  for (const row of db.select().from(ebookAuthors).all()) {
    const id = audiobookAuthorIdFor(db, row);
    if (id !== row.audiobookAuthorId) {
      db.update(ebookAuthors).set({ audiobookAuthorId: id }).where(eq(ebookAuthors.id, row.id)).run();
      changed += 1;
    }
  }
  return changed;
}

/** An author already in the library for a catalogue record (any key, the OL id, or the name). */
export function findAuthor(db: BooksDb, record: Pick<BookAuthorRecord, 'keys' | 'name' | 'olAuthorId'> & { key?: string }): EbookAuthorRow | undefined {
  const keys = [...new Set([...(record.key ? [record.key] : []), ...record.keys])];
  if (keys.length > 0) {
    const byKey = db.select().from(ebookAuthors).where(inArray(ebookAuthors.foreignId, keys)).get();
    if (byKey) return byKey;
  }
  if (record.olAuthorId) {
    const byOl = db.select().from(ebookAuthors).where(eq(ebookAuthors.olAuthorId, record.olAuthorId)).get();
    if (byOl) return byOl;
  }
  return db.select().from(ebookAuthors).where(eq(ebookAuthors.cleanName, bookTitleKey(record.name))).get();
}

export interface NewAuthorInput {
  foreignId: string;
  record: BookAuthorRecord;
  rootFolderPath: string;
  formatProfileId: number;
  monitored: boolean;
  monitorNewBooks: MonitorNewEbooks;
  tags: readonly number[];
}

/** Inserts an author row (no books); CONFLICT when the author or the folder is already there. */
export function insertAuthor(db: BooksDb, input: NewAuthorInput, now: Date = new Date()): EbookAuthorRow {
  const root = requireRootFolder(db, input.rootFolderPath, 'ebook');
  requireFormatProfile(db as Db, input.formatProfileId, 'ebook');
  const tags = requireTags(db, input.tags);
  const existing = findAuthor(db, { ...input.record, key: input.foreignId });
  if (existing) throw new BooksError('CONFLICT', `${existing.name} is already in the library`);
  const path = buildEbookAuthorPath(root, input.record.name);
  const clash = db.select({ id: ebookAuthors.id }).from(ebookAuthors).where(eq(ebookAuthors.path, path)).get();
  if (clash) throw new BooksError('CONFLICT', `another author already uses ${path}`);
  const olAuthorId = input.record.olAuthorId ?? null;
  return db
    .insert(ebookAuthors)
    .values({
      foreignId: input.foreignId,
      olAuthorId,
      hardcoverId: input.record.hardcoverId ?? null,
      name: input.record.name,
      sortName: authorSortName(input.record.name),
      cleanName: bookTitleKey(input.record.name),
      overview: input.record.overview ?? '',
      imageUrl: input.record.imageUrl ?? null,
      path,
      rootFolderPath: root,
      formatProfileId: input.formatProfileId,
      monitored: input.monitored,
      monitorNewBooks: input.monitorNewBooks,
      tags,
      audiobookAuthorId: audiobookAuthorIdFor(db, { olAuthorId, name: input.record.name }),
      added: iso(now),
    })
    .returning()
    .get();
}

/** Author metadata from a refresh (name, ids, overview, picture); the folder stays. */
export function updateAuthorMetadata(db: BooksDb, id: number, record: BookAuthorRecord, now: Date = new Date()): void {
  const row = authorRow(db, id);
  const olAuthorId = record.olAuthorId ?? row.olAuthorId;
  // Another row holding the same OL id (added by name before) keeps it; this one stays as it is.
  const olTaken = olAuthorId && olAuthorId !== row.olAuthorId && db.select({ id: ebookAuthors.id }).from(ebookAuthors).where(eq(ebookAuthors.olAuthorId, olAuthorId)).get();
  db.update(ebookAuthors)
    .set({
      name: record.name || row.name,
      sortName: authorSortName(record.name || row.name),
      cleanName: bookTitleKey(record.name || row.name),
      olAuthorId: olTaken ? row.olAuthorId : olAuthorId,
      hardcoverId: record.hardcoverId ?? row.hardcoverId,
      overview: record.overview ?? row.overview,
      imageUrl: record.imageUrl ?? row.imageUrl,
      lastRefreshed: iso(now),
    })
    .where(eq(ebookAuthors.id, id))
    .run();
  const linked = audiobookAuthorIdFor(db, { olAuthorId: olTaken ? row.olAuthorId : olAuthorId, name: record.name || row.name });
  if (linked !== row.audiobookAuthorId) db.update(ebookAuthors).set({ audiobookAuthorId: linked }).where(eq(ebookAuthors.id, id)).run();
}

export interface AuthorUpdate {
  monitored?: boolean | undefined;
  monitorNewBooks?: MonitorNewEbooks | undefined;
  formatProfileId?: number | undefined;
  rootFolderPath?: string | undefined;
  tags?: number[] | undefined;
  monitorOption?: EbookMonitorOption | undefined;
}

/** A new root folder moves the author's path (files are not moved; a rescan picks them up). */
export function updateAuthor(db: Db, id: number, req: AuthorUpdate, now: Date = new Date()): EbookAuthor {
  return db.transaction((tx) => {
    const row = authorRow(tx, id);
    const patch: Partial<EbookAuthorRow> = {};
    if (req.monitored !== undefined) patch.monitored = req.monitored;
    if (req.monitorNewBooks !== undefined) patch.monitorNewBooks = req.monitorNewBooks;
    if (req.formatProfileId !== undefined) {
      requireFormatProfile(db, req.formatProfileId, 'ebook');
      patch.formatProfileId = req.formatProfileId;
    }
    if (req.tags !== undefined) patch.tags = requireTags(tx, req.tags);
    if (req.rootFolderPath !== undefined && resolve(req.rootFolderPath) !== resolve(row.rootFolderPath)) {
      const root = requireRootFolder(tx, req.rootFolderPath, 'ebook');
      patch.rootFolderPath = root;
      patch.path = buildEbookAuthorPath(root, row.name);
    }
    if (Object.keys(patch).length > 0) tx.update(ebookAuthors).set(patch).where(eq(ebookAuthors.id, id)).run();
    if (req.monitorOption) applyEbookMonitorOption(tx, id, req.monitorOption, now);
    return getAuthor(tx, id);
  });
}

/** Sets `monitored` on an author's books per the option (the rest unmonitored). */
export function applyEbookMonitorOption(db: BooksDb, authorId: number, option: EbookMonitorOption, now: Date = new Date()): void {
  const rows = db.select().from(ebooks).where(eq(ebooks.authorId, authorId)).all();
  const inSeries = new Set(
    rows.length === 0 ? [] : db.select({ id: ebookSeriesEntries.ebookId }).from(ebookSeriesEntries).where(inArray(ebookSeriesEntries.ebookId, rows.map((r) => r.id))).all().map((r) => r.id),
  );
  const keep = booksToMonitor(option, rows.map((r) => ({ id: r.id, releaseDate: r.releaseDate, hasFiles: r.hasFile, inSeries: inSeries.has(r.id) })), now);
  for (const r of rows) {
    const monitored = keep.has(r.id);
    if (monitored !== r.monitored) db.update(ebooks).set({ monitored }).where(eq(ebooks.id, r.id)).run();
  }
}

async function removeFolder(path: string, root: string): Promise<void> {
  if (!isPathInside(root, path) || resolve(root) === resolve(path)) return;
  await rm(path, { recursive: true, force: true });
}

/** Deletes the author with their books and files rows; `deleteFiles` also removes the folder. */
export async function deleteAuthor(db: Db, id: number, opts: { deleteFiles?: boolean } = {}): Promise<void> {
  const row = authorRow(db, id);
  db.delete(ebookAuthors).where(eq(ebookAuthors.id, id)).run();
  if (opts.deleteFiles) await removeFolder(row.path, row.rootFolderPath);
}

// ---------------------------------------------------------------------------------------
// Ebooks
// ---------------------------------------------------------------------------------------

export function getEbook(db: BooksDb, id: number): Ebook {
  return toEbooks(db, [ebookRow(db, id)])[0]!;
}

/** Removes the ebook and its file row; `deleteFiles` also deletes the file on disk. */
export async function deleteEbook(db: Db, id: number, opts: { deleteFiles?: boolean } = {}): Promise<void> {
  ebookRow(db, id);
  const files = db.select().from(bookFiles).where(eq(bookFiles.ebookId, id)).all();
  db.delete(ebooks).where(eq(ebooks.id, id)).run();
  if (opts.deleteFiles) for (const f of files) await rm(f.path, { force: true });
}

export function setEbooksMonitored(db: Db, ids: readonly number[], monitored: boolean): void {
  const found = db.select({ id: ebooks.id }).from(ebooks).where(inArray(ebooks.id, [...ids])).all().map((r) => r.id);
  const missing = ids.filter((id) => !found.includes(id));
  if (missing.length > 0) throw BooksError.notFound('ebook', missing.join(', '));
  db.update(ebooks).set({ monitored }).where(inArray(ebooks.id, [...ids])).run();
}

/** One catalogue book onto a row (insert or update), with its series links. */
function upsertEbook(tx: BooksDb, authorId: number, existing: EbookRow | undefined, b: BookRecord, monitored: boolean, now: Date): { id: number; created: boolean } {
  const values = {
    foreignId: b.key,
    keys: [...new Set([...(existing?.keys ?? []), b.key, ...b.keys])],
    isbn13: b.isbn13 ?? existing?.isbn13 ?? null,
    isbns: [...new Set([...(existing?.isbns ?? []), ...(b.isbn13 ? [b.isbn13] : []), ...b.isbns])],
    olWorkId: b.olWorkId ?? existing?.olWorkId ?? null,
    googleVolumeId: b.googleVolumeId ?? existing?.googleVolumeId ?? null,
    hardcoverId: b.hardcoverId ?? existing?.hardcoverId ?? null,
    title: b.title,
    subtitle: b.subtitle ?? null,
    sortTitle: libraryService.toSortTitle(b.title),
    cleanTitle: bookTitleKey(b.title),
    publisher: b.publisher ?? null,
    language: b.language ?? null,
    releaseDate: b.releaseDate ?? null,
    year: yearOf(b.releaseDate),
    pageCount: b.pageCount ?? null,
    overview: b.overview ?? '',
    genres: b.genres,
    coverUrl: b.coverUrl ?? null,
    rating: b.rating ?? null,
    lastRefreshed: iso(now),
  };
  let id: number;
  let created = false;
  if (existing) {
    tx.update(ebooks).set(values).where(eq(ebooks.id, existing.id)).run();
    id = existing.id;
  } else {
    id = tx.insert(ebooks).values({ ...values, authorId, monitored, hasFile: false, added: iso(now) }).returning({ id: ebooks.id }).get().id;
    created = true;
  }
  tx.delete(ebookSeriesEntries).where(eq(ebookSeriesEntries.ebookId, id)).run();
  const seen = new Set<number>();
  for (const ref of b.series) {
    if (!ref.name.trim()) continue;
    const seriesId = seriesIdFor(tx, { name: ref.name });
    if (seen.has(seriesId)) continue;
    seen.add(seriesId);
    tx.insert(ebookSeriesEntries).values({ seriesId, ebookId: id, position: ref.position ?? null, positionSort: positionSortOf(ref.position) }).run();
  }
  return { id, created };
}

function matchEbook(rows: readonly EbookRow[], b: BookRecord): EbookRow | undefined {
  const keys = new Set([b.key, ...b.keys]);
  const byKey = rows.find((r) => r.foreignId === b.key || r.keys.some((k) => keys.has(k)));
  if (byKey) return byKey;
  const isbns = new Set([...(b.isbn13 ? [b.isbn13] : []), ...b.isbns]);
  const byIsbn = isbns.size > 0 ? rows.find((r) => (r.isbn13 && isbns.has(r.isbn13)) || r.isbns.some((i) => isbns.has(i))) : undefined;
  if (byIsbn) return byIsbn;
  const title = bookTitleKey(b.title);
  return rows.find((r) => r.cleanTitle === title);
}

export interface SyncBooksOptions {
  /** First sync after add: apply this monitor option to every book. */
  monitorOption?: EbookMonitorOption;
  /** Only these catalogue keys are monitored (adding one book); the rest start unmonitored. */
  onlyKeys?: readonly string[];
}

/**
 * Upserts an author's catalogue books. New books start monitored per the author's
 * `monitorNewBooks` (or the add's monitor option); books the catalogue dropped are kept.
 * Returns the ids of the books it created.
 */
export function syncAuthorBooks(db: Db, authorId: number, records: readonly BookRecord[], opts: SyncBooksOptions = {}, now: Date = new Date()): number[] {
  return db.transaction((tx) => {
    const author = authorRow(tx, authorId);
    const rows = tx.select().from(ebooks).where(eq(ebooks.authorId, authorId)).all();
    const created: number[] = [];
    const seen = new Set<number>();
    for (const b of records) {
      const existing = matchEbook(rows, b);
      if (existing && seen.has(existing.id)) continue;
      const monitored = opts.onlyKeys
        ? [b.key, ...b.keys].some((k) => opts.onlyKeys!.includes(k))
        : author.monitored && monitorNewBook(author.monitorNewBooks, b.series.length > 0);
      const { id, created: isNew } = upsertEbook(tx, authorId, existing, b, monitored, now);
      seen.add(id);
      if (isNew) {
        created.push(id);
        rows.push(ebookRow(tx, id));
      }
    }
    if (opts.monitorOption) applyEbookMonitorOption(tx, authorId, opts.monitorOption, now);
    const books = tx.select({ releaseDate: ebooks.releaseDate, monitored: ebooks.monitored }).from(ebooks).where(eq(ebooks.authorId, authorId)).all();
    tx.update(ebookAuthors).set({ lastRefreshed: iso(now), nextRefreshAt: nextAuthorRefreshAt(books, now) }).where(eq(ebookAuthors.id, authorId)).run();
    return created;
  });
}

export function getSeriesDetails(db: BooksDb, id: number): EbookSeriesDetails {
  const series = db.select().from(bookSeries).where(eq(bookSeries.id, id)).get();
  if (!series) throw BooksError.notFound('series', id);
  const entries = db.select().from(ebookSeriesEntries).where(eq(ebookSeriesEntries.seriesId, id)).all();
  const position = new Map(entries.map((e) => [e.ebookId, e] as const));
  const rows = entries.length === 0 ? [] : db.select().from(ebooks).where(inArray(ebooks.id, entries.map((e) => e.ebookId))).all();
  const books = toEbooks(db, rows)
    .map((b) => ({ ...b, position: position.get(b.id)?.position ?? null, sort: position.get(b.id)?.positionSort ?? null }))
    .sort((a, b) => (a.sort ?? Infinity) - (b.sort ?? Infinity) || (releaseDateMs(a.releaseDate) ?? Infinity) - (releaseDateMs(b.releaseDate) ?? Infinity))
    .map(({ sort: _sort, ...b }) => b);
  const audiobookCount = db.select({ n: sql<number>`count(*)` }).from(bookSeriesEntries).where(eq(bookSeriesEntries.seriesId, id)).get()?.n ?? 0;
  return { id: series.id, name: series.name, overview: series.overview, books, audiobookCount };
}

// ---------------------------------------------------------------------------------------
// Comics
// ---------------------------------------------------------------------------------------

export function comicSeriesRow(db: BooksDb, id: number): ComicSeriesRow {
  const row = db.select().from(comicSeries).where(eq(comicSeries.id, id)).get();
  if (!row) throw BooksError.notFound('comic series', id);
  return row;
}

export function issueRow(db: BooksDb, id: number): ComicIssueRow {
  const row = db.select().from(comicIssues).where(eq(comicIssues.id, id)).get();
  if (!row) throw BooksError.notFound('comic issue', id);
  return row;
}

export function listComicSeries(db: BooksDb): ComicSeries[] {
  return toComicSeries(db, db.select().from(comicSeries).orderBy(asc(comicSeries.sortTitle)).all());
}

export function getComicSeries(db: BooksDb, id: number): ComicSeries {
  return toComicSeries(db, [comicSeriesRow(db, id)])[0]!;
}

function sortIssues<T extends { issueSort: number | null; issueNumber: string }>(list: T[]): T[] {
  return list.sort((a, b) => (a.issueSort ?? Infinity) - (b.issueSort ?? Infinity) || a.issueNumber.localeCompare(b.issueNumber));
}

export function getComicDetails(db: BooksDb, id: number): ComicSeriesDetails {
  const series = getComicSeries(db, id);
  return { ...series, issues: sortIssues(toIssues(db, db.select().from(comicIssues).where(eq(comicIssues.seriesId, id)).all())) };
}

export function findComicSeries(db: BooksDb, record: Pick<ComicSeriesRecord, 'keys' | 'comicVineId' | 'metronId'> & { key?: string }): ComicSeriesRow | undefined {
  const keys = [...new Set([...(record.key ? [record.key] : []), ...record.keys])];
  if (keys.length > 0) {
    const hit = db.select().from(comicSeries).where(inArray(comicSeries.foreignId, keys)).get();
    if (hit) return hit;
  }
  if (record.comicVineId) {
    const hit = db.select().from(comicSeries).where(eq(comicSeries.comicVineId, record.comicVineId)).get();
    if (hit) return hit;
  }
  if (record.metronId) return db.select().from(comicSeries).where(eq(comicSeries.metronId, record.metronId)).get();
  return undefined;
}

export interface NewComicSeriesInput {
  foreignId: string;
  record: ComicSeriesRecord;
  /** The series folder (catalog.ts renders it from the comic folder format). */
  path: string;
  rootFolderPath: string;
  formatProfileId: number;
  seriesType: ComicSeries['seriesType'];
  monitored: boolean;
  monitorNewIssues: boolean;
  tags: readonly number[];
}

export function insertComicSeries(db: BooksDb, input: NewComicSeriesInput, now: Date = new Date()): ComicSeriesRow {
  const root = requireRootFolder(db, input.rootFolderPath, 'comic');
  requireFormatProfile(db as Db, input.formatProfileId, 'comic');
  const tags = requireTags(db, input.tags);
  const existing = findComicSeries(db, { ...input.record, key: input.foreignId });
  if (existing) throw new BooksError('CONFLICT', `${existing.title} is already in the library`);
  const clash = db.select({ id: comicSeries.id }).from(comicSeries).where(eq(comicSeries.path, input.path)).get();
  if (clash) throw new BooksError('CONFLICT', `another comic series already uses ${input.path}`);
  const r = input.record;
  return db
    .insert(comicSeries)
    .values({
      foreignId: input.foreignId,
      comicVineId: r.comicVineId ?? null,
      metronId: r.metronId ?? null,
      title: r.title,
      sortTitle: libraryService.toSortTitle(r.title),
      cleanTitle: bookTitleKey(r.title),
      publisher: r.publisher ?? null,
      startYear: r.startYear ?? null,
      seriesType: input.seriesType,
      overview: r.overview ?? '',
      coverUrl: r.coverUrl ?? null,
      status: r.status ?? 'unknown',
      path: input.path,
      rootFolderPath: root,
      formatProfileId: input.formatProfileId,
      monitored: input.monitored,
      monitorNewIssues: input.monitorNewIssues,
      tags,
      added: iso(now),
    })
    .returning()
    .get();
}

export function updateComicSeriesMetadata(db: BooksDb, id: number, r: ComicSeriesRecord, now: Date = new Date()): void {
  const row = comicSeriesRow(db, id);
  const cvTaken = r.comicVineId && r.comicVineId !== row.comicVineId && db.select({ id: comicSeries.id }).from(comicSeries).where(eq(comicSeries.comicVineId, r.comicVineId)).get();
  const metronTaken = r.metronId && r.metronId !== row.metronId && db.select({ id: comicSeries.id }).from(comicSeries).where(eq(comicSeries.metronId, r.metronId)).get();
  db.update(comicSeries)
    .set({
      title: r.title || row.title,
      sortTitle: libraryService.toSortTitle(r.title || row.title),
      cleanTitle: bookTitleKey(r.title || row.title),
      comicVineId: cvTaken ? row.comicVineId : (r.comicVineId ?? row.comicVineId),
      metronId: metronTaken ? row.metronId : (r.metronId ?? row.metronId),
      publisher: r.publisher ?? row.publisher,
      startYear: r.startYear ?? row.startYear,
      overview: r.overview ?? row.overview,
      coverUrl: r.coverUrl ?? row.coverUrl,
      status: r.status ?? row.status,
      lastRefreshed: iso(now),
    })
    .where(eq(comicSeries.id, id))
    .run();
}

/** Sets `monitored` on a series' issues per the option (the rest unmonitored). */
export function applyComicMonitorOption(db: BooksDb, seriesId: number, option: ComicMonitorOption, now: Date = new Date()): void {
  const rows = db.select().from(comicIssues).where(eq(comicIssues.seriesId, seriesId)).all();
  const keep = booksToMonitor(option, rows.map((r) => ({ id: r.id, releaseDate: issueReleaseDate(r), hasFiles: r.hasFile, inSeries: true })), now);
  for (const r of rows) {
    const monitored = keep.has(r.id);
    if (monitored !== r.monitored) db.update(comicIssues).set({ monitored }).where(eq(comicIssues.id, r.id)).run();
  }
}

/**
 * Upserts a series' catalogue issues (matched by normalized number). New issues start
 * monitored when the series is monitored with `monitorNewIssues`. Returns the created ids.
 */
export function syncComicIssues(db: Db, seriesId: number, records: readonly ComicIssueRecord[], opts: { monitorOption?: ComicMonitorOption } = {}, now: Date = new Date()): number[] {
  return db.transaction((tx) => {
    const series = comicSeriesRow(tx, seriesId);
    const rows = new Map(tx.select().from(comicIssues).where(eq(comicIssues.seriesId, seriesId)).all().map((r) => [r.issueKey, r] as const));
    const created: number[] = [];
    for (const r of records) {
      if (!r.issueNumber.trim()) continue;
      const issueKey = issueKeyOf(r.issueNumber);
      const values = {
        foreignId: r.key,
        comicVineId: r.comicVineId ?? null,
        metronId: r.metronId ?? null,
        issueNumber: r.issueNumber.trim(),
        issueSort: issueSortOf(r.issueNumber),
        title: r.title ?? null,
        coverDate: r.coverDate ?? null,
        storeDate: r.storeDate ?? null,
        overview: r.overview ?? '',
        coverUrl: r.coverUrl ?? null,
      };
      const existing = rows.get(issueKey);
      if (existing) {
        tx.update(comicIssues).set(values).where(eq(comicIssues.id, existing.id)).run();
      } else {
        const row = tx
          .insert(comicIssues)
          .values({ ...values, seriesId, issueKey, monitored: series.monitored && series.monitorNewIssues, hasFile: false, added: iso(now) })
          .returning()
          .get();
        rows.set(issueKey, row);
        created.push(row.id);
      }
    }
    if (opts.monitorOption) applyComicMonitorOption(tx, seriesId, opts.monitorOption, now);
    const issues = tx.select().from(comicIssues).where(eq(comicIssues.seriesId, seriesId)).all();
    const nextRefreshAt = nextAuthorRefreshAt(issues.map((i) => ({ releaseDate: issueReleaseDate(i), monitored: i.monitored })), now);
    tx.update(comicSeries).set({ lastRefreshed: iso(now), nextRefreshAt }).where(eq(comicSeries.id, seriesId)).run();
    return created;
  });
}

export interface ComicSeriesUpdate {
  monitored?: boolean | undefined;
  monitorNewIssues?: boolean | undefined;
  seriesType?: ComicSeries['seriesType'] | undefined;
  formatProfileId?: number | undefined;
  rootFolderPath?: string | undefined;
  tags?: number[] | undefined;
  monitorOption?: ComicMonitorOption | undefined;
}

/** A new root folder keeps the series folder name under the new root. */
export function updateComicSeries(db: Db, id: number, req: ComicSeriesUpdate, now: Date = new Date()): ComicSeries {
  return db.transaction((tx) => {
    const row = comicSeriesRow(tx, id);
    const patch: Partial<ComicSeriesRow> = {};
    if (req.monitored !== undefined) patch.monitored = req.monitored;
    if (req.monitorNewIssues !== undefined) patch.monitorNewIssues = req.monitorNewIssues;
    if (req.seriesType !== undefined) patch.seriesType = req.seriesType;
    if (req.formatProfileId !== undefined) {
      requireFormatProfile(db, req.formatProfileId, 'comic');
      patch.formatProfileId = req.formatProfileId;
    }
    if (req.tags !== undefined) patch.tags = requireTags(tx, req.tags);
    if (req.rootFolderPath !== undefined && resolve(req.rootFolderPath) !== resolve(row.rootFolderPath)) {
      const root = requireRootFolder(tx, req.rootFolderPath, 'comic');
      patch.rootFolderPath = root;
      patch.path = join(root, relative(row.rootFolderPath, row.path));
    }
    if (Object.keys(patch).length > 0) tx.update(comicSeries).set(patch).where(eq(comicSeries.id, id)).run();
    if (req.monitorOption) applyComicMonitorOption(tx, id, req.monitorOption, now);
    return getComicSeries(tx, id);
  });
}

export async function deleteComicSeries(db: Db, id: number, opts: { deleteFiles?: boolean } = {}): Promise<void> {
  const row = comicSeriesRow(db, id);
  db.delete(comicSeries).where(eq(comicSeries.id, id)).run();
  if (opts.deleteFiles) await removeFolder(row.path, row.rootFolderPath);
}

export function setIssuesMonitored(db: Db, ids: readonly number[], monitored: boolean): void {
  const found = db.select({ id: comicIssues.id }).from(comicIssues).where(inArray(comicIssues.id, [...ids])).all().map((r) => r.id);
  const missing = ids.filter((id) => !found.includes(id));
  if (missing.length > 0) throw BooksError.notFound('comic issue', missing.join(', '));
  db.update(comicIssues).set({ monitored }).where(inArray(comicIssues.id, [...ids])).run();
}

// ---------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------

export function bookFileRow(db: BooksDb, id: number): BookFileRow {
  const row = db.select().from(bookFiles).where(eq(bookFiles.id, id)).get();
  if (!row) throw BooksError.notFound('book file', id);
  return row;
}

/** Drops a file row and clears `hasFile` on its ebook / issue when no other file is left. */
export function removeFileRow(db: BooksDb, id: number): BookFileRow {
  const row = bookFileRow(db, id);
  db.delete(bookFiles).where(eq(bookFiles.id, id)).run();
  refreshHasFile(db, row);
  return row;
}

/** Recomputes `hasFile` of the item a file row belongs to. */
export function refreshHasFile(db: BooksDb, target: { ebookId: number | null; comicIssueId: number | null }): void {
  if (target.ebookId !== null) {
    const any = db.select({ id: bookFiles.id }).from(bookFiles).where(eq(bookFiles.ebookId, target.ebookId)).limit(1).get();
    db.update(ebooks).set({ hasFile: any !== undefined }).where(eq(ebooks.id, target.ebookId)).run();
  }
  if (target.comicIssueId !== null) {
    const any = db.select({ id: bookFiles.id }).from(bookFiles).where(eq(bookFiles.comicIssueId, target.comicIssueId)).limit(1).get();
    db.update(comicIssues).set({ hasFile: any !== undefined }).where(eq(comicIssues.id, target.comicIssueId)).run();
  }
}

// ---------------------------------------------------------------------------------------
// Wanted, calendar, overview
// ---------------------------------------------------------------------------------------

/** Rank of a format in the profile (0 = best); formats the profile does not list rank last. */
export function formatRank(formats: readonly BooksFormat[], format: BooksFormat): number {
  const i = formats.indexOf(format);
  return i < 0 ? formats.length : i;
}

/** Whether a file at `format` meets the profile's cutoff (at the cutoff or better). */
export function meetsCutoff(profile: { formats: readonly BooksFormat[]; cutoff: BooksFormat }, format: BooksFormat): boolean {
  return formatRank(profile.formats, format) <= formatRank(profile.formats, profile.cutoff);
}

/** Every wanted item of a kind, oldest release first (Wanted, the missing search). */
export function wantedItems(db: BooksDb, kind: BooksKind, reason: 'missing' | 'cutoff', now: Date = new Date()): BooksWantedItem[] {
  if (kind === 'ebook') {
    const rows = db
      .select({ book: ebooks, author: ebookAuthors })
      .from(ebooks)
      .innerJoin(ebookAuthors, eq(ebookAuthors.id, ebooks.authorId))
      .where(and(eq(ebooks.monitored, true), eq(ebookAuthors.monitored, true), eq(ebooks.hasFile, reason === 'cutoff')))
      .all()
      .filter((r) => reason === 'cutoff' || isReleased(r.book.releaseDate, now) || r.book.releaseDate === null);
    const keep = reason === 'cutoff' ? belowCutoff(db, 'ebook', rows.map((r) => ({ id: r.book.id, profileId: r.author.formatProfileId }))) : null;
    return rows
      .filter((r) => !keep || keep.has(r.book.id))
      .map((r) => ({
        kind: 'ebook' as const,
        id: r.book.id,
        parentId: r.author.id,
        title: r.book.title,
        parentTitle: r.author.name,
        releaseDate: r.book.releaseDate,
        coverUrl: r.book.coverUrl,
        lastSearchedAt: r.book.lastSearchedAt,
        reason,
      }));
  }
  const rows = db
    .select({ issue: comicIssues, series: comicSeries })
    .from(comicIssues)
    .innerJoin(comicSeries, eq(comicSeries.id, comicIssues.seriesId))
    .where(and(eq(comicIssues.monitored, true), eq(comicSeries.monitored, true), eq(comicIssues.hasFile, reason === 'cutoff')))
    .all()
    .filter((r) => reason === 'cutoff' || issueReleaseDate(r.issue) === null || isReleased(issueReleaseDate(r.issue), now));
  const keep = reason === 'cutoff' ? belowCutoff(db, 'comic', rows.map((r) => ({ id: r.issue.id, profileId: r.series.formatProfileId }))) : null;
  return rows
    .filter((r) => !keep || keep.has(r.issue.id))
    .map((r) => ({
      kind: 'comic' as const,
      id: r.issue.id,
      parentId: r.series.id,
      title: `${r.series.title} #${r.issue.issueNumber}${r.issue.title ? ` - ${r.issue.title}` : ''}`,
      parentTitle: r.series.startYear ? `${r.series.title} (${r.series.startYear})` : r.series.title,
      releaseDate: issueReleaseDate(r.issue),
      coverUrl: r.issue.coverUrl ?? r.series.coverUrl,
      lastSearchedAt: r.issue.lastSearchedAt,
      reason,
    }));
}

/** Items (ebook or issue ids) whose file is below their profile's cutoff. */
function belowCutoff(db: BooksDb, kind: BooksKind, items: ReadonlyArray<{ id: number; profileId: number }>): Set<number> {
  const out = new Set<number>();
  if (items.length === 0) return out;
  const profiles = new Map(db.select().from(bookFormatProfiles).all().map((p) => [p.id, p] as const));
  const files = kind === 'ebook' ? filesByEbook(db, items.map((i) => i.id)) : filesByIssue(db, items.map((i) => i.id));
  for (const item of items) {
    const profile = profiles.get(item.profileId);
    const file = files.get(item.id);
    if (profile && file && profile.upgradeAllowed && !meetsCutoff(profile, file.format)) out.add(item.id);
  }
  return out;
}

export function wanted(db: BooksDb, raw: unknown, now: Date = new Date()): BooksWantedPage {
  const q = BooksWantedQuery.parse(raw ?? {});
  const kinds: BooksKind[] = q.kind === 'all' ? ['ebook', 'comic'] : [q.kind];
  const all = kinds
    .flatMap((k) => wantedItems(db, k, q.reason, now))
    .sort((a, b) => (releaseDateMs(b.releaseDate) ?? 0) - (releaseDateMs(a.releaseDate) ?? 0) || a.title.localeCompare(b.title));
  const start = (q.page - 1) * q.pageSize;
  return { page: q.page, pageSize: q.pageSize, totalRecords: all.length, records: all.slice(start, start + q.pageSize) };
}

function dayOf(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString().slice(0, 10);
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new BooksError('VALIDATION', `${value} is not a date`);
  return new Date(t).toISOString().slice(0, 10);
}

const fullDate = (d: string | null): d is string => d !== null && /^\d{4}-\d{2}-\d{2}/.test(d);

/** Books and issues released between `start` and `end` (default: a week back, four weeks ahead). */
export function calendar(db: BooksDb, query: BooksCalendarQuery, now: Date = new Date()): BooksCalendarEntry[] {
  const start = dayOf(query.start, new Date(now.getTime() - 7 * DAY_MS));
  const end = dayOf(query.end, new Date(now.getTime() + 28 * DAY_MS));
  if (start > end) throw new BooksError('VALIDATION', 'start is after end');
  const unmonitored = query.unmonitored === true || query.unmonitored === 'true';
  const out: BooksCalendarEntry[] = [];
  const books = db
    .select({ book: ebooks, author: ebookAuthors })
    .from(ebooks)
    .innerJoin(ebookAuthors, eq(ebookAuthors.id, ebooks.authorId))
    .where(and(isNotNull(ebooks.releaseDate), sql`substr(${ebooks.releaseDate}, 1, 10) between ${start} and ${end}`))
    .all();
  for (const { book, author } of books) {
    if (!fullDate(book.releaseDate) || (!unmonitored && !(book.monitored && author.monitored))) continue;
    out.push({ kind: 'ebook', id: book.id, parentId: author.id, date: book.releaseDate.slice(0, 10), title: book.title, parentTitle: author.name, coverUrl: book.coverUrl, monitored: book.monitored, hasFile: book.hasFile });
  }
  const issues = db
    .select({ issue: comicIssues, series: comicSeries })
    .from(comicIssues)
    .innerJoin(comicSeries, eq(comicSeries.id, comicIssues.seriesId))
    .where(sql`substr(coalesce(${comicIssues.storeDate}, ${comicIssues.coverDate}), 1, 10) between ${start} and ${end}`)
    .all();
  for (const { issue, series } of issues) {
    const date = issueReleaseDate(issue);
    if (!fullDate(date) || (!unmonitored && !(issue.monitored && series.monitored))) continue;
    out.push({
      kind: 'comic',
      id: issue.id,
      parentId: series.id,
      date: date.slice(0, 10),
      title: `${series.title} #${issue.issueNumber}${issue.title ? ` - ${issue.title}` : ''}`,
      parentTitle: series.startYear ? `${series.title} (${series.startYear})` : series.title,
      coverUrl: issue.coverUrl ?? series.coverUrl,
      monitored: issue.monitored,
      hasFile: issue.hasFile,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

export function overview(db: BooksDb, now: Date = new Date()): BooksOverview {
  const count = (q: { n: number } | undefined) => q?.n ?? 0;
  const n = sql<number>`count(*)`;
  return {
    ebookAuthors: count(db.select({ n }).from(ebookAuthors).get()),
    ebooks: count(db.select({ n }).from(ebooks).get()),
    ebooksAvailable: count(db.select({ n }).from(ebooks).where(eq(ebooks.hasFile, true)).get()),
    comicSeries: count(db.select({ n }).from(comicSeries).get()),
    comicIssues: count(db.select({ n }).from(comicIssues).get()),
    comicIssuesAvailable: count(db.select({ n }).from(comicIssues).where(eq(comicIssues.hasFile, true)).get()),
    sizeOnDisk: db.select({ n: sql<number>`coalesce(sum(${bookFiles.sizeBytes}), 0)` }).from(bookFiles).get()?.n ?? 0,
    wanted: wantedItems(db, 'ebook', 'missing', now).length + wantedItems(db, 'comic', 'missing', now).length,
  };
}

/** Marks items as searched now (the automatic search skips them for the cooldown). */
export function markSearched(db: BooksDb, kind: BooksKind, ids: readonly number[], now: Date = new Date()): void {
  if (ids.length === 0) return;
  if (kind === 'ebook') db.update(ebooks).set({ lastSearchedAt: iso(now) }).where(inArray(ebooks.id, [...ids])).run();
  else db.update(comicIssues).set({ lastSearchedAt: iso(now) }).where(inArray(comicIssues.id, [...ids])).run();
}

/** Authors / series due for the scheduled refresh, most overdue first. */
export function dueForRefresh(db: BooksDb, now: Date = new Date()): { authors: number[]; series: number[] } {
  const t = iso(now);
  const authors = db
    .select({ id: ebookAuthors.id, next: ebookAuthors.nextRefreshAt })
    .from(ebookAuthors)
    .orderBy(asc(ebookAuthors.nextRefreshAt))
    .all()
    .filter((r) => r.next === null || r.next <= t)
    .map((r) => r.id);
  const series = db
    .select({ id: comicSeries.id, next: comicSeries.nextRefreshAt })
    .from(comicSeries)
    .orderBy(asc(comicSeries.nextRefreshAt))
    .all()
    .filter((r) => r.next === null || r.next <= t)
    .map((r) => r.id);
  return { authors, series };
}

