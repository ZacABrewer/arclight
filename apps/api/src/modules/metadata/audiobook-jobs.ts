import { stat } from 'node:fs/promises';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import { isMetadataError, type CatalogAuthorRef, type CatalogBook, type RequestPriority } from '@arclight/metadata';
import type { AddAuthorRequest, AddBookRequest, AudiobookCommand, Author, Book, BookChapter, Job } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { authors, books } from '../../db/schema.js';
import type { JobHandler, Scheduler } from '../../scheduler.js';
import { nextAuthorRefreshAt } from '../audiobooks/monitoring.js';
import { scanAuthorFolder } from '../audiobooks/rescan.js';
import * as ab from '../audiobooks/service.js';
import type { TagReader } from '../imports/audio/index.js';
import { LibraryError } from '../library/index.js';
import type { AudiobookMetadataService } from './audiobook-service.js';

// Audiobook metadata jobs (design 5.2, 5.3), next to the music ones:
//
// * AuthorAdd (ad hoc): after POST /author inserted the author row, load the bibliography
//   (filtered by the author's languages, else the `audiobookMetadata.languages` setting), upsert
//   books, series, series entries and co-author links, apply the monitor option, fetch chapters
//   of monitored books, and rescan an existing author folder.
// * RefreshAuthor (ad hoc, per author ids): the same against an existing author; new books follow
//   `monitor_new_books`.
// * RefreshAuthors (every 12 h): authors due by `next_refresh_at`, oldest first, until about
//   20 minutes of calls are spent. Next refresh +1 d while a monitored book is upcoming, else +7 d.
// * RescanAuthor (ad hoc): re-read the author folders into `audio_files`.
// * AuthorSearch / BookSearch: through the search port the release pipeline registers.
//
// Every job is a no-op while `features.audiobooks` is off. Network calls of the jobs are
// `background` priority, so UI lookups go first on the shared provider budgets.

export const AUTHOR_ADD_JOB = 'AuthorAdd';
export const REFRESH_AUTHOR_JOB = 'RefreshAuthor';
export const REFRESH_AUTHORS_JOB = 'RefreshAuthors';
export const RESCAN_AUTHOR_JOB = 'RescanAuthor';
export const AUTHOR_SEARCH_JOB = 'AuthorSearch';
export const BOOK_SEARCH_JOB = 'BookSearch';

/** Wall-clock budget of one RefreshAuthors run. */
export const REFRESH_AUTHORS_BUDGET_MS = 20 * 60 * 1000;
/** Chapter lists fetched per author refresh (one Audnexus call each). */
export const CHAPTERS_PER_REFRESH = 10;
const DISABLED = 'skipped: audiobooks are not enabled';
/** AuthorSearch / BookSearch message when the release pipeline is not wired. */
export const AUDIOBOOK_SEARCH_NOT_AVAILABLE = 'not available: the release pipeline is not running';

/**
 * Searches for authors' wanted books / for books, through the release pipeline (wired by
 * wiring.ts, so this module does not depend on the releases module). Resolves to a summary.
 */
export interface AudiobookSearchPort {
  authors(ids: readonly number[], signal: AbortSignal): Promise<string>;
  books(ids: readonly number[], signal: AbortSignal): Promise<string>;
}

export interface Started {
  job: Job;
  done: Promise<Job>;
}

export interface AudiobookRefresherDeps {
  db: Db;
  scheduler: Scheduler;
  service: AudiobookMetadataService;
  log: Logger;
  tagReader: () => TagReader;
  search?: () => AudiobookSearchPort | null;
  now?: () => Date;
  budgetMs?: number;
}

type RefreshMode = { kind: 'add'; option: AddAuthorRequest['monitorOption']; keep?: number[] } | { kind: 'refresh' };

interface RefreshOptions {
  priority: RequestPriority;
  fresh: boolean;
  signal: AbortSignal;
  log: Logger;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AudiobookRefresher {
  private readonly pending = new Set<Promise<Job>>();
  private reader: TagReader | null = null;

  constructor(private readonly deps: AudiobookRefresherDeps) {}

  private get db(): Db {
    return this.deps.db;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  enabled(): boolean {
    return ab.audiobooksEnabled(this.db);
  }

  /** Resolves once every job this refresher started has settled (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private start(name: string, key: string, handler: JobHandler, trigger: Job['trigger'] = 'manual'): Started {
    const started = this.deps.scheduler.runTask(name, trigger, handler, { key });
    const done = started.done.finally(() => this.pending.delete(done));
    this.pending.add(done);
    return { job: started.job, done };
  }

  private exists(id: number): boolean {
    return this.db.select({ id: authors.id }).from(authors).where(eq(authors.id, id)).get() !== undefined;
  }

  // ---- add -----------------------------------------------------------------------------------

  /**
   * POST /author: validates, reads the author record (one interactive call), inserts the row and
   * starts the AuthorAdd job. Returns without waiting for the job.
   */
  async addAuthor(req: AddAuthorRequest): Promise<{ author: Author } & Started> {
    ab.validateAddAuthor(this.db, req);
    const record = await this.deps.service.authorRecord(req.asin ? { asin: req.asin } : { olid: req.olAuthorId! }, { priority: 'interactive' });
    const author = ab.addAuthor(
      this.db,
      ab.authorMetadataFrom(record),
      {
        asin: req.asin,
        olAuthorId: req.olAuthorId,
        rootFolderPath: req.rootFolderPath,
        qualityProfileId: req.qualityProfileId,
        monitored: req.monitorOption === 'none' ? false : req.monitored,
        monitorNewBooks: req.monitorNewBooks,
        languages: req.languages,
        tags: req.tags,
      },
      this.now().toISOString(),
    );
    return { author, ...this.startAdd(author.id, { kind: 'add', option: req.monitorOption }, req.searchOnAdd ? { authors: [author.id] } : null) };
  }

  private startAdd(authorId: number, mode: RefreshMode, search: { authors: number[] } | { books: number[] } | null): Started {
    return this.start(AUTHOR_ADD_JOB, `${AUTHOR_ADD_JOB}:${authorId}`, async ({ signal, log }) => {
      if (!this.enabled()) return DISABLED;
      const message = await this.refreshAuthor(authorId, mode, { priority: 'background', fresh: false, signal, log });
      const row = this.exists(authorId) ? ab.authorRow(this.db, authorId) : null;
      let result = message;
      if (row && (await this.folderExists(row.path)) && !signal.aborted) result = `${message}; ${await this.rescanOne(authorId)}`;
      // Search on add: once the books (and what is already on disk) are known.
      if (search && !signal.aborted && this.exists(authorId)) {
        if ('authors' in search) this.search(AUTHOR_SEARCH_JOB, search.authors, 'system');
        else this.search(BOOK_SEARCH_JOB, search.books, 'system');
      }
      return result;
    });
  }

  /**
   * POST /book: one book by ASIN or ISBN. Its primary author is found in the library or, with an
   * `author` block, created (their other books arrive unmonitored through AuthorAdd). Without the
   * block an unknown author is a 400.
   */
  async addBook(req: AddBookRequest): Promise<{ book: Book; author: Author; started: Started | null }> {
    if (req.asin && ab.booksByAsin(this.db, [req.asin]).size > 0) throw new LibraryError('CONFLICT', `book ${req.asin} is already in the library`);
    const ref = { ...(req.asin ? { asin: req.asin } : {}), ...(req.isbn ? { isbn: req.isbn } : {}) };
    const cb = await this.deps.service.getBook(ref, { priority: 'interactive', ...(req.region ? { region: req.region } : {}) });
    const asin = cb.asin?.toUpperCase();
    if (asin && ab.booksByAsin(this.db, [asin]).size > 0) throw new LibraryError('CONFLICT', `book ${asin} is already in the library`);
    if (ab.isBookExcluded(this.db, cb)) throw new LibraryError('CONFLICT', `book ${asin ?? req.isbn} is on the import exclusion list`);
    const credits = cb.authors.filter((a) => ab.creditRole(a.name).role === 'author');
    const primary = credits.find((a) => a.asin) ?? credits[0] ?? cb.authors[0];
    if (!primary) throw new LibraryError('VALIDATION', `the catalogue lists no author for ${cb.title}`);
    const name = ab.creditRole(primary.name).name;
    let owner = ab.findAuthorForCredit(this.db, { name, asin: primary.asin ?? null, olid: primary.olid ?? null });
    let created = false;
    if (!owner) {
      if (!req.author) {
        throw new LibraryError('VALIDATION', `${name} is not in the library; send an author block (rootFolderPath, qualityProfileId) to add them`);
      }
      const a = ab.addAuthor(
        this.db,
        { asin: primary.asin?.toUpperCase() ?? null, olAuthorId: primary.olid?.toUpperCase() ?? null, name, overview: '', images: [], genres: [] },
        {
          asin: primary.asin?.toUpperCase(),
          olAuthorId: primary.olid?.toUpperCase(),
          rootFolderPath: req.author.rootFolderPath,
          qualityProfileId: req.author.qualityProfileId,
          monitored: req.author.monitored,
          monitorNewBooks: req.author.monitorNewBooks,
          languages: [],
          tags: req.author.tags,
        },
        this.now().toISOString(),
      );
      owner = ab.authorRow(this.db, a.id);
      created = true;
    }
    const ownerId = owner.id;
    const id = this.db.transaction((tx) => ab.upsertCatalogBook(tx, ownerId, cb, req.monitored, this.now().toISOString())).id;
    let started: Started | null = null;
    const search = req.searchOnAdd ? { books: [id] } : null;
    if (created) {
      // The rest of the bibliography arrives unmonitored; the requested book keeps its flag.
      started = this.startAdd(ownerId, { kind: 'add', option: 'none', keep: [id] }, search);
    } else if (search) {
      started = this.search(BOOK_SEARCH_JOB, search.books, 'system');
    }
    return { book: ab.getBook(this.db, id), author: ab.getAuthor(this.db, ownerId), started };
  }

  // ---- refresh -------------------------------------------------------------------------------

  private requireAuthors(ids: readonly number[]): Array<{ id: number; name: string }> {
    const rows = this.db.select({ id: authors.id, name: authors.name }).from(authors).where(inArray(authors.id, [...ids])).all();
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) throw LibraryError.notFound('author', missing.join(', '));
    return ids.map((id) => rows.find((r) => r.id === id)!);
  }

  /** RefreshAuthor for the given ids (unknown ids throw before any job starts). */
  refresh(ids: readonly number[], opts: { trigger?: Job['trigger'] } = {}): Started {
    const rows = this.requireAuthors(ids);
    const key = `${REFRESH_AUTHOR_JOB}:${[...ids].sort((a, b) => a - b).join(',')}`;
    return this.start(
      REFRESH_AUTHOR_JOB,
      key,
      async ({ signal, log }) => {
        if (!this.enabled()) return DISABLED;
        const parts: string[] = [];
        const failures: string[] = [];
        for (const row of rows) {
          if (signal.aborted) break;
          try {
            parts.push(await this.refreshAuthor(row.id, { kind: 'refresh' }, { priority: 'background', fresh: true, signal, log }));
          } catch (err) {
            log.warn({ err, authorId: row.id }, 'author refresh failed');
            failures.push(`${row.name}: ${errorText(err)}`);
          }
        }
        if (rows.length === 1 && failures.length === 1) throw new Error(failures[0]);
        return [...parts, ...(failures.length ? [`${failures.length} failed`] : [])].join('; ');
      },
      opts.trigger ?? 'manual',
    );
  }

  /** RefreshAuthors: due authors by `next_refresh_at`, within the call budget. */
  async refreshDue({ signal, log }: { signal: AbortSignal; log: Logger }): Promise<string> {
    if (!this.enabled()) return DISABLED;
    const startedAt = Date.now();
    const budget = this.deps.budgetMs ?? REFRESH_AUTHORS_BUDGET_MS;
    const nowIso = this.now().toISOString();
    const due = this.db
      .select({ id: authors.id, next: authors.nextRefreshAt })
      .from(authors)
      .all()
      .filter((r) => r.next === null || r.next <= nowIso)
      .sort((a, b) => (a.next ?? '').localeCompare(b.next ?? '') || a.id - b.id);
    let refreshed = 0;
    let failed = 0;
    for (const row of due) {
      if (signal.aborted || Date.now() - startedAt >= budget) break;
      try {
        await this.refreshAuthor(row.id, { kind: 'refresh' }, { priority: 'background', fresh: false, signal, log });
        refreshed++;
      } catch (err) {
        failed++;
        log.warn({ err, authorId: row.id }, 'scheduled author refresh failed');
        // Try again tomorrow rather than on every run.
        this.db.update(authors).set({ nextRefreshAt: new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString() }).where(eq(authors.id, row.id)).run();
      }
    }
    const left = due.length - refreshed - failed;
    return `refreshed ${refreshed} of ${due.length} due authors${failed ? `, ${failed} failed` : ''}${left > 0 ? `, ${left} left for the next run` : ''}`;
  }

  /** Re-reads one author's bibliography. Returns a one-line summary. */
  private async refreshAuthor(id: number, mode: RefreshMode, opts: RefreshOptions): Promise<string> {
    const { priority, fresh, signal, log } = opts;
    const row = ab.authorRow(this.db, id);
    const ref: CatalogAuthorRef = row.asin ? { asin: row.asin } : row.olAuthorId ? { olid: row.olAuthorId } : { name: row.name };
    const languages = ab.effectiveLanguages(this.db, row);
    const data = await this.deps.service.getAuthorWithBooks(ref, languages, { priority, fresh, signal });
    if (!this.exists(id)) return `${row.name}: deleted during refresh`;
    const now = this.now();
    const sync = ab.syncBibliography(
      this.db,
      id,
      data,
      mode.kind === 'add' ? { kind: 'add', option: mode.option, ...(mode.keep ? { keep: mode.keep } : {}) } : { kind: 'refresh', monitorNewBooks: ab.authorRow(this.db, id).monitorNewBooks },
      now.toISOString(),
    );
    const chapters = await this.loadChapters(id, { priority, signal, log });

    const dates = this.db.select({ releaseDate: books.releaseDate, monitored: books.monitored }).from(books).where(eq(books.authorId, id)).all();
    const at = this.now();
    ab.markAuthorRefreshed(this.db, id, at.toISOString(), nextAuthorRefreshAt(dates, at));
    return [
      `${row.name}: ${dates.length} books`,
      sync.added.length ? `${sync.added.length} new` : null,
      sync.linked ? `${sync.linked} co-authored` : null,
      sync.removed ? `${sync.removed} removed` : null,
      chapters ? `chapters for ${chapters}` : null,
    ]
      .filter(Boolean)
      .join(', ');
  }

  /** Chapter lists of monitored books that have none yet (a few per refresh; failures are skipped). */
  private async loadChapters(authorId: number, opts: { priority: RequestPriority; signal: AbortSignal; log: Logger }): Promise<number> {
    const rows = this.db
      .select({ id: books.id, asin: books.asin, region: books.region, chapters: books.chapters })
      .from(books)
      .where(and(eq(books.authorId, authorId), eq(books.monitored, true), isNotNull(books.asin)))
      .all()
      .filter((r) => r.chapters.length === 0)
      .slice(0, CHAPTERS_PER_REFRESH);
    let loaded = 0;
    for (const r of rows) {
      if (opts.signal.aborted) break;
      try {
        const found = await this.deps.service.getChapters(r.asin!, { priority: opts.priority, signal: opts.signal, ...(r.region ? { region: r.region } : {}) });
        const chapters: BookChapter[] = found.chapters.map((c) => ({ title: c.title, startMs: Math.max(0, Math.round(c.startMs)), lengthMs: Math.max(0, Math.round(c.lengthMs)) }));
        if (chapters.length > 0 && this.db.select({ id: books.id }).from(books).where(eq(books.id, r.id)).get()) {
          ab.setBookChapters(this.db, r.id, chapters);
          loaded++;
        }
      } catch (err) {
        if (opts.signal.aborted) break;
        if (!isMetadataError(err, 'not-found')) opts.log.debug({ err, bookId: r.id }, 'chapters not loaded');
      }
    }
    return loaded;
  }

  // ---- rescan --------------------------------------------------------------------------------

  private tagReader(): TagReader {
    this.reader ??= this.deps.tagReader();
    return this.reader;
  }

  private async folderExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Scans one author folder and writes the result. Returns a one-line summary. */
  async rescanOne(id: number): Promise<string> {
    const row = ab.authorRow(this.db, id);
    if (!(await this.folderExists(row.path))) return `${row.name}: folder ${row.path} does not exist`;
    const result = await scanAuthorFolder({
      authorFolder: row.path,
      books: ab.knownBooksFor(this.db, id),
      tagReader: this.tagReader(),
      preferredLanguages: ab.effectiveLanguages(this.db, row),
    });
    if (!this.exists(id)) return `${row.name}: deleted during rescan`;
    const w = ab.applyAuthorRescan(this.db, id, result, this.now().toISOString());
    return [
      `${row.name}: ${w.books} books with files (${w.files} files)`,
      w.added ? `${w.added} new` : null,
      w.removed ? `${w.removed} removed` : null,
      w.unmatchedGroups ? `${w.unmatchedGroups} unmatched` : null,
    ]
      .filter(Boolean)
      .join(', ');
  }

  rescan(ids: readonly number[]): Started {
    const rows = this.requireAuthors(ids);
    return this.start(RESCAN_AUTHOR_JOB, `${RESCAN_AUTHOR_JOB}:${[...ids].sort((a, b) => a - b).join(',')}`, async ({ signal, log }) => {
      if (!this.enabled()) return DISABLED;
      const parts: string[] = [];
      for (const row of rows) {
        if (signal.aborted) break;
        try {
          parts.push(await this.rescanOne(row.id));
        } catch (err) {
          log.warn({ err, authorId: row.id }, 'author rescan failed');
          if (rows.length === 1) throw err;
          parts.push(`${row.name}: ${errorText(err)}`);
        }
      }
      return parts.join('; ');
    });
  }

  // ---- commands ------------------------------------------------------------------------------

  /** POST /command. Unknown ids throw before a job starts. */
  command(cmd: AudiobookCommand): Started {
    switch (cmd.name) {
      case 'RefreshAuthor':
        return this.refresh(cmd.authorIds);
      case 'RescanAuthor':
        return this.rescan(cmd.authorIds);
      case 'AuthorSearch':
        this.requireAuthors(cmd.authorIds);
        return this.search(AUTHOR_SEARCH_JOB, cmd.authorIds);
      case 'BookSearch': {
        const found = this.db.select({ id: books.id }).from(books).where(inArray(books.id, cmd.bookIds)).all();
        const missing = cmd.bookIds.filter((id) => !found.some((r) => r.id === id));
        if (missing.length > 0) throw LibraryError.notFound('book', missing.join(', '));
        return this.search(BOOK_SEARCH_JOB, cmd.bookIds);
      }
    }
  }

  /** AuthorSearch / BookSearch as a job, through the search port. */
  search(name: typeof AUTHOR_SEARCH_JOB | typeof BOOK_SEARCH_JOB, ids: readonly number[], trigger: Job['trigger'] = 'manual'): Started {
    return this.start(
      name,
      `${name}:${ids.join(',')}`,
      async ({ signal }) => {
        if (!this.enabled()) return DISABLED;
        const port = this.deps.search?.() ?? null;
        if (!port) return AUDIOBOOK_SEARCH_NOT_AVAILABLE;
        return name === AUTHOR_SEARCH_JOB ? port.authors(ids, signal) : port.books(ids, signal);
      },
      trigger,
    );
  }
}

export function registerAudiobookJobs(scheduler: Scheduler, refresher: AudiobookRefresher): void {
  // Every 12 hours, off the hour and away from the music refresh.
  scheduler.register({ name: REFRESH_AUTHORS_JOB, cron: '40 3,15 * * *', handler: (ctx) => refresher.refreshDue(ctx) });
}

export type { CatalogBook };
