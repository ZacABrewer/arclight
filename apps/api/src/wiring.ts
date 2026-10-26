import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { desc, eq, inArray } from 'drizzle-orm';
import type { MediaFileInfo, NotificationEvent, ReleaseInfo } from '@arclight/notifications';
import type { HistoryEventType, HistoryRecord, HistoryReleaseSource, Job, MediaFile } from '@arclight/shared';
import type { AppContext } from './app.js';
import { downloadClients, episodes, mediaFiles, trackedDownloads } from './db/schema.js';
import { blocklistServiceFor } from './modules/blocklist/index.js';
import { vpnServiceFor, GRAB_GUARD_REASON } from './modules/vpn/service.js';
import { subtitlesServiceFor } from './modules/subtitles/index.js';
import { getDownloadClientsService, type TrackedDownload } from './modules/download-clients/index.js';
import {
  dataValue,
  HistoryError,
  historyServiceFor,
  type HistoryTarget,
  type TrackedDownloadInfo,
} from './modules/history/index.js';
import { healthServiceFor } from './modules/health/index.js';
import { createAnalysisProbe, ffprobeRunnerFor, mediaAnalysisFor } from './modules/media-analysis/index.js';
import { containerUpdatesCheckFor, updateAvailableCheckFor } from './modules/updates/index.js';
import {
  getImportsService,
  type ImportedEvent,
  type ImportsDeps,
} from './modules/imports/index.js';
import { indexersServiceFor } from './modules/indexers/index.js';
import type { LibraryCommands, LibraryCommandTarget } from './modules/library/index.js';
import { metadataRefresherFor } from './modules/metadata/index.js';
import { profileMigrationServiceFor } from './modules/profile-migration/index.js';
import { EventTranslator, notificationsServiceFor, releaseFrom, toEpisodeInfo, toFileInfo } from './modules/notifications/index.js';
import {
  releasesServiceFor,
  type BlocklistCandidate,
  type GrabHistoryInput,
  type HistoryEventSummary,
  type ReleasesDeps,
  type SearchTarget,
} from './modules/releases/index.js';
import { getSection } from './modules/settings/service.js';
import { trackerStatsServiceFor } from './modules/tracker-stats/index.js';

// ---------------------------------------------------------------------------------------
// Cross-module wiring for the Phase 1 pipeline.
//
// Modules are written stand-alone: each exposes a per-context service accessor
// (`historyServiceFor(ctx)`, ...) and the pipeline modules (releases, imports) take a typed
// deps object with no-op defaults. This file is the only place that knows how the shapes of
// one module map onto another's. Every adapter resolves the target service lazily, at call
// time, so module registration order cannot strand a dependency.
//
// Flows and the single path each one takes:
//
// * Grab: releases.grab -> download-clients.grab -> bus `release grabbed` -> deps.history
//   .recordGrab (adapter below -> history.recordGrab). The `grab` NOTIFICATION comes only from
//   the notifications module's bus translator (it loads the tracked download, which already
//   exists when `release grabbed` is published). The wiring does NOT dispatch a grab
//   notification itself, so there is exactly one per grab.
//
// * Import: imports -> deps.history.recordImport (-> history.recordImport) and
//   deps.notifications.onImported (-> an `import` or `upgrade` NotificationEvent built here
//   from the import result + library rows, dispatched through notificationsServiceFor). The bus
//   translator's own `import imported` translation is switched off in app.ts
//   (`notificationsModuleWith({ translateImported: false })`) so imports notify exactly once.
//   `import manualRequired` still reaches notifications through the bus only.
//
// * Failed download: download-clients onItemFailed -> imports.handleFailedDownload ->
//   deps.blocklist.add (adapter -> history.failTracked) -> history writes `downloadFailed` and
//   runs its onDownloadFailed handlers in priority order: blocklist (0, subscribed by the
//   blocklist module) then the automatic re-search registered here (100), which honours
//   `mediaManagement.autoRedownloadFailed` and the event's skipRedownload. Queue removal with
//   "blocklist" (download-clients onBlocklist) and history "mark as failed" go through the same
//   history pipeline, so they blocklist and re-search identically. The imports module's own
//   `releases.researchFor` and `history.recordDownloadFailed` hooks are deliberately NOT
//   wired: history.failTracked already wrote the row and the priority-100 handler is the one
//   re-search path (wiring both would search twice).
//
// * Redownload: POST /history/:id/redownload -> history.redownload -> the handler registered
//   here, which runs releases.searchFor for the record's episodes/movie inside an ad-hoc
//   `HistoryRedownload` job (Scheduler.runTask) and hands the job back for the 202 answer.
//
// * Library commands: the bulk editor's `refresh` / `search` flags and "search on add" call
//   libraryCommands below: refresh -> the metadata module's MetadataRefresher, search ->
//   releases.searchFor per item inside a `SeriesSearch` / `MovieSearch` job.
//
// * Library deletes: the history and blocklist modules subscribe to `library deleted` on the
//   bus themselves; the library routes publish added/updated/deleted/fileDeleted and the
//   imports module publishes fileAdded.
// ---------------------------------------------------------------------------------------

export interface WiringOptions {
  /**
   * Inject an ffprobe-backed media probe into imports when the binary is available
   * (checked asynchronously at startup). Default true. Tests turn it off so fake media files
   * are not classed as unreadable samples.
   */
  probe?: boolean;
}

export interface Wiring {
  releases: ReleasesDeps;
  imports: ImportsDeps;
  /** Bulk-editor refresh/search and search-on-add for the library routes. */
  library: LibraryCommands;
  /** Unsubscribes the hooks registered on history and download-clients. */
  dispose(): void;
}

/** Priority of the automatic re-search handler on history's download-failed pipeline. */
export const REDOWNLOAD_PRIORITY = 100;

export const REDOWNLOAD_JOB = 'HistoryRedownload';
export const SERIES_SEARCH_JOB = 'SeriesSearch';
export const MOVIE_SEARCH_JOB = 'MovieSearch';

export function wireModules(ctx: AppContext, options: WiringOptions = {}): Wiring {
  const log = ctx.log.child({ module: 'wiring' });
  const disposers: Array<() => void> = [];

  // Failed-download pipeline: automatic re-search runs after the blocklist handler.
  disposers.push(historyServiceFor(ctx).onDownloadFailed((event) => {
    if (event.skipRedownload) return;
    if (!getSection(ctx.db, 'mediaManagement').autoRedownloadFailed) return;
    const target = searchTargetFor(event.target);
    if (!target) return;
    // Detached: an indexer search must not hold up the failed-download handling (or the HTTP
    // request that marked the download failed).
    void releasesServiceFor(ctx)
      .searchFor(target)
      .then((summary) => log.info({ target, grabbed: summary.grabbed }, 'automatic re-search after failed download'))
      .catch((err: unknown) => log.warn({ err, target }, 'automatic re-search after failed download failed'));
  }, REDOWNLOAD_PRIORITY));

  // Manual redownload of a history record: one search, run as a job so the UI can follow it.
  const history = historyServiceFor(ctx);
  history.setRedownloadHandler((target, record) => {
    const search = searchTargetFor(target);
    if (!search) throw new HistoryError('VALIDATION', `history item ${record.id} has no episodes to search for`);
    return ctx.scheduler.runTask(REDOWNLOAD_JOB, 'manual', async ({ signal }) => {
      const summary = await releasesServiceFor(ctx).searchFor(search, { signal });
      return `searched for "${record.sourceTitle}": ${summary.releases} releases, ${summary.grabbed.length} grabbed`;
    }, { key: `${REDOWNLOAD_JOB}:${record.id}` }).job;
  });
  disposers.push(() => history.setRedownloadHandler(undefined));

  // Queue removal with "blocklist" goes through the same failed pipeline.
  disposers.push(getDownloadClientsService(ctx).onBlocklist(async (item, { skipRedownload }) => {
    await failTrackedDownload(ctx, item, { source: 'Queue', skipRedownload });
  }));

  if (options.probe ?? true) {
    // One ffprobe runner per context, shared with the media-analysis queue.
    const runner = ffprobeRunnerFor(ctx);
    void runner.available().then((available) => {
      if (available) getImportsService(ctx).setDeps({ probe: createAnalysisProbe(runner) });
      else log.info('ffprobe not found; imports use name-based sample detection only');
    });
  }

  // Health checks contributed by modules that do not register their own. (media-analysis
  // FfprobeMissing and library-hygiene OrphanFilesFound register in their modules; stale feeds,
  // guides included, are the generic FeedStale check over the feeds registry.)
  const health = healthServiceFor(ctx);
  disposers.push(health.register(updateAvailableCheckFor(ctx)));
  disposers.push(health.register(containerUpdatesCheckFor(ctx)));

  return {
    releases: releasesDeps(ctx),
    imports: importsDeps(ctx),
    library: libraryCommands(ctx),
    dispose: () => {
      for (const d of disposers.splice(0)) d();
    },
  };
}

// ---------------------------------------------------------------------------------------
// library commands
// ---------------------------------------------------------------------------------------

export function libraryCommands(ctx: AppContext): LibraryCommands {
  const log = ctx.log.child({ module: 'wiring' });
  return {
    refresh: (target) => {
      const refresher = metadataRefresherFor(ctx);
      if (!refresher) {
        log.warn('metadata module not registered; refresh skipped');
        return;
      }
      if (target.seriesIds?.length) refresher.series(target.seriesIds);
      if (target.movieIds?.length) refresher.movies(target.movieIds);
    },
    search: (target) => {
      startLibrarySearch(ctx, target);
    },
  };
}

/** One job per media type that searches each item in turn; returns the started jobs. */
export function startLibrarySearch(ctx: AppContext, target: LibraryCommandTarget): Array<{ job: Job; done: Promise<Job> }> {
  const started: Array<{ job: Job; done: Promise<Job> }> = [];
  const run = (name: string, targets: SearchTarget[]) =>
    ctx.scheduler.runTask(name, 'manual', async ({ signal, log }) => {
      let grabbed = 0;
      let failed = 0;
      for (const t of targets) {
        if (signal.aborted) break;
        try {
          grabbed += (await releasesServiceFor(ctx).searchFor(t, { userInvoked: true, signal })).grabbed.length;
        } catch (err) {
          failed++;
          log.warn({ err, target: t }, 'library search failed');
        }
      }
      return `searched ${targets.length}, grabbed ${grabbed}${failed ? `, ${failed} failed` : ''}`;
    }, { key: `${name}:${targets.map((t) => ('movieId' in t ? t.movieId : t.seriesId)).join(',')}` });
  if (target.seriesIds?.length) started.push(run(SERIES_SEARCH_JOB, target.seriesIds.map((seriesId) => ({ seriesId }))));
  if (target.movieIds?.length) started.push(run(MOVIE_SEARCH_JOB, target.movieIds.map((movieId) => ({ movieId }))));
  return started;
}

// ---------------------------------------------------------------------------------------
// releases
// ---------------------------------------------------------------------------------------

export function releasesDeps(ctx: AppContext): ReleasesDeps {
  const db = ctx.db;
  return {
    history: {
      recordGrab: (grab) => {
        recordGrabInHistory(ctx, grab);
      },
      latestFor: (item, eventType) => {
        const history = historyServiceFor(ctx);
        const type = eventType as HistoryEventType | undefined;
        const row = 'movieId' in item ? history.mostRecentForMovie(item.movieId, type) : history.mostRecentForEpisode(item.episodeId, type);
        return row ? toEventSummary(row) : null;
      },
      findByDownloadId: (downloadId, eventType) => {
        const row = historyServiceFor(ctx).mostRecentForDownloadId(downloadId, eventType as HistoryEventType);
        return row ? toEventSummary(row) : null;
      },
    },
    blocklist: {
      isBlocklisted: (candidate) => {
        const scope = blocklistScopeFor(candidate);
        if (!scope) return false;
        const indexer = indexersServiceFor(ctx).list().find((i) => i.id === candidate.indexerId);
        return blocklistServiceFor(ctx).isBlocklisted(scope, {
          title: candidate.title,
          protocol: candidate.protocol,
          indexer: indexer?.name ?? null,
          torrentInfoHash: candidate.infoHash ?? null,
          publishedDate: candidate.publishDate,
        });
      },
    },
    propers: {
      getDownloadPropersAndRepacks: () => getSection(db, 'mediaManagement').downloadPropersAndRepacks,
    },
    // VPN kill switch: grabs wait while the tunnel is down (no-op when VPN is disabled).
    grabGuard: {
      isSafeToGrab: () => vpnServiceFor(ctx).isSafeToGrab(),
      reason: GRAB_GUARD_REASON,
    },
    // Private trackers in freeleech-only mode reject non-freeleech releases (`notFreeleech`).
    releaseFilter: (indexerId, release) => trackerStatsServiceFor(ctx).releaseFilter(indexerId, release),
    // "When files don't meet this profile": lets a release replace a file the profile no longer allows.
    profileMigration: { mismatchActionFor: (id) => profileMigrationServiceFor(ctx).mismatchActionFor(id) },
    settings: {
      getReleaseSettings: () => {
        const r = getSection(db, 'releases');
        const i = getSection(db, 'indexers');
        return {
          maximumSizeMb: r.maximumSizeMb,
          minimumAgeMinutes: r.minimumAgeMinutes,
          retentionDays: r.retentionDays,
          allowMultiSeason: r.allowMultiSeasonPacks,
          seasonPackUpgrade: r.seasonPackUpgradeMode,
          seasonPackUpgradeThreshold: r.seasonPackUpgradeThreshold,
          availabilityDelayDays: r.availabilityDelayDays,
          allowUnairedEpisodes: r.allowUnairedEpisodes,
          unairedToleranceMinutes: r.unairedToleranceMinutes,
          allowHardcodedSubs: i.allowHardcodedSubs,
          whitelistedHardcodedSubs: i.whitelistedHardcodedSubs,
          preferIndexerFlags: i.preferIndexerFlags,
        };
      },
    },
    freeSpace: async (path) => (getSection(db, 'mediaManagement').skipFreeSpaceCheck ? null : freeSpaceAt(path)),
    // Read per decision, so a settings change applies without a restart.
    get minimumFreeSpaceMb() {
      return getSection(db, 'mediaManagement').minimumFreeSpaceMb;
    },
  };
}

/** releases' GrabHistoryInput -> history.recordGrab(release, mapping, downloadId, client). */
export function recordGrabInHistory(ctx: AppContext, grab: GrabHistoryInput): void {
  const target = historyTarget(grab);
  if (!target) {
    ctx.log.warn({ title: grab.sourceTitle }, 'grab without a library target; not recorded in history');
    return;
  }
  const client =
    grab.downloadClientId === null
      ? undefined
      : ctx.db
          .select({ implementation: downloadClients.implementation })
          .from(downloadClients)
          .where(eq(downloadClients.id, grab.downloadClientId))
          .get();
  const name = grab.downloadClientName ?? 'Unknown';
  historyServiceFor(ctx).recordGrab(
    {
      title: grab.sourceTitle,
      protocol: grab.protocol,
      guid: grab.guid,
      indexerId: grab.indexerId,
      indexerName: grab.indexerName,
      size: grab.size,
      publishDate: grab.publishDate,
      ...(grab.infoUrl ? { infoUrl: grab.infoUrl } : {}),
      // Torrent download ids are the info-hash.
      ...(grab.protocol === 'torrent' && /^[0-9a-f]{40}$/i.test(grab.downloadId) ? { infoHash: grab.downloadId.toLowerCase() } : {}),
    },
    {
      target,
      quality: grab.quality,
      languages: grab.languages,
      customFormatScore: grab.customFormatScore,
      releaseSource: toReleaseSource(grab.source),
      ...(grab.releaseGroup ? { releaseGroup: grab.releaseGroup } : {}),
      ...(grab.batchId ? { decisionBatchId: grab.batchId } : {}),
    },
    grab.downloadId,
    client ? { name, implementation: client.implementation } : name,
  );
}

function historyTarget(input: { mediaType: 'series' | 'movie'; seriesId?: number; episodeIds?: number[]; movieId?: number }): HistoryTarget | null {
  if (input.mediaType === 'movie') return input.movieId === undefined ? null : { mediaType: 'movie', movieId: input.movieId };
  return input.seriesId === undefined ? null : { mediaType: 'series', seriesId: input.seriesId, episodeIds: input.episodeIds ?? [] };
}

/** Blocklist entries are scoped to the parent (series or movie) of the candidate. */
export function blocklistScopeFor(candidate: BlocklistCandidate): { seriesId: number } | { movieId: number } | null {
  if (candidate.seriesId !== undefined) return { seriesId: candidate.seriesId };
  if (candidate.movieId !== undefined) return { movieId: candidate.movieId };
  return null;
}

function toEventSummary(row: HistoryRecord): HistoryEventSummary {
  const size = Number(dataValue(row.data, 'size'));
  return {
    eventType: row.eventType,
    date: row.date,
    sourceTitle: row.sourceTitle,
    quality: row.quality,
    ...(row.downloadId ? { downloadId: row.downloadId } : {}),
    ...(Number.isFinite(size) && size > 0 ? { sizeBytes: size } : {}),
  };
}

const RELEASE_SOURCES = new Set<string>(['rss', 'search', 'userInvokedSearch', 'interactiveSearch', 'releasePush']);

function toReleaseSource(source: string): HistoryReleaseSource {
  return RELEASE_SOURCES.has(source) ? (source as HistoryReleaseSource) : 'unknown';
}

function searchTargetFor(target: HistoryTarget): SearchTarget | null {
  if (target.mediaType === 'movie') return { movieId: target.movieId };
  // A failed download without known episodes would turn into a whole-series search; skip it.
  if (target.episodeIds.length === 0) return null;
  return { seriesId: target.seriesId, episodeIds: [...target.episodeIds] };
}

/** Free bytes on the volume holding `path`, walking up to the nearest existing folder. */
async function freeSpaceAt(path: string): Promise<number | null> {
  let current = path;
  for (;;) {
    try {
      const s = await statfs(current);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------------------

export function importsDeps(ctx: AppContext): ImportsDeps {
  return {
    history: {
      recordImport: (event) => {
        recordImportInHistory(ctx, event);
      },
    },
    notifications: {
      onImported: async (event) => {
        const built = buildImportNotification(ctx, event);
        if (built) await notificationsServiceFor(ctx).dispatch(built);
        // Media info for the new file (queued; the analysis job works it off).
        try {
          mediaAnalysisFor(ctx).enqueue([event.file.id]);
        } catch (err) {
          ctx.log.warn({ err, fileId: event.file.id }, 'could not queue media analysis');
        }
        // Subtitles: schedule a wanted-search for the freshly imported file (returns at once).
        subtitlesServiceFor(ctx).onImported(event);
      },
    },
    blocklist: {
      add: async ({ item, message }) => {
        await failTrackedDownload(ctx, item, { message, source: 'DownloadClient', skipRedownload: false });
      },
    },
    // Same rule on the import side: a file the profile no longer allows gives way under `replace`.
    profileMigration: { mismatchActionFor: (id) => profileMigrationServiceFor(ctx).mismatchActionFor(id) },
  };
}

/** imports' ImportedEvent -> history.recordImport(ImportHistoryInput). */
export function recordImportInHistory(ctx: AppContext, event: ImportedEvent): void {
  const target = historyTarget({
    mediaType: event.mediaType,
    ...(event.seriesId !== undefined ? { seriesId: event.seriesId } : {}),
    episodeIds: event.episodeIds,
    ...(event.movieId !== undefined ? { movieId: event.movieId } : {}),
  });
  if (!target) return;
  const history = historyServiceFor(ctx);
  const grabbed = event.downloadId ? history.mostRecentForDownloadId(event.downloadId, 'grabbed') : null;
  const downloadClient = grabbed ? dataValue(grabbed.data, 'downloadClient') : undefined;
  const downloadClientName = grabbed ? dataValue(grabbed.data, 'downloadClientName') : undefined;
  const file = event.file;
  history.recordImport({
    target,
    quality: file.quality,
    languages: file.languages,
    sceneName: file.sceneName ?? event.sourceTitle,
    droppedPath: event.sourcePath,
    importedPath: file.path,
    fileId: file.id,
    downloadId: event.downloadId,
    size: file.sizeBytes,
    ...(file.releaseGroup ? { releaseGroup: file.releaseGroup } : {}),
    ...(downloadClient ? { downloadClient } : {}),
    ...(downloadClientName ? { downloadClientName } : {}),
    ...(grabbed && grabbed.customFormatScore !== 0 ? { customFormatScore: grabbed.customFormatScore } : {}),
  });
}

const translatorCache = new WeakMap<AppContext, EventTranslator>();

/** An `import` (or `upgrade`, when files were replaced) notification for one imported file. */
export function buildImportNotification(ctx: AppContext, event: ImportedEvent): NotificationEvent | null {
  const mediaId = event.mediaType === 'movie' ? event.movieId : event.seriesId;
  if (mediaId === undefined) return null;
  let translator = translatorCache.get(ctx);
  if (!translator) {
    translator = new EventTranslator({ db: ctx.db, log: ctx.log.child({ module: 'notifications' }) });
    translatorCache.set(ctx, translator);
  }
  const media = translator.media(event.mediaType, mediaId);
  if (!media) return null;
  const db = ctx.db;

  const eps =
    event.mediaType === 'series' && event.episodeIds.length > 0
      ? db
          .select()
          .from(episodes)
          .where(inArray(episodes.id, event.episodeIds))
          .orderBy(episodes.seasonNumber, episodes.episodeNumber)
          .all()
          .map(toEpisodeInfo)
      : undefined;
  const fileRow = db.select().from(mediaFiles).where(eq(mediaFiles.id, event.file.id)).get();
  const file: MediaFileInfo = { ...(fileRow ? toFileInfo(fileRow) : fileInfoFrom(event.file)), sourcePath: event.sourcePath };

  const tracked = event.downloadId
    ? db
        .select({ row: trackedDownloads, clientName: downloadClients.name, clientType: downloadClients.implementation })
        .from(trackedDownloads)
        .leftJoin(downloadClients, eq(trackedDownloads.clientId, downloadClients.id))
        .where(eq(trackedDownloads.downloadId, event.downloadId))
        .orderBy(desc(trackedDownloads.id))
        .get()
    : undefined;
  const release: ReleaseInfo | undefined = tracked
    ? releaseFrom(event.sourceTitle, tracked.row.grabbedRelease, tracked.row.size)
    : undefined;

  const common = {
    instanceName: 'Arclight',
    timestamp: new Date().toISOString(),
    media,
    ...(eps ? { episodes: eps } : {}),
    file,
    ...(release ? { release } : {}),
    ...(tracked?.clientName ? { downloadClient: tracked.clientName } : {}),
    ...(tracked?.clientType ? { downloadClientType: tracked.clientType } : {}),
    ...(event.downloadId ? { downloadId: event.downloadId } : {}),
  };
  if (event.isUpgrade && event.replacedFiles.length > 0) {
    return { ...common, type: 'upgrade', oldFiles: event.replacedFiles.map(fileInfoFrom) };
  }
  return { ...common, type: 'import' };
}

function fileInfoFrom(file: MediaFile): MediaFileInfo {
  return {
    id: file.id,
    path: file.path,
    relativePath: file.relativePath,
    quality: file.quality.quality.name,
    qualityVersion: file.quality.revision.version,
    ...(file.releaseGroup ? { releaseGroup: file.releaseGroup } : {}),
    ...(file.sceneName ? { sceneName: file.sceneName } : {}),
    size: file.sizeBytes,
    dateAdded: file.dateAdded,
    languages: file.languages,
  };
}

// ---------------------------------------------------------------------------------------
// failed downloads
// ---------------------------------------------------------------------------------------

/**
 * Fail a tracked download through history (which blocklists and triggers the re-search
 * handlers). Downloads Arclight never grabbed have no history to fail; they are blocklisted
 * directly from the queue item instead.
 */
export async function failTrackedDownload(
  ctx: AppContext,
  item: TrackedDownload,
  opts: { message?: string; source: string; skipRedownload: boolean },
): Promise<void> {
  const { message, source, skipRedownload } = opts;
  const tracked: TrackedDownloadInfo = {
    downloadId: item.downloadId,
    title: item.title,
    protocol: item.protocol,
    downloadClientName: item.downloadClientName,
    sizeBytes: item.sizeBytes,
  };
  try {
    await historyServiceFor(ctx).failTracked(tracked, {
      ...(message !== undefined ? { message } : {}),
      source,
      skipRedownload,
    });
  } catch (err) {
    if (!(err instanceof HistoryError && err.code === 'NOT_GRABBED')) throw err;
    blocklistServiceFor(ctx).addFromTracked(
      {
        title: item.title,
        downloadId: item.downloadId,
        protocol: item.protocol,
        sizeBytes: item.sizeBytes,
        ...(item.mediaType ? { mediaType: item.mediaType } : {}),
        ...(item.seriesId !== undefined ? { seriesId: item.seriesId } : {}),
        ...(item.episodeIds ? { episodeIds: item.episodeIds } : {}),
        ...(item.movieId !== undefined ? { movieId: item.movieId } : {}),
      },
      message ?? 'Manually marked as failed',
    );
  }
}
