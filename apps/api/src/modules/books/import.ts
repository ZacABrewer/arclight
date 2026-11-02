import { eq } from 'drizzle-orm';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { ebookRelativePath, comicRelativePath, NamingFormatError } from '@arclight/organizer';
import { parseComicPath, parseEbookPath, bookTitleKey } from '@arclight/parser';
import { booksFormatOfExtension, formatsOfKind, type BooksFormat, type BooksKind, type QueueStatusMessage, type TrackedDownloadState } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { bookSeries, rootFolders } from '../../db/schema.js';
import type { TrackedDownload } from '../download-clients/service.js';
import { RecycleBin, setPermissions, transferFile, type TransferMode } from '../imports/mover.js';
import { getSection } from '../settings/service.js';
import { titleKeysMatch } from './decision.js';
import { BooksError } from './errors.js';
import { grabForDownload, isBooksGrabbedRelease, setGrabStatus } from './grab.js';
import { authorRow, bookFileRow, comicSeriesRow, ebookRow, isPathInside, issueKeyOf, issueRow, refreshHasFile, removeFileRow, formatRank } from './library.js';
import type { BooksLibraryAppsService } from './library-apps.js';
import { formatProfileRow } from './profiles.js';
import { bookFiles, comicIssues, comicSeries, ebookAuthors, ebookSeriesEntries, ebooks, type BookFileRow } from './schema.js';

// Importing ebook and comic files (docs/books.md "Importing"):
//
//   - completed downloads: the imports module hands every completed download to
//     `handleCompleted` first; a download with a `book_grabs` row (or the books marker in its
//     grabbed release) is ours. The best file of the profile's formats is moved / hard-linked /
//     copied (as for every other import) to the path the naming formats give, an existing file
//     of the item goes to the recycle bin, and the library apps are told;
//   - RescanBooks: files already under the ebook / comic root folders that no row knows are
//     matched to the library in place (nothing is moved), and rows whose file is gone are
//     dropped.

/** What the import needs of the download-clients service (a fake in tests). */
export interface BooksImportDownloadsPort {
  setState(id: number, state: TrackedDownloadState, options?: { statusMessages?: QueueStatusMessage[]; trackedStatus?: 'ok' | 'warning' | 'error' }): unknown;
  markImported(id: number): Promise<unknown>;
  setImportProgress(downloadId: string, progress: { copiedBytes: number; totalBytes: number } | null): void;
}

export interface ImportTarget {
  kind: BooksKind;
  /** Ebook id or comic issue id. */
  id: number;
}

/** Book files under `path` (a file or a folder, recursively) of the kind's formats. */
export async function bookFilesUnder(path: string, kind: BooksKind): Promise<Array<{ path: string; size: number; format: BooksFormat }>> {
  const allowed = new Set(formatsOfKind(kind));
  const out: Array<{ path: string; size: number; format: BooksFormat }> = [];
  const visit = async (p: string, depth: number): Promise<void> => {
    let s;
    try {
      s = await stat(p);
    } catch {
      return;
    }
    if (s.isFile()) {
      const format = booksFormatOfExtension(extname(p).slice(1));
      if (format && allowed.has(format)) out.push({ path: p, size: s.size, format });
      return;
    }
    if (!s.isDirectory() || depth > 8) return;
    const entries = await readdir(p).catch(() => [] as string[]);
    for (const name of entries.sort()) {
      if (name.startsWith('.') || name.startsWith('@')) continue;
      await visit(join(p, name), depth + 1);
    }
  };
  await visit(path, 0);
  return out;
}

export class BooksImportService {
  constructor(
    private readonly deps: {
      db: Db;
      log: Logger;
      downloads: () => BooksImportDownloadsPort;
      libraryApps: BooksLibraryAppsService;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private mediaManagement() {
    return getSection(this.deps.db, 'mediaManagement');
  }

  /** The library item a completed download was grabbed for, or null when it is not a books download. */
  targetOf(item: Pick<TrackedDownload, 'downloadId' | 'grabbedRelease'>): ImportTarget | null {
    const grab = grabForDownload(this.deps.db, item.downloadId);
    if (grab) return { kind: grab.kind, id: (grab.kind === 'ebook' ? grab.ebookId : grab.comicIssueId) ?? 0 };
    if (isBooksGrabbedRelease(item.grabbedRelease)) return { kind: item.grabbedRelease.kind, id: item.grabbedRelease.targetId };
    return null;
  }

  /**
   * Completed-download handler (imports module hook). Returns false for downloads that are not
   * ours; otherwise imports (or blocks with a message) and returns true.
   */
  async handleCompleted(item: TrackedDownload, path: string): Promise<boolean> {
    const target = this.targetOf(item);
    if (!target) return false;
    const downloads = this.deps.downloads();
    const block = (message: string) => {
      setGrabStatus(this.deps.db, item.downloadId, 'grabbed', message, this.now());
      downloads.setState(item.id, 'importPending', { statusMessages: [{ title: item.title, messages: [message] }], trackedStatus: 'warning' });
      this.deps.log.info({ title: item.title, message }, 'book download needs a manual import');
      return true;
    };
    if (!target.id) return block('The library item of this download was deleted');
    try {
      if (target.kind === 'ebook') ebookRow(this.deps.db, target.id);
      else issueRow(this.deps.db, target.id);
    } catch {
      return block('The library item of this download was deleted');
    }
    downloads.setState(item.id, 'importing');
    const profile = this.profileOf(target);
    const files = (await bookFilesUnder(path, target.kind)).filter((f) => profile.formats.includes(f.format));
    if (files.length === 0) return block(`No ${target.kind === 'ebook' ? 'ebook' : 'comic'} file of the profile's formats (${profile.formats.join(', ')}) in the download`);
    const best = files.sort((a, b) => formatRank(profile.formats, a.format) - formatRank(profile.formats, b.format) || b.size - a.size)[0]!;
    const settings = this.mediaManagement();
    const mode: TransferMode = item.canMoveFiles ? 'move' : settings.useHardlinks ? 'hardlinkOrCopy' : 'copy';
    const grab = grabForDownload(this.deps.db, item.downloadId);
    try {
      await this.importFile(target, best.path, {
        mode,
        sceneName: item.title,
        releaseGroup: grab?.releaseGroup ?? null,
        onProgress: (copiedBytes, totalBytes) => downloads.setImportProgress(item.downloadId, { copiedBytes, totalBytes }),
      });
    } catch (err) {
      return block(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      downloads.setImportProgress(item.downloadId, null);
    }
    setGrabStatus(this.deps.db, item.downloadId, 'imported', null, this.now());
    await downloads.markImported(item.id);
    return true;
  }

  private profileOf(target: ImportTarget) {
    const db = this.deps.db;
    if (target.kind === 'ebook') return formatProfileRow(db, authorRow(db, ebookRow(db, target.id).authorId).formatProfileId);
    return formatProfileRow(db, comicSeriesRow(db, issueRow(db, target.id).seriesId).formatProfileId);
  }

  /** Root-relative destination of a file for the item (naming formats, or the original name with renaming off). */
  destinationOf(target: ImportTarget, src: string, format: BooksFormat): { root: string; relativePath: string } {
    const db = this.deps.db;
    const naming = getSection(db, 'books').naming;
    let rel: string;
    let root: string;
    try {
      if (target.kind === 'ebook') {
        const book = ebookRow(db, target.id);
        const author = authorRow(db, book.authorId);
        root = author.rootFolderPath;
        const series = db
          .select({ name: bookSeries.name, position: ebookSeriesEntries.position })
          .from(ebookSeriesEntries)
          .innerJoin(bookSeries, eq(bookSeries.id, ebookSeriesEntries.seriesId))
          .where(eq(ebookSeriesEntries.ebookId, book.id))
          .get();
        rel = ebookRelativePath(
          { folderFormat: naming.ebookFolderFormat, fileFormat: naming.ebookFileFormat },
          {
            authorName: author.name,
            authorSortName: author.sortName,
            title: book.title,
            subtitle: book.subtitle ?? undefined,
            seriesTitle: series?.name,
            seriesPosition: series?.position ?? undefined,
            year: book.year ?? undefined,
            publisher: book.publisher ?? undefined,
            isbn: book.isbn13 ?? undefined,
            format,
          },
        );
      } else {
        const issue = issueRow(db, target.id);
        const series = comicSeriesRow(db, issue.seriesId);
        root = series.rootFolderPath;
        const date = issue.coverDate ?? issue.storeDate;
        rel = comicRelativePath(
          { folderFormat: naming.comicFolderFormat, fileFormat: naming.comicFileFormat },
          {
            seriesTitle: series.title,
            seriesYear: series.startYear ?? undefined,
            publisher: series.publisher ?? undefined,
            issueNumber: issue.issueNumber,
            issueTitle: issue.title ?? undefined,
            year: date ? Number(date.slice(0, 4)) || undefined : undefined,
            format,
          },
        );
      }
    } catch (err) {
      if (err instanceof NamingFormatError) throw new BooksError('VALIDATION', `naming format: ${err.message}`, { cause: err });
      throw err;
    }
    if (!naming.renameFiles) rel = join(dirname(rel), basename(src));
    return { root, relativePath: rel };
  }

  /**
   * Puts `src` into the library for the item: the item's previous files go to the recycle bin,
   * the file is transferred, permissions set, a `book_files` row written and the apps told.
   */
  async importFile(
    target: ImportTarget,
    src: string,
    opts: { mode: TransferMode; sceneName?: string | null; releaseGroup?: string | null; onProgress?: (copied: number, total: number) => void },
  ): Promise<BookFileRow> {
    const db = this.deps.db;
    const format = booksFormatOfExtension(extname(src).slice(1));
    if (!format || !formatsOfKind(target.kind).includes(format)) throw new BooksError('VALIDATION', `${basename(src)} is not a${target.kind === 'ebook' ? 'n ebook' : ' comic'} file`);
    const { root, relativePath } = this.destinationOf(target, src, format);
    const dst = join(root, relativePath);
    const settings = this.mediaManagement();
    const column = target.kind === 'ebook' ? bookFiles.ebookId : bookFiles.comicIssueId;
    const previous = db.select().from(bookFiles).where(eq(column, target.id)).all();
    const bin = new RecycleBin(settings.recycleBinPath, () => this.now());
    for (const old of previous) {
      if (resolve(old.path) === resolve(dst)) continue;
      try {
        await bin.recycle(old.path, dirname(old.relativePath));
      } catch (err) {
        this.deps.log.warn({ err, path: old.path }, 'could not recycle the previous book file');
      }
      db.delete(bookFiles).where(eq(bookFiles.id, old.id)).run();
    }
    const overwrite = previous.some((old) => resolve(old.path) === resolve(dst));
    await transferFile(src, dst, opts.mode, { overwrite, ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) });
    if (settings.setPermissions) await setPermissions(dst, settings.chmodFolder, false).catch(() => undefined);
    const size = (await stat(dst)).size;
    db.delete(bookFiles).where(eq(bookFiles.path, dst)).run();
    const row = db
      .insert(bookFiles)
      .values({
        kind: target.kind,
        ebookId: target.kind === 'ebook' ? target.id : null,
        comicIssueId: target.kind === 'comic' ? target.id : null,
        path: dst,
        relativePath,
        sizeBytes: size,
        format,
        releaseGroup: opts.releaseGroup ?? null,
        sceneName: opts.sceneName ?? null,
        dateAdded: this.now().toISOString(),
      })
      .returning()
      .get();
    refreshHasFile(db, row);
    this.deps.log.info({ path: dst, kind: target.kind }, 'book file imported');
    await this.deps.libraryApps.notify(target.kind, dirname(dst));
    return row;
  }

  /** Deletes a file (to the recycle bin when one is set) and its row; a file already gone only loses its row. */
  async deleteFile(id: number): Promise<void> {
    const row = bookFileRow(this.deps.db, id);
    const bin = new RecycleBin(this.mediaManagement().recycleBinPath, () => this.now());
    const exists = await stat(row.path).then((s) => s.isFile()).catch(() => false);
    try {
      if (exists) await bin.recycle(row.path, dirname(row.relativePath));
    } catch (err) {
      throw new BooksError('UNAVAILABLE', `could not delete ${row.path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    removeFileRow(this.deps.db, id);
  }

  // -------------------------------------------------------------------------------------
  // RescanBooks
  // -------------------------------------------------------------------------------------

  /** Matches unknown files under the root folders in place; drops rows whose file is gone. */
  async rescan(signal?: AbortSignal): Promise<string> {
    const db = this.deps.db;
    let removed = 0;
    for (const row of db.select().from(bookFiles).all()) {
      const exists = await stat(row.path).then((s) => s.isFile()).catch(() => false);
      if (exists) continue;
      db.delete(bookFiles).where(eq(bookFiles.id, row.id)).run();
      refreshHasFile(db, row);
      removed += 1;
    }
    const known = new Set(db.select({ path: bookFiles.path }).from(bookFiles).all().map((r) => resolve(r.path)));
    let added = 0;
    let unmatched = 0;
    for (const kind of ['ebook', 'comic'] as const) {
      const roots = db.select().from(rootFolders).where(eq(rootFolders.mediaType, kind)).all();
      for (const root of roots) {
        if (signal?.aborted) break;
        for (const file of await bookFilesUnder(root.path, kind)) {
          if (known.has(resolve(file.path))) continue;
          const target = kind === 'ebook' ? this.matchEbookFile(root.path, file.path) : this.matchComicFile(file.path);
          if (!target) {
            unmatched += 1;
            continue;
          }
          const column = kind === 'ebook' ? bookFiles.ebookId : bookFiles.comicIssueId;
          if (db.select({ id: bookFiles.id }).from(bookFiles).where(eq(column, target.id)).get()) {
            unmatched += 1;
            continue;
          }
          const row = db
            .insert(bookFiles)
            .values({
              kind,
              ebookId: kind === 'ebook' ? target.id : null,
              comicIssueId: kind === 'comic' ? target.id : null,
              path: file.path,
              relativePath: relative(root.path, file.path),
              sizeBytes: file.size,
              format: file.format,
              dateAdded: this.now().toISOString(),
            })
            .returning()
            .get();
          refreshHasFile(db, row);
          known.add(resolve(file.path));
          added += 1;
        }
      }
    }
    return `matched ${added} file(s), removed ${removed} missing, ${unmatched} not matched`;
  }

  /** The ebook a file under an ebook root belongs to: author by folder or parsed name, book by title. */
  matchEbookFile(root: string, path: string): ImportTarget | null {
    const db = this.deps.db;
    const parsed = parseEbookPath(relative(root, path));
    if (!parsed) return null;
    const authors = db.select().from(ebookAuthors).all();
    const author =
      authors.find((a) => isPathInside(a.path, path)) ??
      (parsed.author ? authors.find((a) => titleKeysMatch(a.cleanName, bookTitleKey(parsed.author!))) : undefined) ??
      (parsed.orderAmbiguous && parsed.title ? authors.find((a) => a.cleanName === bookTitleKey(parsed.title!)) : undefined);
    if (!author) return null;
    const titles = [parsed.title, ...(parsed.orderAmbiguous ? [parsed.author] : [])].filter((t): t is string => !!t).map(bookTitleKey);
    const books = db.select({ id: ebooks.id, cleanTitle: ebooks.cleanTitle, isbn13: ebooks.isbn13, isbns: ebooks.isbns }).from(ebooks).where(eq(ebooks.authorId, author.id)).all();
    const byIsbn = parsed.isbn ? books.find((b) => b.isbn13 === parsed.isbn || b.isbns.includes(parsed.isbn!)) : undefined;
    const book = byIsbn ?? books.find((b) => titles.some((t) => b.cleanTitle === t)) ?? books.find((b) => titles.some((t) => titleKeysMatch(b.cleanTitle, t)));
    return book ? { kind: 'ebook', id: book.id } : null;
  }

  /** The issue a file inside a comic series folder belongs to (normalized issue number). */
  matchComicFile(path: string): ImportTarget | null {
    const db = this.deps.db;
    const series = db
      .select()
      .from(comicSeries)
      .all()
      .filter((s) => isPathInside(s.path, path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!series) return null;
    const parsed = parseComicPath(path);
    const number = parsed?.issueNumber ?? (parsed?.volume !== undefined && series.seriesType === 'manga' ? String(parsed.volume) : undefined);
    if (!parsed || number === undefined) return null;
    const key = issueKeyOf(number, parsed.annual);
    const issue = db.select({ id: comicIssues.id, issueKey: comicIssues.issueKey }).from(comicIssues).where(eq(comicIssues.seriesId, series.id)).all().find((i) => i.issueKey === key);
    return issue ? { kind: 'comic', id: issue.id } : null;
  }
}
