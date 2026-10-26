import { and, eq, inArray, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { SearchRequest } from '@media-tron/indexers';
import { parseRelease } from '@media-tron/parser';
import {
  MovieListQuery,
  SeriesListQuery,
  type CustomFormat,
  type DelayProfile,
  type Episode,
  type Indexer,
  type ManualSearchRequest,
  type MediaFile,
  type Movie,
  type PendingReason,
  type PendingRelease,
  type QualityDefinitionItem,
  type QualityModel,
  type QualityProfile,
  type ReleaseDecision,
  type ReleaseGrabRequest,
  type ReleaseProfile,
  type ReleasePushRequest,
  type ReleaseResource,
  type ReleaseSource,
  type Series,
  type TrackedDownloadState,
} from '@media-tron/shared';
import { selectDelayProfile } from '@media-tron/profiles-engine';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { libraryService } from '../library/index.js';
import { ProfilesService } from '../profiles/index.js';
import {
  DEFAULT_RELEASE_SETTINGS,
  defaultPropers,
  noopBlocklist,
  noopHistory,
  type DownloadPropersAndRepacks,
  type HistoryEventSummary,
  type ItemRef,
  type ReleaseSettings,
  type ReleasesDeps,
} from './deps.js';
import {
  buildDecision,
  cutoffNotMet,
  evaluate,
  evaluateFormats,
  prioritize,
  qualityModelOf,
  releaseKindOf,
  runtimeMinutes,
  toLanguageCodes,
  unmatchedDecision,
  type Candidate,
  type DecisionContext,
  type ExistingFile,
  type HistoryItem,
  type PendingItem,
  type QueuedItem,
  type Ranked,
  type SearchCriteria,
} from './engine.js';
import { matchRelease, type LibrarySnapshot, type MovieMatch, type SeriesMatch } from './matcher.js';
import { pendingReleases, releaseSearchState } from './schema.js';

// The release pipeline: decide on releases (RSS, searches, pushes), act on the decisions
// (grab / park as pending), and run the scheduled searches.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RELEASE_CACHE_TTL_MS = 30 * MINUTE;
const CLIENT_RETRY_MINUTES = 5;
const MAX_REDIRECTS = 5;

// ---- errors -------------------------------------------------------------------------

export type ReleasesErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'UNAVAILABLE' | 'DOWNLOAD_FAILED' | 'CLIENT_UNAVAILABLE';

export class ReleasesError extends Error {
  constructor(
    readonly code: ReleasesErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ReleasesError';
  }
}

// ---- ports (narrow views of the indexers / download-clients services) ----------------

export interface IndexerPort {
  list(): Indexer[];
  search(request: SearchRequest, opts: { mode: 'automatic' | 'interactive'; signal?: AbortSignal }): Promise<ReleaseResource[]>;
  onReleases(handler: (releases: ReleaseResource[]) => void | Promise<void>): () => void;
  setManualSearchResolver(resolver: ((request: ManualSearchRequest) => SearchRequest | null | Promise<SearchRequest | null>) | undefined): void;
}

export interface DownloadClientGrab {
  title: string;
  magnet?: string;
  torrentFile?: Uint8Array;
  isRecent?: boolean;
  seedConfig?: { ratioLimit?: number; seedTimeLimitMinutes?: number };
  protocol?: 'usenet' | 'torrent';
}

export interface DownloadTracking {
  mediaType?: 'series' | 'movie';
  seriesId?: number;
  episodeIds?: number[];
  movieId?: number;
  grabbedRelease?: unknown;
  tags?: number[];
}

export interface TrackedView {
  id: number;
  downloadId: string;
  downloadClientId: number | null;
  downloadClientName: string | null;
  title: string;
  trackedState: TrackedDownloadState;
  episodeIds?: number[] | undefined;
  movieId?: number | undefined;
  sizeBytes: number;
}

export interface DownloadPort {
  grab(clientId: number | null, request: DownloadClientGrab, tracking: DownloadTracking): Promise<TrackedView>;
  listTracked(states?: readonly TrackedDownloadState[]): TrackedView[];
}

export interface ReleasesServiceOptions {
  db: Db;
  bus?: EventBus;
  log?: Logger;
  indexers: IndexerPort;
  downloads: DownloadPort;
  deps?: ReleasesDeps;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Timeout for fetching a .torrent / .nzb. Default 30 s. */
  downloadTimeoutMs?: number;
}

/** A decision plus what the pipeline needs to act on it. */
export interface Evaluated extends Ranked {
  candidate?: Candidate;
}

export type SearchTarget =
  | { seriesId: number; seasonNumber?: number; episodeIds?: number[] }
  | { movieId: number };

export interface SearchSummary {
  releases: number;
  approved: number;
  grabbed: string[];
  pending: number;
}

interface ProcessResult {
  grabbed: Evaluated[];
  pending: number;
}

const ACTIVE_QUEUE_STATES: TrackedDownloadState[] = ['pending', 'downloading', 'importPending', 'importing', 'failedPending'];
const PARKABLE = new Set(['minimumAgeDelay', 'minimumAge']);

type PendingRow = typeof pendingReleases.$inferSelect;

// ---- per-batch data -----------------------------------------------------------------

/** Everything read once per batch so a 500-release RSS sync does not hit the DB per release. */
class Batch implements LibrarySnapshot {
  private seriesList?: Series[];
  private movieList?: Movie[];
  private readonly episodeCache = new Map<number, Episode[]>();
  private readonly fileCache = new Map<string, MediaFile[]>();
  readonly profiles: Map<number, QualityProfile>;
  readonly formats: CustomFormat[];
  readonly delayProfiles: DelayProfile[];
  readonly releaseProfiles: ReleaseProfile[];
  readonly limits: Map<number, QualityDefinitionItem>;
  readonly indexers: Map<number, Indexer>;
  readonly queue: Array<TrackedView & { parsedQuality: QualityModel }>;
  readonly pending: PendingRow[];

  constructor(
    private readonly db: Db,
    profiles: ProfilesService,
    indexers: IndexerPort,
    downloads: DownloadPort,
  ) {
    this.profiles = new Map(profiles.listQualityProfiles().map((p) => [p.id, p]));
    this.formats = profiles.listCustomFormats();
    this.delayProfiles = profiles.listDelayProfiles();
    this.releaseProfiles = profiles.listReleaseProfiles();
    this.limits = new Map(profiles.listQualityDefinitions().map((d) => [d.qualityId, d]));
    this.indexers = new Map(indexers.list().map((i) => [i.id, i]));
    this.queue = downloads.listTracked(ACTIVE_QUEUE_STATES).map((q) => {
      const p = parseRelease(q.title);
      return { ...q, parsedQuality: qualityModelOf(p.quality) };
    });
    this.pending = db.select().from(pendingReleases).all();
  }

  series(): readonly Series[] {
    this.seriesList ??= libraryService.listSeries(this.db, SeriesListQuery.parse({ includeStatistics: false }));
    return this.seriesList;
  }

  episodes(seriesId: number): readonly Episode[] {
    let list = this.episodeCache.get(seriesId);
    if (!list) {
      list = libraryService.listEpisodes(this.db, { seriesId });
      this.episodeCache.set(seriesId, list);
    }
    return list;
  }

  movies(): readonly Movie[] {
    this.movieList ??= libraryService.listMovies(this.db, MovieListQuery.parse({}));
    return this.movieList;
  }

  files(match: SeriesMatch | MovieMatch): MediaFile[] {
    const key = match.mediaType === 'series' ? `s${match.series.id}` : `m${match.movie.id}`;
    let list = this.fileCache.get(key);
    if (!list) {
      list = libraryService.listMediaFiles(
        this.db,
        match.mediaType === 'series' ? { seriesId: match.series.id } : { movieId: match.movie.id },
      );
      this.fileCache.set(key, list);
    }
    return list;
  }
}

// ---- service ------------------------------------------------------------------------

export class ReleasesService {
  private readonly db: Db;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly indexers: IndexerPort;
  private readonly downloads: DownloadPort;
  private readonly deps: ReleasesDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly downloadTimeoutMs: number;
  private readonly profilesService: ProfilesService;
  /** Releases seen by recent searches/pushes, so POST /release can grab by guid. */
  private readonly releaseCache = new Map<string, { release: ReleaseResource; at: number }>();
  private unsubscribeRss: (() => void) | undefined;

  constructor(opts: ReleasesServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.indexers = opts.indexers;
    this.downloads = opts.downloads;
    this.deps = opts.deps ?? {};
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? 30_000;
    this.profilesService = new ProfilesService({ db: opts.db });
  }

  // ---- wiring -----------------------------------------------------------------------

  /** Subscribe to RSS sync results and answer library-id manual searches. */
  attach(): void {
    this.unsubscribeRss = this.indexers.onReleases(async (releases) => {
      await this.processReleases(releases, 'rss');
    });
    this.indexers.setManualSearchResolver((request) => this.resolveManualSearch(request));
  }

  detach(): void {
    this.unsubscribeRss?.();
    this.indexers.setManualSearchResolver(undefined);
  }

  private settings(): ReleaseSettings {
    return { ...DEFAULT_RELEASE_SETTINGS, ...(this.deps.settings?.getReleaseSettings() ?? {}) };
  }

  private propers(): DownloadPropersAndRepacks {
    return (this.deps.propers ?? defaultPropers).getDownloadPropersAndRepacks();
  }

  // ---- deciding ---------------------------------------------------------------------

  /**
   * Decide on a batch of releases. `criteria` is the item a search ran for; `override`
   * pins the library mapping (interactive grab of an ambiguous release).
   */
  async decide(
    releases: readonly ReleaseResource[],
    source: ReleaseSource,
    opts: {
      criteria?: SearchCriteria;
      override?: { seriesId?: number | undefined; episodeIds?: number[] | undefined; movieId?: number | undefined };
      batch?: Batch;
    } = {},
  ): Promise<Evaluated[]> {
    const batch = opts.batch ?? this.newBatch();
    const settings = this.settings();
    const propers = this.propers();
    const out: Evaluated[] = [];
    for (const release of releases) {
      try {
        const evaluated = await this.decideOne(release, source, batch, settings, propers, opts.criteria, opts.override);
        if (evaluated) out.push(evaluated);
      } catch (err) {
        this.log?.warn({ err, title: release.title }, 'release decision failed');
        out.push({
          decision: unmatchedDecision(source, release, null, null, {
            reason: 'error',
            message: 'Unexpected error processing release',
            type: 'permanent',
          }),
        });
      }
    }
    return out;
  }

  private newBatch(): Batch {
    return new Batch(this.db, this.profilesService, this.indexers, this.downloads);
  }

  private async decideOne(
    release: ReleaseResource,
    source: ReleaseSource,
    batch: Batch,
    settings: ReleaseSettings,
    propers: DownloadPropersAndRepacks,
    criteria: SearchCriteria | undefined,
    override: { seriesId?: number | undefined; episodeIds?: number[] | undefined; movieId?: number | undefined } | undefined,
  ): Promise<Evaluated | null> {
    const ids = { tvdbId: release.tvdbId, tmdbId: release.tmdbId, imdbId: release.imdbId };
    const hint = hintFromCategories(release.categories);
    const outcome = matchRelease(release.title, ids, batch, { hint, ...(criteria ? { criteria } : {}) });
    const parsed = outcome.parsed;
    let match = outcome.match;

    if (override && (override.movieId !== undefined || override.seriesId !== undefined || override.episodeIds?.length)) {
      const pinned = this.overrideMatch(batch, override, parsed.series?.fullSeason ?? false);
      if (!pinned) throw new ReleasesError('VALIDATION', 'override does not refer to a library item');
      match = pinned;
    }

    if (match.status !== 'mapped') {
      // Plain RSS/push drops what it cannot parse (§1.2.1).
      if (match.reason === 'unableToParse' && !criteria && (source === 'rss' || source === 'releasePush')) return null;
      return { decision: unmatchedDecision(source, release, parsed, match) };
    }

    const profileId = match.mediaType === 'series' ? match.series.qualityProfileId : match.movie.qualityProfileId;
    const profile = batch.profiles.get(profileId);
    if (!profile) {
      return {
        decision: unmatchedDecision(source, release, parsed, null, {
          reason: 'decisionError',
          message: `Quality profile ${profileId} does not exist`,
          type: 'permanent',
        }),
      };
    }

    const quality: QualityModel = qualityModelOf(parsed.quality);
    const languages = toLanguageCodes(parsed.languages);
    const releaseGroup = parsed.releaseGroup ?? undefined;
    const mediaType = match.mediaType;
    const formats = evaluateFormats(profile, batch.formats, {
      title: release.title,
      quality,
      mediaType,
      sizeBytes: release.size,
      languages,
      releaseGroup: releaseGroup ?? null,
      ...(parsed.movie?.year ? { year: parsed.movie.year } : {}),
      releaseKind: releaseKindOf(match),
    });
    const now = this.now();
    const ageMinutes = Math.max(0, (now.getTime() - Date.parse(release.publishDate)) / MINUTE) || 0;
    const candidate: Candidate = {
      release,
      parsed,
      match,
      quality,
      languages,
      customFormats: formats.formats,
      formatScore: formats.score,
      releaseGroup,
      ageMinutes,
    };

    const ctx = await this.buildContext(batch, candidate, profile, source, settings, propers, criteria, now);
    const ev = evaluate(ctx, candidate);
    const decision = buildDecision(source, candidate, ev);
    const limits = batch.limits.get(quality.quality.id);
    return {
      decision,
      candidate,
      rank: {
        profile,
        preferredProtocol: ctx.delayProfile?.preferredProtocol,
        runtimeMinutes: runtimeMinutes(candidate, now),
        preferredSizeMbPerMinute: limits?.preferredSize ?? null,
        isAnime: match.mediaType === 'series' && match.series.seriesType === 'anime',
        firstEpisodeNumber: match.mediaType === 'series' ? Math.min(...match.episodes.map((e) => e.episodeNumber)) : 0,
      },
    };
  }

  private overrideMatch(
    batch: Batch,
    override: { seriesId?: number | undefined; episodeIds?: number[] | undefined; movieId?: number | undefined },
    fullSeason: boolean,
  ): SeriesMatch | MovieMatch | null {
    if (override.movieId !== undefined) {
      const movie = batch.movies().find((m) => m.id === override.movieId);
      return movie ? { status: 'mapped', mediaType: 'movie', movie, matchType: 'override' } : null;
    }
    let seriesId = override.seriesId;
    if (seriesId === undefined && override.episodeIds?.length) {
      seriesId = libraryService.getEpisode(this.db, override.episodeIds[0]!).seriesId;
    }
    const series = batch.series().find((s) => s.id === seriesId);
    if (!series) return null;
    const all = batch.episodes(series.id);
    const episodes = override.episodeIds?.length ? all.filter((e) => override.episodeIds!.includes(e.id)) : [];
    if (episodes.length === 0) return null;
    return {
      status: 'mapped',
      mediaType: 'series',
      series,
      episodes,
      seasonNumber: episodes[0]!.seasonNumber,
      fullSeason,
      special: episodes.every((e) => e.seasonNumber === 0),
      matchType: 'override',
    };
  }

  private async buildContext(
    batch: Batch,
    c: Candidate,
    profile: QualityProfile,
    source: ReleaseSource,
    settings: ReleaseSettings,
    propers: DownloadPropersAndRepacks,
    criteria: SearchCriteria | undefined,
    now: Date,
  ): Promise<DecisionContext> {
    const match = c.match;
    const mediaType = match.mediaType;
    const tags = mediaType === 'series' ? match.series.tags : match.movie.tags;
    const episodeIds = mediaType === 'series' ? match.episodes.map((e) => e.id) : [];
    const indexer = batch.indexers.get(c.release.indexerId);

    const fileEval = (f: MediaFile): ExistingFile => ({
      id: f.id,
      quality: f.quality,
      formatScore: evaluateFormats(profile, batch.formats, {
        title: f.sceneName ?? f.relativePath,
        quality: f.quality,
        mediaType,
        sizeBytes: f.sizeBytes,
        languages: f.languages,
        releaseGroup: f.releaseGroup ?? null,
      }).score,
      releaseGroup: f.releaseGroup ?? null,
      dateAdded: f.dateAdded,
      episodeIds: f.episodeIds,
      sizeBytes: f.sizeBytes,
    });
    const files = batch
      .files(match)
      .filter((f) => (mediaType === 'movie' ? f.id === match.movie.movieFileId || match.movie.movieFileId == null : true))
      .map(fileEval);

    const queue: QueuedItem[] = batch.queue
      .filter((q) => (mediaType === 'movie' ? q.movieId === match.movie.id : (q.episodeIds ?? []).some((id) => episodeIds.includes(id))))
      .map((q) => ({
        title: q.title,
        quality: q.parsedQuality,
        formatScore: evaluateFormats(profile, batch.formats, { title: q.title, quality: q.parsedQuality, mediaType, sizeBytes: q.sizeBytes }).score,
        state: q.trackedState,
        downloadId: q.downloadId,
        ...(q.episodeIds ? { episodeIds: q.episodeIds } : {}),
        ...(q.movieId !== undefined ? { movieId: q.movieId } : {}),
      }));

    const pending: PendingItem[] = batch.pending
      .filter((p) => (mediaType === 'movie' ? p.movieId === match.movie.id : (p.episodeIds ?? []).some((id) => episodeIds.includes(id))))
      .map((p) => ({
        id: p.id,
        guid: p.guid,
        indexerId: p.indexerId,
        addedAt: p.addedAt,
        ...(p.episodeIds ? { episodeIds: p.episodeIds } : {}),
        ...(p.movieId !== null ? { movieId: p.movieId } : {}),
      }));

    const items: ItemRef[] =
      mediaType === 'movie' ? [{ movieId: match.movie.id }] : match.episodes.map((e) => ({ episodeId: e.id, seriesId: match.series.id }));
    const history = this.deps.history ?? noopHistory;
    const latestHistory: HistoryItem[] = [];
    const importedGrabs: Array<{ grab: HistoryEventSummary; imported: HistoryEventSummary }> = [];
    if (history.latestFor) {
      for (const item of items) {
        const event = await history.latestFor(item);
        if (event) {
          latestHistory.push({
            event,
            formatScore: evaluateFormats(profile, batch.formats, {
              title: event.sourceTitle,
              quality: event.quality,
              mediaType,
              ...(event.sizeBytes ? { sizeBytes: event.sizeBytes } : {}),
            }).score,
          });
        }
        const hasFile = mediaType === 'movie' ? match.movie.hasFile : match.episodes.find((e) => 'episodeId' in item && e.id === item.episodeId)?.hasFile;
        if (hasFile && history.findByDownloadId) {
          const grab = await history.latestFor(item, 'grabbed');
          if (grab?.downloadId) {
            const imported = await history.findByDownloadId(grab.downloadId, 'downloadFolderImported');
            if (imported && imported.quality.quality.id !== grab.quality.quality.id) importedGrabs.push({ grab, imported });
          }
        }
      }
    }

    const blocklisted = await (this.deps.blocklist ?? noopBlocklist).isBlocklisted({
      mediaType,
      ...(mediaType === 'series' ? { seriesId: match.series.id, episodeIds } : { movieId: match.movie.id }),
      title: c.release.title,
      protocol: c.release.protocol,
      indexerId: c.release.indexerId,
      ...(c.release.infoHash ? { infoHash: c.release.infoHash } : {}),
      publishDate: c.release.publishDate,
    });

    let freeSpaceBytes: number | null = null;
    if (this.deps.freeSpace) {
      const path = mediaType === 'series' ? match.series.path : match.movie.path;
      try {
        freeSpaceBytes = await this.deps.freeSpace(path);
      } catch {
        freeSpaceBytes = null;
      }
    }

    return {
      source,
      now,
      settings,
      propers,
      profile,
      delayProfile: selectDelayProfile(batch.delayProfiles, tags),
      releaseProfiles: batch.releaseProfiles,
      qualityLimits: (id) => batch.limits.get(id),
      indexer,
      indexerDisabledTill: indexer?.status?.disabledTill,
      existingFiles: files,
      queue,
      pending,
      latestHistory,
      importedGrabs,
      blocklisted,
      criteria,
      freeSpaceBytes,
      minimumFreeSpaceMb: this.deps.minimumFreeSpaceMb ?? 100,
    };
  }

  // ---- acting on decisions (§12) ----------------------------------------------------

  /** Decide and act: grab the best approved release per episode set / movie, park delayed ones. */
  async processReleases(releases: ReleaseResource[], source: ReleaseSource, criteria?: SearchCriteria): Promise<ReleaseDecision[]> {
    this.cacheReleases(releases);
    const evaluated = await this.decide(releases, source, criteria ? { criteria } : {});
    await this.processDecisions(evaluated);
    return evaluated.map((e) => e.decision);
  }

  async processDecisions(evaluated: Evaluated[], opts: { downloadClientId?: number } = {}): Promise<ProcessResult> {
    const propers = this.propers();
    const qualified = evaluated.filter((e) => e.rank && e.candidate && (e.decision.approved || e.decision.temporarilyRejected));
    const sorted = prioritize(qualified, propers);
    const grabbedItems = new Set<string>();
    const pendingItems = new Set<string>();
    const failedProtocols = new Set<string>();
    const result: ProcessResult = { grabbed: [], pending: 0 };

    for (const e of sorted) {
      const keys = coverageKeys(e.decision);
      if (keys.some((k) => grabbedItems.has(k))) continue;
      if (e.decision.temporarilyRejected) {
        if (!e.decision.rejections.every((r) => PARKABLE.has(r.reason))) continue;
        const reason: PendingReason = keys.some((k) => pendingItems.has(k)) ? 'fallback' : 'delay';
        this.addPending(e.decision, reason, e.decision.delayMinutes ?? 1);
        for (const k of keys) pendingItems.add(k);
        result.pending++;
        continue;
      }
      if (failedProtocols.has(e.decision.protocol)) {
        this.addPending(e.decision, 'downloadClientUnavailable', CLIENT_RETRY_MINUTES);
        result.pending++;
        continue;
      }
      try {
        await this.grabEvaluated(e, opts.downloadClientId);
        for (const k of keys) grabbedItems.add(k);
        result.grabbed.push(e);
      } catch (err) {
        if (err instanceof ReleasesError && err.code === 'CLIENT_UNAVAILABLE') {
          failedProtocols.add(e.decision.protocol);
          this.addPending(e.decision, 'downloadClientUnavailable', CLIENT_RETRY_MINUTES);
          result.pending++;
        } else {
          this.log?.warn({ err, title: e.decision.title }, 'grab failed');
          this.bus?.publish({ type: 'release', action: 'rejected', title: e.decision.title, ...mediaRef(e.decision) });
        }
      }
    }
    return result;
  }

  // ---- grabbing ---------------------------------------------------------------------

  /** Grab by guid (POST /release). Interactive: rejections may be overridden by the user. */
  async grab(request: ReleaseGrabRequest | Evaluated): Promise<TrackedView> {
    if ('decision' in request) return this.grabEvaluated(request);
    const cached = this.cachedRelease(request.indexerId, request.guid);
    if (!cached) throw new ReleasesError('NOT_FOUND', 'Release not found; search again before grabbing');
    const override = {
      seriesId: request.seriesId,
      episodeIds: request.episodeIds,
      movieId: request.movieId,
    };
    const [evaluated] = await this.decide([cached], 'interactiveSearch', { override });
    if (!evaluated?.candidate) {
      throw new ReleasesError(
        'VALIDATION',
        `Cannot map release to a library item (${evaluated?.decision.rejections[0]?.message ?? 'unknown'}); pass seriesId/episodeIds or movieId`,
      );
    }
    return this.grabEvaluated(evaluated, request.downloadClientId);
  }

  private async grabEvaluated(e: Evaluated, downloadClientId?: number): Promise<TrackedView> {
    const c = e.candidate;
    if (!c) throw new ReleasesError('VALIDATION', 'Release is not mapped to a library item');
    const d = e.decision;
    // Grab guard (deps.grabGuard, e.g. VPN down): temporary rejection `vpnDown`. Thrown as
    // CLIENT_UNAVAILABLE so processDecisions parks the release as pending and retries it.
    const guard = this.deps.grabGuard;
    if (guard && !(await guard.isSafeToGrab())) {
      if (!d.rejections.some((r) => r.reason === 'vpnDown')) {
        d.rejections.push({ reason: 'vpnDown', message: guard.reason, type: 'temporary' });
      }
      d.temporarilyRejected = true;
      throw new ReleasesError('CLIENT_UNAVAILABLE', guard.reason);
    }
    const release = c.release;
    const indexer = this.indexers.list().find((i) => i.id === release.indexerId);
    const payload = await this.downloadPayload(release);

    const settings = indexer?.settings;
    const seedTimeMs = d.fullSeason ? (settings?.seasonPackSeedTime ?? settings?.seedTime) : settings?.seedTime;
    const ratio = settings?.seedRatio ?? release.minimumRatio;
    const seedTime = seedTimeMs ?? release.minimumSeedTime;
    const seedConfig = {
      ...(ratio !== undefined ? { ratioLimit: ratio } : {}),
      ...(seedTime !== undefined ? { seedTimeLimitMinutes: Math.round(seedTime / MINUTE) } : {}),
    };
    const match = c.match;
    const tags = match.mediaType === 'series' ? match.series.tags : match.movie.tags;
    const tracking: DownloadTracking = {
      mediaType: match.mediaType,
      tags,
      ...(match.mediaType === 'series'
        ? { seriesId: match.series.id, episodeIds: match.episodes.map((ep) => ep.id) }
        : { movieId: match.movie.id }),
      grabbedRelease: {
        guid: release.guid,
        title: release.title,
        indexerId: release.indexerId,
        indexer: release.indexerName,
        protocol: release.protocol,
        infoHash: release.infoHash,
        publishDate: release.publishDate,
        size: release.size,
        quality: d.quality,
        customFormatScore: d.customFormatScore,
        languages: d.languages,
        releaseGroup: d.releaseGroup,
      },
    };

    let tracked: TrackedView;
    try {
      tracked = await this.downloads.grab(
        downloadClientId ?? indexer?.downloadClientId ?? null,
        {
          title: release.title,
          protocol: release.protocol,
          isRecent: release.age <= 14,
          ...payload,
          ...(release.protocol === 'torrent' && Object.keys(seedConfig).length > 0 ? { seedConfig } : {}),
        },
        tracking,
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'NO_CLIENT' || code === 'CLIENT_ERROR') {
        throw new ReleasesError('CLIENT_UNAVAILABLE', err instanceof Error ? err.message : String(err), { cause: err });
      }
      throw err;
    }

    this.clearPendingFor(d);
    this.resetSearchState(d);
    this.bus?.publish({ type: 'release', action: 'grabbed', title: release.title, ...mediaRef(d) });
    try {
      await (this.deps.history ?? noopHistory).recordGrab({
        mediaType: match.mediaType,
        ...(match.mediaType === 'series'
          ? { seriesId: match.series.id, episodeIds: match.episodes.map((ep) => ep.id) }
          : { movieId: match.movie.id }),
        sourceTitle: release.title,
        quality: d.quality,
        languages: d.languages,
        customFormatScore: d.customFormatScore,
        ...(d.releaseGroup ? { releaseGroup: d.releaseGroup } : {}),
        indexerId: release.indexerId,
        indexerName: release.indexerName,
        protocol: release.protocol,
        guid: release.guid,
        size: release.size,
        publishDate: release.publishDate,
        ...(release.infoUrl ? { infoUrl: release.infoUrl } : {}),
        downloadClientId: tracked.downloadClientId,
        downloadClientName: tracked.downloadClientName,
        downloadId: tracked.downloadId,
        source: d.source,
      });
    } catch (err) {
      this.log?.warn({ err }, 'history hook failed after grab');
    }
    this.log?.info({ title: release.title, client: tracked.downloadClientName }, 'release grabbed');
    return tracked;
  }

  /** Magnet passthrough, else fetch the .torrent / .nzb (redirects to magnets are followed). */
  private async downloadPayload(release: ReleaseResource): Promise<{ magnet: string } | { torrentFile: Uint8Array }> {
    if (release.protocol === 'torrent') {
      if (release.downloadUrl.startsWith('magnet:')) return { magnet: release.downloadUrl };
      if (!release.downloadUrl && release.magnetUrl) return { magnet: release.magnetUrl };
    }
    let url = release.downloadUrl;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await this.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(this.downloadTimeoutMs) });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) break;
          if (location.startsWith('magnet:')) return { magnet: location };
          url = new URL(location, url).toString();
          continue;
        }
        if (res.status === 404 || res.status === 410) {
          throw new ReleasesError('UNAVAILABLE', `Release is no longer available at the indexer (HTTP ${res.status})`);
        }
        if (!res.ok) throw new ReleasesError('DOWNLOAD_FAILED', `Downloading the release failed (HTTP ${res.status})`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length === 0) throw new ReleasesError('DOWNLOAD_FAILED', 'Indexer returned an empty file');
        // GrabRequest has no nzb field yet: usenet bytes travel in `torrentFile` until a
        // usenet download client exists (pickClient('usenet') currently finds none).
        return { torrentFile: bytes };
      }
      throw new ReleasesError('DOWNLOAD_FAILED', 'Too many redirects downloading the release');
    } catch (err) {
      if (release.protocol === 'torrent' && release.magnetUrl) return { magnet: release.magnetUrl };
      if (err instanceof ReleasesError) throw err;
      throw new ReleasesError('DOWNLOAD_FAILED', `Downloading the release failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  // ---- release cache ----------------------------------------------------------------

  private cacheReleases(releases: readonly ReleaseResource[]): void {
    const now = Date.now();
    for (const [key, v] of this.releaseCache) if (now - v.at > RELEASE_CACHE_TTL_MS) this.releaseCache.delete(key);
    for (const r of releases) this.releaseCache.set(`${r.indexerId}:${r.guid}`, { release: r, at: now });
  }

  private cachedRelease(indexerId: number, guid: string): ReleaseResource | undefined {
    const hit = this.releaseCache.get(`${indexerId}:${guid}`);
    if (hit) return hit.release;
    const pending = this.db
      .select()
      .from(pendingReleases)
      .where(and(eq(pendingReleases.guid, guid), eq(pendingReleases.indexerId, indexerId)))
      .get();
    return pending?.release;
  }

  // ---- pending ----------------------------------------------------------------------

  private addPending(d: ReleaseDecision, reason: PendingReason, waitMinutes: number): void {
    const release = this.cachedRelease(d.indexerId, d.guid) ?? decisionToRelease(d);
    const now = this.now();
    const eligibleAt = new Date(now.getTime() + Math.max(1, waitMinutes) * MINUTE).toISOString();
    const values = {
      guid: d.guid,
      indexerId: d.indexerId,
      title: d.title,
      mediaType: d.mediaType ?? 'series',
      seriesId: d.seriesId ?? null,
      episodeIds: d.episodeIds ?? null,
      movieId: d.movieId ?? null,
      reason,
      release,
      addedAt: now.toISOString(),
      eligibleAt,
    };
    this.db
      .insert(pendingReleases)
      .values(values)
      .onConflictDoUpdate({
        target: [pendingReleases.guid, pendingReleases.indexerId],
        set: { reason, eligibleAt, seriesId: values.seriesId, episodeIds: values.episodeIds, movieId: values.movieId },
      })
      .run();
    this.bus?.publish({ type: 'release', action: 'pending', title: d.title, ...mediaRef(d) });
  }

  private clearPendingFor(d: ReleaseDecision): void {
    if (d.movieId !== undefined) {
      this.db.delete(pendingReleases).where(eq(pendingReleases.movieId, d.movieId)).run();
      return;
    }
    if (d.seriesId === undefined) return;
    const ids = new Set(d.episodeIds ?? []);
    const rows = this.db.select().from(pendingReleases).where(eq(pendingReleases.seriesId, d.seriesId)).all();
    const doomed = rows.filter((r) => (r.episodeIds ?? []).some((id) => ids.has(id))).map((r) => r.id);
    if (doomed.length > 0) this.db.delete(pendingReleases).where(inArray(pendingReleases.id, doomed)).run();
  }

  listPending(): PendingRelease[] {
    const now = this.now().getTime();
    return this.db
      .select()
      .from(pendingReleases)
      .all()
      .map((row) => {
        const parsed = parseRelease(row.title);
        return {
          id: row.id,
          guid: row.guid,
          indexerId: row.indexerId,
          indexerName: row.release.indexerName,
          title: row.title,
          protocol: row.release.protocol,
          size: row.release.size,
          publishDate: row.release.publishDate,
          mediaType: row.mediaType,
          ...(row.seriesId !== null ? { seriesId: row.seriesId } : {}),
          ...(row.episodeIds ? { episodeIds: row.episodeIds } : {}),
          ...(row.movieId !== null ? { movieId: row.movieId } : {}),
          quality: qualityModelOf(parsed.quality),
          customFormatScore: 0,
          reason: row.reason,
          added: row.addedAt,
          eligibleAt: row.eligibleAt,
          remainingMinutes: Math.max(0, Math.ceil((Date.parse(row.eligibleAt) - now) / MINUTE)),
        };
      });
  }

  deletePending(id: number): void {
    const row = this.db.select({ id: pendingReleases.id }).from(pendingReleases).where(eq(pendingReleases.id, id)).get();
    if (!row) throw new ReleasesError('NOT_FOUND', `Pending release ${id} not found`);
    this.db.delete(pendingReleases).where(eq(pendingReleases.id, id)).run();
  }

  /**
   * Re-decide pending releases whose time has come, per item: the best still-qualified
   * release is grabbed when approved; while the best is still delayed the item keeps waiting.
   */
  async processPending(): Promise<string> {
    const nowIso = this.now().toISOString();
    const due = this.db.select().from(pendingReleases).where(lte(pendingReleases.eligibleAt, nowIso)).all();
    if (due.length === 0) return 'no pending releases due';
    const all = this.db.select().from(pendingReleases).all();
    const groups = groupPending(all, new Set(due.map((r) => r.id)));
    let grabbed = 0;
    let dropped = 0;
    for (const rows of groups) {
      const batch = this.newBatch();
      const evaluated: Array<Evaluated & { row: PendingRow }> = [];
      for (const row of rows) {
        const [e] = await this.decide([row.release], 'rss', {
          batch,
          override: {
            seriesId: row.seriesId ?? undefined,
            episodeIds: row.episodeIds ?? undefined,
            movieId: row.movieId ?? undefined,
          },
        });
        if (e) evaluated.push({ ...e, row });
      }
      const sorted = prioritize(evaluated, this.propers());
      for (const e of sorted) {
        if (e.decision.approved) {
          try {
            await this.grabEvaluated(e);
            grabbed++;
          } catch (err) {
            if (err instanceof ReleasesError && err.code === 'CLIENT_UNAVAILABLE') {
              this.addPending(e.decision, 'downloadClientUnavailable', CLIENT_RETRY_MINUTES);
            } else {
              this.log?.warn({ err, title: e.decision.title }, 'pending grab failed');
              this.db.delete(pendingReleases).where(eq(pendingReleases.id, e.row.id)).run();
              dropped++;
              continue;
            }
          }
          break;
        }
        if (e.decision.temporarilyRejected) {
          if (e.decision.delayMinutes !== undefined) {
            const eligibleAt = new Date(this.now().getTime() + e.decision.delayMinutes * MINUTE).toISOString();
            this.db.update(pendingReleases).set({ eligibleAt }).where(eq(pendingReleases.id, e.row.id)).run();
          }
          break;
        }
        this.db.delete(pendingReleases).where(eq(pendingReleases.id, e.row.id)).run();
        dropped++;
      }
    }
    return `pending: ${grabbed} grabbed, ${dropped} dropped`;
  }

  // ---- searching --------------------------------------------------------------------

  /** Indexer requests + match criteria for a library item. */
  buildSearch(target: SearchTarget, userInvoked: boolean): { requests: SearchRequest[]; criteria: SearchCriteria } {
    if ('movieId' in target) {
      const movie = libraryService.getMovie(this.db, target.movieId);
      const request: SearchRequest = {
        kind: 'movie',
        query: movie.title,
        tmdbId: movie.tmdbId,
        ...(movie.imdbId ? { imdbId: movie.imdbId } : {}),
        ...(movie.year ? { year: movie.year } : {}),
      };
      return { requests: [request], criteria: { mediaType: 'movie', movieId: movie.id, userInvoked } };
    }
    const series = libraryService.getSeries(this.db, target.seriesId, { includeStatistics: false });
    const episodes = libraryService.listEpisodes(this.db, { seriesId: series.id });
    let targeted: Episode[];
    if (target.episodeIds?.length) targeted = episodes.filter((e) => target.episodeIds!.includes(e.id));
    else if (target.seasonNumber !== undefined) targeted = episodes.filter((e) => e.seasonNumber === target.seasonNumber);
    else targeted = episodes.filter((e) => e.seasonNumber > 0 && (userInvoked || e.monitored));

    const base = {
      kind: 'tv' as const,
      query: series.title,
      tmdbId: series.tmdbId,
      ...(series.tvdbId ? { tvdbId: series.tvdbId } : {}),
      ...(series.imdbId ? { imdbId: series.imdbId } : {}),
    };
    const requests: SearchRequest[] = [];
    const bySeason = new Map<number, Episode[]>();
    for (const e of targeted) bySeason.set(e.seasonNumber, [...(bySeason.get(e.seasonNumber) ?? []), e]);
    for (const [season, eps] of bySeason) {
      const wholeSeason = eps.length === episodes.filter((e) => e.seasonNumber === season).length && eps.length > 1;
      if (series.seriesType === 'daily') {
        for (const e of eps) if (e.airDate) requests.push({ ...base, airDate: e.airDate });
        continue;
      }
      if (wholeSeason || (target.seasonNumber !== undefined && !target.episodeIds?.length)) {
        requests.push({ ...base, season });
        continue;
      }
      for (const e of eps) {
        requests.push({ ...base, season, episode: e.episodeNumber });
        if (series.seriesType === 'anime' && e.absoluteEpisodeNumber) {
          requests.push({ kind: 'search', query: `${series.title} ${String(e.absoluteEpisodeNumber).padStart(2, '0')}` });
        }
      }
    }
    const criteria: SearchCriteria = {
      mediaType: 'series',
      seriesId: series.id,
      userInvoked,
      ...(target.episodeIds?.length ? { episodeIds: targeted.map((e) => e.id) } : {}),
      ...(target.seasonNumber !== undefined
        ? { seasonNumber: target.seasonNumber }
        : target.episodeIds?.length === 1 && targeted[0]
          ? { seasonNumber: targeted[0].seasonNumber }
          : {}),
    };
    return { requests, criteria };
  }

  private async runSearch(requests: SearchRequest[], mode: 'automatic' | 'interactive', signal?: AbortSignal): Promise<ReleaseResource[]> {
    const seen = new Set<string>();
    const out: ReleaseResource[] = [];
    for (const request of requests) {
      const results = await this.indexers.search(request, { mode, ...(signal ? { signal } : {}) });
      for (const r of results) {
        const key = `${r.indexerId}:${r.guid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
    }
    this.cacheReleases(out);
    return out;
  }

  /** Automatic search + grab for a library item. `userInvoked` relaxes delay/monitored specs. */
  async searchFor(target: SearchTarget, opts: { userInvoked?: boolean; signal?: AbortSignal } = {}): Promise<SearchSummary> {
    const userInvoked = opts.userInvoked ?? false;
    const { requests, criteria } = this.buildSearch(target, userInvoked);
    if (requests.length === 0) return { releases: 0, approved: 0, grabbed: [], pending: 0 };
    const releases = await this.runSearch(requests, 'automatic', opts.signal);
    const evaluated = await this.decide(releases, userInvoked ? 'userInvokedSearch' : 'search', { criteria });
    const result = await this.processDecisions(evaluated);
    return {
      releases: releases.length,
      approved: evaluated.filter((e) => e.decision.approved).length,
      grabbed: result.grabbed.map((e) => e.decision.title),
      pending: result.pending,
    };
  }

  /** Interactive search: every decision, approved first then by rank, nothing grabbed. */
  async interactiveSearch(query: { seriesId?: number | undefined; seasonNumber?: number | undefined; episodeId?: number | undefined; movieId?: number | undefined }, signal?: AbortSignal): Promise<ReleaseDecision[]> {
    const target = this.targetFromQuery(query);
    const { requests, criteria } = this.buildSearch(target, true);
    const releases = await this.runSearch(requests, 'interactive', signal);
    const evaluated = await this.decide(releases, 'interactiveSearch', { criteria });
    const sorted = prioritize(evaluated, this.propers()).map((e) => e.decision);
    return [...sorted.filter((d) => d.approved), ...sorted.filter((d) => !d.approved)];
  }

  private targetFromQuery(query: { seriesId?: number | undefined; seasonNumber?: number | undefined; episodeId?: number | undefined; movieId?: number | undefined }): SearchTarget {
    if (query.movieId !== undefined) return { movieId: query.movieId };
    if (query.episodeId !== undefined) {
      const episode = libraryService.getEpisode(this.db, query.episodeId);
      return { seriesId: episode.seriesId, episodeIds: [episode.id] };
    }
    if (query.seriesId !== undefined) {
      return { seriesId: query.seriesId, ...(query.seasonNumber !== undefined ? { seasonNumber: query.seasonNumber } : {}) };
    }
    throw new ReleasesError('VALIDATION', 'seriesId, episodeId or movieId is required');
  }

  seriesIdForEpisode(episodeId: number): number {
    return libraryService.getEpisode(this.db, episodeId).seriesId;
  }

  /** Lets GET /search?seriesId= on the indexers module resolve library ids. */
  resolveManualSearch(request: ManualSearchRequest): SearchRequest | null {
    try {
      const target = this.targetFromQuery(request);
      return this.buildSearch(target, true).requests[0] ?? null;
    } catch {
      return null;
    }
  }

  // ---- push -------------------------------------------------------------------------

  async push(input: ReleasePushRequest): Promise<{ decision: ReleaseDecision | null; grabbed: boolean; pending: boolean }> {
    const downloadUrl = input.downloadUrl ?? input.magnetUrl;
    if (!downloadUrl) throw new ReleasesError('VALIDATION', 'downloadUrl or magnetUrl is required');
    const now = this.now().getTime();
    const published = Date.parse(input.publishDate);
    if (!Number.isFinite(published)) throw new ReleasesError('VALIDATION', 'publishDate is not a valid date');
    const ageMs = Math.max(0, now - published);
    const indexer = input.indexerId !== undefined ? this.indexers.list().find((i) => i.id === input.indexerId) : undefined;
    const release: ReleaseResource = {
      guid: input.guid ?? downloadUrl,
      title: input.title,
      size: input.size,
      publishDate: new Date(published).toISOString(),
      downloadUrl,
      categories: [],
      indexerId: input.indexerId ?? 0,
      indexerName: indexer?.name ?? input.indexer ?? 'Push',
      indexerPriority: indexer?.priority ?? 25,
      protocol: input.protocol,
      age: Math.floor(ageMs / DAY),
      ageHours: ageMs / (60 * MINUTE),
      ageMinutes: ageMs / MINUTE,
      rejections: [],
      approved: false,
      ...(input.infoUrl ? { infoUrl: input.infoUrl } : {}),
      ...(input.magnetUrl ? { magnetUrl: input.magnetUrl } : {}),
      ...(input.infoHash ? { infoHash: input.infoHash.toLowerCase() } : {}),
      ...(input.seeders !== undefined ? { seeders: input.seeders } : {}),
      ...(input.leechers !== undefined ? { leechers: input.leechers } : {}),
      ...(input.tvdbId !== undefined ? { tvdbId: input.tvdbId } : {}),
      ...(input.tmdbId !== undefined ? { tmdbId: input.tmdbId } : {}),
      ...(input.imdbId !== undefined ? { imdbId: input.imdbId } : {}),
    };
    this.cacheReleases([release]);
    const evaluated = await this.decide([release], 'releasePush');
    const result = await this.processDecisions(evaluated, input.downloadClientId !== undefined ? { downloadClientId: input.downloadClientId } : {});
    return {
      decision: evaluated[0]?.decision ?? null,
      grabbed: result.grabbed.length > 0,
      pending: result.pending > 0,
    };
  }

  // ---- scheduled searches -----------------------------------------------------------

  private shouldSearch(kind: 'episode' | 'movie', itemId: number): boolean {
    const row = this.db
      .select()
      .from(releaseSearchState)
      .where(and(eq(releaseSearchState.mediaType, kind), eq(releaseSearchState.itemId, itemId)))
      .get();
    if (!row) return true;
    const backoff = Math.min(Math.max(row.searchCount, 1), 7) * DAY;
    return this.now().getTime() - Date.parse(row.lastSearchedAt) >= backoff - MINUTE;
  }

  private markSearched(kind: 'episode' | 'movie', itemIds: readonly number[]): void {
    const nowIso = this.now().toISOString();
    for (const itemId of itemIds) {
      const row = this.db
        .select()
        .from(releaseSearchState)
        .where(and(eq(releaseSearchState.mediaType, kind), eq(releaseSearchState.itemId, itemId)))
        .get();
      if (row) {
        this.db
          .update(releaseSearchState)
          .set({ lastSearchedAt: nowIso, searchCount: row.searchCount + 1 })
          .where(eq(releaseSearchState.id, row.id))
          .run();
      } else {
        this.db.insert(releaseSearchState).values({ mediaType: kind, itemId, lastSearchedAt: nowIso, searchCount: 1 }).run();
      }
    }
  }

  private resetSearchState(d: ReleaseDecision): void {
    if (d.movieId !== undefined) {
      this.db
        .delete(releaseSearchState)
        .where(and(eq(releaseSearchState.mediaType, 'movie'), eq(releaseSearchState.itemId, d.movieId)))
        .run();
    } else if (d.episodeIds?.length) {
      this.db
        .delete(releaseSearchState)
        .where(and(eq(releaseSearchState.mediaType, 'episode'), inArray(releaseSearchState.itemId, d.episodeIds)))
        .run();
    }
  }

  private allPages<T>(fetchPage: (page: number) => { records: T[]; totalRecords: number; pageSize: number }): T[] {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const p = fetchPage(page);
      out.push(...p.records);
      if (page * p.pageSize >= p.totalRecords || p.records.length === 0) break;
    }
    return out;
  }

  private async searchEpisodeSet(
    episodes: ReadonlyArray<{ id: number; seriesId: number; seasonNumber: number }>,
    signal: AbortSignal | undefined,
    limit: number,
  ): Promise<{ searched: number; grabbed: number }> {
    const due = episodes.filter((e) => this.shouldSearch('episode', e.id)).slice(0, limit);
    const groups = new Map<string, number[]>();
    for (const e of due) {
      const key = `${e.seriesId}:${e.seasonNumber}`;
      groups.set(key, [...(groups.get(key) ?? []), e.id]);
    }
    let grabbed = 0;
    for (const [key, ids] of groups) {
      if (signal?.aborted) break;
      const seriesId = Number(key.split(':')[0]);
      this.markSearched('episode', ids);
      try {
        const summary = await this.searchFor({ seriesId, episodeIds: ids }, signal ? { signal } : {});
        grabbed += summary.grabbed.length;
      } catch (err) {
        this.log?.warn({ err, seriesId }, 'episode search failed');
      }
    }
    return { searched: due.length, grabbed };
  }

  private async searchMovies(movies: readonly Movie[], signal: AbortSignal | undefined, limit: number): Promise<{ searched: number; grabbed: number }> {
    const due = movies.filter((m) => this.shouldSearch('movie', m.id)).slice(0, limit);
    let grabbed = 0;
    for (const m of due) {
      if (signal?.aborted) break;
      this.markSearched('movie', [m.id]);
      try {
        grabbed += (await this.searchFor({ movieId: m.id }, signal ? { signal } : {})).grabbed.length;
      } catch (err) {
        this.log?.warn({ err, movieId: m.id }, 'movie search failed');
      }
    }
    return { searched: due.length, grabbed };
  }

  async missingEpisodeSearch(signal?: AbortSignal, limit = 200): Promise<string> {
    const now = this.now().toISOString();
    const missing = this.allPages((page) =>
      libraryService.listMissingEpisodes(this.db, { page, pageSize: 500, includeSpecials: false }, now),
    );
    const r = await this.searchEpisodeSet(missing, signal, limit);
    return `missing episodes: searched ${r.searched}, grabbed ${r.grabbed}`;
  }

  async missingMovieSearch(signal?: AbortSignal, limit = 100): Promise<string> {
    const now = this.now().toISOString();
    const missing = this.allPages((page) => libraryService.listMissingMovies(this.db, { page, pageSize: 500 }, now));
    const r = await this.searchMovies(missing, signal, limit);
    return `missing movies: searched ${r.searched}, grabbed ${r.grabbed}`;
  }

  /** The library's cutoff hook, evaluated with the item's current profile (§6.5). */
  isFileCutoffMet(): (file: MediaFile) => boolean {
    const profiles = new Map(this.profilesService.listQualityProfiles().map((p) => [p.id, p]));
    const formats = this.profilesService.listCustomFormats();
    const seriesProfiles = new Map(
      libraryService.listSeries(this.db, SeriesListQuery.parse({ includeStatistics: false })).map((s) => [s.id, s.qualityProfileId]),
    );
    const movieProfiles = new Map(libraryService.listMovies(this.db, MovieListQuery.parse({})).map((m) => [m.id, m.qualityProfileId]));
    return (file) => {
      const profileId = file.seriesId != null ? seriesProfiles.get(file.seriesId) : file.movieId != null ? movieProfiles.get(file.movieId) : undefined;
      const profile = profileId !== undefined ? profiles.get(profileId) : undefined;
      if (!profile) return true;
      const score = evaluateFormats(profile, formats, {
        title: file.sceneName ?? file.relativePath,
        quality: file.quality,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        languages: file.languages,
        releaseGroup: file.releaseGroup ?? null,
      }).score;
      return !cutoffNotMetForFile(profile, file.quality, score);
    };
  }

  async cutoffUnmetSearch(signal?: AbortSignal, limit = 100): Promise<string> {
    const isMet = this.isFileCutoffMet();
    const episodes = this.allPages((page) =>
      libraryService.listCutoffUnmetEpisodes(this.db, { page, pageSize: 500, includeSpecials: false }, isMet),
    );
    const movies = this.allPages((page) => libraryService.listCutoffUnmetMovies(this.db, { page, pageSize: 500 }, isMet));
    const e = await this.searchEpisodeSet(episodes, signal, limit);
    const m = await this.searchMovies(movies, signal, limit);
    return `cutoff unmet: searched ${e.searched} episodes / ${m.searched} movies, grabbed ${e.grabbed + m.grabbed}`;
  }
}

// ---- helpers ------------------------------------------------------------------------

function cutoffNotMetForFile(profile: QualityProfile, quality: QualityModel, score: number): boolean {
  return cutoffNotMet(profile, { quality, formatScore: score });
}

function hintFromCategories(categories: readonly number[]): 'series' | 'movie' | 'auto' {
  if (categories.length === 0) return 'auto';
  const tv = categories.every((c) => c >= 5000 && c < 6000);
  const movie = categories.every((c) => c >= 2000 && c < 3000);
  return tv ? 'series' : movie ? 'movie' : 'auto';
}

/** Keys a decision covers, for "one release per episode set" bookkeeping. */
function coverageKeys(d: ReleaseDecision): string[] {
  if (d.movieId !== undefined) return [`m${d.movieId}`];
  return (d.episodeIds ?? []).map((id) => `e${id}`);
}

function mediaRef(d: ReleaseDecision): { mediaType?: 'series' | 'movie'; mediaId?: number } {
  if (d.movieId !== undefined) return { mediaType: 'movie', mediaId: d.movieId };
  if (d.seriesId !== undefined) return { mediaType: 'series', mediaId: d.seriesId };
  return {};
}

function decisionToRelease(d: ReleaseDecision): ReleaseResource {
  return {
    guid: d.guid,
    title: d.title,
    size: d.size,
    publishDate: d.publishDate,
    downloadUrl: d.downloadUrl,
    categories: d.categories,
    indexerId: d.indexerId,
    indexerName: d.indexerName,
    indexerPriority: d.indexerPriority,
    protocol: d.protocol,
    age: d.age,
    ageHours: d.ageHours,
    ageMinutes: d.ageMinutes,
    rejections: [],
    approved: false,
    ...(d.magnetUrl ? { magnetUrl: d.magnetUrl } : {}),
    ...(d.infoHash ? { infoHash: d.infoHash } : {}),
    ...(d.infoUrl ? { infoUrl: d.infoUrl } : {}),
    ...(d.seeders !== undefined ? { seeders: d.seeders } : {}),
    ...(d.leechers !== undefined ? { leechers: d.leechers } : {}),
  };
}

/** Pending rows grouped by overlapping item, keeping only groups with at least one due row. */
function groupPending(rows: PendingRow[], due: Set<number>): PendingRow[][] {
  const groups: PendingRow[][] = [];
  const keysOf = (r: PendingRow) => (r.movieId !== null ? [`m${r.movieId}`] : (r.episodeIds ?? []).map((id) => `e${id}`));
  for (const row of rows) {
    const keys = keysOf(row);
    const group = groups.find((g) => g.some((r) => keysOf(r).some((k) => keys.includes(k))));
    if (group) group.push(row);
    else groups.push([row]);
  }
  return groups.filter((g) => g.some((r) => due.has(r.id)));
}
