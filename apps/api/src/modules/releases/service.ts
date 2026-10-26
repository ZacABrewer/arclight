import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { SearchRequest } from '@arclight/indexers';
import { parseRelease } from '@arclight/parser';
import {
  MovieListQuery,
  SeriesListQuery,
  type CustomFormat,
  type DecisionLogBatch,
  type DecisionLogPage,
  type DecisionLogQuery,
  type DecisionLogSource,
  type DelayProfile,
  type Episode,
  type Indexer,
  type ManualSearchRequest,
  type MediaFile,
  type MediaVersion,
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
} from '@arclight/shared';
import { selectDelayProfile } from '@arclight/profiles-engine';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { additionalLanguages } from '../../db/schema.js';
import {
  fileAudioLanguages,
  releaseAudioLanguages,
  requiredAudioFor,
  slotLanguageFit,
  type AudioRequirementRow,
} from '../additional-languages/audio.js';
import { createCutoffChecker, isVersioned, libraryService, pickVersion, sameTag, slotOf } from '../library/index.js';
import { ProfilesService } from '../profiles/index.js';
import { loadSceneRules } from '../scene-mapping/service.js';
import type { SceneRule } from '../scene-mapping/mapping.js';
import { DecisionLog, DecisionLogNotFound, toLogSource, type DecisionLogRow } from './decision-log.js';
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
  evaluate,
  evaluateFormats,
  prioritize,
  qualityModelOf,
  releaseIndexerFlags,
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
  /**
   * Resolve a release link through its indexer (login cookies, definition download rules,
   * proxies). Optional: without it the link is fetched directly. Errors carry `code`
   * `UNAVAILABLE` (gone) or `DOWNLOAD_FAILED`.
   */
  downloadRelease?(
    indexerId: number,
    url: string,
  ): Promise<{ kind: 'magnet'; magnetUrl: string } | { kind: 'file'; protocol: 'torrent' | 'usenet'; data: Uint8Array }>;
  /** Lets the search page (POST /search/grab) grab through the decision engine. Optional. */
  setSearchGrabber?(grabber: SearchResultGrabber | undefined): void;
}

/** See `ReleasesService.grabSearchResult`. */
export type SearchResultGrabber = (
  release: ReleaseResource,
  opts: { force: boolean; downloadClientId?: number },
) => Promise<
  | { kind: 'grabbed'; title: string; queueItemId: number; downloadId: string; downloadClientId: number | null; matched: boolean; rejections: string[] }
  | { kind: 'no-match'; rejections: string[] }
>;

export interface DownloadClientGrab {
  title: string;
  magnet?: string;
  torrentFile?: Uint8Array;
  /** Usenet releases: the raw .nzb document. */
  nzb?: Uint8Array;
  isRecent?: boolean;
  seedConfig?: { ratioLimit?: number; seedTimeLimitMinutes?: number };
  protocol?: 'usenet' | 'torrent';
  /** Release size (bytes) when known: the download-clients disk-space guard may hold the grab. */
  sizeBytes?: number;
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
  /** Decision-log batch the decision belongs to (attached to the grab's history record). */
  batchId?: string;
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
  private sceneRules?: SceneRule[];
  private audioRows?: AudioRequirementRow[];

  constructor(
    private readonly db: Db,
    profiles: ProfilesService,
    indexers: IndexerPort,
    downloads: DownloadPort,
    private readonly log?: Logger,
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

  private rules(): SceneRule[] {
    this.sceneRules ??= loadSceneRules(this.db, this.log);
    return this.sceneRules;
  }

  /** Saved "Add additional…" audio requirements. */
  audioRequirements(): readonly AudioRequirementRow[] {
    this.audioRows ??= this.db.select().from(additionalLanguages).where(eq(additionalLanguages.kind, 'audio')).all();
    return this.audioRows;
  }

  sceneMappings(seriesId: number): readonly SceneRule[] {
    return this.rules().filter((r) => r.seriesId === seriesId);
  }

  sceneTitleRules(): readonly SceneRule[] {
    return this.rules().filter((r) => r.kind === 'title');
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
  readonly decisionLog: DecisionLog;
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
    this.decisionLog = new DecisionLog(opts.db);
  }

  // ---- wiring -----------------------------------------------------------------------

  /** Subscribe to RSS sync results and answer library-id manual searches. */
  attach(): void {
    this.unsubscribeRss = this.indexers.onReleases(async (releases) => {
      await this.processReleases(releases, 'rss');
    });
    this.indexers.setManualSearchResolver((request) => this.resolveManualSearch(request));
    this.indexers.setSearchGrabber?.((release, opts) => this.grabSearchResult(release, opts));
  }

  detach(): void {
    this.unsubscribeRss?.();
    this.indexers.setManualSearchResolver(undefined);
    this.indexers.setSearchGrabber?.(undefined);
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
      /** Decision-log batch id; a new one by default. */
      batchId?: string;
    } = {},
  ): Promise<Evaluated[]> {
    const batch = opts.batch ?? this.newBatch();
    const batchId = opts.batchId ?? randomUUID();
    const settings = this.settings();
    const propers = this.propers();
    const out: Evaluated[] = [];
    for (const release of releases) {
      try {
        const evaluated = await this.decideOne(release, source, batch, settings, propers, opts.criteria, opts.override);
        if (evaluated) out.push({ ...evaluated, batchId });
      } catch (err) {
        this.log?.warn({ err, title: release.title }, 'release decision failed');
        out.push({
          batchId,
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
    return new Batch(this.db, this.profilesService, this.indexers, this.downloads, this.log);
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

    // Multi-version: evaluate against the version slot whose profile the release fits best (a
    // slot that asks for audio languages the release carries wins: "Add additional…" versions).
    const versions = match.mediaType === 'series' ? match.series.versions : match.movie.versions;
    const original = match.mediaType === 'series' ? match.series.originalLanguage : match.movie.originalLanguage;
    const releaseAudio = releaseAudioLanguages(release.title, toLanguageCodes(parsed.languages), original);
    const version = isVersioned(versions)
      ? pickVersion(
          versions,
          batch.profiles,
          qualityModelOf(parsed.quality),
          (p) =>
            evaluateFormats(p, batch.formats, { title: release.title, quality: qualityModelOf(parsed.quality), mediaType: match.mediaType, sizeBytes: release.size }).score,
          (v) => slotLanguageFit(v, releaseAudio),
        )
      : null;
    const profileId = version?.qualityProfileId ?? (match.mediaType === 'series' ? match.series.qualityProfileId : match.movie.qualityProfileId);
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
      indexerFlags: releaseIndexerFlags(release),
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

    const built = await this.buildContext(batch, candidate, profile, source, settings, propers, criteria, now);
    const narrowed = version ? narrowToVersion(built, versions, version.tag, batch.profiles) : built;
    const covered =
      match.mediaType === 'movie'
        ? { movieId: match.movie.id }
        : { seriesId: match.series.id, episodes: match.episodes.map((e) => ({ id: e.id, seasonNumber: e.seasonNumber })) };
    const requiredAudio = requiredAudioFor(batch.audioRequirements(), covered, version);
    const ctx: DecisionContext = requiredAudio ? { ...narrowed, requiredAudio } : narrowed;
    const ev = evaluate(ctx, candidate);
    const decision = buildDecision(source, candidate, ev);
    if (version) decision.versionTag = version.tag;
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
        preferIndexerFlags: settings.preferIndexerFlags,
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
      versionTag: f.versionTag ?? null,
      audioLanguages: fileAudioLanguages(f, { fallback: true }),
    });
    const files = batch
      .files(match)
      .filter((f) =>
        mediaType === 'movie' ? isVersioned(match.movie.versions) || f.id === match.movie.movieFileId || match.movie.movieFileId == null : true,
      )
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
      releaseFilter: this.deps.releaseFilter?.(c.release.indexerId, c.release) ?? null,
      mismatchAction: this.deps.profileMigration?.mismatchActionFor(profile.id) ?? 'none',
    };
  }

  // ---- acting on decisions (§12) ----------------------------------------------------

  /** Decide and act: grab the best approved release per episode set / movie, park delayed ones. */
  async processReleases(releases: ReleaseResource[], source: ReleaseSource, criteria?: SearchCriteria): Promise<ReleaseDecision[]> {
    this.cacheReleases(releases);
    const evaluated = await this.decide(releases, source, criteria ? { criteria } : {});
    const result = await this.processDecisions(evaluated);
    this.logDecisions(evaluated, toLogSource(source), result.grabbed, criteria);
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
    const tracked = await this.grabEvaluated(evaluated, request.downloadClientId);
    this.logDecisions([evaluated], 'interactive', [evaluated]);
    return tracked;
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
          ...(release.size > 0 ? { sizeBytes: release.size } : {}),
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
        ...(e.batchId ? { batchId: e.batchId } : {}),
      });
    } catch (err) {
      this.log?.warn({ err }, 'history hook failed after grab');
    }
    this.log?.info({ title: release.title, client: tracked.downloadClientName }, 'release grabbed');
    return tracked;
  }

  /**
   * Search page grab (POST /search/grab via the indexers module): decide on the result, grab it
   * mapped when it matches the library; otherwise only with `force`, untracked (no library
   * item, the client's default category), so it shows as unknown in the queue.
   */
  async grabSearchResult(
    release: ReleaseResource,
    opts: { force: boolean; downloadClientId?: number },
  ): ReturnType<SearchResultGrabber> {
    const [evaluated] = await this.decide([release], 'interactiveSearch');
    const rejections = evaluated?.decision.rejections.map((r) => r.message) ?? [];
    if (evaluated?.candidate) {
      const tracked = await this.grabEvaluated(evaluated, opts.downloadClientId);
      this.logDecisions([evaluated], 'interactive', [evaluated]);
      return { kind: 'grabbed', ...grabResponse(tracked), matched: true, rejections };
    }
    if (!opts.force) return { kind: 'no-match', rejections };
    const indexer = this.indexers.list().find((i) => i.id === release.indexerId);
    const payload = await this.downloadPayload(release);
    let tracked: TrackedView;
    try {
      tracked = await this.downloads.grab(
        opts.downloadClientId ?? indexer?.downloadClientId ?? null,
        { title: release.title, protocol: release.protocol, isRecent: release.age <= 14, ...payload, ...(release.size > 0 ? { sizeBytes: release.size } : {}) },
        {},
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'NO_CLIENT' || code === 'CLIENT_ERROR') {
        throw new ReleasesError('CLIENT_UNAVAILABLE', err instanceof Error ? err.message : String(err), { cause: err });
      }
      throw err;
    }
    this.log?.info({ title: release.title, client: tracked.downloadClientName }, 'release force-grabbed without a library match');
    return { kind: 'grabbed', ...grabResponse(tracked), matched: false, rejections };
  }

  /** Magnet passthrough, else fetch the .torrent / .nzb (redirects to magnets are followed). */
  private async downloadPayload(release: ReleaseResource): Promise<{ magnet: string } | { torrentFile: Uint8Array } | { nzb: Uint8Array }> {
    // Through the indexer when it can (definition logins/cookies, proxies, grab stats).
    // An unknown indexer (deleted since the search) falls through to the direct fetch below.
    const viaIndexer = release.downloadUrl || release.magnetUrl;
    if (this.indexers.downloadRelease && release.indexerId > 0 && viaIndexer) {
      try {
        const result = await this.indexers.downloadRelease(release.indexerId, viaIndexer);
        if (result.kind === 'magnet') {
          if (release.protocol === 'usenet') throw new ReleasesError('DOWNLOAD_FAILED', 'Indexer redirected a usenet release to a magnet link');
          return { magnet: result.magnetUrl };
        }
        return release.protocol === 'usenet' ? { nzb: result.data } : { torrentFile: result.data };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'NOT_FOUND') {
          if (release.protocol === 'torrent' && release.magnetUrl && viaIndexer !== release.magnetUrl) return { magnet: release.magnetUrl };
          if (err instanceof ReleasesError) throw err;
          throw new ReleasesError(code === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'DOWNLOAD_FAILED', err instanceof Error ? err.message : String(err), { cause: err });
        }
      }
    }
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
          if (location.startsWith('magnet:')) {
            if (release.protocol === 'usenet') throw new ReleasesError('DOWNLOAD_FAILED', 'Indexer redirected a usenet release to a magnet link');
            return { magnet: location };
          }
          url = new URL(location, url).toString();
          continue;
        }
        if (res.status === 404 || res.status === 410) {
          throw new ReleasesError('UNAVAILABLE', `Release is no longer available at the indexer (HTTP ${res.status})`);
        }
        if (!res.ok) throw new ReleasesError('DOWNLOAD_FAILED', `Downloading the release failed (HTTP ${res.status})`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length === 0) throw new ReleasesError('DOWNLOAD_FAILED', 'Indexer returned an empty file');
        return release.protocol === 'usenet' ? { nzb: bytes } : { torrentFile: bytes };
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
      const batchId = randomUUID();
      const evaluated: Array<Evaluated & { row: PendingRow }> = [];
      const chosen: Evaluated[] = [];
      for (const row of rows) {
        const [e] = await this.decide([row.release], 'rss', {
          batch,
          batchId,
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
            chosen.push(e);
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
      this.logDecisions(evaluated, 'pending', chosen);
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
    this.logDecisions(evaluated, 'search', result.grabbed, criteria);
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
    this.logDecisions(evaluated, 'interactive', [], criteria);
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
    this.logDecisions(evaluated, 'push', result.grabbed);
    return {
      decision: evaluated[0]?.decision ?? null,
      grabbed: result.grabbed.length > 0,
      pending: result.pending > 0,
    };
  }

  // ---- decision log -----------------------------------------------------------------

  /**
   * Write one evaluation batch to the decision log. Unmatched releases of a search are logged
   * against the searched item; elsewhere they have no item and are skipped. Never throws: the
   * log must not break the pipeline.
   */
  private logDecisions(evaluated: readonly Evaluated[], source: DecisionLogSource, chosen: readonly Evaluated[], criteria?: SearchCriteria): void {
    if (evaluated.length === 0) return;
    try {
      const chosenSet = new Set(chosen);
      const ranks = new Map<Evaluated, number>();
      const tier = (e: Evaluated) => (e.decision.approved ? 0 : e.decision.temporarilyRejected ? 1 : 2);
      const ordered = prioritize(evaluated, this.propers()).filter((e) => e.rank);
      const byItem = new Map<string, Evaluated[]>();
      for (const e of ordered) {
        const key = e.decision.movieId !== undefined ? `m${e.decision.movieId}` : `s${e.decision.seriesId ?? 0}`;
        byItem.set(key, [...(byItem.get(key) ?? []), e]);
      }
      for (const group of byItem.values()) {
        const stable = group.map((e, i) => ({ e, i })).sort((a, b) => tier(a.e) - tier(b.e) || a.i - b.i);
        stable.forEach(({ e }, i) => ranks.set(e, i + 1));
      }
      const rows: DecisionLogRow[] = evaluated.map((e) => {
        const d = e.decision;
        const fallback = !e.candidate && d.seriesId === undefined && d.movieId === undefined ? criteria : undefined;
        return {
          mediaType: d.mediaType ?? fallback?.mediaType ?? null,
          seriesId: d.seriesId ?? (fallback?.mediaType === 'series' ? (fallback.seriesId ?? null) : null),
          episodeIds: d.episodeIds ?? (fallback?.episodeIds ? [...fallback.episodeIds] : []),
          movieId: d.movieId ?? (fallback?.mediaType === 'movie' ? (fallback.movieId ?? null) : null),
          guid: d.guid,
          indexerId: d.indexerId,
          title: d.title,
          quality: d.quality,
          formats: d.customFormats,
          score: d.customFormatScore,
          approved: d.approved,
          rejections: d.rejections,
          chosen: chosenSet.has(e),
          rank: ranks.get(e) ?? null,
        };
      });
      const batchId = evaluated.find((e) => e.batchId)?.batchId ?? randomUUID();
      this.decisionLog.record({ batchId, time: this.now().toISOString(), source }, rows);
    } catch (err) {
      this.log?.warn({ err }, 'writing the release decision log failed');
    }
  }

  /** GET /release/decisions. */
  listDecisionBatches(query: DecisionLogQuery): DecisionLogPage {
    return this.decisionLog.list(query, (episodeId) => this.seriesIdForEpisode(episodeId));
  }

  /** GET /release/decisions/:batchId. */
  getDecisionBatch(batchId: string): DecisionLogBatch {
    try {
      return this.decisionLog.getBatch(batchId);
    } catch (err) {
      if (err instanceof DecisionLogNotFound) throw new ReleasesError('NOT_FOUND', err.message);
      throw err;
    }
  }

  /** DecisionLogCleanup: drop log rows older than `days`. */
  cleanupDecisionLog(days: number): string {
    const removed = this.decisionLog.cleanup(days, this.now());
    return `decision log: removed ${removed} row${removed === 1 ? '' : 's'} older than ${days} days`;
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

  /**
   * The library's cutoff hook, evaluated with the item's current profile (§6.5). The same
   * checker backs GET /wanted/cutoff/*, so the job and the Wanted page agree.
   */
  isFileCutoffMet(): (file: MediaFile) => boolean {
    return createCutoffChecker(this.db, this.profilesService);
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

function hintFromCategories(categories: readonly number[]): 'series' | 'movie' | 'auto' {
  if (categories.length === 0) return 'auto';
  const tv = categories.every((c) => c >= 5000 && c < 6000);
  const movie = categories.every((c) => c >= 2000 && c < 3000);
  return tv ? 'series' : movie ? 'movie' : 'auto';
}

/** Keys a decision covers, for "one release per episode set" bookkeeping. */
function coverageKeys(d: ReleaseDecision): string[] {
  const v = d.versionTag ? `:${d.versionTag}` : '';
  if (d.movieId !== undefined) return [`m${d.movieId}${v}`];
  return (d.episodeIds ?? []).map((id) => `e${id}${v}`);
}

/**
 * Multi-version library: a release competes only with its own version slot. Files, queued
 * downloads and history of other slots are dropped from the context (queue/history entries
 * are assigned to the slot their quality fits best, the same rule the release went through).
 */
function narrowToVersion(
  ctx: DecisionContext,
  versions: readonly MediaVersion[] | null | undefined,
  tag: string,
  profiles: ReadonlyMap<number, QualityProfile>,
): DecisionContext {
  const fits = (quality: QualityModel): boolean => sameTag(pickVersion(versions, profiles, quality)?.tag ?? null, tag);
  return {
    ...ctx,
    existingFiles: ctx.existingFiles.filter((f) => sameTag(slotOf(f.versionTag ?? null, versions), tag)),
    queue: ctx.queue.filter((q) => fits(q.quality)),
    latestHistory: ctx.latestHistory.filter((h) => fits(h.event.quality)),
    importedGrabs: ctx.importedGrabs.filter((g) => fits(g.grab.quality)),
  };
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

function grabResponse(tracked: TrackedView): { title: string; queueItemId: number; downloadId: string; downloadClientId: number | null } {
  return {
    title: tracked.title,
    queueItemId: tracked.id,
    downloadId: tracked.downloadId,
    downloadClientId: tracked.downloadClientId,
  };
}
