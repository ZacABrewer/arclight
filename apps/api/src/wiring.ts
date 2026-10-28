import { statfs } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { desc, eq, inArray } from 'drizzle-orm';
import type { AlbumInfo, ArtistInfo, MediaFileInfo, MediaImage, MediaInfo, NotificationEvent, ReleaseInfo, TrackInfo } from '@arclight/notifications';
import type { AnyMediaType, AudioFile, HistoryEventType, HistoryRecord, HistoryReleaseSource, Job, MediaFile } from '@arclight/shared';
import type { AppContext } from './app.js';
import { albumReleases, albums, artists, downloadClients, episodes, mediaFiles, tags as tagsTable, trackedDownloads, tracks } from './db/schema.js';
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
  type AudioImportedEvent,
  type ImportedEvent,
  type ImportsDeps,
} from './modules/imports/index.js';
import { mediaServersServiceFor } from './modules/media-servers/index.js';
import { indexersServiceFor } from './modules/indexers/index.js';
import type { LibraryCommands, LibraryCommandTarget } from './modules/library/index.js';
import { ARTIST_SEARCH_JOB, metadataRefresherFor, musicMetadataFor, musicRefresherFor, setMusicSearchPort } from './modules/metadata/index.js';
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
//   `import manualRequired` still reaches notifications through the bus only. Music imports
//   report once per album: deps.history.recordAudioImport (a music history target),
//   deps.notifications.onAudioImported (an "Artist – Album" import/upgrade notification from
//   musicNotificationContext) and deps.mediaServers.refreshPath for the album folder.
//   deps.musicReleases loads other editions when the importer switches an album's edition.
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
// * Replace (POST /queue/:id/replace, stall recovery): download-clients.replace removes the
//   download, fails it through the same history pipeline with skipRedownload (blocklist with
//   the reason) and calls the replacement search registered here, which runs releases.searchFor
//   in a `ReplacementSearch` job. Exactly one search, whatever `autoRedownloadFailed` says: the
//   user (or the stall setting) asked for another release.
//
// * Held grabs: a grab the disk-space guard holds gets a `pending:*` download id; history
//   records the grab under it and is re-keyed (onPendingSent) when the grab is finally sent.
//
// * Library commands: the bulk editor's `refresh` / `search` flags and "search on add" call
//   libraryCommands below: refresh -> the metadata module's MetadataRefresher, search ->
//   releases.searchFor per item inside a `SeriesSearch` / `MovieSearch` / `ArtistSearch` job.
//   `artistIds` refresh through the metadata module's MusicRefresher (RefreshArtist). The music
//   commands (ArtistSearch, AlbumSearch, search on add) reach the release pipeline through the
//   music search port registered in wireModules (runMusicSearch).
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
/** Search started when a download's release is replaced (manually or by stall recovery). */
export const REPLACE_SEARCH_JOB = 'ReplacementSearch';

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

  // Music commands (ArtistSearch, AlbumSearch, search on add) search through the release pipeline.
  setMusicSearchPort(ctx, {
    artists: (ids, signal) => runMusicSearch(ctx, { artistIds: ids }, signal),
    albums: (ids, signal) => runMusicSearch(ctx, { albumIds: ids }, signal),
  });

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

  // Queue removal with "blocklist" goes through the same failed pipeline (so does replacing a
  // release, with its reason, e.g. "Stalled: no data for 40 min").
  const downloads = getDownloadClientsService(ctx);
  disposers.push(downloads.onBlocklist(async (item, { skipRedownload, message }) => {
    await failTrackedDownload(ctx, item, { source: 'Queue', skipRedownload, ...(message !== undefined ? { message } : {}) });
  }));

  // Replacing a release ("Try another release", stall recovery): one search for the same
  // episodes / movie, run as a job so it shows on the job board.
  downloads.setReplacementSearch((item) => {
    const target = searchTargetForTracked(item);
    if (!target) return false;
    ctx.scheduler.runTask(REPLACE_SEARCH_JOB, 'system', async ({ signal }) => {
      const summary = await releasesServiceFor(ctx).searchFor(target, { signal });
      return `searched for a replacement of "${item.title}": ${summary.releases} releases, ${summary.grabbed.length} grabbed`;
    }, { key: `${REPLACE_SEARCH_JOB}:${item.id}` });
    return true;
  });
  // Automatic replacements wait while grabs would (VPN down): the search could not grab anyway.
  downloads.setReplaceGuard(() => vpnServiceFor(ctx).isSafeToGrab());
  // A held (disk space) or delayed grab got its real download id: history follows it.
  disposers.push(downloads.onPendingSent((item, pendingId) => {
    historyServiceFor(ctx).rekeyDownloadId(pendingId, item.downloadId);
  }));
  disposers.push(() => {
    downloads.setReplacementSearch(undefined);
    downloads.setReplaceGuard(undefined);
  });

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
      if (target.artistIds?.length) musicRefresherFor(ctx)?.refresh(target.artistIds);
    },
    search: (target) => {
      startLibrarySearch(ctx, target);
    },
  };
}

function searchTargetKey(t: SearchTarget): string {
  if ('movieId' in t) return String(t.movieId);
  if ('seriesId' in t) return String(t.seriesId);
  if ('artistId' in t) return `a${t.artistId}`;
  if ('authorId' in t) return `w${t.authorId}`;
  return `al${t.albumIds.join('+')}`;
}

/**
 * Artist / album searches for the music module's ArtistSearch and AlbumSearch commands (and
 * search on add): each artist, or each album, in turn. Returns a one-line summary.
 */
export async function runMusicSearch(
  ctx: AppContext,
  target: { artistIds: readonly number[] } | { albumIds: readonly number[] },
  signal: AbortSignal,
): Promise<string> {
  const releases = releasesServiceFor(ctx);
  const targets: SearchTarget[] =
    'artistIds' in target ? target.artistIds.map((artistId) => ({ artistId })) : target.albumIds.map((id) => ({ albumIds: [id] }));
  let grabbed = 0;
  let found = 0;
  let failed = 0;
  for (const t of targets) {
    if (signal.aborted) break;
    try {
      const summary = await releases.searchFor(t, { userInvoked: true, signal });
      grabbed += summary.grabbed.length;
      found += summary.releases;
    } catch (err) {
      failed++;
      ctx.log.warn({ err, target: t }, 'music search failed');
    }
  }
  const n = targets.length;
  const what = 'artistIds' in target ? `${n} artist${n === 1 ? '' : 's'}` : `${n} album${n === 1 ? '' : 's'}`;
  return `searched ${what}: ${found} releases, ${grabbed} grabbed${failed ? `, ${failed} failed` : ''}`;
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
    }, { key: `${name}:${targets.map(searchTargetKey).join(',')}` });
  if (target.seriesIds?.length) started.push(run(SERIES_SEARCH_JOB, target.seriesIds.map((seriesId) => ({ seriesId }))));
  if (target.movieIds?.length) started.push(run(MOVIE_SEARCH_JOB, target.movieIds.map((movieId) => ({ movieId }))));
  if (target.artistIds?.length) started.push(run(ARTIST_SEARCH_JOB, target.artistIds.map((artistId) => ({ artistId }))));
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
        let row: HistoryRecord | null;
        if ('movieId' in item) row = history.mostRecentForMovie(item.movieId, type);
        else if ('episodeId' in item) row = history.mostRecentForEpisode(item.episodeId, type);
        else if ('albumId' in item) row = history.mostRecentForAlbum(item.albumId, type);
        else return null; // audiobooks: Wave 3
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
          allowDiscographyPacks: r.allowDiscographyPacks,
          minPackWanted: r.minPackWanted,
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

export function historyTarget(input: {
  mediaType: AnyMediaType;
  seriesId?: number;
  episodeIds?: number[];
  movieId?: number;
  artistId?: number;
  albumIds?: number[];
}): HistoryTarget | null {
  if (input.mediaType === 'music') {
    return input.artistId === undefined ? null : { mediaType: 'music', artistId: input.artistId, albumIds: input.albumIds ?? [] };
  }
  if (input.mediaType === 'audiobook') return null; // Wave 3
  if (input.mediaType === 'movie') return input.movieId === undefined ? null : { mediaType: 'movie', movieId: input.movieId };
  return input.seriesId === undefined ? null : { mediaType: 'series', seriesId: input.seriesId, episodeIds: input.episodeIds ?? [] };
}

/** Blocklist entries are scoped to the parent (series, movie, artist or author) of the candidate. */
export function blocklistScopeFor(
  candidate: BlocklistCandidate,
): { seriesId: number } | { movieId: number } | { artistId: number } | { authorId: number } | null {
  if (candidate.seriesId !== undefined) return { seriesId: candidate.seriesId };
  if (candidate.movieId !== undefined) return { movieId: candidate.movieId };
  if (candidate.artistId !== undefined) return { artistId: candidate.artistId };
  if (candidate.authorId !== undefined) return { authorId: candidate.authorId };
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

export function searchTargetFor(target: HistoryTarget): SearchTarget | null {
  if (target.mediaType === 'music') {
    // A failed album download searches those albums again (never the whole artist).
    return target.albumIds.length > 0 ? { artistId: target.artistId, albumIds: [...target.albumIds] } : null;
  }
  if (target.mediaType === 'audiobook') return null; // Wave 3
  if (target.mediaType === 'movie') return { movieId: target.movieId };
  // A failed download without known episodes would turn into a whole-series search; skip it.
  if (target.episodeIds.length === 0) return null;
  return { seriesId: target.seriesId, episodeIds: [...target.episodeIds] };
}

/** Search target of a queue item's episodes / movie; null when it is not linked to any. */
function searchTargetForTracked(item: TrackedDownload): SearchTarget | null {
  if (item.movieId !== undefined) return { movieId: item.movieId };
  if (item.artistId !== undefined) return item.albumIds?.length ? { artistId: item.artistId, albumIds: [...item.albumIds] } : null;
  if (item.seriesId === undefined || !item.episodeIds?.length) return null;
  return { seriesId: item.seriesId, episodeIds: [...item.episodeIds] };
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
      recordAudioImport: (event) => {
        recordAudioImportInHistory(ctx, event);
      },
    },
    notifications: {
      onAudioImported: async (event) => {
        const built = buildAudioImportNotification(ctx, event);
        if (built) await notificationsServiceFor(ctx).dispatch(built);
      },
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
    // Music imports: media servers with a music library holding the album folder rescan it.
    mediaServers: {
      refreshPath: async (input) => {
        const results = await mediaServersServiceFor(ctx).refreshPath(input);
        for (const r of results) {
          if (r.status === 'failed') ctx.log.warn({ server: r.name, path: input.path, message: r.message }, 'media server refresh after import failed');
        }
        return results;
      },
    },
    // Edition switches during music import load the other editions through the cached client.
    musicReleases: {
      getRelease: async (mbReleaseId) => {
        const service = musicMetadataFor(ctx);
        if (!service) throw new Error('music metadata is not available');
        return service.musicBrainz().getRelease(mbReleaseId, { priority: 'background' });
      },
    },
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

/** imports' AudioImportedEvent -> history.recordImport with a music target (one record per album). */
export function recordAudioImportInHistory(ctx: AppContext, event: AudioImportedEvent): void {
  const history = historyServiceFor(ctx);
  const grabbed = event.downloadId ? history.mostRecentForDownloadId(event.downloadId, 'grabbed') : null;
  const downloadClient = grabbed ? dataValue(grabbed.data, 'downloadClient') : undefined;
  const downloadClientName = grabbed ? dataValue(grabbed.data, 'downloadClientName') : undefined;
  const first = event.files[0];
  history.recordImport({
    target: { mediaType: 'music', artistId: event.artistId, albumIds: event.albumIds },
    quality: event.quality,
    languages: [],
    sceneName: event.sourceTitle,
    droppedPath: event.sourcePath,
    importedPath: event.albumFolder,
    ...(first ? { fileId: first.id } : {}),
    downloadId: event.downloadId,
    size: event.files.reduce((n, f) => n + f.sizeBytes, 0),
    ...(first?.releaseGroup ? { releaseGroup: first.releaseGroup } : {}),
    ...(downloadClient ? { downloadClient } : {}),
    ...(downloadClientName ? { downloadClientName } : {}),
    ...(grabbed && grabbed.customFormatScore !== 0 ? { customFormatScore: grabbed.customFormatScore } : {}),
  });
}

const MUSIC_COVER_TYPES: Record<string, MediaImage['coverType'] | undefined> = {
  poster: 'poster',
  cover: 'poster',
  fanart: 'fanart',
  banner: 'banner',
  clearlogo: 'clearlogo',
  logo: 'clearlogo',
};

/**
 * Notification context of a music item: the artist as `MediaInfo` (music headlines read
 * "Artist - Album [FLAC]"), plus artist and album details. Null when the artist is gone.
 * Shared by the music grab and import notifications.
 */
export function musicNotificationContext(
  ctx: AppContext,
  artistId: number,
  albumId?: number,
): { media: MediaInfo; artist: ArtistInfo; album?: AlbumInfo } | null {
  const db = ctx.db;
  const artist = db.select().from(artists).where(eq(artists.id, artistId)).get();
  if (!artist) return null;
  const album = albumId !== undefined ? db.select().from(albums).where(eq(albums.id, albumId)).get() : undefined;
  const release =
    album?.selectedReleaseId != null ? db.select().from(albumReleases).where(eq(albumReleases.id, album.selectedReleaseId)).get() : undefined;
  const tagLabels = artist.tags.length ? db.select().from(tagsTable).where(inArray(tagsTable.id, artist.tags)).all().map((t) => t.label) : [];
  const images = artist.images.flatMap((img): MediaImage[] => {
    const coverType = MUSIC_COVER_TYPES[img.coverType];
    const url = /^https?:\/\//.test(img.url) ? img.url : (img.remoteUrl ?? undefined);
    return coverType && url ? [{ coverType, url }] : [];
  });
  const media: MediaInfo = {
    id: artist.id,
    mediaType: 'music',
    title: artist.name,
    year: album?.year ?? 0,
    tmdbId: 0,
    path: artist.path,
    ...(artist.overview ? { overview: artist.overview } : {}),
    genres: artist.genres,
    tags: tagLabels,
    images,
  };
  const artistInfo: ArtistInfo = {
    id: artist.id,
    name: artist.name,
    mbArtistId: artist.mbArtistId,
    ...(artist.disambiguation ? { disambiguation: artist.disambiguation } : {}),
    path: artist.path,
  };
  if (!album) return { media, artist: artistInfo };
  const albumInfo: AlbumInfo = {
    id: album.id,
    title: album.title,
    albumType: album.primaryType,
    ...(album.releaseDate ? { releaseDate: album.releaseDate } : {}),
    mbReleaseGroupId: album.mbReleaseGroupId,
    ...(release ? { mbReleaseId: release.mbReleaseId } : {}),
  };
  return { media, artist: artistInfo, album: albumInfo };
}

/** An `import` (or `upgrade`) notification for one imported album. */
export function buildAudioImportNotification(ctx: AppContext, event: AudioImportedEvent): NotificationEvent | null {
  const context = musicNotificationContext(ctx, event.artistId, event.albumId);
  const firstFile = event.files[0];
  if (!context || !firstFile) return null;
  const db = ctx.db;
  const artistPath = context.artist.path ?? event.albumFolder;
  const trackRows = event.trackIds.length ? db.select().from(tracks).where(inArray(tracks.id, event.trackIds)).all() : [];
  const trackInfos: TrackInfo[] = trackRows
    .sort((a, b) => a.mediumNumber - b.mediumNumber || a.trackNumber - b.trackNumber)
    .map((t) => ({
      id: t.id,
      title: t.title,
      mediumNumber: t.mediumNumber,
      trackNumber: t.trackNumber,
      ...(t.durationMs != null ? { durationMs: t.durationMs } : {}),
      ...(t.mbRecordingId ? { mbRecordingId: t.mbRecordingId } : {}),
    }));
  // The album as one "file": its folder, total size and best quality.
  const file: MediaFileInfo = {
    id: firstFile.id,
    path: event.albumFolder,
    relativePath: relative(artistPath, event.albumFolder),
    quality: event.quality.quality.name,
    qualityVersion: event.quality.revision.version,
    ...(firstFile.releaseGroup ? { releaseGroup: firstFile.releaseGroup } : {}),
    size: event.files.reduce((n, f) => n + f.sizeBytes, 0),
    dateAdded: firstFile.dateAdded,
    languages: [],
    sourcePath: event.sourcePath,
  };
  const tracked = event.downloadId
    ? db
        .select({ row: trackedDownloads, clientName: downloadClients.name, clientType: downloadClients.implementation })
        .from(trackedDownloads)
        .leftJoin(downloadClients, eq(trackedDownloads.clientId, downloadClients.id))
        .where(eq(trackedDownloads.downloadId, event.downloadId))
        .orderBy(desc(trackedDownloads.id))
        .get()
    : undefined;
  const release: ReleaseInfo | undefined = tracked ? releaseFrom(event.sourceTitle, tracked.row.grabbedRelease, tracked.row.size) : undefined;
  const common = {
    instanceName: 'Arclight',
    timestamp: new Date().toISOString(),
    media: context.media,
    artist: context.artist,
    ...(context.album ? { album: { ...context.album, path: event.albumFolder } } : {}),
    tracks: trackInfos,
    file,
    ...(release ? { release } : {}),
    ...(tracked?.clientName ? { downloadClient: tracked.clientName } : {}),
    ...(tracked?.clientType ? { downloadClientType: tracked.clientType } : {}),
    ...(event.downloadId ? { downloadId: event.downloadId } : {}),
  };
  if (event.isUpgrade && event.replacedFiles.length > 0) {
    return { ...common, type: 'upgrade', oldFiles: event.replacedFiles.map(audioFileInfoFrom) };
  }
  return { ...common, type: 'import' };
}

function audioFileInfoFrom(file: AudioFile): MediaFileInfo {
  return {
    id: file.id,
    path: file.path,
    relativePath: file.relativePath,
    quality: file.quality.quality.name,
    qualityVersion: file.quality.revision.version,
    ...(file.releaseGroup ? { releaseGroup: file.releaseGroup } : {}),
    size: file.sizeBytes,
    dateAdded: file.dateAdded,
    languages: [],
  };
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
        ...(item.artistId !== undefined ? { artistId: item.artistId } : {}),
        ...(item.albumIds ? { albumIds: item.albumIds } : {}),
      },
      message ?? 'Manually marked as failed',
    );
  }
}
