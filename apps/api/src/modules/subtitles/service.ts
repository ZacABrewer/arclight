import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { NotificationEvent } from '@arclight/notifications';
import {
  LANGUAGE_PROFILE_CUTOFF_ANY,
  SubtitleSettings as SubtitleSettingsSchema,
  type LanguageProfile,
  type LanguageProfileInput,
  type MediaFileSubtitles,
  type SubtitleBlacklistPage,
  type SubtitleBlacklistRecord,
  type SubtitleFileQuery,
  type SubtitleHistoryAction,
  type SubtitleHistoryPage,
  type SubtitleHistoryQuery,
  type SubtitleHistoryRecord,
  type SubtitleLanguageOption,
  type SubtitleLanguageRef,
  type SubtitleManualSearchResponse,
  type SubtitleMediaType,
  type SubtitleProviderId,
  type SubtitleProvidersResponse,
  type SubtitleProviderTestResult,
  type SubtitleSearchCommand,
  type SubtitleSearchCommandResult,
  type SubtitleSearchResult,
  type SubtitleSettings,
  type SubtitleState,
  type SubtitleSyncCheck,
  type SubtitleSyncCheckResult,
  type SubtitleSyncResult,
  type SubtitleWhisperStatus,
  type WantedSubtitleItem,
  type WantedSubtitlesPage,
  type WantedSubtitlesQuery,
  SubtitleProviderId as SubtitleProviderIdSchema,
} from '@arclight/shared';
import {
  LANGUAGES,
  MAX_SCORE,
  SubtitleSearcher,
  ThrottleTracker,
  buildAlassCommand,
  buildAudioActivityCommand,
  buildFfsubsyncCommand,
  buildSyncCheckCommand,
  compareTimings,
  decodeSubtitle,
  estimateSync,
  parseCues,
  parseEbur128,
  parseSilenceDetect,
  planAudioWindows,
  probeWhisperService,
  syncAutoAction,
  type SyncEstimate,
  type TimeInterval,
  type WhisperProbeResult,
  buildPostProcessCommand,
  buildQuery,
  buildSubtitleExtractArgs,
  codecFormat,
  computeFileHashes,
  detectFormatFromBytes,
  languageName,
  matchReport,
  nameSubtitleFile,
  parseLanguageTag,
  prepareSubtitle,
  scorePercent,
  selectCandidates,
  shouldPostProcess,
  shouldSync,
  syncedOutputPath,
  type MediaType as PackageMediaType,
  type PreparedSubtitle,
  type ProbeResult,
  type ScoredCandidate,
  type SubtitleCandidate,
  type SubtitleFormat,
  type SubtitleProvider,
  type SubtitleQuery,
  type ThrottleEntry,
  type WantedLanguage,
} from '@arclight/subtitles';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, movies, series } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { getSection, setSection } from '../settings/service.js';
import {
  PROVIDER_DEFS,
  configError,
  credentialsChanged,
  maskProviders,
  onlyWhenNoOtherResult,
  ONLY_WHEN_NO_OTHER_RESULT,
  providerName,
  providerSchemas,
  unmaskSettings,
  type ProviderDeps,
} from './providers.js';
import { execFileRunner, type ProcessRunner } from './runner.js';
import {
  BITMAP_CODECS,
  SUBTITLE_EXTENSIONS,
  TEXT_CODECS,
  createFfprobe,
  embeddedFromMediaInfo,
  embeddedFromProbe,
  scanExternal,
  type SubtitleProbe,
} from './scan.js';
import {
  languageProfiles,
  subtitleBlacklist,
  subtitleFiles,
  subtitleHistory,
  subtitleProviderState,
  subtitleWantedState,
} from './schema.js';
import {
  desiredForUpgrade,
  languageKey,
  missingEntries,
  normalizeTag,
  shouldSearch,
  toRef,
  toWantedLanguage,
  type DesiredEntry,
  type PresentSubtitle,
} from './wanted.js';

// The subtitles service: profiles, indexing, wanted, search -> download -> save -> notify ->
// post-process, upgrades, blacklist, manual search/download/upload, sync and extraction.

export class SubtitlesError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'EXPIRED' | 'UNSUPPORTED' | 'FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'SubtitlesError';
  }
}

type MediaFileRow = typeof mediaFiles.$inferSelect;
type SeriesRow = typeof series.$inferSelect;
type MovieRow = typeof movies.$inferSelect;
type EpisodeRow = typeof episodes.$inferSelect;
type SubtitleRow = typeof subtitleFiles.$inferSelect;
type HistoryRow = typeof subtitleHistory.$inferSelect;
type ProfileRow = typeof languageProfiles.$inferSelect;

/** Everything about one media file the pipeline needs. */
export interface FileContext {
  file: MediaFileRow;
  mediaType: SubtitleMediaType;
  series: SeriesRow | null;
  movie: MovieRow | null;
  episodes: EpisodeRow[];
  profile: LanguageProfile | null;
  mediaTitle: string;
  episodeLabel: string | null;
}

export interface SubtitlesServiceOptions {
  db: Db;
  bus: EventBus;
  log: Logger;
  /** Process runner for ffprobe/ffmpeg/sync tools/scripts. Default execFile. */
  runner?: ProcessRunner;
  /** Embedded stream probe. Undefined: ffprobe through the runner. Null: none (media info only). */
  probe?: SubtitleProbe | null;
  /** Replaces the provider registry factory (tests pass fakes). */
  createProvider?: (id: SubtitleProviderId, settings: Record<string, unknown>, deps: ProviderDeps) => SubtitleProvider;
  /** Notification dispatch for `subtitleDownloaded`. */
  notify?: (event: NotificationEvent) => Promise<void>;
  /** Describes the series/movie for notifications (defaults to a no-op that skips notifying). */
  describeMedia?: (mediaType: SubtitleMediaType, id: number) => Extract<NotificationEvent, { type: 'subtitleDownloaded' }>['media'] | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  /** Download retry pause and strike sleep (tests set 0). */
  retryDelayMs?: number;
  /** ARCLIGHT_WHISPER_URL (the bundled Whisper service); undefined disables auto-detect. */
  whisperUrl?: string | undefined;
  /** Whisper liveness probe (tests pass a fake). */
  probeWhisper?: (url: string) => Promise<WhisperProbeResult>;
}

/** Setting key marking a whisperai entry created by WhisperAutoDetect. */
export const WHISPER_AUTO_KEY = 'autoRegistered';

export interface FileSearchResult {
  searched: number;
  downloaded: number;
  allThrottled: boolean;
}

interface Downloaded {
  candidate: ScoredCandidate;
  prepared: PreparedSubtitle;
  hi: boolean;
}

interface SaveInput {
  language: string;
  forced: boolean;
  hi: boolean;
  bytes: Uint8Array;
  format: SubtitleFormat;
  provider: string;
  providerSubtitleId: string | null;
  score: number | null;
  scoreOutOf: number | null;
  matched: string[];
  notMatched: string[];
  action: SubtitleHistoryAction;
  manual: boolean;
  upgradedFromId?: number | null;
  releaseInfo?: string | undefined;
  uploader?: string | undefined;
  /** Run sync and the custom command (not for extraction). Default true. */
  postProcess?: boolean;
  /** Automatic provider download: a low sync score may ask the caller to try the next candidate. */
  allowRetry?: boolean;
}

interface CachedResult {
  mediaFileId: number;
  candidate: ScoredCandidate;
  wanted: WantedLanguage;
  query: SubtitleQuery;
  expiresAt: number;
}

const DAY_MS = 24 * 3600 * 1000;
const MANUAL_CACHE_MS = 3600 * 1000;
const TEXT_FORMATS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub']);

const pkgType = (t: SubtitleMediaType): PackageMediaType => (t === 'series' ? 'episode' : 'movie');
const maxScore = (t: SubtitleMediaType): number => MAX_SCORE[pkgType(t)];
const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');

function paginate<T>(items: T[], page: number, pageSize: number) {
  const start = (page - 1) * pageSize;
  return { page, pageSize, totalRecords: items.length, records: items.slice(start, start + pageSize) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function episodeLabelFor(eps: readonly Pick<EpisodeRow, 'seasonNumber' | 'episodeNumber'>[]): string | null {
  if (eps.length === 0) return null;
  const sorted = [...eps].sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const base = `S${pad(first.seasonNumber)}E${pad(first.episodeNumber)}`;
  return sorted.length > 1 ? `${base}-E${pad(last.episodeNumber)}` : base;
}

function toProfile(row: ProfileRow): LanguageProfile {
  return {
    id: row.id,
    name: row.name,
    languages: row.languages,
    cutoff: row.cutoff,
    mustContain: row.mustContain,
    mustNotContain: row.mustNotContain,
    originalFormat: row.originalFormat,
  };
}

function toState(row: SubtitleRow): SubtitleState {
  return {
    id: row.id,
    mediaFileId: row.mediaFileId,
    language: row.language,
    forced: row.forced,
    hi: row.hi,
    path: row.path,
    embedded: row.embedded,
    streamIndex: row.streamIndex,
    codec: row.codec,
    provider: row.provider,
    providerSubtitleId: row.providerSubtitleId,
    score: row.score,
    percent: row.score !== null && row.scoreOutOf ? round2((row.score / row.scoreOutOf) * 100) : null,
    size: row.size,
    mtime: row.mtime,
    added: row.added,
    syncScore: row.syncScore,
    syncOffsetMs: row.syncOffsetMs,
    syncDriftPpm: row.syncDriftPpm,
    syncCheckedAt: row.syncCheckedAt,
    syncMethod: row.syncMethod,
  };
}

function toCheck(e: SyncEstimate): SubtitleSyncCheck {
  return {
    method: e.method,
    reliable: e.reliable,
    syncScore: e.syncScore,
    offsetMs: e.offsetMs,
    driftPpm: e.driftPpm,
    meanErrorMs: e.meanErrorMs,
    confidence: e.confidence,
    matched: e.matched,
    message: e.message,
  };
}

function toHistory(row: HistoryRow): SubtitleHistoryRecord {
  return { ...row };
}

function toBlacklist(row: typeof subtitleBlacklist.$inferSelect): SubtitleBlacklistRecord {
  return { ...row };
}

/** R6.10 message. */
export function describeAction(ref: SubtitleLanguageRef, verb: string, provider: string, percent: number | null): string {
  const flavour = ref.forced ? ' forced' : ref.hi ? ' HI' : '';
  const score = percent === null ? '' : ` with a score of ${percent}%`;
  return `${languageName(ref.language)}${flavour} subtitles ${verb} from ${providerName(provider)}${score}.`;
}

export class SubtitlesService {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly runner: ProcessRunner;
  private readonly probeFn: SubtitleProbe | null;
  private readonly opts: SubtitlesServiceOptions;
  private readonly now: () => number;
  readonly throttle: ThrottleTracker;
  private readonly providerCache = new Map<string, { key: string; provider: SubtitleProvider }>();
  private readonly manualCache = new Map<string, CachedResult>();
  private readonly pending = new Set<Promise<unknown>>();
  /** Subtitle rows whose sync check asked for the next candidate (consumed by searchFile). */
  private readonly retryRequested = new Set<number>();

  constructor(opts: SubtitlesServiceOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.runner = opts.runner ?? execFileRunner;
    this.now = opts.now ?? Date.now;
    this.probeFn = opts.probe === undefined ? createFfprobe(this.runner, () => this.settings().embedded.ffprobePath) : opts.probe;
    const initial: ThrottleEntry[] = this.db
      .select()
      .from(subtitleProviderState)
      .all()
      .flatMap((r) => (SubtitleProviderIdSchema.safeParse(r.provider).success ? [{ provider: r.provider as SubtitleProviderId, code: r.code as ThrottleEntry['code'], description: r.description, until: r.until }] : []));
    this.throttle = new ThrottleTracker({ now: this.now, initial });
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private publish(action: Extract<Parameters<EventBus['publish']>[0], { type: 'subtitle' }>['action'], c?: FileContext): void {
    this.bus.publish({
      type: 'subtitle',
      action,
      ...(c ? { mediaType: c.mediaType, mediaFileId: c.file.id } : {}),
      ...(c ? { mediaId: (c.mediaType === 'series' ? c.series?.id : c.movie?.id) ?? 0 } : {}),
    });
  }

  /** Detached work (import-triggered searches, boot-time detection); tests await `idle()`. */
  detach(p: Promise<unknown>): void {
    const tracked = p.catch((err: unknown) => this.log.warn({ err }, 'background subtitle task failed')).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  // ---- settings ---------------------------------------------------------------------------

  settings(): SubtitleSettings {
    return getSection(this.db, 'subtitles');
  }

  getMaskedSettings(): SubtitleSettings {
    const s = this.settings();
    return { ...s, providers: maskProviders(s.providers) };
  }

  updateSettings(input: SubtitleSettings): SubtitleSettings {
    const current = this.settings();
    const seen = new Set<string>();
    let resetAuth = false;
    const providers = input.providers.flatMap((p) => {
      if (seen.has(p.id)) return [];
      seen.add(p.id);
      const stored = current.providers.find((c) => c.id === p.id);
      const settings = unmaskSettings(p.id, p.settings, stored?.settings);
      if (credentialsChanged(p.id, stored?.settings, settings)) resetAuth = true;
      return [{ ...p, settings }];
    });
    for (const id of [input.defaultSeriesProfileId, input.defaultMovieProfileId]) {
      if (id !== null && !this.findProfile(id)) throw new SubtitlesError('VALIDATION', `language profile ${id} does not exist`);
    }
    const parsed = SubtitleSettingsSchema.safeParse({ ...input, providers });
    if (!parsed.success) throw new SubtitlesError('VALIDATION', parsed.error.message);
    setSection(this.db, 'subtitles', parsed.data, this.iso());
    this.providerCache.clear();
    if (resetAuth) {
      this.throttle.reset(true);
      this.syncThrottleRows();
    }
    this.publish('settings');
    return this.getMaskedSettings();
  }

  languages(): SubtitleLanguageOption[] {
    const out = new Map<string, string>();
    for (const l of LANGUAGES) {
      const code = l.alpha2 ?? l.alpha3t;
      out.set(code, l.name);
    }
    for (const extra of ['pt-BR', 'zh-Hans', 'zh-Hant', 'zh-TW', 'es-MX', 'sr-Latn', 'sr-Cyrl', 'fr-CA']) {
      const tag = parseLanguageTag(extra);
      if (tag) out.set(tag, languageName(tag));
    }
    return [...out].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- language profiles --------------------------------------------------------------------

  listProfiles(): LanguageProfile[] {
    return this.db.select().from(languageProfiles).orderBy(asc(languageProfiles.name)).all().map(toProfile);
  }

  private findProfile(id: number): LanguageProfile | null {
    const row = this.db.select().from(languageProfiles).where(eq(languageProfiles.id, id)).get();
    return row ? toProfile(row) : null;
  }

  getProfile(id: number): LanguageProfile {
    const p = this.findProfile(id);
    if (!p) throw new SubtitlesError('NOT_FOUND', `language profile ${id} not found`);
    return p;
  }

  private normalizeProfile(input: LanguageProfileInput): LanguageProfileInput {
    const seen = new Set<string>();
    const languages = input.languages.map((l) => {
      const tag = parseLanguageTag(l.code);
      if (!tag) throw new SubtitlesError('VALIDATION', `unknown language: ${l.code}`);
      if (seen.has(tag)) throw new SubtitlesError('VALIDATION', `language listed twice: ${tag}`);
      seen.add(tag);
      return { ...l, code: tag };
    });
    let cutoff = input.cutoff;
    if (cutoff !== null && cutoff !== LANGUAGE_PROFILE_CUTOFF_ANY) {
      const tag = parseLanguageTag(cutoff);
      if (!tag || !seen.has(tag)) throw new SubtitlesError('VALIDATION', `cutoff ${cutoff} is not one of the profile's languages`);
      cutoff = tag;
    }
    for (const p of [...input.mustContain, ...input.mustNotContain]) if (!p.trim()) throw new SubtitlesError('VALIDATION', 'empty filter pattern');
    return { ...input, languages, cutoff };
  }

  createProfile(input: LanguageProfileInput): LanguageProfile {
    const v = this.normalizeProfile(input);
    const row = this.db.insert(languageProfiles).values(v).returning().get();
    this.publish('profiles');
    return toProfile(row);
  }

  updateProfile(id: number, input: LanguageProfileInput): LanguageProfile {
    this.getProfile(id);
    const v = this.normalizeProfile(input);
    const row = this.db.update(languageProfiles).set(v).where(eq(languageProfiles.id, id)).returning().get();
    this.publish('profiles');
    return toProfile(row!);
  }

  deleteProfile(id: number): void {
    this.getProfile(id);
    this.db.transaction((tx) => {
      tx.update(series).set({ languageProfileId: null }).where(eq(series.languageProfileId, id)).run();
      tx.update(movies).set({ languageProfileId: null }).where(eq(movies.languageProfileId, id)).run();
      tx.delete(languageProfiles).where(eq(languageProfiles.id, id)).run();
    });
    const s = this.settings();
    if (s.defaultSeriesProfileId === id || s.defaultMovieProfileId === id) {
      setSection(
        this.db,
        'subtitles',
        {
          ...s,
          defaultSeriesProfileId: s.defaultSeriesProfileId === id ? null : s.defaultSeriesProfileId,
          defaultMovieProfileId: s.defaultMovieProfileId === id ? null : s.defaultMovieProfileId,
        },
        this.iso(),
      );
    }
    this.publish('profiles');
  }

  // ---- providers ----------------------------------------------------------------------------

  private syncThrottleRows(): void {
    const active = this.throttle.list();
    this.db.transaction((tx) => {
      tx.delete(subtitleProviderState).run();
      for (const e of active) tx.insert(subtitleProviderState).values({ provider: e.provider, code: e.code, description: e.description, until: e.until }).run();
    });
  }

  private persistThrottle(entry: ThrottleEntry): void {
    this.log.warn({ provider: entry.provider, code: entry.code, until: entry.until }, 'subtitle provider throttled');
    this.db
      .insert(subtitleProviderState)
      .values({ provider: entry.provider, code: entry.code, description: entry.description, until: entry.until })
      .onConflictDoUpdate({ target: subtitleProviderState.provider, set: { code: entry.code, description: entry.description, until: entry.until } })
      .run();
  }

  providers(): SubtitleProvidersResponse {
    const s = this.settings();
    const active = new Map(this.throttle.list().map((e) => [e.provider, e]));
    this.syncThrottleRows();
    const status = providerSchemas().map((schema) => {
      const cfg = s.providers.find((p) => p.id === schema.id);
      const err = configError(schema.id, cfg?.settings ?? {});
      const t = active.get(schema.id);
      return {
        id: schema.id,
        name: schema.name,
        enabled: cfg?.enabled ?? false,
        configured: err === null,
        configError: err,
        throttle: t ? { code: t.code, description: t.description, until: t.until } : null,
      };
    });
    return { schema: providerSchemas(), status };
  }

  resetThrottles(onlyAuthOrConfig: boolean): SubtitleProvidersResponse {
    this.throttle.reset(onlyAuthOrConfig);
    this.syncThrottleRows();
    return this.providers();
  }

  private providerDeps(): ProviderDeps {
    const s = this.settings();
    const ffmpegPath = s.embedded.ffmpegPath;
    const runFfmpeg = async (args: string[]): Promise<Uint8Array> => {
      const [cmd, ...rest] = args;
      const r = await this.runner(cmd ?? ffmpegPath, rest, { timeoutMs: 600_000 });
      if (!r.ok) throw new Error(`ffmpeg failed: ${r.error ?? r.stderr.slice(-300)}`);
      return new Uint8Array(r.stdout);
    };
    return {
      ctx: {
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
        now: this.now,
        ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      },
      embedded: {
        probe: async (path) => {
          const r = this.probeFn ? await this.probeFn(path) : null;
          if (!r) throw new Error('ffprobe is not available');
          return r;
        },
        runFfmpeg,
      },
      whisper: { extractAudio: runFfmpeg },
      ffmpegPath,
    };
  }

  private buildProvider(id: SubtitleProviderId, settings: Record<string, unknown>): SubtitleProvider {
    const deps = this.providerDeps();
    return this.opts.createProvider ? this.opts.createProvider(id, settings, deps) : PROVIDER_DEFS[id].create(settings, deps);
  }

  /** Enabled, configured providers for a media type, in priority order (cached per settings). */
  activeProviders(mediaType: SubtitleMediaType): SubtitleProvider[] {
    const s = this.settings();
    const out: SubtitleProvider[] = [];
    for (const cfg of s.providers) {
      if (!cfg.enabled) continue;
      if (!PROVIDER_DEFS[cfg.id].mediaTypes.includes(mediaType)) continue;
      if (configError(cfg.id, cfg.settings)) continue;
      const key = JSON.stringify([cfg.settings, s.embedded.ffmpegPath]);
      const cached = this.providerCache.get(cfg.id);
      if (cached && cached.key === key) {
        out.push(cached.provider);
        continue;
      }
      try {
        const provider = this.buildProvider(cfg.id, cfg.settings);
        this.providerCache.set(cfg.id, { key, provider });
        out.push(provider);
      } catch (err) {
        this.log.warn({ err, provider: cfg.id }, 'subtitle provider could not be created');
      }
    }
    return out;
  }

  async testProvider(id: SubtitleProviderId, incoming: Record<string, unknown>): Promise<SubtitleProviderTestResult> {
    const stored = this.settings().providers.find((p) => p.id === id);
    const settings = unmaskSettings(id, incoming, stored?.settings);
    const err = configError(id, settings);
    if (err) return { ok: false, message: err };
    try {
      await this.buildProvider(id, settings).test();
      return { ok: true, message: `${providerName(id)} is reachable` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  private searcher(providers: SubtitleProvider[], profile: LanguageProfile | null, c?: FileContext): SubtitleSearcher {
    const s = this.settings();
    const blacklisted = new Set(
      this.db
        .select({ p: subtitleBlacklist.provider, id: subtitleBlacklist.providerSubtitleId })
        .from(subtitleBlacklist)
        .all()
        .map((r) => `${r.p}\u0000${r.id}`),
    );
    const delay = this.opts.retryDelayMs;
    return new SubtitleSearcher({
      providers,
      now: this.now,
      ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      minScorePercent: { episode: s.minimumScore.series, movie: s.minimumScore.movie },
      concurrent: s.search.concurrentProviders,
      isBlacklisted: (provider, id) => blacklisted.has(`${provider}\u0000${id}`),
      onBlacklist: (candidate) => {
        if (c) this.insertBlacklist(c, candidate.provider, candidate.id, { language: candidate.language, forced: candidate.forced, hi: candidate.hi });
        blacklisted.add(`${candidate.provider}\u0000${candidate.id}`);
      },
      onThrottle: (entry) => this.persistThrottle(entry),
      mustContain: profile?.mustContain ?? [],
      mustNotContain: profile?.mustNotContain ?? [],
      originalFormat: profile?.originalFormat ?? false,
      utf8: s.naming.utf8Encode,
      throttle: this.throttle,
      fallbackProviders: s.providers.filter((p) => p.enabled && onlyWhenNoOtherResult(p)).map((p) => p.id),
      ...(delay !== undefined ? { downloadRetryDelayMs: delay, strikeSleepMs: delay } : {}),
    });
  }

  // ---- library context ----------------------------------------------------------------------

  loadFile(mediaFileId: number): FileContext {
    const file = this.db.select().from(mediaFiles).where(eq(mediaFiles.id, mediaFileId)).get();
    if (!file) throw new SubtitlesError('NOT_FOUND', `media file ${mediaFileId} not found`);
    return this.contextFor(file);
  }

  private contextFor(file: MediaFileRow, cache?: { series: Map<number, SeriesRow>; movies: Map<number, MovieRow>; episodes: Map<number, EpisodeRow[]>; profiles: Map<number, LanguageProfile> }): FileContext {
    let seriesRow: SeriesRow | null = null;
    let movieRow: MovieRow | null = null;
    let eps: EpisodeRow[] = [];
    if (file.mediaType === 'series' && file.seriesId !== null) {
      seriesRow = cache ? cache.series.get(file.seriesId) ?? null : this.db.select().from(series).where(eq(series.id, file.seriesId)).get() ?? null;
      eps = cache ? cache.episodes.get(file.id) ?? [] : this.db.select().from(episodes).where(eq(episodes.episodeFileId, file.id)).orderBy(asc(episodes.seasonNumber), asc(episodes.episodeNumber)).all();
    } else if (file.movieId !== null) {
      movieRow = cache ? cache.movies.get(file.movieId) ?? null : this.db.select().from(movies).where(eq(movies.id, file.movieId)).get() ?? null;
    }
    const profileId = seriesRow?.languageProfileId ?? movieRow?.languageProfileId ?? null;
    const profile = profileId === null ? null : cache ? cache.profiles.get(profileId) ?? null : this.findProfile(profileId);
    return {
      file,
      mediaType: file.mediaType,
      series: seriesRow,
      movie: movieRow,
      episodes: eps,
      profile,
      mediaTitle: seriesRow?.title ?? movieRow?.title ?? file.relativePath,
      episodeLabel: episodeLabelFor(eps),
    };
  }

  private displayTitle(c: FileContext): string {
    return c.episodeLabel ? `${c.mediaTitle} - ${c.episodeLabel}` : c.mediaTitle;
  }

  private rowsFor(mediaFileId: number): SubtitleRow[] {
    return this.db.select().from(subtitleFiles).where(eq(subtitleFiles.mediaFileId, mediaFileId)).orderBy(asc(subtitleFiles.id)).all();
  }

  /** Subtitles that count toward wanted, by embedded mode. */
  private present(rows: readonly SubtitleRow[], s: SubtitleSettings): PresentSubtitle[] {
    const mode = s.embedded.mode;
    return rows
      .filter((r) => {
        if (!r.embedded) return true;
        if (mode === 'present') return true;
        if (mode === 'ignore') return false;
        // extract: text tracks are extracted to files; bitmap/unknown tracks still count.
        return r.codec === null || r.streamIndex === null || BITMAP_CODECS.has(r.codec);
      })
      .map((r) => ({ language: r.language, forced: r.forced, hi: r.hi, embedded: r.embedded }));
  }

  missingFor(c: FileContext, rows: readonly SubtitleRow[] = this.rowsFor(c.file.id), s: SubtitleSettings = this.settings()): DesiredEntry[] {
    return missingEntries(c.profile, this.present(rows, s), { countEmbedded: true });
  }

  private describe(c: FileContext, rows: readonly SubtitleRow[] = this.rowsFor(c.file.id), s: SubtitleSettings = this.settings()): MediaFileSubtitles {
    return {
      mediaFileId: c.file.id,
      mediaType: c.mediaType,
      seriesId: c.file.seriesId,
      movieId: c.file.movieId,
      episodeIds: c.episodes.map((e) => e.id),
      seasonNumber: c.file.seasonNumber,
      episodeLabel: c.episodeLabel,
      path: c.file.path,
      languageProfileId: c.profile?.id ?? null,
      subtitles: rows.map(toState),
      missing: this.missingFor(c, rows, s).map(toRef),
    };
  }

  private filesFor(q: SubtitleFileQuery): MediaFileRow[] {
    if (q.mediaFileId !== undefined) return this.db.select().from(mediaFiles).where(eq(mediaFiles.id, q.mediaFileId)).all();
    if (q.seriesId !== undefined) return this.db.select().from(mediaFiles).where(eq(mediaFiles.seriesId, q.seriesId)).all();
    if (q.movieId !== undefined) return this.db.select().from(mediaFiles).where(eq(mediaFiles.movieId, q.movieId)).all();
    throw new SubtitlesError('VALIDATION', 'mediaFileId, seriesId or movieId is required');
  }

  private sortContexts(list: FileContext[]): FileContext[] {
    return list.sort((a, b) => {
      const ea = a.episodes[0];
      const eb = b.episodes[0];
      if (ea && eb) return ea.seasonNumber - eb.seasonNumber || ea.episodeNumber - eb.episodeNumber;
      return a.file.relativePath.localeCompare(b.file.relativePath);
    });
  }

  fileSubtitles(q: SubtitleFileQuery): MediaFileSubtitles[] {
    const s = this.settings();
    return this.sortContexts(this.filesFor(q).map((f) => this.contextFor(f))).map((c) => this.describe(c, undefined, s));
  }

  async scan(q: SubtitleFileQuery): Promise<MediaFileSubtitles[]> {
    const files = this.filesFor(q);
    const out: FileContext[] = [];
    for (const f of files) {
      const c = this.contextFor(f);
      await this.indexFile(c);
      out.push(c);
    }
    return this.sortContexts(out).map((c) => this.describe(c));
  }

  // ---- indexing -------------------------------------------------------------------------------

  private extraDirs(videoPath: string, s: SubtitleSettings): string[] {
    const p = s.naming.folderPath.trim();
    if (!p) return [];
    if (s.naming.folder === 'absolute' && isAbsolute(p)) return [p];
    if (s.naming.folder === 'relative') return [join(dirname(videoPath), p)];
    return [];
  }

  private async probe(path: string): Promise<ProbeResult | null> {
    if (!this.probeFn) return null;
    try {
      return await this.probeFn(path);
    } catch {
      return null;
    }
  }

  /** Rescan disk and streams for one file (R7, R9.8), keeping download metadata of known files. */
  async indexFile(c: FileContext): Promise<void> {
    const s = this.settings();
    const now = this.iso();
    const external = await scanExternal(c.file.path, this.extraDirs(c.file.path, s));
    const existing = this.rowsFor(c.file.id);
    const byPath = new Map(existing.filter((r) => !r.embedded && r.path).map((r) => [r.path!, r]));
    const embeddedOpts = {
      ignorePgs: s.embedded.ignorePgs,
      ignoreVobsub: s.embedded.ignoreVobsub,
      ignoreAss: s.embedded.ignoreAss,
      undefinedLanguage: s.embedded.undefinedLanguage,
    };
    const probed = (await exists(c.file.path)) ? await this.probe(c.file.path) : null;
    const embedded = probed ? embeddedFromProbe(probed, embeddedOpts) : embeddedFromMediaInfo(c.file.mediaInfo, embeddedOpts);

    this.db.transaction((tx) => {
      for (const e of external) {
        const row = byPath.get(e.path);
        if (row) {
          byPath.delete(e.path);
          tx.update(subtitleFiles)
            .set({ language: e.language, forced: e.forced, hi: e.hi, size: e.size, mtime: e.mtime })
            .where(eq(subtitleFiles.id, row.id))
            .run();
        } else {
          tx.insert(subtitleFiles)
            .values({ mediaFileId: c.file.id, language: e.language, forced: e.forced, hi: e.hi, path: e.path, embedded: false, size: e.size, mtime: e.mtime, added: now })
            .run();
        }
      }
      const gone = [...byPath.values()].map((r) => r.id);
      if (gone.length) tx.delete(subtitleFiles).where(inArray(subtitleFiles.id, gone)).run();
      tx.delete(subtitleFiles).where(and(eq(subtitleFiles.mediaFileId, c.file.id), eq(subtitleFiles.embedded, true))).run();
      for (const e of embedded) {
        tx.insert(subtitleFiles)
          .values({ mediaFileId: c.file.id, language: e.language, forced: e.forced, hi: e.hi, path: null, embedded: true, streamIndex: e.streamIndex, codec: e.codec, added: now })
          .run();
      }
    });

    if (s.embedded.mode === 'extract' && c.profile) await this.extractMissing(c, s);
  }

  /** Embedded mode `extract`: copy text tracks that would satisfy a missing entry out to files. */
  private async extractMissing(c: FileContext, s: SubtitleSettings): Promise<void> {
    for (const entry of this.missingFor(c, undefined, s)) {
      const track = this.rowsFor(c.file.id).find(
        (r) => r.embedded && r.streamIndex !== null && r.codec !== null && TEXT_CODECS.has(r.codec) && r.language === entry.tag && r.forced === entry.forced,
      );
      if (!track) continue;
      try {
        await this.extract(track.id);
      } catch (err) {
        this.log.debug({ err, mediaFileId: c.file.id }, 'embedded extraction failed');
        return;
      }
    }
  }

  /** Remove rows of media files that no longer exist (library deletes). */
  pruneOrphans(): number {
    const live = new Set(this.db.select({ id: mediaFiles.id }).from(mediaFiles).all().map((r) => r.id));
    const orphanSubs = this.db.select({ id: subtitleFiles.id, f: subtitleFiles.mediaFileId }).from(subtitleFiles).all().filter((r) => !live.has(r.f)).map((r) => r.id);
    const orphanState = this.db.select({ id: subtitleWantedState.id, f: subtitleWantedState.mediaFileId }).from(subtitleWantedState).all().filter((r) => !live.has(r.f)).map((r) => r.id);
    if (orphanSubs.length) this.db.delete(subtitleFiles).where(inArray(subtitleFiles.id, orphanSubs)).run();
    if (orphanState.length) this.db.delete(subtitleWantedState).where(inArray(subtitleWantedState.id, orphanState)).run();
    return orphanSubs.length;
  }

  // ---- wanted ---------------------------------------------------------------------------------

  /** Every media file with a profile and its missing entries (bulk-loaded). */
  private wantedContexts(mediaType?: SubtitleMediaType): Array<{ c: FileContext; missing: DesiredEntry[] }> {
    const s = this.settings();
    const files = mediaType ? this.db.select().from(mediaFiles).where(eq(mediaFiles.mediaType, mediaType)).all() : this.db.select().from(mediaFiles).all();
    if (files.length === 0) return [];
    const cache = {
      series: new Map(this.db.select().from(series).where(isNotNull(series.languageProfileId)).all().map((r) => [r.id, r])),
      movies: new Map(this.db.select().from(movies).where(isNotNull(movies.languageProfileId)).all().map((r) => [r.id, r])),
      episodes: new Map<number, EpisodeRow[]>(),
      profiles: new Map(this.listProfiles().map((p) => [p.id, p])),
    };
    for (const e of this.db.select().from(episodes).where(isNotNull(episodes.episodeFileId)).orderBy(asc(episodes.seasonNumber), asc(episodes.episodeNumber)).all()) {
      const list = cache.episodes.get(e.episodeFileId!) ?? [];
      list.push(e);
      cache.episodes.set(e.episodeFileId!, list);
    }
    const rows = new Map<number, SubtitleRow[]>();
    for (const r of this.db.select().from(subtitleFiles).all()) {
      const list = rows.get(r.mediaFileId) ?? [];
      list.push(r);
      rows.set(r.mediaFileId, list);
    }
    const out: Array<{ c: FileContext; missing: DesiredEntry[] }> = [];
    for (const f of files) {
      const c = this.contextFor(f, cache);
      if (!c.profile) continue;
      const missing = this.missingFor(c, rows.get(f.id) ?? [], s);
      if (missing.length) out.push({ c, missing });
    }
    return out;
  }

  private attemptsByFile(): Map<number, { lastSearch: string | null; attempts: number }> {
    const map = new Map<number, { lastSearch: string | null; attempts: number }>();
    for (const r of this.db.select().from(subtitleWantedState).all()) {
      const cur = map.get(r.mediaFileId) ?? { lastSearch: null, attempts: 0 };
      cur.attempts += r.attempts;
      if (!cur.lastSearch || r.lastAttempt > cur.lastSearch) cur.lastSearch = r.lastAttempt;
      map.set(r.mediaFileId, cur);
    }
    return map;
  }

  wanted(q: WantedSubtitlesQuery): WantedSubtitlesPage {
    const attempts = this.attemptsByFile();
    const items: WantedSubtitleItem[] = this.wantedContexts(q.mediaType).map(({ c, missing }) => {
      const a = attempts.get(c.file.id);
      return {
        mediaFileId: c.file.id,
        mediaType: c.mediaType,
        seriesId: c.file.seriesId,
        movieId: c.file.movieId,
        episodeIds: c.episodes.map((e) => e.id),
        title: c.mediaTitle,
        episodeLabel: c.episodeLabel,
        episodeTitle: c.episodes[0]?.title ?? null,
        path: c.file.path,
        languageProfileId: c.profile!.id,
        missing: missing.map(toRef),
        lastSearch: a?.lastSearch ?? null,
        attempts: a?.attempts ?? 0,
      };
    });
    items.sort((a, b) => a.title.localeCompare(b.title) || (a.episodeLabel ?? '').localeCompare(b.episodeLabel ?? ''));
    return paginate(items, q.page, q.pageSize);
  }

  /** R3.11 eligibility for automatic runs. */
  private eligible(c: FileContext, s: SubtitleSettings): boolean {
    if (!s.search.onlyMonitored) return true;
    if (c.mediaType === 'movie') return c.movie?.monitored ?? false;
    return (c.series?.monitored ?? false) && c.episodes.some((e) => e.monitored);
  }

  private attemptState(mediaFileId: number, key: string) {
    return this.db
      .select()
      .from(subtitleWantedState)
      .where(and(eq(subtitleWantedState.mediaFileId, mediaFileId), eq(subtitleWantedState.language, key)))
      .get();
  }

  private recordAttempt(mediaFileId: number, key: string): void {
    const now = this.iso();
    this.db
      .insert(subtitleWantedState)
      .values({ mediaFileId, language: key, firstAttempt: now, lastAttempt: now, attempts: 1 })
      .onConflictDoUpdate({
        target: [subtitleWantedState.mediaFileId, subtitleWantedState.language],
        set: { lastAttempt: now, attempts: (this.attemptState(mediaFileId, key)?.attempts ?? 0) + 1 },
      })
      .run();
  }

  private clearAttempts(mediaFileId: number, key: string): void {
    this.db.delete(subtitleWantedState).where(and(eq(subtitleWantedState.mediaFileId, mediaFileId), eq(subtitleWantedState.language, key))).run();
  }

  // ---- search pipeline --------------------------------------------------------------------------

  private async queryFor(c: FileContext, languages: readonly WantedLanguage[]): Promise<SubtitleQuery> {
    const s = this.settings();
    let hashes: SubtitleQuery['hashes'];
    try {
      const h = await computeFileHashes(c.file.path, c.file.sizeBytes);
      if (h.opensubtitles || h.napiprojekt) hashes = h;
    } catch {
      hashes = undefined;
    }
    const ep = c.episodes[0];
    return buildQuery({
      mediaType: pkgType(c.mediaType),
      file: {
        path: c.file.path,
        sizeBytes: c.file.sizeBytes,
        sceneName: c.file.sceneName,
        releaseGroup: c.file.releaseGroup,
        edition: c.file.edition,
        mediaInfo: c.file.mediaInfo,
        quality: c.file.quality,
      },
      title: c.series?.title ?? c.movie?.title ?? c.mediaTitle,
      ...(c.movie && c.movie.originalTitle !== c.movie.title ? { originalTitle: c.movie.originalTitle } : {}),
      year: c.series?.year ?? c.movie?.year,
      season: ep?.seasonNumber,
      episode: ep?.episodeNumber,
      absoluteEpisode: ep?.absoluteEpisodeNumber ?? undefined,
      episodeTitle: ep?.title,
      imdbId: c.movie?.imdbId ?? undefined,
      seriesImdbId: c.series?.imdbId ?? undefined,
      tmdbId: c.movie?.tmdbId ?? c.series?.tmdbId,
      seriesTvdbId: c.series?.tvdbId ?? undefined,
      hashes,
      languages,
      useSceneName: s.search.useSceneName,
    });
  }

  /** Walk acceptable candidates best-first until one downloads and validates (R6.2, R6.5, R6.6). */
  private async downloadBest(
    searcher: SubtitleSearcher,
    query: SubtitleQuery,
    candidates: ScoredCandidate[],
    wanted: WantedLanguage,
    minScore: number,
    profile: LanguageProfile | null,
  ): Promise<Downloaded | null> {
    const s = this.settings();
    for (const cand of selectCandidates(query, candidates, wanted, { minScore })) {
      if (searcher.throttle.isThrottled(cand.provider)) continue;
      try {
        const prepared = await this.fetchPrepared(searcher, cand, query, wanted, profile);
        const hi = !wanted.forced && (cand.hi || (s.hearingImpaired.detectFromContent && prepared.looksHi && wanted.hi !== 'excluded'));
        return { candidate: cand, prepared, hi };
      } catch (err) {
        this.log.info({ provider: cand.provider, id: cand.id, err: err instanceof Error ? err.message : String(err) }, 'subtitle candidate failed');
      }
    }
    return null;
  }

  private async fetchPrepared(searcher: SubtitleSearcher, cand: SubtitleCandidate, query: SubtitleQuery, wanted: WantedLanguage, profile: LanguageProfile | null): Promise<PreparedSubtitle> {
    const raw = await searcher.download(cand, query);
    return prepareSubtitle(raw, {
      hints: {
        season: query.season,
        episode: cand.episode ?? query.episode,
        absoluteEpisode: query.absoluteEpisode,
        forced: wanted.forced,
        releaseName: query.sceneName ?? query.fileName,
        episodeTitle: query.episodeTitle,
      },
      language: cand.language,
      declaredEncoding: cand.encoding,
      convertToSrt: !(profile?.originalFormat ?? false),
      utf8: this.settings().naming.utf8Encode,
      fps: cand.fps ?? query.fps,
    });
  }

  /**
   * Search one media file for its missing languages, one language at a time (R5.6), re-checking
   * what is still missing before each (R5.4). Automatic runs honour the adaptive gate.
   */
  async searchFile(mediaFileId: number, opts: { ignoreBackoff?: boolean } = {}): Promise<FileSearchResult> {
    const result: FileSearchResult = { searched: 0, downloaded: 0, allThrottled: false };
    const c = this.loadFile(mediaFileId);
    if (!c.profile) return result;
    await this.indexFile(c);
    const missing = this.missingFor(c);
    if (missing.length === 0) return result;
    const providers = this.activeProviders(c.mediaType);
    if (providers.length === 0) return result;
    const searcher = this.searcher(providers, c.profile, c);
    if (searcher.available().length === 0) return { ...result, allThrottled: true };
    const s = this.settings();
    const base = await this.queryFor(c, []);
    for (const entry of missing) {
      const still = this.missingFor(c).some((e) => e.tag === entry.tag && e.forced === entry.forced && e.hi === entry.hi);
      if (!still) continue;
      const key = languageKey(toRef(entry));
      if (!opts.ignoreBackoff && !shouldSearch(this.attemptState(c.file.id, key), s.search, this.now())) continue;
      const wanted = toWantedLanguage(entry);
      const query: SubtitleQuery = { ...base, languages: [wanted] };
      result.searched++;
      const outcome = await searcher.search(query);
      if (outcome.allThrottled) {
        result.allThrottled = true;
        break;
      }
      const minScore = searcher.minScore(query.mediaType);
      let candidates = outcome.candidates;
      let got = await this.downloadBest(searcher, query, candidates, wanted, minScore, c.profile);
      let saved: SubtitleState | null = null;
      let retries = 0;
      while (got) {
        saved = await this.saveDownloaded(c, got, query, 'downloaded', false, null, true);
        // A sync check below autoRetryProviderBelow blacklists this one and tries the next candidate.
        if (!this.retryRequested.delete(saved.id) || retries >= s.sync.maxProviderRetries) break;
        retries++;
        const rejected = got.candidate;
        await this.rejectForSync(c, saved.id);
        saved = null;
        candidates = candidates.filter((x) => !(x.provider === rejected.provider && x.id === rejected.id));
        got = await this.downloadBest(searcher, query, candidates, wanted, minScore, c.profile);
      }
      if (saved) {
        this.clearAttempts(c.file.id, key);
        result.downloaded++;
      } else if (searcher.available().length > 0) {
        this.recordAttempt(c.file.id, key);
      }
    }
    return result;
  }

  private async saveDownloaded(
    c: FileContext,
    got: Downloaded,
    query: SubtitleQuery,
    action: SubtitleHistoryAction,
    manual: boolean,
    upgradedFromId: number | null = null,
    allowRetry = false,
  ): Promise<SubtitleState> {
    const report = matchReport(got.candidate.matches, query.mediaType);
    return this.saveSubtitle(c, {
      language: got.candidate.language,
      forced: got.candidate.forced,
      hi: got.hi,
      bytes: got.prepared.file.bytes,
      format: got.prepared.file.format,
      provider: got.candidate.provider,
      providerSubtitleId: got.candidate.id,
      score: got.candidate.score,
      scoreOutOf: maxScore(c.mediaType),
      matched: report.matched,
      notMatched: report.notMatched,
      action,
      manual,
      upgradedFromId,
      releaseInfo: got.candidate.releaseInfo,
      uploader: got.candidate.uploader,
      allowRetry,
    });
  }

  subtitlePath(c: FileContext, language: string, forced: boolean, hi: boolean, format: SubtitleFormat): string {
    const s = this.settings();
    const folderPath = s.naming.folderPath.trim();
    const folder =
      s.naming.folder === 'absolute' && folderPath
        ? ({ mode: 'absolute', path: folderPath } as const)
        : s.naming.folder === 'relative' && folderPath
          ? ({ mode: 'relative', name: folderPath } as const)
          : ({ mode: 'current' } as const);
    return nameSubtitleFile(c.file.path, language, { forced, hi }, { hiExtension: s.naming.hiExtension, singleLanguage: s.naming.singleLanguage, format, folder });
  }

  /** Write a subtitle (R9.5), record state + history, post-process (R11.1), notify. */
  private async saveSubtitle(c: FileContext, input: SaveInput): Promise<SubtitleState> {
    const s = this.settings();
    const path = this.subtitlePath(c, input.language, input.forced, input.hi, input.format);
    // R1.3: one subtitle per (item, language, forced, HI); a new one replaces the old.
    const same = this.rowsFor(c.file.id).filter((r) => !r.embedded && r.path && r.language === input.language && r.forced === input.forced && r.hi === input.hi);
    for (const r of same) if (r.path !== path) await rm(r.path!, { force: true });
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, input.bytes);
    await rename(tmp, path);
    const now = this.iso();
    const percent = input.score !== null && input.scoreOutOf ? round2((input.score / input.scoreOutOf) * 100) : null;
    const row = this.db.transaction((tx) => {
      if (same.length) tx.delete(subtitleFiles).where(inArray(subtitleFiles.id, same.map((r) => r.id))).run();
      tx.delete(subtitleFiles).where(and(eq(subtitleFiles.mediaFileId, c.file.id), eq(subtitleFiles.path, path))).run();
      return tx
        .insert(subtitleFiles)
        .values({
          mediaFileId: c.file.id,
          language: input.language,
          forced: input.forced,
          hi: input.hi,
          path,
          embedded: false,
          provider: input.provider,
          providerSubtitleId: input.providerSubtitleId,
          score: input.score,
          scoreOutOf: input.scoreOutOf,
          size: input.bytes.byteLength,
          mtime: now,
          added: now,
        })
        .returning()
        .get();
    });
    const ref = { language: input.language, forced: input.forced, hi: input.hi };
    const verb = { downloaded: 'downloaded', manualDownload: 'manually downloaded', upgraded: 'upgraded', uploaded: 'uploaded', extracted: 'extracted', synced: 'synced', translated: 'translated', deleted: 'deleted' }[input.action];
    this.writeHistory(c, {
      action: input.action,
      description: describeAction(ref, verb, input.provider, percent),
      ...ref,
      provider: input.provider,
      providerSubtitleId: input.providerSubtitleId,
      score: input.score,
      scoreOutOf: input.scoreOutOf,
      subtitlePath: path,
      matched: input.matched,
      notMatched: input.notMatched,
      upgradedFromId: input.upgradedFromId ?? null,
    });

    if (input.postProcess !== false) {
      await this.postProcess(c, row, { percent: percent ?? 100, manual: input.manual, releaseInfo: input.releaseInfo, uploader: input.uploader, allowRetry: input.allowRetry ?? false });
    }
    try {
      const st = await stat(path);
      this.db.update(subtitleFiles).set({ size: st.size, mtime: st.mtime.toISOString() }).where(eq(subtitleFiles.id, row.id)).run();
    } catch {
      // The post-processing command may have moved it; the next scan reconciles.
    }
    if (!input.manual || s.notifyManualActions) await this.notifyDownloaded(c, ref, input.provider, path, percent);
    this.publish(input.action === 'upgraded' ? 'upgraded' : input.action === 'uploaded' ? 'uploaded' : 'downloaded', c);
    const fresh = this.db.select().from(subtitleFiles).where(eq(subtitleFiles.id, row.id)).get();
    return toState(fresh ?? row);
  }

  private writeHistory(
    c: FileContext,
    h: Omit<typeof subtitleHistory.$inferInsert, 'id' | 'mediaType' | 'seriesId' | 'movieId' | 'episodeIds' | 'mediaFileId' | 'title' | 'videoPath' | 'date'>,
  ): HistoryRow {
    return this.db
      .insert(subtitleHistory)
      .values({
        ...h,
        mediaType: c.mediaType,
        seriesId: c.file.seriesId,
        movieId: c.file.movieId,
        episodeIds: c.episodes.map((e) => e.id),
        mediaFileId: c.file.id,
        title: this.displayTitle(c),
        videoPath: c.file.path,
        date: this.iso(),
      })
      .returning()
      .get();
  }

  private async notifyDownloaded(c: FileContext, ref: SubtitleLanguageRef, provider: string, path: string, percent: number | null): Promise<void> {
    if (!this.opts.notify || !this.opts.describeMedia) return;
    const mediaId = c.mediaType === 'series' ? c.series?.id : c.movie?.id;
    if (mediaId === undefined) return;
    try {
      const media = this.opts.describeMedia(c.mediaType, mediaId);
      if (!media) return;
      await this.opts.notify({
        type: 'subtitleDownloaded',
        instanceName: 'Arclight',
        timestamp: this.iso(),
        media,
        ...(c.episodes.length
          ? {
              episodes: c.episodes.map((e) => ({
                id: e.id,
                seasonNumber: e.seasonNumber,
                episodeNumber: e.episodeNumber,
                title: e.title,
                ...(e.absoluteEpisodeNumber !== null ? { absoluteEpisodeNumber: e.absoluteEpisodeNumber } : {}),
                ...(e.airDate ? { airDate: e.airDate } : {}),
              })),
            }
          : {}),
        subtitle: { language: ref.language, provider, path, ...(percent !== null ? { score: percent } : {}), forced: ref.forced, hearingImpaired: ref.hi },
      });
    } catch (err) {
      this.log.warn({ err }, 'subtitle notification failed');
    }
  }

  // ---- post-processing ------------------------------------------------------------------------

  private async postProcess(
    c: FileContext,
    row: SubtitleRow,
    info: { percent: number; manual: boolean; releaseInfo?: string | undefined; uploader?: string | undefined; allowRetry?: boolean },
  ): Promise<void> {
    const s = this.settings();
    const series = c.mediaType === 'series';
    const syncSettings = {
      enabled: s.sync.enabled,
      useThreshold: series ? s.sync.useThresholdSeries : s.sync.useThresholdMovie,
      threshold: series ? s.sync.thresholdSeries : s.sync.thresholdMovie,
      blacklistedProviders: s.sync.blacklistedProviders,
    };
    let synced = false;
    if (row.path && shouldSync(syncSettings, { forced: row.forced, provider: row.provider ?? 'manual', percent: info.percent })) {
      try {
        const r = await this.runSyncTool(c, row.path);
        synced = r.ok;
        if (r.ok) this.writeHistory(c, { action: 'synced', description: r.message, language: row.language, forced: row.forced, hi: row.hi, provider: row.provider, providerSubtitleId: row.providerSubtitleId, score: null, scoreOutOf: null, subtitlePath: row.path, matched: [], notMatched: [] });
        else this.log.warn({ path: row.path, message: r.message }, 'subtitle sync failed');
      } catch (err) {
        this.log.warn({ err }, 'subtitle sync failed');
      }
    }
    if (row.path && s.sync.autoCheck) {
      try {
        const r = await this.checkAndAct(c, row.id, { fixed: synced, fromProvider: info.allowRetry ?? false });
        if (r.retry) this.retryRequested.add(row.id);
      } catch (err) {
        this.log.warn({ err: err instanceof Error ? err.message : String(err), path: row.path }, 'subtitle sync check failed');
      }
    }
    const useThreshold = series ? s.postProcessing.useThresholdSeries : s.postProcessing.useThresholdMovie;
    const threshold = series ? s.postProcessing.thresholdSeries : s.postProcessing.thresholdMovie;
    if (row.path && s.postProcessing.command.trim() && shouldPostProcess(s.postProcessing.enabled, useThreshold, threshold, info.percent)) {
      try {
        const audio = c.file.mediaInfo?.audioLanguages?.[0];
        const audioTag = audio ? parseLanguageTag(audio) : undefined;
        const cmd = buildPostProcessCommand(
          s.postProcessing.command,
          {
            videoPath: c.file.path,
            subtitlePath: row.path,
            language: row.language,
            forced: row.forced,
            hi: row.hi,
            audioLanguage: audioTag,
            percent: info.percent,
            subtitleId: row.providerSubtitleId ?? '1',
            provider: row.provider ?? 'manual',
            uploader: info.uploader ?? (row.provider === 'manual' ? 'user' : undefined),
            releaseInfo: info.releaseInfo ?? 'unknown',
            seriesId: c.file.seriesId ?? undefined,
            episodeId: c.mediaType === 'series' ? c.episodes[0]?.id : c.file.movieId ?? undefined,
          },
          s.postProcessing.timeoutMs,
        );
        const r = await this.runner(cmd.command, cmd.args, { timeoutMs: cmd.timeoutMs, env: cmd.env });
        this.log.info({ command: cmd.command, exitCode: r.exitCode, stdout: r.stdout.toString('utf8').slice(-2000), stderr: r.stderr.slice(-2000) }, 'subtitle post-processing finished');
      } catch (err) {
        this.log.warn({ err }, 'subtitle post-processing failed');
      }
    }
  }

  /** Run the sync tool; the synced output replaces the original only on success (R11.13, R17.8). */
  private async runSyncTool(c: FileContext, subtitlePath: string): Promise<{ ok: boolean; message: string }> {
    const s = this.settings();
    const output = syncedOutputPath(subtitlePath);
    const binary = s.sync.binaryPath.trim() || undefined;
    const cmd =
      s.sync.tool === 'alass'
        ? buildAlassCommand({ binary, reference: c.file.path, subtitle: subtitlePath, output, disableFpsGuessing: s.sync.noFixFramerate, timeoutMs: s.sync.timeoutMs })
        : buildFfsubsyncCommand({
            binary,
            reference: c.file.path,
            subtitle: subtitlePath,
            output,
            maxOffsetSeconds: s.sync.maxOffsetSeconds,
            noFixFramerate: s.sync.noFixFramerate,
            gss: s.sync.gss,
            timeoutMs: s.sync.timeoutMs,
          });
    const r = await this.runner(cmd.command, cmd.args, { timeoutMs: cmd.timeoutMs });
    if (!r.ok || !(await exists(output))) {
      await rm(output, { force: true });
      return { ok: false, message: r.error ?? (r.stderr.trim().split('\n').pop() || 'sync tool produced no output') };
    }
    await rename(output, subtitlePath);
    const text = `${r.stdout.toString('utf8')}\n${r.stderr}`;
    const offset = /offset seconds:\s*(-?[\d.]+)/i.exec(text)?.[1];
    const ratio = /framerate scale factor:\s*([\d.]+)/i.exec(text)?.[1];
    const lang = languageName(this.db.select({ l: subtitleFiles.language }).from(subtitleFiles).where(eq(subtitleFiles.path, subtitlePath)).get()?.l ?? 'und');
    return {
      ok: true,
      message: offset !== undefined
        ? `${lang} subtitles synchronization ended with an offset of ${offset} seconds and a framerate scale factor of ${ratio ?? '1.000'}.`
        : `${lang} subtitles synchronized with ${s.sync.tool}.`,
    };
  }

  // ---- sync-quality scoring -----------------------------------------------------------------------

  /** Measure the sync of an external subtitle (builtin audio correlation or the sync tool in check mode). */
  private async measureSync(c: FileContext, row: SubtitleRow): Promise<SyncEstimate> {
    if (!row.path) throw new SubtitlesError('UNSUPPORTED', 'only external subtitles can be checked');
    const s = this.settings();
    const cues = parseCues(decodeSubtitle(new Uint8Array(await readFile(row.path)), { language: row.language }).text, row.path);
    if (s.sync.checkMethod === 'tool') {
      const cmd = buildSyncCheckCommand({
        tool: s.sync.tool,
        binary: s.sync.binaryPath.trim() || undefined,
        video: c.file.path,
        subtitle: row.path,
        maxOffsetSeconds: s.sync.maxOffsetSeconds,
        gss: s.sync.gss,
        timeoutMs: s.sync.timeoutMs,
      });
      try {
        const r = await this.runner(cmd.command, cmd.args, { timeoutMs: cmd.timeoutMs });
        if (!r.ok || !(await exists(cmd.output))) {
          throw new SubtitlesError('FAILED', `${s.sync.tool} check failed: ${r.error ?? (r.stderr.trim().split('\n').pop() || 'no output')}`);
        }
        const corrected = parseCues(decodeSubtitle(new Uint8Array(await readFile(cmd.output))).text, cmd.output);
        return compareTimings(cues, corrected, s.sync.tool);
      } finally {
        await rm(cmd.output, { force: true });
      }
    }
    const lastCue = cues.length ? cues[cues.length - 1]!.startMs : 0;
    const windows = planAudioWindows(lastCue, s.sync.checkWindowMinutes * 60_000);
    const speech: TimeInterval[] = [];
    for (const window of windows) {
      const cmd = buildAudioActivityCommand({ ffmpegPath: s.embedded.ffmpegPath, input: c.file.path, window, detector: s.sync.audioDetector });
      const r = await this.runner(cmd.command, cmd.args, { timeoutMs: cmd.timeoutMs });
      if (!r.ok) throw new SubtitlesError('FAILED', `audio analysis failed: ${r.error ?? r.stderr.slice(-300)}`);
      speech.push(...(s.sync.audioDetector === 'ebur128' ? parseEbur128(r.stderr, window) : parseSilenceDetect(r.stderr, window)));
    }
    return estimateSync(speech, cues, { windows, maxOffsetMs: s.sync.maxOffsetSeconds * 1000 });
  }

  /** Store a measurement on the subtitle row and on the history entry that wrote the file. */
  private storeSync(row: SubtitleRow, e: SyncEstimate): void {
    this.db
      .update(subtitleFiles)
      .set({ syncScore: e.syncScore, syncOffsetMs: e.offsetMs, syncDriftPpm: e.driftPpm, syncCheckedAt: this.iso(), syncMethod: e.method })
      .where(eq(subtitleFiles.id, row.id))
      .run();
    if (!row.path) return;
    const h = this.db
      .select({ id: subtitleHistory.id })
      .from(subtitleHistory)
      .where(and(eq(subtitleHistory.subtitlePath, row.path), inArray(subtitleHistory.action, ['downloaded', 'manualDownload', 'upgraded', 'uploaded'])))
      .orderBy(desc(subtitleHistory.id))
      .get();
    if (h) this.db.update(subtitleHistory).set({ syncScore: e.syncScore, syncOffsetMs: e.offsetMs, syncDriftPpm: e.driftPpm }).where(eq(subtitleHistory.id, h.id)).run();
  }

  /**
   * Check, then apply the `subtitles.sync` auto actions: below autoFixBelow run the sync tool and
   * check again; below autoRetryProviderBelow (after any fix) report `retry` for provider downloads.
   */
  private async checkAndAct(c: FileContext, id: number, o: { fixed: boolean; fromProvider: boolean }): Promise<{ check: SyncEstimate; actions: string[]; retry: boolean }> {
    const s = this.settings();
    const actions: string[] = [];
    let row = this.stateRow(id);
    let check = await this.measureSync(c, row);
    this.storeSync(row, check);
    let action = syncAutoAction(check, s.sync, { fixed: o.fixed, fromProvider: o.fromProvider });
    if (action === 'fix' && row.path) {
      const r = await this.runSyncTool(c, row.path);
      if (r.ok) {
        actions.push('fixed');
        this.writeHistory(c, { action: 'synced', description: r.message, language: row.language, forced: row.forced, hi: row.hi, provider: row.provider, providerSubtitleId: row.providerSubtitleId, score: null, scoreOutOf: null, subtitlePath: row.path, matched: [], notMatched: [] });
        row = this.stateRow(id);
        check = await this.measureSync(c, row);
        this.storeSync(row, check);
      } else {
        this.log.warn({ path: row.path, message: r.message }, 'automatic subtitle sync failed');
      }
      action = syncAutoAction(check, s.sync, { fixed: true, fromProvider: o.fromProvider });
    }
    const retry = action === 'retry';
    if (retry) actions.push('retried');
    this.log.info({ path: row.path, score: check.syncScore, offsetMs: check.offsetMs, driftPpm: check.driftPpm, actions }, 'subtitle sync checked');
    return { check, actions, retry };
  }

  /** Blacklist a just-downloaded subtitle whose sync score is too low (the caller tries the next one). */
  private async rejectForSync(c: FileContext, id: number): Promise<void> {
    const row = this.stateRow(id);
    if (!row.provider || !row.providerSubtitleId) return;
    this.insertBlacklist(c, row.provider, row.providerSubtitleId, { language: row.language, forced: row.forced, hi: row.hi });
    if (row.path) await rm(row.path, { force: true });
    this.db.delete(subtitleFiles).where(eq(subtitleFiles.id, row.id)).run();
    this.writeHistory(c, {
      action: 'deleted',
      description: `${languageName(row.language)} subtitles from ${providerName(row.provider)} blacklisted: sync score ${row.syncScore ?? '?'} is below ${this.settings().sync.autoRetryProviderBelow}.`,
      language: row.language,
      forced: row.forced,
      hi: row.hi,
      provider: row.provider,
      providerSubtitleId: row.providerSubtitleId,
      score: null,
      scoreOutOf: null,
      subtitlePath: row.path,
      matched: [],
      notMatched: [],
      syncScore: row.syncScore,
      syncOffsetMs: row.syncOffsetMs,
      syncDriftPpm: row.syncDriftPpm,
    });
    this.publish('blacklisted', c);
  }

  /** POST /subtitle/:id/synccheck: measure now and store the result (no auto actions). */
  async syncCheck(id: number): Promise<SubtitleSyncCheckResult> {
    const row = this.stateRow(id);
    if (row.embedded || !row.path) throw new SubtitlesError('UNSUPPORTED', 'only external subtitles can be checked');
    const c = this.loadFile(row.mediaFileId);
    let check: SyncEstimate;
    try {
      check = await this.measureSync(c, row);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), check: null, actions: [], subtitle: toState(row) };
    }
    this.storeSync(row, check);
    this.publish('synced', c);
    return { ok: check.reliable, message: check.message, check: toCheck(check), actions: [], subtitle: toState(this.stateRow(id)) };
  }

  /** SubtitleSyncCheck job: score external subtitles never checked, applying the auto actions. */
  async syncCheckBatch(signal?: AbortSignal): Promise<string> {
    const s = this.settings();
    if (!s.sync.autoCheck) return 'Sync checks are off (subtitle settings: sync.autoCheck)';
    const rows = this.db
      .select()
      .from(subtitleFiles)
      .where(and(eq(subtitleFiles.embedded, false), isNotNull(subtitleFiles.path), isNull(subtitleFiles.syncCheckedAt)))
      .orderBy(asc(subtitleFiles.id))
      .limit(s.sync.checkBatchSize)
      .all();
    const out = { checked: 0, unreliable: 0, fixed: 0, retried: 0, failed: 0 };
    for (const row of rows) {
      if (signal?.aborted) break;
      try {
        const c = this.loadFile(row.mediaFileId);
        const fromProvider = Boolean(row.provider && row.providerSubtitleId && row.provider !== 'manual' && row.provider !== 'embeddedsubtitles');
        const r = await this.checkAndAct(c, row.id, { fixed: false, fromProvider });
        out.checked++;
        if (!r.check.reliable) out.unreliable++;
        if (r.actions.includes('fixed')) out.fixed++;
        if (r.retry) {
          await this.blacklist(row.id, true);
          out.retried++;
        }
      } catch (err) {
        out.failed++;
        // Mark it checked so one broken file does not block the queue.
        this.db.update(subtitleFiles).set({ syncCheckedAt: this.iso() }).where(eq(subtitleFiles.id, row.id)).run();
        this.log.warn({ err: err instanceof Error ? err.message : String(err), subtitleId: row.id }, 'subtitle sync check failed');
      }
    }
    if (out.checked) this.publish('synced');
    return `Checked ${out.checked} subtitle(s) (${out.unreliable} not measurable): ${out.fixed} fixed, ${out.retried} re-searched, ${out.failed} failed`;
  }

  // ---- whisper ------------------------------------------------------------------------------------

  private probeWhisperUrl(url: string): Promise<WhisperProbeResult> {
    if (this.opts.probeWhisper) return this.opts.probeWhisper(url);
    return probeWhisperService(url, { ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}), timeoutMs: 5000 });
  }

  /**
   * WhisperAutoDetect: when ARCLIGHT_WHISPER_URL answers, register the whisperai provider last in
   * the priority list with onlyWhenNoOtherResult. A hand-configured entry is never touched; an
   * auto-registered one follows the URL.
   */
  async whisperAutoDetect(): Promise<string> {
    const url = this.opts.whisperUrl?.trim().replace(/\/+$/, '');
    if (!url) return 'ARCLIGHT_WHISPER_URL is not set';
    const s = this.settings();
    const entry = s.providers.find((p) => p.id === 'whisperai');
    if (entry && entry.settings[WHISPER_AUTO_KEY] !== true) return 'Whisper provider is configured by hand; left unchanged';
    if (entry && entry.settings['endpoint'] === url) return 'Whisper provider already registered';
    const probe = await this.probeWhisperUrl(url);
    if (!probe.ok) return `Whisper not detected: ${probe.message}`;
    const providers = entry
      ? s.providers.map((p) => (p.id === 'whisperai' ? { ...p, settings: { ...p.settings, endpoint: url } } : p))
      : [...s.providers, { id: 'whisperai' as const, enabled: true, settings: { endpoint: url, [ONLY_WHEN_NO_OTHER_RESULT]: true, [WHISPER_AUTO_KEY]: true } }];
    setSection(this.db, 'subtitles', { ...s, providers }, this.iso());
    this.providerCache.clear();
    this.publish('settings');
    const message = entry ? `Whisper endpoint updated to ${url}` : `Whisper provider registered at ${url} (lowest priority, only when no other result)`;
    this.log.info({ url }, message);
    return message;
  }

  /** GET /subtitle/whisper/status: the settings entry plus a live probe. */
  async whisperStatus(): Promise<SubtitleWhisperStatus> {
    const envUrl = this.opts.whisperUrl?.trim() || null;
    const entry = this.settings().providers.find((p) => p.id === 'whisperai');
    const raw = entry?.settings['endpoint'];
    const endpoint = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    const target = endpoint ?? envUrl;
    const probe = target ? await this.probeWhisperUrl(target) : null;
    return {
      envUrl,
      endpoint,
      registered: Boolean(entry),
      enabled: entry?.enabled ?? false,
      autoRegistered: entry?.settings[WHISPER_AUTO_KEY] === true,
      onlyWhenNoOtherResult: entry ? onlyWhenNoOtherResult(entry) : true,
      reachable: probe ? probe.ok : null,
      message: probe?.message ?? 'Whisper is not configured: set ARCLIGHT_WHISPER_URL or add the Whisper provider',
      checkedAt: this.iso(),
    };
  }

  // ---- upgrades ---------------------------------------------------------------------------------

  /** Upgrade recent downloads that scored below perfect (section 8). */
  async upgrade(signal?: AbortSignal): Promise<{ candidates: number; upgraded: number }> {
    const s = this.settings();
    const out = { candidates: 0, upgraded: 0 };
    if (!s.upgrade.enabled) return out;
    const since = new Date(this.now() - s.upgrade.windowDays * DAY_MS).toISOString();
    const eligibleActions = new Set<SubtitleHistoryAction>(['downloaded', 'upgraded', ...(s.upgrade.includeManual ? (['manualDownload', 'uploaded'] as const) : [])]);
    const considered = new Set<SubtitleHistoryAction>(['deleted', 'downloaded', 'upgraded', 'manualDownload', 'uploaded']);
    const rows = this.db.select().from(subtitleHistory).where(gte(subtitleHistory.date, since)).orderBy(desc(subtitleHistory.id)).all();
    const upgradedFrom = new Set(
      this.db.select({ id: subtitleHistory.upgradedFromId }).from(subtitleHistory).where(isNotNull(subtitleHistory.upgradedFromId)).all().map((r) => r.id!),
    );
    const seen = new Set<string>();
    const candidates: HistoryRow[] = [];
    for (const r of rows) {
      if (!considered.has(r.action)) continue;
      const key = `${r.videoPath}\u0000${languageKey(r)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!eligibleActions.has(r.action)) continue;
      if (r.score === null || r.scoreOutOf === null || r.score >= r.scoreOutOf - 3) continue;
      if (upgradedFrom.has(r.id) || r.mediaFileId === null) continue;
      candidates.push(r);
    }
    for (const h of candidates) {
      if (signal?.aborted) break;
      const c = (() => {
        try {
          return this.loadFile(h.mediaFileId!);
        } catch {
          return null;
        }
      })();
      if (!c || !c.profile || c.file.path !== h.videoPath || !this.eligible(c, s)) continue;
      const state = this.rowsFor(c.file.id).find((r) => !r.embedded && r.path === h.subtitlePath);
      if (!state || !state.path || !(await exists(state.path))) continue;
      const entry = desiredForUpgrade(c.profile, { language: h.language, forced: h.forced, hi: h.hi });
      if (!entry) continue;
      out.candidates++;
      const providers = this.activeProviders(c.mediaType);
      if (providers.length === 0) break;
      const searcher = this.searcher(providers, c.profile, c);
      if (searcher.available().length === 0) break;
      const wanted = toWantedLanguage(entry);
      const query = await this.queryFor(c, [wanted]);
      const outcome = await searcher.search(query);
      if (outcome.allThrottled) break;
      // R8.6: the new score must beat the stored one by two points, and pass the normal minimum.
      const minScore = Math.max(searcher.minScore(query.mediaType), h.score! + 2);
      const got = await this.downloadBest(searcher, query, outcome.candidates, wanted, minScore, c.profile);
      if (!got) continue;
      if (state.path) await rm(state.path, { force: true });
      this.db.delete(subtitleFiles).where(eq(subtitleFiles.id, state.id)).run();
      await this.saveDownloaded(c, got, query, 'upgraded', false, h.id);
      out.upgraded++;
    }
    return out;
  }

  // ---- jobs ---------------------------------------------------------------------------------------

  /** SubtitleSearchWanted: least recently searched first, up to the batch size. */
  async searchWanted(signal?: AbortSignal): Promise<string> {
    const s = this.settings();
    const attempts = this.attemptsByFile();
    const list = this.wantedContexts()
      .filter(({ c }) => this.eligible(c, s))
      .sort((a, b) => (attempts.get(a.c.file.id)?.lastSearch ?? '').localeCompare(attempts.get(b.c.file.id)?.lastSearch ?? ''));
    let searchedFiles = 0;
    let downloaded = 0;
    for (const { c } of list) {
      if (signal?.aborted || searchedFiles >= s.search.batchSize) break;
      const r = await this.searchFile(c.file.id);
      if (r.allThrottled) return `All providers throttled after ${searchedFiles} item(s); ${downloaded} subtitle(s) downloaded`;
      if (r.searched > 0) searchedFiles++;
      downloaded += r.downloaded;
    }
    return `Searched ${searchedFiles} of ${list.length} wanted item(s); ${downloaded} subtitle(s) downloaded`;
  }

  /** SubtitleScan: re-index every file and prune orphans. */
  async scanAll(signal?: AbortSignal): Promise<string> {
    const pruned = this.pruneOrphans();
    const files = this.db.select().from(mediaFiles).all();
    let scanned = 0;
    for (const f of files) {
      if (signal?.aborted) break;
      try {
        await this.indexFile(this.contextFor(f));
        scanned++;
      } catch (err) {
        this.log.warn({ err, mediaFileId: f.id }, 'subtitle scan failed');
      }
    }
    if (scanned) this.publish('scanned');
    return `Scanned ${scanned} file(s); pruned ${pruned} orphaned subtitle row(s)`;
  }

  /** Import hook: search the new file soon (R3.19) unless disabled. Returns immediately. */
  onImported(event: { file: { id: number } }): void {
    if (!this.settings().search.searchOnImport) return;
    this.detach(this.searchFile(event.file.id));
  }

  /** POST /command/subtitlesearch: ignores backoff and eligibility (Q12). */
  async commandSearch(cmd: SubtitleSearchCommand): Promise<SubtitleSearchCommandResult> {
    let ids: number[];
    if (cmd.mediaFileId !== undefined) ids = [cmd.mediaFileId];
    else if (cmd.episodeIds?.length) {
      ids = [...new Set(this.db.select({ f: episodes.episodeFileId }).from(episodes).where(inArray(episodes.id, cmd.episodeIds)).all().flatMap((r) => (r.f === null ? [] : [r.f])))];
    } else if (cmd.seriesId !== undefined) {
      const where = cmd.seasonNumber !== undefined ? and(eq(mediaFiles.seriesId, cmd.seriesId), eq(mediaFiles.seasonNumber, cmd.seasonNumber)) : eq(mediaFiles.seriesId, cmd.seriesId);
      ids = this.db.select({ id: mediaFiles.id }).from(mediaFiles).where(where).all().map((r) => r.id);
    } else if (cmd.movieId !== undefined) {
      ids = this.db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.movieId, cmd.movieId)).all().map((r) => r.id);
    } else throw new SubtitlesError('VALIDATION', 'a seriesId, episodeIds, movieId or mediaFileId is required');
    const out = { files: ids.length, searched: 0, downloaded: 0, message: '' };
    for (const id of ids) {
      const r = await this.searchFile(id, { ignoreBackoff: true });
      out.searched += r.searched;
      out.downloaded += r.downloaded;
      if (r.allThrottled) {
        out.message = 'All providers are throttled';
        return out;
      }
    }
    out.message = `Searched ${out.searched} language(s) in ${ids.length} file(s); ${out.downloaded} downloaded`;
    return out;
  }

  // ---- manual search / download / upload ------------------------------------------------------------

  private manualLanguages(c: FileContext, language: string | undefined): WantedLanguage[] {
    const profileEntries = c.profile ? missingEntries({ ...c.profile, cutoff: null }, [], { countEmbedded: true }) : [];
    if (language) {
      const tag = parseLanguageTag(language);
      if (!tag) throw new SubtitlesError('VALIDATION', `unknown language: ${language}`);
      const fromProfile = profileEntries.filter((e) => normalizeTag(e.tag) === tag);
      return fromProfile.length
        ? fromProfile.map(toWantedLanguage)
        : [
            { tag, forced: false, hi: 'normal' },
            { tag, forced: true, hi: 'normal' },
          ];
    }
    if (!profileEntries.length) throw new SubtitlesError('VALIDATION', 'the item has no language profile; pick a language');
    return profileEntries.map(toWantedLanguage);
  }

  async manualSearch(mediaFileId: number, language?: string): Promise<SubtitleManualSearchResponse> {
    const c = this.loadFile(mediaFileId);
    const languages = this.manualLanguages(c, language);
    const providers = this.activeProviders(c.mediaType);
    if (providers.length === 0) return { results: [], errors: [], throttled: [], allThrottled: false };
    const searcher = this.searcher(providers, c.profile, c);
    const query = await this.queryFor(c, languages);
    const { rows, outcome } = await searcher.manualSearch(query);
    const now = this.now();
    for (const [k, v] of this.manualCache) if (v.expiresAt <= now) this.manualCache.delete(k);
    const results: SubtitleSearchResult[] = rows.map((row) => {
      const cand = row.candidate;
      const wanted = languages.find((w) => w.tag === cand.language && w.forced === cand.forced) ?? { tag: cand.language, forced: cand.forced, hi: 'normal' as const };
      const key = randomUUID();
      this.manualCache.set(key, { mediaFileId, candidate: cand, wanted, query, expiresAt: now + MANUAL_CACHE_MS });
      const report = matchReport(cand.matches, query.mediaType);
      return {
        key,
        provider: cand.provider,
        providerSubtitleId: cand.id,
        language: cand.language,
        forced: cand.forced,
        hi: cand.hi,
        releaseInfo: cand.releaseInfo.split(/\r?\n/).filter(Boolean),
        uploader: cand.uploader ?? null,
        score: cand.score,
        scoreWithoutHash: cand.scoreWithoutHash,
        scoreOutOf: maxScore(c.mediaType),
        percent: scorePercent(cand.score, query.mediaType),
        matches: report.matched,
        dontMatches: report.notMatched,
        url: cand.pageUrl ?? cand.downloadUrl ?? null,
        hashVerifiable: cand.hashVerifiable,
        hiVerifiable: cand.hiVerifiable,
      };
    });
    return {
      results,
      errors: outcome.errors.map((e) => ({ provider: e.provider, message: e.error.message })),
      throttled: [...new Set(outcome.throttled)],
      allThrottled: outcome.allThrottled,
    };
  }

  async manualDownload(mediaFileId: number, key: string): Promise<SubtitleState> {
    const cached = this.manualCache.get(key);
    if (!cached || cached.expiresAt <= this.now()) throw new SubtitlesError('EXPIRED', 'search result expired; search again');
    if (cached.mediaFileId !== mediaFileId) throw new SubtitlesError('VALIDATION', 'search result belongs to another file');
    const c = this.loadFile(mediaFileId);
    if (cached.wanted.hi === 'excluded' && cached.candidate.hi) throw new SubtitlesError('VALIDATION', 'HI subtitles are excluded for this language');
    const providers = this.activeProviders(c.mediaType);
    if (!providers.some((p) => p.kind === cached.candidate.provider)) throw new SubtitlesError('VALIDATION', `provider ${cached.candidate.provider} is not enabled`);
    const searcher = this.searcher(providers, c.profile, c);
    let prepared: PreparedSubtitle;
    try {
      prepared = await this.fetchPrepared(searcher, cached.candidate, cached.query, cached.wanted, c.profile);
    } catch (err) {
      throw new SubtitlesError('FAILED', `download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const s = this.settings();
    const hi = !cached.candidate.forced && (cached.candidate.hi || (s.hearingImpaired.detectFromContent && prepared.looksHi && cached.wanted.hi !== 'excluded'));
    this.manualCache.delete(key);
    const state = await this.saveDownloaded(c, { candidate: cached.candidate, prepared, hi }, cached.query, 'manualDownload', true);
    this.clearAttempts(c.file.id, languageKey(state));
    return state;
  }

  async upload(fields: { mediaFileId: number; language: string; forced: boolean; hi: boolean }, bytes: Uint8Array, fileName: string): Promise<SubtitleState> {
    const c = this.loadFile(fields.mediaFileId);
    const tag = parseLanguageTag(fields.language);
    if (!tag) throw new SubtitlesError('VALIDATION', `unknown language: ${fields.language}`);
    const ext = extname(fileName).slice(1).toLowerCase();
    if (ext && !SUBTITLE_EXTENSIONS.has(ext)) throw new SubtitlesError('VALIDATION', `not a subtitle file: ${fileName}`);
    let prepared: PreparedSubtitle;
    try {
      prepared = prepareSubtitle(
        { bytes, format: detectFormatFromBytes(bytes, fileName), encoding: 'unknown', fileName },
        { language: tag, convertToSrt: !(c.profile?.originalFormat ?? false), utf8: this.settings().naming.utf8Encode },
      );
    } catch (err) {
      throw new SubtitlesError('VALIDATION', `invalid subtitle: ${err instanceof Error ? err.message : String(err)}`);
    }
    const max = maxScore(c.mediaType);
    const state = await this.saveSubtitle(c, {
      language: tag,
      forced: fields.forced,
      hi: fields.forced ? false : fields.hi,
      bytes: prepared.file.bytes,
      format: TEXT_FORMATS.has(prepared.file.format) ? prepared.file.format : 'srt',
      provider: 'manual',
      providerSubtitleId: null,
      score: max,
      scoreOutOf: max,
      matched: [],
      notMatched: [],
      action: 'uploaded',
      manual: true,
      uploader: 'user',
      releaseInfo: 'unknown',
    });
    this.clearAttempts(c.file.id, languageKey(state));
    return state;
  }

  private stateRow(id: number): SubtitleRow {
    const row = this.db.select().from(subtitleFiles).where(eq(subtitleFiles.id, id)).get();
    if (!row) throw new SubtitlesError('NOT_FOUND', `subtitle ${id} not found`);
    return row;
  }

  /** Delete an external subtitle file (R9.7). */
  async delete(id: number): Promise<void> {
    const row = this.stateRow(id);
    if (row.embedded || !row.path) throw new SubtitlesError('UNSUPPORTED', 'embedded subtitles cannot be deleted');
    const ext = extname(row.path).slice(1).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(ext)) throw new SubtitlesError('UNSUPPORTED', 'refusing to delete a non-subtitle file');
    const c = this.loadFile(row.mediaFileId);
    await rm(row.path, { force: true });
    this.db.delete(subtitleFiles).where(eq(subtitleFiles.id, id)).run();
    this.writeHistory(c, {
      action: 'deleted',
      description: `${languageName(row.language)}${row.forced ? ' forced' : row.hi ? ' HI' : ''} subtitles deleted.`,
      language: row.language,
      forced: row.forced,
      hi: row.hi,
      provider: row.provider,
      providerSubtitleId: row.providerSubtitleId,
      score: null,
      scoreOutOf: null,
      subtitlePath: row.path,
      matched: [],
      notMatched: [],
    });
    this.publish('deleted', c);
  }

  /** Manual sync from the UI (R11.17): ignores thresholds. */
  async sync(id: number): Promise<SubtitleSyncResult> {
    const row = this.stateRow(id);
    if (row.embedded || !row.path) throw new SubtitlesError('UNSUPPORTED', 'only external subtitles can be synchronized');
    const c = this.loadFile(row.mediaFileId);
    const r = await this.runSyncTool(c, row.path);
    if (r.ok) {
      this.writeHistory(c, { action: 'synced', description: r.message, language: row.language, forced: row.forced, hi: row.hi, provider: row.provider, providerSubtitleId: row.providerSubtitleId, score: null, scoreOutOf: null, subtitlePath: row.path, matched: [], notMatched: [] });
      try {
        const st = await stat(row.path);
        this.db.update(subtitleFiles).set({ size: st.size, mtime: st.mtime.toISOString() }).where(eq(subtitleFiles.id, id)).run();
      } catch {
        // reconciled on the next scan
      }
      this.publish('synced', c);
    }
    return { ok: r.ok, message: r.message, subtitle: toState(this.stateRow(id)) };
  }

  /** Copy an embedded text track out to a subtitle file (R7.10, R7.11). */
  async extract(id: number): Promise<SubtitleState> {
    const row = this.stateRow(id);
    if (!row.embedded || row.streamIndex === null || !row.codec) throw new SubtitlesError('UNSUPPORTED', 'not an embedded track with a known stream');
    if (!TEXT_CODECS.has(row.codec)) throw new SubtitlesError('UNSUPPORTED', 'bitmap subtitles not supported');
    const c = this.loadFile(row.mediaFileId);
    const s = this.settings();
    const format = codecFormat(row.codec);
    const target = this.subtitlePath(c, row.language, row.forced, row.hi, format);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    const argv = buildSubtitleExtractArgs({ ffmpegPath: s.embedded.ffmpegPath, input: c.file.path, streamIndex: row.streamIndex, codec: row.codec, output: tmp });
    const r = await this.runner(argv[0]!, argv.slice(1), { timeoutMs: 600_000 });
    if (!r.ok || !(await exists(tmp))) {
      await rm(tmp, { force: true });
      throw new SubtitlesError('FAILED', `extraction failed: ${r.error ?? r.stderr.slice(-300)}`);
    }
    const bytes = new Uint8Array(await readFile(tmp));
    await rm(tmp, { force: true });
    const max = maxScore(c.mediaType);
    return this.saveSubtitle(c, {
      language: row.language,
      forced: row.forced,
      hi: row.hi,
      bytes,
      format,
      provider: 'embeddedsubtitles',
      providerSubtitleId: `stream:${row.streamIndex}`,
      score: max,
      scoreOutOf: max,
      matched: [],
      notMatched: [],
      action: 'extracted',
      manual: true,
      postProcess: false,
    });
  }

  // ---- history and blacklist --------------------------------------------------------------------------

  history(q: SubtitleHistoryQuery): SubtitleHistoryPage {
    const where = [
      q.mediaType ? eq(subtitleHistory.mediaType, q.mediaType) : undefined,
      q.action ? eq(subtitleHistory.action, q.action) : undefined,
      q.provider ? eq(subtitleHistory.provider, q.provider) : undefined,
      q.seriesId !== undefined ? eq(subtitleHistory.seriesId, q.seriesId) : undefined,
      q.movieId !== undefined ? eq(subtitleHistory.movieId, q.movieId) : undefined,
      q.mediaFileId !== undefined ? eq(subtitleHistory.mediaFileId, q.mediaFileId) : undefined,
    ].filter((w) => w !== undefined);
    const cond = where.length ? and(...where) : undefined;
    const total = this.db.select({ n: count() }).from(subtitleHistory).where(cond).get()?.n ?? 0;
    const records = this.db
      .select()
      .from(subtitleHistory)
      .where(cond)
      .orderBy(desc(subtitleHistory.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .all()
      .map(toHistory);
    return { page: q.page, pageSize: q.pageSize, totalRecords: total, records };
  }

  private insertBlacklist(c: FileContext, provider: string, providerSubtitleId: string, ref: SubtitleLanguageRef): SubtitleBlacklistRecord {
    const row = this.db
      .insert(subtitleBlacklist)
      .values({
        provider,
        providerSubtitleId,
        ...ref,
        mediaType: c.mediaType,
        seriesId: c.file.seriesId,
        movieId: c.file.movieId,
        mediaFileId: c.file.id,
        title: this.displayTitle(c),
        date: this.iso(),
      })
      .onConflictDoUpdate({ target: [subtitleBlacklist.provider, subtitleBlacklist.providerSubtitleId], set: { date: this.iso() } })
      .returning()
      .get();
    return toBlacklist(row);
  }

  isBlacklisted(provider: string, providerSubtitleId: string): boolean {
    return Boolean(
      this.db
        .select({ id: subtitleBlacklist.id })
        .from(subtitleBlacklist)
        .where(and(eq(subtitleBlacklist.provider, provider), eq(subtitleBlacklist.providerSubtitleId, providerSubtitleId)))
        .get(),
    );
  }

  /** Blacklist a downloaded subtitle: entry, delete the file, history, then search again (R10.6). */
  async blacklist(subtitleId: number, search: boolean): Promise<SubtitleBlacklistRecord> {
    const row = this.stateRow(subtitleId);
    if (!row.provider || !row.providerSubtitleId || row.provider === 'manual' || row.embedded) {
      throw new SubtitlesError('UNSUPPORTED', 'only subtitles downloaded from a provider can be blacklisted');
    }
    const c = this.loadFile(row.mediaFileId);
    const record = this.insertBlacklist(c, row.provider, row.providerSubtitleId, { language: row.language, forced: row.forced, hi: row.hi });
    if (row.path) await rm(row.path, { force: true });
    this.db.delete(subtitleFiles).where(eq(subtitleFiles.id, row.id)).run();
    this.writeHistory(c, {
      action: 'deleted',
      description: `${languageName(row.language)} subtitles from ${providerName(row.provider)} blacklisted and deleted.`,
      language: row.language,
      forced: row.forced,
      hi: row.hi,
      provider: row.provider,
      providerSubtitleId: row.providerSubtitleId,
      score: null,
      scoreOutOf: null,
      subtitlePath: row.path,
      matched: [],
      notMatched: [],
    });
    this.publish('blacklisted', c);
    if (search) this.detach(this.searchFile(c.file.id, { ignoreBackoff: true }));
    return record;
  }

  listBlacklist(page: number, pageSize: number): SubtitleBlacklistPage {
    const total = this.db.select({ n: count() }).from(subtitleBlacklist).get()?.n ?? 0;
    const records = this.db
      .select()
      .from(subtitleBlacklist)
      .orderBy(desc(subtitleBlacklist.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all()
      .map(toBlacklist);
    return { page, pageSize, totalRecords: total, records };
  }

  removeBlacklist(id: number): void {
    const res = this.db.delete(subtitleBlacklist).where(eq(subtitleBlacklist.id, id)).run();
    if (res.changes === 0) throw new SubtitlesError('NOT_FOUND', `blacklist entry ${id} not found`);
    this.publish('blacklisted');
  }

  clearBlacklist(): void {
    this.db.delete(subtitleBlacklist).run();
    this.publish('blacklisted');
  }
}

