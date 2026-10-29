import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import { domainFromCategories, type SearchRequest } from '@arclight/indexers';
import {
  audiobookAudioEvaluation,
  audiobookReleaseKind,
  musicAudioEvaluation,
  musicReleaseKind,
  parseAudiobookRelease,
  parseMusicRelease,
  parseRelease,
  type ParsedAudiobookRelease,
  type ParsedMusicRelease,
  type ParsedRelease,
} from '@arclight/parser';
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
  type ItemSearchStatus,
  type LastSearch,
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
  type SearchItemType,
  type SearchRunSource,
  type SearchStatusQuery,
  type Series,
  type TrackedDownloadState,
} from '@arclight/shared';
import { customFormatFitsDomain, isQualityCutoffMet, qualityIndex, selectDelayProfile } from '@arclight/profiles-engine';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import {
  additionalLanguages,
  albums as albumTable,
  artists as artistTable,
  episodes as episodeTable,
  movies as movieTable,
  series as seriesTable,
} from '../../db/schema.js';
import {
  fileAudioLanguages,
  releaseAudioLanguages,
  requiredAudioFor,
  slotLanguageFit,
  type AudioRequirementRow,
} from '../additional-languages/audio.js';
import * as musicService from '../music/service.js';
import { albumStatistics } from '../music/statistics.js';
import { createCutoffChecker, isVersioned, libraryService, pickVersion, sameTag, slotOf } from '../library/index.js';
import { ProfilesService } from '../profiles/index.js';
import { loadSceneRules } from '../scene-mapping/service.js';
import type { SceneRule } from '../scene-mapping/mapping.js';
import { audiobooksEnabled, BookLibrary, MusicLibrary } from './audio-library.js';
import {
  hasAudioMarker,
  hasAudiobookMarker,
  matchAlbum,
  matchBook,
  type AlbumMatch,
  type AudioMatchResult,
  type BookMatch,
  type BookMatchResult,
} from './audio-matcher.js';
import { albumSearchPlan, artistSearchPlan, authorSearchPlan, bookSearchPlan, type PlanAlbum, type PlanBook, type SearchStep } from './audio-search.js';
import { audiobookSpecifications, musicSpecifications } from './audio-specs.js';
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
  albumMinutes,
  albumsGainedBy,
  audiobookInfoOf,
  bookMinutes,
  booksGainedBy,
  buildDecision,
  evaluate,
  evaluateFormats,
  itemTags,
  musicInfoOf,
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
import {
  CUTOFF_UNMET_AUDIO_SEARCH_JOB,
  CUTOFF_UNMET_SEARCH_JOB,
  MISSING_ALBUM_SEARCH_JOB,
  MISSING_BOOK_SEARCH_JOB,
  MISSING_EPISODE_SEARCH_JOB,
  MISSING_MOVIE_SEARCH_JOB,
  SEARCH_JOB_CRONS,
} from './jobs.js';
import { matchRelease, type LibrarySnapshot, type MovieMatch, type SeriesMatch } from './matcher.js';
import { pendingReleases, releaseSearchResults, releaseSearchState } from './schema.js';
import { isSearchDue, itemOutcomes, planSearchRuns, searchDueAt, upcomingRuns, type ItemOutcome } from './search-status.js';

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
  mediaType?: 'series' | 'movie' | 'music' | 'audiobook';
  seriesId?: number;
  episodeIds?: number[];
  movieId?: number;
  /** Music grabs: the artist and the albums the release fills or upgrades. */
  artistId?: number;
  albumIds?: number[];
  /** Audiobook grabs: the author and the books the release fills or upgrades. */
  authorId?: number;
  bookIds?: number[];
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
  artistId?: number | undefined;
  albumIds?: number[] | undefined;
  authorId?: number | undefined;
  bookIds?: number[] | undefined;
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
  | { movieId: number }
  /** Music: the artist's wanted albums (or only `albumIds`); with `albumIds` alone, their artist. */
  | { artistId: number; albumIds?: number[] }
  | { albumIds: number[] }
  /** Audiobooks: the author's wanted books (or only `bookIds`); with `bookIds` alone, their author. */
  | { authorId: number; bookIds?: number[] }
  | { bookIds: number[] };

/** Pins the library mapping of a release (interactive grab, pending re-check). */
export interface MatchOverride {
  seriesId?: number | undefined;
  episodeIds?: number[] | undefined;
  movieId?: number | undefined;
  artistId?: number | undefined;
  albumIds?: number[] | undefined;
  authorId?: number | undefined;
  bookIds?: number[] | undefined;
}

type VideoCandidate = Candidate & { match: SeriesMatch | MovieMatch };
type MusicCandidate = Candidate & { match: AlbumMatch };
type BookCandidate = Candidate & { match: BookMatch };
type MusicMatched = { parsed: ParsedMusicRelease; match: AudioMatchResult };
type BookMatched = { parsed: ParsedAudiobookRelease; match: BookMatchResult };
type BookTarget = { authorId: number; bookIds?: number[] } | { bookIds: number[] };

export interface SearchSummary {
  releases: number;
  approved: number;
  grabbed: string[];
  pending: number;
}

interface ProcessResult {
  grabbed: Evaluated[];
  pending: number;
  /** The decisions parked as pending (delay profile, client unavailable). */
  pendingDecisions: Evaluated[];
}

/** Items the scheduled jobs search per run (their default `limit`). */
export const MISSING_EPISODE_SEARCH_LIMIT = 200;
export const MISSING_MOVIE_SEARCH_LIMIT = 100;
export const CUTOFF_UNMET_SEARCH_LIMIT = 100;
export const MISSING_ALBUM_SEARCH_LIMIT = 50;
export const CUTOFF_UNMET_AUDIO_SEARCH_LIMIT = 50;
export const MISSING_BOOK_SEARCH_LIMIT = 50;

/** The live schedule of a job (Scheduler.jobSchedule); null when it is not registered. */
export type JobScheduleLookup = (name: string) => { cron: string | null; enabled: boolean } | null;

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
  private musicLimits?: Map<number, QualityDefinitionItem>;
  private musicFormats?: CustomFormat[];
  private audiobookLimits?: Map<number, QualityDefinitionItem>;
  private audiobookFormats?: CustomFormat[];
  /** The music library (artists, albums, track files), read on first use. */
  readonly music: MusicLibrary;
  /** The audiobook library (authors, books, series, files), read on first use. */
  readonly books: BookLibrary;

  constructor(
    private readonly db: Db,
    private readonly profilesService: ProfilesService,
    indexers: IndexerPort,
    downloads: DownloadPort,
    private readonly log?: Logger,
  ) {
    this.profiles = new Map(profilesService.listQualityProfiles().map((p) => [p.id, p]));
    this.formats = profilesService.listCustomFormats();
    this.delayProfiles = profilesService.listDelayProfiles();
    this.releaseProfiles = profilesService.listReleaseProfiles();
    this.limits = new Map(profilesService.listQualityDefinitions().map((d) => [d.qualityId, d]));
    this.indexers = new Map(indexers.list().map((i) => [i.id, i]));
    this.queue = downloads.listTracked(ACTIVE_QUEUE_STATES).map((q) => {
      // Audio downloads are named like albums / books: their quality comes from the audio parsers.
      const quality = q.albumIds?.length
        ? parseMusicRelease(q.title).audio
        : q.bookIds?.length
          ? parseAudiobookRelease(q.title).audio
          : parseRelease(q.title).quality;
      return { ...q, parsedQuality: qualityModelOf(quality) };
    });
    this.pending = db.select().from(pendingReleases).all();
    this.music = new MusicLibrary(db);
    this.books = new BookLibrary(db);
  }

  /** Audiobook quality definitions (MB per minute), loaded for the first book decision of the batch. */
  bookLimits(): Map<number, QualityDefinitionItem> {
    this.audiobookLimits ??= new Map(this.profilesService.listQualityDefinitions('audiobook').map((d) => [d.qualityId, d]));
    return this.audiobookLimits;
  }

  /** Custom formats that can apply to audiobook releases. */
  bookFormats(): CustomFormat[] {
    this.audiobookFormats ??= this.formats.filter((f) => customFormatFitsDomain(f, 'audiobook'));
    return this.audiobookFormats;
  }

  /** Music quality definitions (MB per minute), loaded for the first audio decision of the batch. */
  audioLimits(): Map<number, QualityDefinitionItem> {
    this.musicLimits ??= new Map(this.profilesService.listQualityDefinitions('music').map((d) => [d.qualityId, d]));
    return this.musicLimits;
  }

  /** Custom formats that can apply to music releases. */
  audioFormats(): CustomFormat[] {
    this.musicFormats ??= this.formats.filter((f) => customFormatFitsDomain(f, 'music'));
    return this.musicFormats;
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
  private jobSchedules: JobScheduleLookup | undefined;

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

  /** Where search status estimates read the jobs' live schedules; without it the default crons apply. */
  setJobSchedules(lookup: JobScheduleLookup | undefined): void {
    this.jobSchedules = lookup;
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
      override?: MatchOverride;
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
    override: MatchOverride | undefined,
  ): Promise<Evaluated | null> {
    // The indexer category picks the parser (design 8.3): music categories go to the audio path,
    // as do searches for albums and grabs pinned to an artist.
    const domain = domainFromCategories(release.categories);
    const bookOverride = override?.authorId !== undefined || (override?.bookIds?.length ?? 0) > 0;
    const audioOverride = override?.artistId !== undefined || (override?.albumIds?.length ?? 0) > 0;
    const videoOverride = override !== undefined && (override.movieId !== undefined || override.seriesId !== undefined || (override.episodeIds?.length ?? 0) > 0);
    if (bookOverride) return this.decideAudio(release, source, batch, settings, propers, criteria, override, null, 'audiobook');
    if (audioOverride) return this.decideAudio(release, source, batch, settings, propers, criteria, override, null, 'music');
    if (!videoOverride) {
      // A search's item decides the parser; otherwise the categories do (3030 audiobook, other 3xxx music).
      const wanted =
        criteria?.mediaType === 'audiobook' || criteria?.mediaType === 'music'
          ? criteria.mediaType
          : domain === 'audiobook' || domain === 'music'
            ? domain
            : null;
      if (wanted) return this.decideAudio(release, source, batch, settings, propers, criteria, undefined, null, wanted);
      // Uncategorised releases that read like an audiobook (m4b, "Unabridged", "narrated by", an
      // ASIN) go to the book matcher first; only a library hit counts.
      if (domain === 'auto' && !criteria && hasAudiobookMarker(release.title) && batch.books.enabled()) {
        const book = this.bookMatch(release, batch, criteria, undefined);
        if (book.match.status === 'mapped') return this.decideAudio(release, source, batch, settings, propers, criteria, undefined, book, 'audiobook');
      }
    }

    const ids = { tvdbId: release.tvdbId, tmdbId: release.tmdbId, imdbId: release.imdbId };
    const hint = domain === 'series' || domain === 'movie' ? domain : 'auto';
    const outcome = matchRelease(release.title, ids, batch, { hint, ...(criteria ? { criteria } : {}) });
    const parsed = outcome.parsed;
    let match = outcome.match;

    if (videoOverride && override) {
      const pinned = this.overrideMatch(batch, override, parsed.series?.fullSeason ?? false);
      if (!pinned) throw new ReleasesError('VALIDATION', 'override does not refer to a library item');
      match = pinned;
    }

    if (match.status !== 'mapped') {
      // Uncategorised releases that name an audio codec may be albums: only a library hit counts.
      if (domain === 'auto' && !videoOverride && hasAudioMarker(release.title) && batch.music.enabled()) {
        const audio = this.audioMatch(release, batch, criteria, undefined);
        if (audio.match.status === 'mapped') {
          return this.decideAudio(release, source, batch, settings, propers, criteria, undefined, audio, 'music');
        }
      }
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
    const candidate: VideoCandidate = {
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
    override: MatchOverride,
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

  // ---- music decisions ----------------------------------------------------------------

  /** Parse a music release and map it to the library (or to the pinned artist / albums). */
  private audioMatch(
    release: ReleaseResource,
    batch: Batch,
    criteria: SearchCriteria | undefined,
    override: MatchOverride | undefined,
  ): { parsed: ParsedMusicRelease; match: AudioMatchResult } {
    const parsed = parseMusicRelease(release.title);
    const lib = batch.music;
    const now = this.now();
    if (!override) return { parsed, match: matchAlbum(parsed.music, lib, { ...(criteria ? { criteria } : {}), now }) };

    let artistId = override.artistId;
    if (artistId === undefined && override.albumIds?.length) artistId = lib.album(override.albumIds[0]!)?.artistId;
    const artist = artistId !== undefined ? lib.artist(artistId) : undefined;
    if (!artist) throw new ReleasesError('VALIDATION', 'override does not refer to an artist in the library');
    const own = lib.albums(artist.id);
    let albums = override.albumIds?.length ? own.filter((a) => override.albumIds!.includes(a.id)) : [];
    if (override.albumIds?.length && albums.length === 0) throw new ReleasesError('VALIDATION', 'override albums do not belong to the artist');
    if (albums.length === 0) {
      // Artist pinned, albums not: let the matcher find them under that artist.
      const found = matchAlbum(parsed.music, { artists: () => [artist], albums: (id) => lib.albums(id), albumTypeProfile: (id) => lib.albumTypeProfile(id) }, {
        criteria: { mediaType: 'music', artistId: artist.id },
        now,
      });
      if (found.status !== 'mapped') {
        throw new ReleasesError('VALIDATION', `Cannot map release to an album of ${artist.name} (${found.message}); pass albumIds`);
      }
      albums = found.albums;
    }
    return {
      parsed,
      match: { status: 'mapped', mediaType: 'music', artist, albums: [...albums], pack: parsed.music?.packType ?? null, matchType: 'override' },
    };
  }

  /**
   * Decide on an audio release (design 8.4): the shared specs plus the album or book specs.
   * `domain` (from the categories or the search's item) picks the music or audiobook path.
   */
  private async decideAudio(
    release: ReleaseResource,
    source: ReleaseSource,
    batch: Batch,
    settings: ReleaseSettings,
    propers: DownloadPropersAndRepacks,
    criteria: SearchCriteria | undefined,
    override: MatchOverride | undefined,
    matched: MusicMatched | BookMatched | null,
    domain: 'music' | 'audiobook',
  ): Promise<Evaluated | null> {
    if (domain === 'audiobook') {
      const book = matched && matched.match.mediaType === 'audiobook' ? (matched as BookMatched) : null;
      return this.decideBook(release, source, batch, settings, propers, criteria, override, book);
    }
    return this.decideMusic(release, source, batch, settings, propers, criteria, override, matched && matched.match.mediaType === 'music' ? (matched as MusicMatched) : null);
  }

  /** Decide on a music release: the shared specs plus the album specs. */
  private async decideMusic(
    release: ReleaseResource,
    source: ReleaseSource,
    batch: Batch,
    settings: ReleaseSettings,
    propers: DownloadPropersAndRepacks,
    criteria: SearchCriteria | undefined,
    override: MatchOverride | undefined,
    matched: MusicMatched | null,
  ): Promise<Evaluated | null> {
    if (!batch.music.enabled() && !override) {
      if (!criteria && (source === 'rss' || source === 'releasePush')) return null;
      return { decision: audioUnmatchedDecision(source, release, null, { reason: 'musicDisabled', message: 'Music is not enabled', type: 'permanent' }) };
    }
    const { parsed, match } = matched ?? this.audioMatch(release, batch, criteria, override);
    const info = parsed.music;
    if (match.status !== 'mapped') {
      if (match.reason === 'unableToParse' && !criteria && (source === 'rss' || source === 'releasePush')) return null;
      return {
        decision: audioUnmatchedDecision(source, release, parsed, { reason: match.reason, message: match.message, type: 'permanent' }, match.artist),
      };
    }
    const artist = match.artist;
    const profile = batch.profiles.get(artist.qualityProfileId);
    if (!profile) {
      return {
        decision: audioUnmatchedDecision(source, release, parsed, {
          reason: 'decisionError',
          message: `Quality profile ${artist.qualityProfileId} does not exist`,
          type: 'permanent',
        }),
      };
    }

    const quality: QualityModel = qualityModelOf(parsed.audio);
    const releaseGroup = parsed.releaseGroup ?? undefined;
    const formats = evaluateFormats(profile, batch.audioFormats(), {
      title: release.title,
      quality,
      mediaType: 'music',
      sizeBytes: release.size,
      releaseGroup: releaseGroup ?? null,
      ...(info?.year ? { year: info.year } : {}),
      releaseKind: info ? musicReleaseKind(info) : releaseKindOf(match),
      indexerFlags: releaseIndexerFlags(release),
      ...(info ? { audio: musicAudioEvaluation(info) } : {}),
    });
    const now = this.now();
    const ageMinutes = Math.max(0, (now.getTime() - Date.parse(release.publishDate)) / MINUTE) || 0;
    const candidate: MusicCandidate = {
      release,
      parsed: emptyVideoParse(parsed),
      match,
      ...(info ? { music: info } : {}),
      quality,
      languages: [],
      customFormats: formats.formats,
      formatScore: formats.score,
      releaseGroup,
      ageMinutes,
    };
    const ctx = await this.buildAudioContext(batch, candidate, profile, source, settings, propers, criteria, now);
    const ev = evaluate(ctx, candidate, musicSpecifications);
    // A pack is only worth the albums it fills or upgrades: track and record just those.
    let tracked: MusicCandidate = candidate;
    if (match.pack) {
      const gained = new Set(albumsGainedBy(ctx, candidate));
      const albums = match.albums.filter((a) => gained.has(a.id));
      if (albums.length > 0) tracked = { ...candidate, match: { ...match, albums } };
    }
    const decision = buildDecision(source, tracked, ev);
    const limits = batch.audioLimits().get(quality.quality.id);
    return {
      decision,
      candidate: tracked,
      rank: {
        profile,
        preferredProtocol: ctx.delayProfile?.preferredProtocol,
        runtimeMinutes: albumMinutes(match),
        preferredSizeMbPerMinute: limits?.preferredSize ?? null,
        isAnime: false,
        firstEpisodeNumber: 0,
        preferIndexerFlags: settings.preferIndexerFlags,
      },
    };
  }

  private async buildAudioContext(
    batch: Batch,
    c: MusicCandidate,
    profile: QualityProfile,
    source: ReleaseSource,
    settings: ReleaseSettings,
    propers: DownloadPropersAndRepacks,
    criteria: SearchCriteria | undefined,
    now: Date,
  ): Promise<DecisionContext> {
    const { artist, albums } = c.match;
    const albumIds = albums.map((a) => a.id);
    const indexer = batch.indexers.get(c.release.indexerId);
    const scoreOf = (title: string, quality: QualityModel, sizeBytes?: number, releaseGroup?: string | null) =>
      evaluateFormats(profile, batch.audioFormats(), {
        title,
        quality,
        mediaType: 'music',
        ...(sizeBytes ? { sizeBytes } : {}),
        releaseGroup: releaseGroup ?? null,
      }).score;

    // One "file" per album: the album is as good as its worst track.
    const files: ExistingFile[] = [];
    const trackFiles = batch.music.files(artist.id);
    for (const album of albums) {
      const own = trackFiles.filter((f) => f.albumId === album.id);
      if (own.length === 0) continue;
      const lowest = own.reduce((worst, f) => (qualityIndex(profile, f.quality) < qualityIndex(profile, worst.quality) ? f : worst));
      files.push({
        id: lowest.id,
        quality: lowest.quality,
        formatScore: scoreOf(lowest.sceneName ?? lowest.relativePath, lowest.quality, lowest.sizeBytes, lowest.releaseGroup),
        releaseGroup: lowest.releaseGroup,
        dateAdded: own.reduce((latest, f) => (f.dateAdded > latest ? f.dateAdded : latest), lowest.dateAdded),
        episodeIds: [],
        albumIds: [album.id],
        sizeBytes: own.reduce((sum, f) => sum + f.sizeBytes, 0),
      });
    }

    const overlaps = (ids: readonly number[] | null | undefined) => (ids ?? []).some((id) => albumIds.includes(id));
    const queue: QueuedItem[] = batch.queue
      .filter((q) => overlaps(q.albumIds))
      .map((q) => ({
        title: q.title,
        quality: q.parsedQuality,
        formatScore: scoreOf(q.title, q.parsedQuality, q.sizeBytes),
        state: q.trackedState,
        downloadId: q.downloadId,
        albumIds: q.albumIds ?? [],
      }));
    const pending: PendingItem[] = batch.pending
      .filter((p) => overlaps(p.albumIds))
      .map((p) => ({ id: p.id, guid: p.guid, indexerId: p.indexerId, addedAt: p.addedAt, albumIds: p.albumIds ?? [] }));

    const history = this.deps.history ?? noopHistory;
    const latestHistory: HistoryItem[] = [];
    const importedGrabs: Array<{ grab: HistoryEventSummary; imported: HistoryEventSummary }> = [];
    if (history.latestFor) {
      for (const album of albums) {
        const item: ItemRef = { albumId: album.id, artistId: artist.id };
        const event = await history.latestFor(item);
        if (event) {
          latestHistory.push({ event, formatScore: scoreOf(event.sourceTitle, event.quality, event.sizeBytes) });
        }
        if (album.trackFileCount > 0 && history.findByDownloadId) {
          const grab = await history.latestFor(item, 'grabbed');
          if (grab?.downloadId) {
            const imported = await history.findByDownloadId(grab.downloadId, 'downloadFolderImported');
            if (imported && imported.quality.quality.id !== grab.quality.quality.id) importedGrabs.push({ grab, imported });
          }
        }
      }
    }

    const blocklisted = await (this.deps.blocklist ?? noopBlocklist).isBlocklisted({
      mediaType: 'music',
      artistId: artist.id,
      albumIds,
      title: c.release.title,
      protocol: c.release.protocol,
      indexerId: c.release.indexerId,
      ...(c.release.infoHash ? { infoHash: c.release.infoHash } : {}),
      publishDate: c.release.publishDate,
    });

    let freeSpaceBytes: number | null = null;
    if (this.deps.freeSpace) {
      try {
        freeSpaceBytes = await this.deps.freeSpace(artist.path);
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
      delayProfile: selectDelayProfile(batch.delayProfiles, artist.tags),
      releaseProfiles: batch.releaseProfiles,
      qualityLimits: (id) => batch.audioLimits().get(id) ?? batch.limits.get(id),
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

  // ---- audiobook decisions -----------------------------------------------------------

  /** Parse an audiobook release and map it to the library (or to the pinned author / books). */
  private bookMatch(release: ReleaseResource, batch: Batch, criteria: SearchCriteria | undefined, override: MatchOverride | undefined): BookMatched {
    const parsed = parseAudiobookRelease(release.title);
    const lib = batch.books;
    const now = this.now();
    if (!override) return { parsed, match: matchBook(parsed.audiobook, lib, { ...(criteria ? { criteria } : {}), now }) };

    let authorId = override.authorId;
    if (authorId === undefined && override.bookIds?.length) authorId = lib.book(override.bookIds[0]!)?.authorId;
    const author = authorId !== undefined ? lib.author(authorId) : undefined;
    if (!author) throw new ReleasesError('VALIDATION', 'override does not refer to an author in the library');
    const own = lib.books(author.id);
    let books = override.bookIds?.length ? own.filter((b) => override.bookIds!.includes(b.id)) : [];
    if (override.bookIds?.length && books.length === 0) throw new ReleasesError('VALIDATION', 'override books do not belong to the author');
    let owner = author;
    if (books.length === 0) {
      // Author pinned, books not: let the matcher find them under that author.
      const found = matchBook(parsed.audiobook, { authors: () => [author], books: (id) => lib.books(id) }, { criteria: { mediaType: 'audiobook', authorId: author.id }, now });
      if (found.status !== 'mapped') {
        throw new ReleasesError('VALIDATION', `Cannot map release to a book of ${author.name} (${found.message}); pass bookIds`);
      }
      books = found.books;
    }
    // Co-authored books are filed (and profiled) under the author who owns them.
    owner = lib.author(books[0]!.authorId) ?? author;
    books = books.filter((b) => b.authorId === owner.id);
    return {
      parsed,
      match: {
        status: 'mapped',
        mediaType: 'audiobook',
        author: owner,
        books: [...books],
        isPack: parsed.audiobook?.isPack ?? books.length > 1,
        matchType: 'override',
      },
    };
  }

  /** Decide on an audiobook release: the shared specs plus the book specs. */
  private async decideBook(
    release: ReleaseResource,
    source: ReleaseSource,
    batch: Batch,
    settings: ReleaseSettings,
    propers: DownloadPropersAndRepacks,
    criteria: SearchCriteria | undefined,
    override: MatchOverride | undefined,
    matched: BookMatched | null,
  ): Promise<Evaluated | null> {
    if (!batch.books.enabled() && !override) {
      if (!criteria && (source === 'rss' || source === 'releasePush')) return null;
      return { decision: bookUnmatchedDecision(source, release, null, { reason: 'audiobooksDisabled', message: 'Audiobooks are not enabled', type: 'permanent' }) };
    }
    const { parsed, match } = matched ?? this.bookMatch(release, batch, criteria, override);
    const info = parsed.audiobook;
    if (match.status !== 'mapped') {
      if (match.reason === 'unableToParse' && !criteria && (source === 'rss' || source === 'releasePush')) return null;
      return { decision: bookUnmatchedDecision(source, release, parsed, { reason: match.reason, message: match.message, type: 'permanent' }, match.author) };
    }
    const author = match.author;
    const profile = batch.profiles.get(author.qualityProfileId);
    if (!profile) {
      return {
        decision: bookUnmatchedDecision(source, release, parsed, {
          reason: 'decisionError',
          message: `Quality profile ${author.qualityProfileId} does not exist`,
          type: 'permanent',
        }),
      };
    }

    const quality: QualityModel = qualityModelOf(parsed.audio);
    const releaseGroup = parsed.releaseGroup ?? undefined;
    const languages = info?.language ? [info.language] : [];
    const formats = evaluateFormats(profile, batch.bookFormats(), {
      title: release.title,
      quality,
      mediaType: 'audiobook',
      sizeBytes: release.size,
      languages,
      releaseGroup: releaseGroup ?? null,
      ...(info?.year ? { year: info.year } : {}),
      releaseKind: info ? audiobookReleaseKind(info) : releaseKindOf(match),
      indexerFlags: releaseIndexerFlags(release),
      ...(info ? { audio: audiobookAudioEvaluation(info) } : {}),
    });
    const now = this.now();
    const ageMinutes = Math.max(0, (now.getTime() - Date.parse(release.publishDate)) / MINUTE) || 0;
    const candidate: BookCandidate = {
      release,
      parsed: emptyVideoParse(parsed),
      match,
      ...(info ? { audiobook: info } : {}),
      quality,
      languages,
      customFormats: formats.formats,
      formatScore: formats.score,
      releaseGroup,
      ageMinutes,
    };
    const ctx = await this.buildBookContext(batch, candidate, profile, source, settings, propers, criteria, now);
    const ev = evaluate(ctx, candidate, audiobookSpecifications);
    // A pack is only worth the books it fills or upgrades: track and record just those.
    let tracked: BookCandidate = candidate;
    if (match.isPack) {
      const gained = new Set(booksGainedBy(ctx, candidate));
      const books = match.books.filter((b) => gained.has(b.id));
      if (books.length > 0) tracked = { ...candidate, match: { ...match, books } };
    }
    const decision = buildDecision(source, tracked, ev);
    const limits = batch.bookLimits().get(quality.quality.id);
    return {
      decision,
      candidate: tracked,
      rank: {
        profile,
        preferredProtocol: ctx.delayProfile?.preferredProtocol,
        runtimeMinutes: bookMinutes(match),
        preferredSizeMbPerMinute: limits?.preferredSize ?? null,
        isAnime: false,
        firstEpisodeNumber: 0,
        preferIndexerFlags: settings.preferIndexerFlags,
      },
    };
  }

  private async buildBookContext(
    batch: Batch,
    c: BookCandidate,
    profile: QualityProfile,
    source: ReleaseSource,
    settings: ReleaseSettings,
    propers: DownloadPropersAndRepacks,
    criteria: SearchCriteria | undefined,
    now: Date,
  ): Promise<DecisionContext> {
    const { author, books } = c.match;
    const bookIds = books.map((b) => b.id);
    const indexer = batch.indexers.get(c.release.indexerId);
    const scoreOf = (title: string, quality: QualityModel, sizeBytes?: number, releaseGroup?: string | null) =>
      evaluateFormats(profile, batch.bookFormats(), {
        title,
        quality,
        mediaType: 'audiobook',
        ...(sizeBytes ? { sizeBytes } : {}),
        releaseGroup: releaseGroup ?? null,
      }).score;

    // One "file" per book: a multi-part book is as good as its worst part.
    const files: ExistingFile[] = [];
    const bookFiles = batch.books.files(author.id);
    for (const book of books) {
      const own = bookFiles.filter((f) => f.bookId === book.id);
      if (own.length === 0) continue;
      const lowest = own.reduce((worst, f) => (qualityIndex(profile, f.quality) < qualityIndex(profile, worst.quality) ? f : worst));
      files.push({
        id: lowest.id,
        quality: lowest.quality,
        formatScore: scoreOf(lowest.sceneName ?? lowest.relativePath, lowest.quality, lowest.sizeBytes, lowest.releaseGroup),
        releaseGroup: lowest.releaseGroup,
        dateAdded: own.reduce((latest, f) => (f.dateAdded > latest ? f.dateAdded : latest), lowest.dateAdded),
        episodeIds: [],
        bookIds: [book.id],
        sizeBytes: own.reduce((sum, f) => sum + f.sizeBytes, 0),
      });
    }

    const overlaps = (ids: readonly number[] | null | undefined) => (ids ?? []).some((id) => bookIds.includes(id));
    const queue: QueuedItem[] = batch.queue
      .filter((q) => overlaps(q.bookIds))
      .map((q) => ({
        title: q.title,
        quality: q.parsedQuality,
        formatScore: scoreOf(q.title, q.parsedQuality, q.sizeBytes),
        state: q.trackedState,
        downloadId: q.downloadId,
        bookIds: q.bookIds ?? [],
      }));
    const pending: PendingItem[] = batch.pending
      .filter((p) => overlaps(p.bookIds))
      .map((p) => ({ id: p.id, guid: p.guid, indexerId: p.indexerId, addedAt: p.addedAt, bookIds: p.bookIds ?? [] }));

    const history = this.deps.history ?? noopHistory;
    const latestHistory: HistoryItem[] = [];
    const importedGrabs: Array<{ grab: HistoryEventSummary; imported: HistoryEventSummary }> = [];
    if (history.latestFor) {
      for (const book of books) {
        const item: ItemRef = { bookId: book.id, authorId: author.id };
        const event = await history.latestFor(item);
        if (event) latestHistory.push({ event, formatScore: scoreOf(event.sourceTitle, event.quality, event.sizeBytes) });
        if (files.some((f) => f.bookIds?.includes(book.id)) && history.findByDownloadId) {
          const grab = await history.latestFor(item, 'grabbed');
          if (grab?.downloadId) {
            const imported = await history.findByDownloadId(grab.downloadId, 'downloadFolderImported');
            if (imported && imported.quality.quality.id !== grab.quality.quality.id) importedGrabs.push({ grab, imported });
          }
        }
      }
    }

    const blocklisted = await (this.deps.blocklist ?? noopBlocklist).isBlocklisted({
      mediaType: 'audiobook',
      authorId: author.id,
      bookIds,
      title: c.release.title,
      protocol: c.release.protocol,
      indexerId: c.release.indexerId,
      ...(c.release.infoHash ? { infoHash: c.release.infoHash } : {}),
      publishDate: c.release.publishDate,
    });

    let freeSpaceBytes: number | null = null;
    if (this.deps.freeSpace) {
      try {
        freeSpaceBytes = await this.deps.freeSpace(author.path);
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
      delayProfile: selectDelayProfile(batch.delayProfiles, author.tags),
      releaseProfiles: batch.releaseProfiles,
      qualityLimits: (id) => batch.bookLimits().get(id) ?? batch.limits.get(id),
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

  private async buildContext(
    batch: Batch,
    c: VideoCandidate,
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
    const result: ProcessResult = { grabbed: [], pending: 0, pendingDecisions: [] };

    for (const e of sorted) {
      const keys = coverageKeys(e.decision);
      if (keys.some((k) => grabbedItems.has(k))) continue;
      if (e.decision.temporarilyRejected) {
        if (!e.decision.rejections.every((r) => PARKABLE.has(r.reason))) continue;
        const reason: PendingReason = keys.some((k) => pendingItems.has(k)) ? 'fallback' : 'delay';
        this.addPending(e.decision, reason, e.decision.delayMinutes ?? 1);
        for (const k of keys) pendingItems.add(k);
        result.pending++;
        result.pendingDecisions.push(e);
        continue;
      }
      if (failedProtocols.has(e.decision.protocol)) {
        this.addPending(e.decision, 'downloadClientUnavailable', CLIENT_RETRY_MINUTES);
        result.pending++;
        result.pendingDecisions.push(e);
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
          result.pendingDecisions.push(e);
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
    const override: MatchOverride = {
      seriesId: request.seriesId,
      episodeIds: request.episodeIds,
      movieId: request.movieId,
      artistId: request.artistId,
      albumIds: request.albumIds,
      authorId: request.authorId,
      bookIds: request.bookIds,
    };
    const [evaluated] = await this.decide([cached], 'interactiveSearch', { override });
    if (!evaluated?.candidate) {
      throw new ReleasesError(
        'VALIDATION',
        `Cannot map release to a library item (${evaluated?.decision.rejections[0]?.message ?? 'unknown'}); pass seriesId/episodeIds, movieId, artistId/albumIds or authorId/bookIds`,
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
    const tags = itemTags(c);
    const target = targetIdsOf(match);
    const tracking: DownloadTracking = {
      mediaType: match.mediaType,
      tags,
      ...target,
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
        ...target,
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
      artistId: d.artistId ?? null,
      albumIds: d.albumIds ?? null,
      authorId: d.authorId ?? null,
      bookIds: d.bookIds ?? null,
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
        set: {
          reason,
          eligibleAt,
          seriesId: values.seriesId,
          episodeIds: values.episodeIds,
          movieId: values.movieId,
          artistId: values.artistId,
          albumIds: values.albumIds,
          authorId: values.authorId,
          bookIds: values.bookIds,
        },
      })
      .run();
    this.bus?.publish({ type: 'release', action: 'pending', title: d.title, ...mediaRef(d) });
  }

  private clearPendingFor(d: ReleaseDecision): void {
    if (d.movieId !== undefined) {
      this.db.delete(pendingReleases).where(eq(pendingReleases.movieId, d.movieId)).run();
      return;
    }
    if (d.artistId !== undefined && d.albumIds?.length) {
      const albums = new Set(d.albumIds);
      const rows = this.db.select().from(pendingReleases).where(eq(pendingReleases.artistId, d.artistId)).all();
      const doomed = rows.filter((r) => (r.albumIds ?? []).some((id) => albums.has(id))).map((r) => r.id);
      if (doomed.length > 0) this.db.delete(pendingReleases).where(inArray(pendingReleases.id, doomed)).run();
      return;
    }
    if (d.authorId !== undefined && d.bookIds?.length) {
      const books = new Set(d.bookIds);
      const rows = this.db.select().from(pendingReleases).where(eq(pendingReleases.authorId, d.authorId)).all();
      const doomed = rows.filter((r) => (r.bookIds ?? []).some((id) => books.has(id))).map((r) => r.id);
      if (doomed.length > 0) this.db.delete(pendingReleases).where(inArray(pendingReleases.id, doomed)).run();
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
        const quality = row.albumIds?.length
          ? parseMusicRelease(row.title).audio
          : row.bookIds?.length
            ? parseAudiobookRelease(row.title).audio
            : parseRelease(row.title).quality;
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
          ...(row.artistId !== null ? { artistId: row.artistId } : {}),
          ...(row.albumIds ? { albumIds: row.albumIds } : {}),
          ...(row.authorId !== null ? { authorId: row.authorId } : {}),
          ...(row.bookIds ? { bookIds: row.bookIds } : {}),
          quality: qualityModelOf(quality),
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
            artistId: row.artistId ?? undefined,
            albumIds: row.albumIds ?? undefined,
            authorId: row.authorId ?? undefined,
            bookIds: row.bookIds ?? undefined,
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

  /** Indexer requests + match criteria for a library item, and the episodes / movie it covers. */
  buildSearch(
    target: SearchTarget,
    userInvoked: boolean,
  ): { requests: SearchRequest[]; criteria: SearchCriteria; items: { kind: SearchItemType; ids: number[] } } {
    if ('movieId' in target) {
      const movie = libraryService.getMovie(this.db, target.movieId);
      const request: SearchRequest = {
        kind: 'movie',
        query: movie.title,
        tmdbId: movie.tmdbId,
        ...(movie.imdbId ? { imdbId: movie.imdbId } : {}),
        ...(movie.year ? { year: movie.year } : {}),
      };
      return { requests: [request], criteria: { mediaType: 'movie', movieId: movie.id, userInvoked }, items: { kind: 'movie', ids: [movie.id] } };
    }
    if (isMusicTarget(target)) {
      const plan = this.buildAudioSearch(target, userInvoked);
      return { requests: plan.steps.flatMap((s) => s.requests), criteria: plan.criteria, items: { kind: 'album', ids: plan.albumIds } };
    }
    if (isBookTarget(target)) {
      const plan = this.buildBookSearch(target, userInvoked);
      return { requests: plan.steps.flatMap((s) => s.requests), criteria: plan.criteria, items: { kind: 'book', ids: plan.bookIds } };
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
    return { requests, criteria, items: { kind: 'episode', ids: targeted.map((e) => e.id) } };
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
    if (isMusicTarget(target)) return this.searchAudio(target, { userInvoked, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (isBookTarget(target)) return this.searchBooks(target, { userInvoked, ...(opts.signal ? { signal: opts.signal } : {}) });
    const { requests, criteria, items } = this.buildSearch(target, userInvoked);
    if (requests.length === 0) return { releases: 0, approved: 0, grabbed: [], pending: 0 };
    const source: SearchRunSource = userInvoked ? 'manual' : 'automatic';
    let releases: ReleaseResource[];
    let evaluated: Evaluated[];
    let result: ProcessResult;
    try {
      releases = await this.runSearch(requests, 'automatic', opts.signal);
      evaluated = await this.decide(releases, userInvoked ? 'userInvokedSearch' : 'search', { criteria });
      result = await this.processDecisions(evaluated);
    } catch (err) {
      if (!opts.signal?.aborted) this.recordSearchError(items, source, err);
      throw err;
    }
    this.logDecisions(evaluated, 'search', result.grabbed, criteria);
    this.recordSearchResults(items, source, evaluated, result);
    return {
      releases: releases.length,
      approved: evaluated.filter((e) => e.decision.approved).length,
      grabbed: result.grabbed.map((e) => e.decision.title),
      pending: result.pending,
    };
  }

  /** Interactive search: every decision, approved first then by rank, nothing grabbed. */
  async interactiveSearch(query: SearchQueryIds, signal?: AbortSignal): Promise<ReleaseDecision[]> {
    const target = this.targetFromQuery(query);
    if (isMusicTarget(target)) {
      const { evaluated } = await this.runAudioSearch(target, { userInvoked: true, interactive: true, ...(signal ? { signal } : {}) });
      const sorted = prioritize(evaluated, this.propers()).map((e) => e.decision);
      return [...sorted.filter((d) => d.approved), ...sorted.filter((d) => !d.approved)];
    }
    if (isBookTarget(target)) {
      const { evaluated } = await this.runBookSearch(target, { userInvoked: true, interactive: true, ...(signal ? { signal } : {}) });
      const sorted = prioritize(evaluated, this.propers()).map((e) => e.decision);
      return [...sorted.filter((d) => d.approved), ...sorted.filter((d) => !d.approved)];
    }
    const { requests, criteria, items } = this.buildSearch(target, true);
    let evaluated: Evaluated[];
    try {
      const releases = await this.runSearch(requests, 'interactive', signal);
      evaluated = await this.decide(releases, 'interactiveSearch', { criteria });
    } catch (err) {
      if (!signal?.aborted) this.recordSearchError(items, 'interactive', err);
      throw err;
    }
    this.logDecisions(evaluated, 'interactive', [], criteria);
    this.recordSearchResults(items, 'interactive', evaluated, { grabbed: [], pending: 0, pendingDecisions: [] });
    const sorted = prioritize(evaluated, this.propers()).map((e) => e.decision);
    return [...sorted.filter((d) => d.approved), ...sorted.filter((d) => !d.approved)];
  }

  private targetFromQuery(query: SearchQueryIds): SearchTarget {
    if (query.movieId !== undefined) return { movieId: query.movieId };
    if (query.albumId !== undefined) return { albumIds: [query.albumId] };
    if (query.artistId !== undefined) return { artistId: query.artistId };
    if (query.bookId !== undefined) return { bookIds: [query.bookId] };
    if (query.authorId !== undefined) return { authorId: query.authorId };
    if (query.episodeId !== undefined) {
      const episode = libraryService.getEpisode(this.db, query.episodeId);
      return { seriesId: episode.seriesId, episodeIds: [episode.id] };
    }
    if (query.seriesId !== undefined) {
      return { seriesId: query.seriesId, ...(query.seasonNumber !== undefined ? { seasonNumber: query.seasonNumber } : {}) };
    }
    throw new ReleasesError('VALIDATION', 'seriesId, episodeId, movieId, albumId, artistId, bookId or authorId is required');
  }

  seriesIdForEpisode(episodeId: number): number {
    return libraryService.getEpisode(this.db, episodeId).seriesId;
  }

  /** The artist of an album; NOT_FOUND when the album does not exist. */
  artistIdForAlbum(albumId: number): number {
    const row = this.db.select({ artistId: albumTable.artistId }).from(albumTable).where(eq(albumTable.id, albumId)).get();
    if (!row) throw new ReleasesError('NOT_FOUND', `Album ${albumId} not found`);
    return row.artistId;
  }

  /** The owning author of a book; NOT_FOUND when the book does not exist. */
  authorIdForBook(bookId: number): number {
    const book = new BookLibrary(this.db).book(bookId);
    if (!book) throw new ReleasesError('NOT_FOUND', `Book ${bookId} not found`);
    return book.authorId;
  }

  /** Lets GET /search?seriesId= on the indexers module resolve library ids. */
  resolveManualSearch(request: ManualSearchRequest): SearchRequest | null {
    try {
      const target = this.targetFromQuery({
        ...(request.seriesId !== undefined ? { seriesId: request.seriesId } : {}),
        ...(request.seasonNumber !== undefined ? { seasonNumber: request.seasonNumber } : {}),
        ...(request.episodeId !== undefined ? { episodeId: request.episodeId } : {}),
        ...(request.movieId !== undefined ? { movieId: request.movieId } : {}),
        ...(request.albumId !== undefined ? { albumId: request.albumId } : {}),
        ...(request.artistId !== undefined ? { artistId: request.artistId } : {}),
      });
      return this.buildSearch(target, true).requests[0] ?? null;
    } catch {
      return null;
    }
  }

  // ---- music searches ---------------------------------------------------------------

  /** Albums of the artist a search should look for: released, monitored (unless asked for by id) and missing or below cutoff. */
  private wantedAlbums(artistId: number, lib: MusicLibrary, profile: QualityProfile | undefined): number[] {
    const now = this.now().getTime() + DAY;
    const files = lib.files(artistId);
    return lib
      .albums(artistId)
      .filter((a) => a.monitored)
      .filter((a) => {
        const ms = a.releaseDate ? Date.parse(/^\d{4}$/.test(a.releaseDate) ? `${a.releaseDate}-01-01` : a.releaseDate.length === 7 ? `${a.releaseDate}-01` : a.releaseDate) : NaN;
        return !Number.isFinite(ms) || ms <= now;
      })
      .filter((a) => {
        const own = files.filter((f) => f.albumId === a.id);
        if (own.length === 0) return true;
        if (a.trackCount > 0 && a.trackFileCount < a.trackCount) return true;
        return profile !== undefined && own.some((f) => !isQualityCutoffMet(profile, f.quality));
      })
      .map((a) => a.id);
  }

  /** Steps, criteria and albums of a music search target (design 8.2). */
  buildAudioSearch(
    target: { artistId: number; albumIds?: number[] } | { albumIds: number[] },
    userInvoked: boolean,
  ): { steps: SearchStep[]; criteria: SearchCriteria; albumIds: number[]; artistId: number | null } {
    const lib = new MusicLibrary(this.db);
    const explicit = target.albumIds?.length ? [...new Set(target.albumIds)] : null;
    const artistId = 'artistId' in target ? target.artistId : explicit ? (lib.album(explicit[0]!)?.artistId ?? null) : null;
    if (artistId === null) throw new ReleasesError('NOT_FOUND', `Album ${explicit?.[0] ?? ''} not found`);
    const artist = lib.artist(artistId);
    if (!artist) throw new ReleasesError('NOT_FOUND', `Artist ${artistId} not found`);
    const own = lib.albums(artist.id);
    if (explicit) {
      const missing = explicit.filter((id) => !own.some((a) => a.id === id));
      if (missing.length > 0) throw new ReleasesError('NOT_FOUND', `Album ${missing.join(', ')} not found for artist ${artist.name}`);
    }
    const ids = explicit ?? this.wantedAlbums(artist.id, lib, this.profilesService.listQualityProfiles().find((p) => p.id === artist.qualityProfileId));
    const albums: PlanAlbum[] = own.filter((a) => ids.includes(a.id)).map((a) => ({ id: a.id, title: a.title, year: a.year }));
    const planArtist = { id: artist.id, name: artist.name };
    // An album search asks per album; an artist search (or several albums of one artist) asks for the artist once first.
    const steps = 'artistId' in target ? artistSearchPlan(planArtist, albums) : albumSearchPlan(planArtist, albums);
    return {
      steps,
      criteria: { mediaType: 'music', artistId: artist.id, albumIds: albums.map((a) => a.id), userInvoked },
      albumIds: albums.map((a) => a.id),
      artistId: artist.id,
    };
  }

  /**
   * Run a music search plan: each step's queries in order, deciding (and, unless interactive,
   * grabbing) after every query, and moving on once the step's albums have an approved release.
   */
  private async runAudioSearch(
    target: { artistId: number; albumIds?: number[] } | { albumIds: number[] },
    opts: { userInvoked: boolean; interactive?: boolean; signal?: AbortSignal },
  ): Promise<{ evaluated: Evaluated[]; result: ProcessResult; releases: number }> {
    const plan = this.buildAudioSearch(target, opts.userInvoked);
    return this.runSteps(
      'album',
      { steps: plan.steps.map((s) => ({ ids: s.albumIds, requests: s.requests })), criteria: plan.criteria, ids: plan.albumIds },
      opts,
    );
  }

  /** Run a book search plan, like runAudioSearch. */
  private async runBookSearch(
    target: BookTarget,
    opts: { userInvoked: boolean; interactive?: boolean; signal?: AbortSignal },
  ): Promise<{ evaluated: Evaluated[]; result: ProcessResult; releases: number }> {
    const plan = this.buildBookSearch(target, opts.userInvoked);
    return this.runSteps('book', { steps: plan.steps.map((s) => ({ ids: s.bookIds, requests: s.requests })), criteria: plan.criteria, ids: plan.bookIds }, opts);
  }

  /** The step runner behind album and book searches. */
  private async runSteps(
    kind: 'album' | 'book',
    plan: { steps: Array<{ ids: number[]; requests: SearchRequest[] }>; criteria: SearchCriteria; ids: number[] },
    opts: { userInvoked: boolean; interactive?: boolean; signal?: AbortSignal },
  ): Promise<{ evaluated: Evaluated[]; result: ProcessResult; releases: number }> {
    const interactive = opts.interactive ?? false;
    const runSource: SearchRunSource = interactive ? 'interactive' : opts.userInvoked ? 'manual' : 'automatic';
    const releaseSource: ReleaseSource = interactive ? 'interactiveSearch' : opts.userInvoked ? 'userInvokedSearch' : 'search';
    const items = { kind, ids: plan.ids };
    const idsOf = (d: ReleaseDecision) => (kind === 'album' ? d.albumIds : d.bookIds) ?? [];
    const evaluated: Evaluated[] = [];
    const result: ProcessResult = { grabbed: [], pending: 0, pendingDecisions: [] };
    const seen = new Set<string>();
    const settled = new Set<number>();
    let releases = 0;
    try {
      for (const step of plan.steps) {
        const open = step.ids.filter((id) => !settled.has(id));
        if (open.length === 0) continue;
        const criteria: SearchCriteria = kind === 'album' ? { ...plan.criteria, albumIds: open } : { ...plan.criteria, bookIds: open };
        for (const request of step.requests) {
          if (opts.signal?.aborted) break;
          const found = (await this.indexers.search(request, { mode: interactive ? 'interactive' : 'automatic', ...(opts.signal ? { signal: opts.signal } : {}) })).filter(
            (r) => {
              const key = `${r.indexerId}:${r.guid}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            },
          );
          if (found.length === 0) continue;
          releases += found.length;
          this.cacheReleases(found);
          const batch = await this.decide(found, releaseSource, { criteria });
          evaluated.push(...batch);
          if (!interactive) {
            const r = await this.processDecisions(batch);
            result.grabbed.push(...r.grabbed);
            result.pending += r.pending;
            result.pendingDecisions.push(...r.pendingDecisions);
            this.logDecisions(batch, 'search', r.grabbed, criteria);
          }
          for (const e of batch) {
            if (!e.rank || !(e.decision.approved || e.decision.temporarilyRejected)) continue;
            for (const id of idsOf(e.decision)) settled.add(id);
          }
          if (open.every((id) => settled.has(id))) break;
        }
      }
    } catch (err) {
      if (!opts.signal?.aborted) this.recordSearchError(items, runSource, err);
      throw err;
    }
    if (interactive) this.logDecisions(evaluated, 'interactive', [], plan.criteria);
    this.recordSearchResults(items, runSource, evaluated, result);
    return { evaluated, result, releases };
  }

  private async searchAudio(
    target: { artistId: number; albumIds?: number[] } | { albumIds: number[] },
    opts: { userInvoked: boolean; signal?: AbortSignal },
  ): Promise<SearchSummary> {
    const { evaluated, result, releases } = await this.runAudioSearch(target, opts);
    return {
      releases,
      approved: evaluated.filter((e) => e.decision.approved).length,
      grabbed: result.grabbed.map((e) => e.decision.title),
      pending: result.pending,
    };
  }

  /** Wanted albums in job order, grouped per artist, at most `limit` due ones. */
  private async searchAlbumSet(
    albums: ReadonlyArray<{ id: number; artistId: number }>,
    signal: AbortSignal | undefined,
    limit: number,
  ): Promise<{ searched: number; grabbed: number }> {
    const due = albums.filter((a) => this.shouldSearch('album', a.id)).slice(0, limit);
    const byArtist = new Map<number, number[]>();
    for (const a of due) byArtist.set(a.artistId, [...(byArtist.get(a.artistId) ?? []), a.id]);
    let grabbed = 0;
    for (const [artistId, ids] of byArtist) {
      if (signal?.aborted) break;
      this.markSearched('album', ids);
      try {
        const target = ids.length > 1 ? { artistId, albumIds: ids } : { albumIds: ids };
        grabbed += (await this.searchFor(target, signal ? { signal } : {})).grabbed.length;
      } catch (err) {
        this.log?.warn({ err, artistId }, 'album search failed');
      }
    }
    return { searched: due.length, grabbed };
  }

  private missingAlbums(): Array<{ id: number; artistId: number }> {
    const now = this.now();
    return this.allPages((page) => musicService.listMissingAlbums(this.db, { page, pageSize: 500 }, now));
  }

  private cutoffUnmetAlbums(): Array<{ id: number; artistId: number }> {
    const profiles = this.profilesService.listQualityProfiles('music');
    return this.allPages((page) => musicService.listCutoffUnmetAlbums(this.db, { page, pageSize: 500 }, profiles));
  }

  /** MissingAlbumSearch: monitored released albums without (all) their tracks, with the per-album back-off. */
  async missingAlbumSearch(signal?: AbortSignal, limit = MISSING_ALBUM_SEARCH_LIMIT): Promise<string> {
    if (!musicService.musicEnabled(this.db)) return 'skipped: music is not enabled';
    const r = await this.searchAlbumSet(this.missingAlbums(), signal, limit);
    return `missing albums: searched ${r.searched}, grabbed ${r.grabbed}`;
  }

  /**
   * CutoffUnmetAudioSearch: albums whose lowest track quality, and books whose lowest file
   * quality, is below the profile cutoff. Each domain runs only while it is enabled.
   */
  async cutoffUnmetAudioSearch(signal?: AbortSignal, limit = CUTOFF_UNMET_AUDIO_SEARCH_LIMIT): Promise<string> {
    const music = musicService.musicEnabled(this.db);
    const books = audiobooksEnabled(this.db);
    if (!music && !books) return 'skipped: music is not enabled';
    const parts: string[] = [];
    if (music) {
      const r = await this.searchAlbumSet(this.cutoffUnmetAlbums(), signal, limit);
      parts.push(`cutoff unmet albums: searched ${r.searched}, grabbed ${r.grabbed}`);
    }
    if (books && !signal?.aborted) {
      const r = await this.searchBookSet(this.cutoffUnmetBooks(), signal, limit);
      parts.push(`cutoff unmet books: searched ${r.searched}, grabbed ${r.grabbed}`);
    }
    return parts.join('; ');
  }

  // ---- audiobook searches -----------------------------------------------------------

  /** Books of the author a search should look for: released, monitored and without a file or below cutoff. */
  private wantedBooks(authorId: number, lib: BookLibrary, profile: QualityProfile | undefined): number[] {
    const now = this.now().getTime() + DAY;
    const files = lib.files(authorId);
    return lib
      .ownBooks(authorId)
      .filter((b) => b.monitored)
      .filter((b) => {
        const ms = releaseDateMs(b.releaseDate);
        return ms === null || ms <= now;
      })
      .filter((b) => {
        const own = files.filter((f) => f.bookId === b.id);
        if (own.length === 0) return true;
        return profile !== undefined && own.some((f) => !isQualityCutoffMet(profile, f.quality));
      })
      .map((b) => b.id);
  }

  /** Steps, criteria and books of an audiobook search target (design 8.2). */
  buildBookSearch(
    target: BookTarget,
    userInvoked: boolean,
  ): { steps: Array<{ bookIds: number[]; requests: SearchRequest[] }>; criteria: SearchCriteria; bookIds: number[]; authorId: number } {
    const lib = new BookLibrary(this.db);
    const explicit = target.bookIds?.length ? [...new Set(target.bookIds)] : null;
    const authorId = 'authorId' in target ? target.authorId : explicit ? (lib.book(explicit[0]!)?.authorId ?? null) : null;
    if (authorId === null) throw new ReleasesError('NOT_FOUND', `Book ${explicit?.[0] ?? ''} not found`);
    const author = lib.author(authorId);
    if (!author) throw new ReleasesError('NOT_FOUND', `Author ${authorId} not found`);
    const own = lib.books(author.id);
    if (explicit) {
      const missing = explicit.filter((id) => !own.some((b) => b.id === id));
      if (missing.length > 0) throw new ReleasesError('NOT_FOUND', `Book ${missing.join(', ')} not found for author ${author.name}`);
    }
    const ids = explicit ?? this.wantedBooks(author.id, lib, this.profilesService.listQualityProfiles().find((p) => p.id === author.qualityProfileId));
    const books: PlanBook[] = own.filter((b) => ids.includes(b.id)).map((b) => ({ id: b.id, title: b.title, asin: b.asin }));
    const planAuthor = { id: author.id, name: author.name };
    // A book search asks per book; an author search asks for the author once first.
    const steps = 'authorId' in target ? authorSearchPlan(planAuthor, books) : bookSearchPlan(planAuthor, books);
    return {
      steps,
      criteria: { mediaType: 'audiobook', authorId: author.id, bookIds: books.map((b) => b.id), userInvoked },
      bookIds: books.map((b) => b.id),
      authorId: author.id,
    };
  }

  private async searchBooks(target: BookTarget, opts: { userInvoked: boolean; signal?: AbortSignal }): Promise<SearchSummary> {
    const { evaluated, result, releases } = await this.runBookSearch(target, opts);
    return {
      releases,
      approved: evaluated.filter((e) => e.decision.approved).length,
      grabbed: result.grabbed.map((e) => e.decision.title),
      pending: result.pending,
    };
  }

  /** Wanted books in job order, grouped per author, at most `limit` due ones. */
  private async searchBookSet(
    list: ReadonlyArray<{ id: number; authorId: number }>,
    signal: AbortSignal | undefined,
    limit: number,
  ): Promise<{ searched: number; grabbed: number }> {
    const due = list.filter((b) => this.shouldSearch('book', b.id)).slice(0, limit);
    const byAuthor = new Map<number, number[]>();
    for (const b of due) byAuthor.set(b.authorId, [...(byAuthor.get(b.authorId) ?? []), b.id]);
    let grabbed = 0;
    for (const [authorId, ids] of byAuthor) {
      if (signal?.aborted) break;
      this.markSearched('book', ids);
      try {
        const target: BookTarget = ids.length > 1 ? { authorId, bookIds: ids } : { bookIds: ids };
        grabbed += (await this.searchFor(target, signal ? { signal } : {})).grabbed.length;
      } catch (err) {
        this.log?.warn({ err, authorId }, 'book search failed');
      }
    }
    return { searched: due.length, grabbed };
  }

  /** Monitored, released books of monitored authors without a file, newest release first. */
  private missingBooks(): Array<{ id: number; authorId: number }> {
    const lib = new BookLibrary(this.db);
    const now = this.now().getTime() + DAY;
    const out: Array<{ id: number; authorId: number; ms: number }> = [];
    for (const author of lib.authors()) {
      if (!author.monitored) continue;
      const files = new Set(lib.files(author.id).map((f) => f.bookId));
      for (const b of lib.ownBooks(author.id)) {
        if (!b.monitored || b.hasFile || files.has(b.id)) continue;
        const ms = releaseDateMs(b.releaseDate);
        if (ms !== null && ms > now) continue;
        out.push({ id: b.id, authorId: author.id, ms: ms ?? 0 });
      }
    }
    return out.sort((a, b) => b.ms - a.ms || a.id - b.id).map(({ id, authorId }) => ({ id, authorId }));
  }

  /** Monitored books whose lowest file quality is below their author's profile cutoff. */
  private cutoffUnmetBooks(): Array<{ id: number; authorId: number }> {
    const lib = new BookLibrary(this.db);
    const profiles = new Map(this.profilesService.listQualityProfiles('audiobook').map((p) => [p.id, p]));
    const out: Array<{ id: number; authorId: number }> = [];
    for (const author of lib.authors()) {
      if (!author.monitored) continue;
      const profile = profiles.get(author.qualityProfileId);
      if (!profile) continue;
      const files = lib.files(author.id);
      for (const b of lib.ownBooks(author.id)) {
        if (!b.monitored) continue;
        const own = files.filter((f) => f.bookId === b.id);
        if (own.length > 0 && own.some((f) => !isQualityCutoffMet(profile, f.quality))) out.push({ id: b.id, authorId: author.id });
      }
    }
    return out;
  }

  /** MissingBookSearch: monitored released books without a file, with the per-book back-off. */
  async missingBookSearch(signal?: AbortSignal, limit = MISSING_BOOK_SEARCH_LIMIT): Promise<string> {
    if (!audiobooksEnabled(this.db)) return 'skipped: audiobooks are not enabled';
    const r = await this.searchBookSet(this.missingBooks(), signal, limit);
    return `missing books: searched ${r.searched}, grabbed ${r.grabbed}`;
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
        const key =
          e.decision.movieId !== undefined
            ? `m${e.decision.movieId}`
            : e.decision.artistId !== undefined
              ? `a${e.decision.artistId}`
              : e.decision.authorId !== undefined
                ? `w${e.decision.authorId}`
                : `s${e.decision.seriesId ?? 0}`;
        byItem.set(key, [...(byItem.get(key) ?? []), e]);
      }
      for (const group of byItem.values()) {
        const stable = group.map((e, i) => ({ e, i })).sort((a, b) => tier(a.e) - tier(b.e) || a.i - b.i);
        stable.forEach(({ e }, i) => ranks.set(e, i + 1));
      }
      const rows: DecisionLogRow[] = evaluated.map((e) => {
        const d = e.decision;
        const fallback =
          !e.candidate && d.seriesId === undefined && d.movieId === undefined && d.artistId === undefined && d.authorId === undefined
            ? criteria
            : undefined;
        const mediaType = d.mediaType ?? fallback?.mediaType ?? null;
        const music = mediaType === 'music';
        const book = mediaType === 'audiobook';
        return {
          mediaType,
          seriesId: d.seriesId ?? (fallback?.mediaType === 'series' ? (fallback.seriesId ?? null) : null),
          episodeIds: d.episodeIds ?? (fallback?.episodeIds ? [...fallback.episodeIds] : []),
          movieId: d.movieId ?? (fallback?.mediaType === 'movie' ? (fallback.movieId ?? null) : null),
          artistId: d.artistId ?? (music ? (fallback?.artistId ?? null) : null),
          albumIds: d.albumIds ?? (music && fallback?.albumIds ? [...fallback.albumIds] : music ? [] : null),
          authorId: d.authorId ?? (book ? (fallback?.authorId ?? null) : null),
          bookIds: d.bookIds ?? (book && fallback?.bookIds ? [...fallback.bookIds] : book ? [] : null),
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
    return this.decisionLog.list(
      query,
      (episodeId) => this.seriesIdForEpisode(episodeId),
      (albumId) => this.artistIdForAlbum(albumId),
      (bookId) => this.authorIdForBook(bookId),
    );
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

  private shouldSearch(kind: SearchItemType, itemId: number): boolean {
    const row = this.db
      .select()
      .from(releaseSearchState)
      .where(and(eq(releaseSearchState.mediaType, kind), eq(releaseSearchState.itemId, itemId)))
      .get();
    return isSearchDue(row, this.now().getTime());
  }

  private markSearched(kind: SearchItemType, itemIds: readonly number[]): void {
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
    } else if (d.albumIds?.length) {
      this.db
        .delete(releaseSearchState)
        .where(and(eq(releaseSearchState.mediaType, 'album'), inArray(releaseSearchState.itemId, d.albumIds)))
        .run();
    } else if (d.bookIds?.length) {
      this.db
        .delete(releaseSearchState)
        .where(and(eq(releaseSearchState.mediaType, 'book'), inArray(releaseSearchState.itemId, d.bookIds)))
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

  // The lists the jobs work through, in the order they take them (also read by searchStatus).

  private missingEpisodes(): WantedEpisodeRef[] {
    const now = this.now().toISOString();
    return this.allPages((page) => libraryService.listMissingEpisodes(this.db, { page, pageSize: 500, includeSpecials: false }, now));
  }

  private missingMovies(): Movie[] {
    const now = this.now().toISOString();
    return this.allPages((page) => libraryService.listMissingMovies(this.db, { page, pageSize: 500 }, now));
  }

  private cutoffUnmetEpisodes(isMet = this.isFileCutoffMet()): WantedEpisodeRef[] {
    return this.allPages((page) => libraryService.listCutoffUnmetEpisodes(this.db, { page, pageSize: 500, includeSpecials: false }, isMet));
  }

  private cutoffUnmetMovies(isMet = this.isFileCutoffMet()): Movie[] {
    return this.allPages((page) => libraryService.listCutoffUnmetMovies(this.db, { page, pageSize: 500 }, isMet));
  }

  async missingEpisodeSearch(signal?: AbortSignal, limit = MISSING_EPISODE_SEARCH_LIMIT): Promise<string> {
    const r = await this.searchEpisodeSet(this.missingEpisodes(), signal, limit);
    return `missing episodes: searched ${r.searched}, grabbed ${r.grabbed}`;
  }

  async missingMovieSearch(signal?: AbortSignal, limit = MISSING_MOVIE_SEARCH_LIMIT): Promise<string> {
    const r = await this.searchMovies(this.missingMovies(), signal, limit);
    return `missing movies: searched ${r.searched}, grabbed ${r.grabbed}`;
  }

  /**
   * The library's cutoff hook, evaluated with the item's current profile (§6.5). The same
   * checker backs GET /wanted/cutoff/*, so the job and the Wanted page agree.
   */
  isFileCutoffMet(): (file: MediaFile) => boolean {
    return createCutoffChecker(this.db, this.profilesService);
  }

  async cutoffUnmetSearch(signal?: AbortSignal, limit = CUTOFF_UNMET_SEARCH_LIMIT): Promise<string> {
    const isMet = this.isFileCutoffMet();
    const episodes = this.cutoffUnmetEpisodes(isMet);
    const movies = this.cutoffUnmetMovies(isMet);
    const e = await this.searchEpisodeSet(episodes, signal, limit);
    const m = await this.searchMovies(movies, signal, limit);
    return `cutoff unmet: searched ${e.searched} episodes / ${m.searched} movies, grabbed ${e.grabbed + m.grabbed}`;
  }

  // ---- search status ----------------------------------------------------------------

  /** Keep what one search did for each item it covered. Never throws. */
  private recordSearchResults(
    items: { kind: SearchItemType; ids: readonly number[] },
    source: SearchRunSource,
    evaluated: readonly Evaluated[],
    result: ProcessResult,
  ): void {
    try {
      const grabbed = new Set(result.grabbed.map((e) => e.decision));
      const pending = new Set(result.pendingDecisions.map((e) => e.decision));
      const outcomes = itemOutcomes(items.kind, items.ids, evaluated.map((e) => e.decision), grabbed, pending);
      this.writeSearchResults(items.kind, source, outcomes);
    } catch (err) {
      this.log?.warn({ err }, 'recording search results failed');
    }
  }

  private recordSearchError(items: { kind: SearchItemType; ids: readonly number[] }, source: SearchRunSource, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      this.writeSearchResults(items.kind, source, new Map(items.ids.map((id) => [id, { outcome: 'error', releases: 0, approved: 0, detail }])));
    } catch (err) {
      this.log?.warn({ err }, 'recording search results failed');
    }
  }

  private writeSearchResults(kind: SearchItemType, source: SearchRunSource, outcomes: ReadonlyMap<number, ItemOutcome>): void {
    if (outcomes.size === 0) return;
    const searchedAt = this.now().toISOString();
    this.db.transaction((tx) => {
      for (const [itemId, o] of outcomes) {
        const values = {
          mediaType: kind,
          itemId,
          searchedAt,
          source,
          outcome: o.outcome,
          releases: o.releases,
          approved: o.approved,
          detail: o.detail === null ? null : o.detail.slice(0, 500),
        };
        tx.insert(releaseSearchResults)
          .values(values)
          .onConflictDoUpdate({ target: [releaseSearchResults.mediaType, releaseSearchResults.itemId], set: values })
          .run();
      }
    });
  }

  /**
   * GET /release/searchstatus: for each episode / movie, its last search and whether (and
   * roughly when) a scheduled search will look for it. The estimate replays the job's rules:
   * the same list in the same order, the per-item back-off and the per-run limit, over the
   * job's upcoming runs. Unknown ids are left out.
   */
  searchStatus(query: SearchStatusQuery): ItemSearchStatus[] {
    const kind = query.mediaType;
    const ids = [...new Set(query.ids)];
    const facts =
      kind === 'episode' ? this.episodeFacts(ids) : kind === 'album' ? this.albumFacts(ids) : kind === 'book' ? this.bookFacts(ids) : this.movieFacts(ids);
    const last = new Map<number, LastSearch>();
    for (const r of this.db
      .select()
      .from(releaseSearchResults)
      .where(and(eq(releaseSearchResults.mediaType, kind), inArray(releaseSearchResults.itemId, ids)))
      .all()) {
      last.set(r.itemId, { time: r.searchedAt, source: r.source, outcome: r.outcome, releases: r.releases, approved: r.approved, detail: r.detail });
    }
    const states = new Map(
      this.db
        .select()
        .from(releaseSearchState)
        .where(eq(releaseSearchState.mediaType, kind))
        .all()
        .map((s) => [s.itemId, s]),
    );

    const album = kind === 'album';
    const book = kind === 'book';
    const musicOn = album ? musicService.musicEnabled(this.db) : book ? audiobooksEnabled(this.db) : true;
    const missingJob =
      kind === 'episode' ? MISSING_EPISODE_SEARCH_JOB : album ? MISSING_ALBUM_SEARCH_JOB : book ? MISSING_BOOK_SEARCH_JOB : MISSING_MOVIE_SEARCH_JOB;
    const cutoffJob = album || book ? CUTOFF_UNMET_AUDIO_SEARCH_JOB : CUTOFF_UNMET_SEARCH_JOB;
    const missing: ReadonlyArray<{ id: number }> =
      kind === 'episode'
        ? this.missingEpisodes()
        : album
          ? musicOn
            ? this.missingAlbums()
            : []
          : book
            ? musicOn
              ? this.missingBooks()
              : []
            : this.missingMovies();
    const missingIds = new Set(missing.map((m) => m.id));
    // The cutoff list costs a pass over every file; only build it when an asked item may be on it.
    const needCutoff = musicOn && ids.some((id) => !missingIds.has(id) && facts.get(id)?.monitored && facts.get(id)?.hasFile);
    const cutoff: ReadonlyArray<{ id: number }> = needCutoff
      ? kind === 'episode'
        ? this.cutoffUnmetEpisodes()
        : album
          ? this.cutoffUnmetAlbums()
          : book
            ? this.cutoffUnmetBooks()
            : this.cutoffUnmetMovies()
      : [];
    const cutoffIds = new Set(cutoff.map((c) => c.id));
    const missingLimit =
      kind === 'episode' ? MISSING_EPISODE_SEARCH_LIMIT : album ? MISSING_ALBUM_SEARCH_LIMIT : book ? MISSING_BOOK_SEARCH_LIMIT : MISSING_MOVIE_SEARCH_LIMIT;
    const plans = new Map<string, Map<number, { at: Date | null; runsAhead: number }> | null>([
      [missingJob, this.planJob(missingJob, missing, states, missingLimit)],
    ]);
    if (needCutoff) plans.set(cutoffJob, this.planJob(cutoffJob, cutoff, states, album || book ? CUTOFF_UNMET_AUDIO_SEARCH_LIMIT : CUTOFF_UNMET_SEARCH_LIMIT));

    const out: ItemSearchStatus[] = [];
    for (const id of ids) {
      const f = facts.get(id);
      if (!f) continue;
      const base = { job: null, nextSearchAt: null, searchCount: states.get(id)?.searchCount ?? 0, runsAhead: 0 };
      const job = missingIds.has(id) ? missingJob : cutoffIds.has(id) ? cutoffJob : null;
      let automatic: ItemSearchStatus['automatic'];
      if (job !== null) {
        const plan = plans.get(job) ?? null;
        const p = plan?.get(id);
        automatic =
          plan === null
            ? { ...base, state: 'jobDisabled', job }
            : { ...base, state: 'scheduled', job, nextSearchAt: p?.at ? p.at.toISOString() : null, runsAhead: p?.runsAhead ?? 0 };
      } else if (!f.monitored) {
        automatic = { ...base, state: 'unmonitored' };
      } else if (f.hasFile) {
        automatic = { ...base, state: 'satisfied' };
      } else {
        automatic = { ...base, state: f.special ? 'special' : 'notAvailable' };
      }
      out.push({ mediaType: kind, id, monitored: f.monitored, lastSearch: last.get(id) ?? null, automatic });
    }
    return out;
  }

  /** Which upcoming run of `job` reaches each listed item; null when the job does not run on a schedule. */
  private planJob(
    job: string,
    list: ReadonlyArray<{ id: number }>,
    states: ReadonlyMap<number, { lastSearchedAt: string; searchCount: number }>,
    limit: number,
  ): Map<number, { at: Date | null; runsAhead: number }> | null {
    const fallback = SEARCH_JOB_CRONS[job as keyof typeof SEARCH_JOB_CRONS];
    const schedule = this.jobSchedules?.(job) ?? { cron: fallback ?? null, enabled: true };
    if (!schedule.enabled || schedule.cron === null) return null;
    const runs = upcomingRuns(schedule.cron, this.now());
    return planSearchRuns(
      list.map((item) => ({ id: item.id, dueAt: searchDueAt(states.get(item.id)) })),
      runs,
      limit,
    );
  }

  /** Monitored (episode and series), has-file and special (season 0) flags of the asked episodes. */
  private episodeFacts(ids: readonly number[]): Map<number, { monitored: boolean; hasFile: boolean; special?: boolean }> {
    const rows = this.db
      .select({
        id: episodeTable.id,
        monitored: episodeTable.monitored,
        hasFile: episodeTable.hasFile,
        seasonNumber: episodeTable.seasonNumber,
        seriesMonitored: seriesTable.monitored,
      })
      .from(episodeTable)
      .innerJoin(seriesTable, eq(episodeTable.seriesId, seriesTable.id))
      .where(inArray(episodeTable.id, [...ids]))
      .all();
    return new Map(rows.map((r) => [r.id, { monitored: r.monitored && r.seriesMonitored, hasFile: r.hasFile, special: r.seasonNumber === 0 }]));
  }

  /** Monitored (album and artist) and has-any-track-file flags of the asked albums. */
  private albumFacts(ids: readonly number[]): Map<number, { monitored: boolean; hasFile: boolean; special?: boolean }> {
    const rows = this.db
      .select({ id: albumTable.id, monitored: albumTable.monitored, artistMonitored: artistTable.monitored })
      .from(albumTable)
      .innerJoin(artistTable, eq(albumTable.artistId, artistTable.id))
      .where(inArray(albumTable.id, [...ids]))
      .all();
    const stats = albumStatistics(
      this.db,
      rows.map((r) => r.id),
    );
    return new Map(rows.map((r) => [r.id, { monitored: r.monitored && r.artistMonitored, hasFile: (stats.get(r.id)?.sizeOnDisk ?? 0) > 0 }]));
  }

  /** Monitored (book and author) and has-a-file flags of the asked books. */
  private bookFacts(ids: readonly number[]): Map<number, { monitored: boolean; hasFile: boolean; special?: boolean }> {
    const lib = new BookLibrary(this.db);
    const out = new Map<number, { monitored: boolean; hasFile: boolean }>();
    for (const id of ids) {
      const b = lib.book(id);
      if (!b) continue;
      const author = lib.author(b.authorId);
      out.set(id, { monitored: b.monitored && (author?.monitored ?? false), hasFile: b.hasFile || lib.files(b.authorId).some((f) => f.bookId === id) });
    }
    return out;
  }

  private movieFacts(ids: readonly number[]): Map<number, { monitored: boolean; hasFile: boolean; special?: boolean }> {
    const rows = this.db
      .select({ id: movieTable.id, monitored: movieTable.monitored, hasFile: movieTable.hasFile })
      .from(movieTable)
      .where(inArray(movieTable.id, [...ids]))
      .all();
    return new Map(rows.map((r) => [r.id, { monitored: r.monitored, hasFile: r.hasFile }]));
  }
}

/** Library ids of GET /release (interactive search). */
export interface SearchQueryIds {
  seriesId?: number | undefined;
  seasonNumber?: number | undefined;
  episodeId?: number | undefined;
  movieId?: number | undefined;
  albumId?: number | undefined;
  artistId?: number | undefined;
  bookId?: number | undefined;
  authorId?: number | undefined;
}

/** Audiobook search targets: an author (optionally some of their books) or books by id. */
export function isBookTarget(target: SearchTarget): target is BookTarget {
  return 'authorId' in target || ('bookIds' in target && !('seriesId' in target) && !('movieId' in target) && !('artistId' in target) && !('albumIds' in target));
}

/** Epoch ms of a `YYYY`, `YYYY-MM` or `YYYY-MM-DD` date; null when absent or unreadable. */
function releaseDateMs(date: string | null): number | null {
  if (!date) return null;
  const iso = /^\d{4}$/.test(date) ? `${date}-01-01` : /^\d{4}-\d{2}$/.test(date) ? `${date}-01` : date;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Music search targets: an artist (optionally some of its albums) or albums by id. */
export function isMusicTarget(target: SearchTarget): target is { artistId: number; albumIds?: number[] } | { albumIds: number[] } {
  return 'artistId' in target || ('albumIds' in target && !('seriesId' in target) && !('movieId' in target) && !('authorId' in target) && !('bookIds' in target));
}

/** The fields of a wanted episode the scheduled searches use. */
type WantedEpisodeRef = { id: number; seriesId: number; seasonNumber: number };

// ---- helpers ------------------------------------------------------------------------

/** The library ids a grab is tracked and recorded under. */
function targetIdsOf(
  match: SeriesMatch | MovieMatch | AlbumMatch | BookMatch,
):
  | { seriesId: number; episodeIds: number[] }
  | { movieId: number }
  | { artistId: number; albumIds: number[] }
  | { authorId: number; bookIds: number[] } {
  if (match.mediaType === 'music') return { artistId: match.artist.id, albumIds: match.albums.map((a) => a.id) };
  if (match.mediaType === 'audiobook') return { authorId: match.author.id, bookIds: match.books.map((b) => b.id) };
  if (match.mediaType === 'series') return { seriesId: match.series.id, episodeIds: match.episodes.map((ep) => ep.id) };
  return { movieId: match.movie.id };
}

/** A video parse with nothing in it, carried by audio candidates (their name is in `Candidate.music` / `.audiobook`). */
function emptyVideoParse(parsed: Pick<ParsedMusicRelease, 'releaseTitle' | 'audio' | 'releaseGroup' | 'releaseHash'>): ParsedRelease {
  return {
    releaseTitle: parsed.releaseTitle,
    quality: { quality: parsed.audio.quality, revision: parsed.audio.revision, detectionSource: parsed.audio.detectionSource },
    languages: [],
    releaseGroup: parsed.releaseGroup,
    releaseHash: parsed.releaseHash,
    series: null,
    movie: null,
  };
}

/** Decision for a music release that did not reach the specs (unparseable, unknown artist / album). */
function audioUnmatchedDecision(
  source: ReleaseSource,
  release: ReleaseResource,
  parsed: ParsedMusicRelease | null,
  rejection: { reason: string; message: string; type: 'permanent' | 'temporary' },
  artist?: { id: number; name: string },
): ReleaseDecision {
  const base = unmatchedDecision(source, release, null, null, rejection);
  return {
    ...base,
    mediaType: 'music',
    ...(parsed ? { quality: qualityModelOf(parsed.audio) } : {}),
    ...(parsed?.releaseGroup ? { releaseGroup: parsed.releaseGroup } : {}),
    ...(parsed?.music ? { music: musicInfoOf(parsed.music) } : {}),
    ...(artist ? { artistId: artist.id, artistName: artist.name } : {}),
  };
}

/** Decision for an audiobook release that did not reach the specs (unparseable, unknown author / book). */
function bookUnmatchedDecision(
  source: ReleaseSource,
  release: ReleaseResource,
  parsed: ParsedAudiobookRelease | null,
  rejection: { reason: string; message: string; type: 'permanent' | 'temporary' },
  author?: { id: number; name: string },
): ReleaseDecision {
  const base = unmatchedDecision(source, release, null, null, rejection);
  return {
    ...base,
    mediaType: 'audiobook',
    ...(parsed ? { quality: qualityModelOf(parsed.audio) } : {}),
    ...(parsed?.releaseGroup ? { releaseGroup: parsed.releaseGroup } : {}),
    ...(parsed?.audiobook ? { audiobook: audiobookInfoOf(parsed.audiobook) } : {}),
    ...(author ? { authorId: author.id, authorName: author.name } : {}),
  };
}

/** Keys a decision covers, for "one release per episode set" bookkeeping. */
function coverageKeys(d: ReleaseDecision): string[] {
  const v = d.versionTag ? `:${d.versionTag}` : '';
  if (d.movieId !== undefined) return [`m${d.movieId}${v}`];
  if (d.albumIds?.length) return d.albumIds.map((id) => `al${id}`);
  if (d.bookIds?.length) return d.bookIds.map((id) => `bk${id}`);
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
  const keysOf = (r: PendingRow) =>
    r.movieId !== null
      ? [`m${r.movieId}`]
      : r.albumIds?.length
        ? r.albumIds.map((id) => `al${id}`)
        : r.bookIds?.length
          ? r.bookIds.map((id) => `bk${id}`)
          : (r.episodeIds ?? []).map((id) => `e${id}`);
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
