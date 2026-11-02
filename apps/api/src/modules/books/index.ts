import { asc, eq } from 'drizzle-orm';
import { BooksCommand, type BooksCommandResult, type BooksKind } from '@arclight/shared';
import type { AppContext, AppModule } from '../../app.js';
import { rootFolders } from '../../db/schema.js';
import { registerIcsEventSource, type IcsDayEvent } from '../calendar/index.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { getImportsService } from '../imports/index.js';
import { indexersServiceFor } from '../indexers/index.js';
import { DEFAULT_PORTAL_RATE_LIMIT, TokenBuckets } from '../requests/portal.js';
import { getSection } from '../settings/service.js';
import { BooksCatalogService, parseBody, type BooksCatalogOverrides } from './catalog.js';
import { BooksError } from './errors.js';
import { grabForDownload, renameGrabDownloadId, setGrabStatus, type BooksDownloadsPort, type BooksIndexersPort } from './grab.js';
import { BooksImportService, type BooksImportDownloadsPort } from './import.js';
import { calendar, dueForRefresh, linkAudiobookAuthors } from './library.js';
import { BooksLibraryAppsService, type FetchLike } from './library-apps.js';
import { listFormatProfiles, seedFormatProfiles } from './profiles.js';
import { BooksRequestsService, type BooksRequestFulfiller } from './requests.js';
import { booksRoutes, type BooksRouteServices } from './routes.js';
import { BooksSearchService } from './search.js';

export * from './schema.js';
export { BooksError } from './errors.js';
export type { BooksRouteServices } from './routes.js';

// The Books section (docs/books.md): ebooks and comics, from catalogue lookup to imported file.
// Startup seeds the default format profiles and links ebook authors to audiobook authors (both
// idempotent). Completed books downloads are imported through the imports module's handler
// hook; failed ones mark their grab failed (the books blocklist). RSS, the jobs and the
// calendar feed do nothing while `features.books` is off; the routes always answer.

export const BOOKS_REFRESH_JOB = 'BooksRefresh';
export const BOOKS_MISSING_SEARCH_JOB = 'BooksMissingSearch';
/** Authors / series one scheduled refresh looks at, at most. */
const REFRESH_LIMIT = 50;
const HOUR_MS = 60 * 60 * 1000;

/** Test seams: fakes for the catalogue, indexers, download clients and library-app calls. */
export interface BooksOverrides {
  catalog?: BooksCatalogOverrides;
  indexers?: BooksIndexersPort;
  downloads?: BooksDownloadsPort;
  importDownloads?: BooksImportDownloadsPort;
  libraryAppsFetch?: FetchLike;
  now?: () => Date;
}

const overridesByCtx = new WeakMap<AppContext, BooksOverrides>();
const servicesByCtx = new WeakMap<AppContext, BooksRouteServices>();

/** Call from `buildApp`'s `onContext` (before the module registers). */
export function setBooksOverrides(ctx: AppContext, overrides: BooksOverrides): void {
  overridesByCtx.set(ctx, overrides);
}

export function booksEnabled(ctx: Pick<AppContext, 'db'>): boolean {
  return getSection(ctx.db, 'features').books === true;
}

function realIndexers(ctx: AppContext): BooksIndexersPort {
  const service = indexersServiceFor(ctx);
  return {
    search: (request, opts) => service.search(request, opts),
    downloadRelease: (indexerId, url) => service.downloadRelease(indexerId, url),
    downloadClientIdOf: (indexerId) => {
      try {
        return service.get(indexerId).downloadClientId ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** The module's services for a context (created on first use). */
export function booksServicesFor(ctx: AppContext): BooksRouteServices {
  const existing = servicesByCtx.get(ctx);
  if (existing) return existing;
  const o = overridesByCtx.get(ctx) ?? {};
  const db = ctx.db;
  const log = ctx.log.child({ module: 'books' });
  const now = o.now ?? (() => new Date());
  const catalog = new BooksCatalogService({ db, log, overrides: { ...o.catalog, ...(o.now && !o.catalog?.now ? { now: o.now } : {}) } });
  const search = new BooksSearchService({
    db,
    log,
    indexers: () => o.indexers ?? realIndexers(ctx),
    downloads: () => o.downloads ?? getDownloadClientsService(ctx),
    now,
  });
  const libraryApps = new BooksLibraryAppsService({ db, log, ...(o.libraryAppsFetch ? { fetchImpl: o.libraryAppsFetch } : {}) });
  const imports = new BooksImportService({ db, log, downloads: () => o.importDownloads ?? getDownloadClientsService(ctx), libraryApps, now });

  /** Runs a search in the background (search on add, approved requests, failed downloads). */
  const searchAfterAdd = (kind: BooksKind, ids: readonly number[]): void => {
    if (ids.length === 0) return;
    const name = kind === 'ebook' ? 'EbookSearch' : 'ComicIssueSearch';
    const { done } = ctx.scheduler.runTask(
      name,
      'system',
      async ({ signal }) => {
        const r = await search.searchItems(kind, ids, signal);
        return `searched ${r.searched} item(s), grabbed ${r.grabbed}`;
      },
      { key: `${name}:${[...ids].sort((a, b) => a - b).join(',')}` },
    );
    done.catch((err: unknown) => log.warn({ err }, 'books search failed'));
  };

  const fulfil: BooksRequestFulfiller = async (row) => {
    const root = db.select().from(rootFolders).where(eq(rootFolders.mediaType, row.kind)).orderBy(asc(rootFolders.id)).get();
    if (!root) throw new BooksError('VALIDATION', `add a${row.kind === 'ebook' ? 'n ebook' : ' comic'} root folder first (Settings → Media Management)`);
    const profile = listFormatProfiles(db).find((p) => p.kind === row.kind);
    if (!profile) throw new BooksError('VALIDATION', `add a${row.kind === 'ebook' ? 'n ebook' : ' comic'} format profile first`);
    if (row.kind === 'ebook') {
      const ebook = await catalog.addEbook({ foreignId: row.foreignId, rootFolderPath: root.path, formatProfileId: profile.id });
      if (!ebook.hasFile) searchAfterAdd('ebook', [ebook.id]);
      return ebook.id;
    }
    const series = await catalog.addComicSeries({ foreignId: row.foreignId, rootFolderPath: root.path, formatProfileId: profile.id });
    searchAfterAdd('comic', search.missingOf('comic', series.id));
    return series.id;
  };
  const requests = new BooksRequestsService({ db, log, fulfil, now });

  const runCommand = async (command: BooksCommand, signal: AbortSignal): Promise<string> => {
    const c = parseBody(BooksCommand, command);
    const searched = (r: { searched: number; grabbed: number }) => `searched ${r.searched} item(s), grabbed ${r.grabbed}`;
    switch (c.name) {
      case 'EbookSearch':
        return searched(await search.searchItems('ebook', c.ebookIds, signal));
      case 'EbookAuthorSearch':
        return searched(await search.searchItems('ebook', c.authorIds.flatMap((id) => search.missingOf('ebook', id)), signal));
      case 'ComicIssueSearch':
        return searched(await search.searchItems('comic', c.issueIds, signal));
      case 'ComicSeriesSearch':
        return searched(await search.searchItems('comic', c.seriesIds.flatMap((id) => search.missingOf('comic', id)), signal));
      case 'RefreshEbookAuthor': {
        let added = 0;
        for (const id of c.authorIds) added += (await catalog.refreshAuthor(id, { fresh: true })).length;
        return `refreshed ${c.authorIds.length} author(s), ${added} new book(s)`;
      }
      case 'RefreshComicSeries': {
        let added = 0;
        for (const id of c.seriesIds) added += (await catalog.refreshComicSeries(id, { fresh: true })).length;
        return `refreshed ${c.seriesIds.length} series, ${added} new issue(s)`;
      }
      case 'BooksMissingSearch':
        return search.missingSearch(c.kind, signal);
      case 'RescanBooks':
        return imports.rescan(signal);
    }
  };

  const services: BooksRouteServices = {
    catalog,
    search,
    imports,
    libraryApps,
    requests,
    searchAfterAdd,
    portalLimiter: new TokenBuckets(DEFAULT_PORTAL_RATE_LIMIT),
    command(command): BooksCommandResult {
      const { job, done } = ctx.scheduler.runTask(command.name, 'manual', ({ signal }) => runCommand(command, signal), {
        key: `${command.name}:${JSON.stringify(command)}`,
      });
      done.catch((err: unknown) => log.warn({ err, command: command.name }, 'books command failed'));
      return { name: command.name, message: `${command.name} queued (job ${job.id})` };
    },
  };
  servicesByCtx.set(ctx, services);
  return services;
}

/** Scheduled refresh of authors / series whose `nextRefreshAt` has passed. */
async function refreshDue(ctx: AppContext, services: BooksRouteServices, signal: AbortSignal): Promise<string> {
  if (!booksEnabled(ctx)) return 'books are not enabled';
  const due = dueForRefresh(ctx.db);
  const authors = due.authors.slice(0, REFRESH_LIMIT);
  const series = due.series.slice(0, Math.max(0, REFRESH_LIMIT - authors.length));
  let failed = 0;
  for (const id of authors) {
    if (signal.aborted) break;
    await services.catalog.refreshAuthor(id).catch((err: unknown) => {
      failed += 1;
      ctx.log.warn({ err, authorId: id }, 'ebook author refresh failed');
    });
  }
  for (const id of series) {
    if (signal.aborted) break;
    await services.catalog.refreshComicSeries(id).catch((err: unknown) => {
      failed += 1;
      ctx.log.warn({ err, seriesId: id }, 'comic series refresh failed');
    });
  }
  return `refreshed ${authors.length} author(s) and ${series.length} series${failed > 0 ? `, ${failed} failed` : ''}`;
}

function calendarEvents(ctx: AppContext, range: { start: string; end: string; unmonitored: boolean }): IcsDayEvent[] {
  if (!booksEnabled(ctx)) return [];
  return calendar(ctx.db, { start: range.start, end: range.end, unmonitored: range.unmonitored }).map((e) => ({
    uid: `arclight-${e.kind}-${e.id}@arclight`,
    date: e.date.slice(0, 10),
    summary: `${e.parentTitle}: ${e.title}`,
    category: e.kind === 'ebook' ? 'Ebook' : 'Comic',
    confirmed: e.hasFile,
  }));
}

export const booksModule: AppModule = (ctx) => async (app) => {
  const db = ctx.db;
  const services = booksServicesFor(ctx);
  const seeded = seedFormatProfiles(db);
  const linked = linkAudiobookAuthors(db);
  if (seeded + linked > 0) ctx.log.debug({ module: 'books', seeded, linked }, 'books startup data');

  await app.register(booksRoutes(ctx, services));
  registerIcsEventSource(ctx, (range) => calendarEvents(ctx, range));

  // Every 12 hours, away from the music and audiobook refreshes.
  ctx.scheduler.register({ name: BOOKS_REFRESH_JOB, cron: '50 4,16 * * *', handler: ({ signal }) => refreshDue(ctx, services, signal) });
  // Hourly check; the search itself runs every `books.search.missingSearchIntervalHours`.
  let lastMissingSearch = Date.now();
  ctx.scheduler.register({
    name: BOOKS_MISSING_SEARCH_JOB,
    cron: '25 * * * *',
    handler: async ({ signal }) => {
      if (!booksEnabled(ctx)) return 'books are not enabled';
      const hours = getSection(db, 'books').search.missingSearchIntervalHours;
      if (hours === 0) return 'the automatic search is off';
      if (Date.now() - lastMissingSearch < hours * HOUR_MS - 5 * 60 * 1000) return 'not due yet';
      lastMissingSearch = Date.now();
      return services.search.missingSearch('all', signal);
    },
  });

  // Listeners on other modules' services, attached once every module is registered.
  const unsubscribe: Array<() => unknown> = [];
  app.addHook('onReady', async () => {
    unsubscribe.push(getImportsService(ctx).addCompletedDownloadHandler((item, path) => services.imports.handleCompleted(item, path)));
    const downloads = getDownloadClientsService(ctx);
    unsubscribe.push(
      downloads.onItemFailed((item) => {
        const grab = grabForDownload(db, item.downloadId);
        if (!grab || grab.status !== 'grabbed') return;
        setGrabStatus(db, item.downloadId, 'failed', 'the download failed');
        const targetId = grab.kind === 'ebook' ? grab.ebookId : grab.comicIssueId;
        if (targetId !== null && booksEnabled(ctx) && getSection(db, 'mediaManagement').autoRedownloadFailed) services.searchAfterAdd(grab.kind, [targetId]);
      }),
    );
    unsubscribe.push(downloads.onPendingSent((item, pendingId) => renameGrabDownloadId(db, pendingId, item.downloadId)));
    if (!overridesByCtx.get(ctx)?.indexers) {
      unsubscribe.push(
        indexersServiceFor(ctx).onReleases(async (releases) => {
          if (!booksEnabled(ctx)) return;
          try {
            const grabbed = await services.search.handleRss(releases);
            if (grabbed > 0) ctx.log.info({ module: 'books', grabbed }, 'books releases grabbed from RSS');
          } catch (err) {
            ctx.log.warn({ err }, 'books RSS matching failed');
          }
        }),
      );
    }
  });
  app.addHook('onClose', async () => {
    for (const off of unsubscribe.splice(0)) off();
  });
};
