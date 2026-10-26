import { and, eq, gte, inArray } from 'drizzle-orm';
import { mkdir, readdir, stat, statfs, utimes } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse as parsePathParts, relative, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import {
  buildEpisodeFileName,
  buildMovieFileName,
  buildSeasonFolder,
  getSamples,
  type NamingFile,
} from '@media-tron/organizer';
import { parsePath, parseRelease, type ParsedQuality, type ParsedRelease } from '@media-tron/parser';
import { scoreRelease } from '@media-tron/profiles-engine';
import {
  MediaManagementSettings,
  MovieListQuery,
  NamingConfig,
  SeriesListQuery,
  type CustomFormat,
  type Episode,
  type FileSystemEntry,
  type FileSystemListing,
  type FileSystemMkdirRequest,
  type FileSystemQuery,
  type ImportRejection,
  type ManualImportItem,
  type ManualImportQuery,
  type ManualImportRequest,
  type ManualImportResult,
  type MediaFile,
  type MediaType,
  type Movie,
  type NamingConfigInput,
  type NamingSamples,
  type QualityModel,
  type QualityProfile,
  type QueueStatusMessage,
  type RenameCommand,
  type RenamePreviewItem,
  type RenamePreviewQuery,
  type RenameResult,
  type RescanResult,
  type Series,
} from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { mediaFiles } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import type { DownloadClientsService, TrackedDownload } from '../download-clients/index.js';
import { libraryService } from '../library/index.js';
import { ProfilesService } from '../profiles/index.js';
import { getSection, setSection } from '../settings/service.js';
import {
  evaluate,
  namingEpisode,
  orderForImport,
  readGrabbedRelease,
  type DecisionContext,
  type GrabbedInfo,
  type ImportDecision,
  type LocalItem,
} from './decisions.js';
import type { ImportedEvent, ImportsDeps } from './deps.js';
import {
  ImportFileError,
  RecycleBin,
  deleteEmptyFolders,
  importExtraFiles,
  setPermissions,
  transferFile,
  type FsOps,
  type TransferMode,
  type TransferResult,
} from './mover.js';
import {
  ScanError,
  extensionOf,
  isSampleByName,
  isUnder,
  qualityForExtension,
  scanPath,
  shouldDeleteFolder,
  type ScanResult,
  type ScannedFile,
} from './scan.js';
import { importedDownloads } from './schema.js';

// The import pipeline: completed downloads → decisions → files placed in the library, plus
// manual import, rescans and renames. Spec: docs/spec/import.md (paths per docs/spec/naming.md).

export type ImportsErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT';

export class ImportsError extends Error {
  constructor(
    readonly code: ImportsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportsError';
  }
}

/** The slice of the download-clients service the importer uses. */
export type DownloadClientsPort = Pick<DownloadClientsService, 'setState' | 'markImported' | 'listTracked'>;

export interface ImportsServiceOptions {
  db: Db;
  downloadClients: DownloadClientsPort;
  bus?: EventBus;
  log?: Logger;
  deps?: ImportsDeps;
  platform?: NodeJS.Platform;
  now?: () => Date;
  /** Test seam for rename/link failures. */
  fsOps?: Partial<FsOps>;
}

export interface ImportOutcome {
  path: string;
  status: 'imported' | 'rejected' | 'failed';
  rejections: ImportRejection[];
  error?: string;
  mediaFileId?: number;
  destination?: string;
  replacedFileIds?: number[];
}

export interface ImportRunResult {
  trackedDownloadId: number;
  verified: boolean;
  outcomes: ImportOutcome[];
  messages: QueueStatusMessage[];
}

interface Target {
  mediaType: MediaType;
  series?: Series | undefined;
  movie?: Movie | undefined;
  /** Episode ids the tracked download was grabbed for. */
  trackedEpisodeIds?: number[] | undefined;
}

interface BuildOptions {
  grab: GrabbedInfo | null;
  /** Parse of the client item / release title. */
  clientParsed: ParsedRelease | null;
  /** Release title, used as scene name when the download holds one video. */
  clientTitle: string | null;
  videoCount: number;
}

const SUPPORTED_ROOT = process.platform === 'win32' ? null : '/';

function toQualityModel(q: ParsedQuality | { quality: QualityModel['quality'] | ReturnType<typeof qualityForExtension>; revision?: QualityModel['revision'] }): QualityModel {
  const def = q.quality;
  return {
    quality: { ...def, mediaTypes: [...def.mediaTypes] },
    revision: q.revision ? { version: q.revision.version, real: q.revision.real, isRepack: q.revision.isRepack } : { version: 1, real: 0, isRepack: false },
  };
}

function safeParsePath(path: string, hint: MediaType | 'auto'): ParsedRelease | null {
  try {
    return parsePath(path, hint);
  } catch {
    return null;
  }
}

function safeParseRelease(title: string, hint: MediaType | 'auto'): ParsedRelease | null {
  try {
    return parseRelease(title, hint);
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripExt(name: string): string {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

export class ImportsService {
  private readonly db: Db;
  private readonly downloads: DownloadClientsPort;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private deps: ImportsDeps;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly fsOps: Partial<FsOps> | undefined;
  private readonly profiles: ProfilesService;
  /** Tracked downloads whose last attempt failed only on temporary rejections. */
  private readonly retryable = new Set<number>();

  constructor(options: ImportsServiceOptions) {
    this.db = options.db;
    this.downloads = options.downloadClients;
    this.bus = options.bus;
    this.log = options.log;
    this.deps = { ...options.deps };
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
    this.fsOps = options.fsOps;
    this.profiles = new ProfilesService({ db: options.db });
  }

  /** Wire (or replace) hooks after construction. */
  setDeps(deps: Partial<ImportsDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  // -------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------

  getMediaManagement(): MediaManagementSettings {
    return getSection(this.db, 'mediaManagement');
  }

  updateMediaManagement(value: unknown): MediaManagementSettings {
    const parsed = MediaManagementSettings.safeParse(value);
    if (!parsed.success) throw new ImportsError('VALIDATION', parsed.error.message);
    const saved = setSection(this.db, 'mediaManagement', parsed.data);
    this.bus?.publish({ type: 'settings', section: 'mediaManagement' });
    return saved;
  }

  getNaming(): NamingConfig {
    return getSection(this.db, 'naming');
  }

  updateNaming(value: NamingConfigInput): NamingConfig {
    const parsed = NamingConfig.safeParse(value);
    if (!parsed.success) throw new ImportsError('VALIDATION', parsed.error.message);
    // Reject formats the organizer cannot render (empty, unknown structure) before saving.
    const samples = getSamples(parsed.data);
    const broken = Object.entries(samples).find(([, s]) => s.error !== null);
    if (broken) throw new ImportsError('VALIDATION', `${broken[0]}: ${broken[1].error}`);
    const saved = setSection(this.db, 'naming', parsed.data);
    this.bus?.publish({ type: 'settings', section: 'naming' });
    return saved;
  }

  namingSamples(config?: NamingConfigInput): NamingSamples {
    return getSamples(config ? NamingConfig.parse(config) : this.getNaming());
  }

  private recycleBin(settings = this.getMediaManagement()): RecycleBin {
    return new RecycleBin(settings.recycleBinPath, this.now);
  }

  // -------------------------------------------------------------------------------------
  // Completed downloads
  // -------------------------------------------------------------------------------------

  async importCompletedDownload(item: TrackedDownload): Promise<ImportRunResult> {
    const settings = this.getMediaManagement();
    const result: ImportRunResult = { trackedDownloadId: item.id, verified: false, outcomes: [], messages: [] };
    if (!settings.enableCompletedDownloadHandling) return result;
    this.retryable.delete(item.id);

    const path = item.outputPath;
    if (!path) return this.block(item, result, ["Download doesn't contain intermediate path, Skipping."]);
    if (!isAbsolute(path)) {
      return this.block(item, result, [`Import failed, path is not a valid local path: ${path}. You may need a Remote Path Mapping.`]);
    }

    const grab = this.grabFor(item);
    const target = this.resolveTarget(item, grab);
    if (!target) {
      const what = item.mediaType === 'movie' ? 'Movie' : 'Series';
      return this.block(item, result, [`${what} title mismatch; automatic import is not possible. Manual Import required.`]);
    }

    this.downloads.setState(item.id, 'importing');
    let scan: ScanResult;
    try {
      scan = await scanPath(path, { workingFolders: settings.downloadClientWorkingFolders });
    } catch (err) {
      const message = err instanceof ScanError ? err.message : `Import failed: ${errorMessage(err)}`;
      return this.block(item, result, [message]);
    }

    if (target.series && resolve(path) === resolve(target.series.path)) {
      return this.block(item, result, ['Import path is mapped to a series folder']);
    }

    const clientParsed = safeParseRelease(item.title, target.mediaType);
    if (target.mediaType === 'series' && clientParsed?.series?.isMultiSeason) {
      return this.block(item, result, ['Multi-season download, unable to import automatically']);
    }

    const items = await this.buildItems(scan.videos, target, {
      grab,
      clientParsed,
      clientTitle: item.title,
      videoCount: scan.videos.length,
    });
    const decisions = await this.decide(items, { grab, downloadId: item.downloadId, addedAt: item.added });
    const mode: 'move' | 'copy' = item.canMoveFiles ? 'move' : 'copy';
    result.outcomes = await this.execute(decisions, {
      mode,
      downloadId: item.downloadId,
      sourceTitle: item.title,
      manual: false,
      folderImport: !scan.isFile,
      nonSampleVideos: scan.videos.filter((v) => !isSampleByName(v.path)).length,
    });

    // Verification (spec 3.4.1).
    const importedEpisodes = new Set<number>();
    let importedAny = false;
    for (const o of result.outcomes) {
      if (o.status !== 'imported') continue;
      importedAny = true;
      const d = decisions.find((x) => x.item.path === o.path);
      for (const e of d?.item.episodes ?? []) importedEpisodes.add(e.id);
    }
    const expected = target.mediaType === 'series' ? Math.max(1, item.episodeIds?.length ?? 0) : 1;
    let verified = target.mediaType === 'series' ? importedEpisodes.size >= expected : importedAny;
    if (!verified && !importedAny) verified = this.previouslyImported(item);

    if (verified) {
      result.verified = true;
      if (mode === 'move' && !scan.isFile) await this.cleanupSourceFolder(path, settings);
      await this.downloads.markImported(item.id);
      return result;
    }

    // Not verified: explain why (spec 3.4.2 / 3.4.4).
    const lines: string[] = [];
    if (decisions.length === 0) {
      if (scan.dangerous.length > 0) lines.push(`Caution: found potentially dangerous file with extension: ${scan.dangerous[0]!.extension}`);
      else if (scan.executables.length > 0) lines.push(`Caution: found executable file with extension: ${scan.executables[0]!.extension}`);
      else if (scan.archives.length > 0) lines.push('Found archive file, might need to be extracted');
      else if (scan.unpacking) lines.push('Download is still being unpacked');
      lines.push(`No files found are eligible for import in ${path}`);
    } else {
      lines.push(
        target.mediaType === 'series'
          ? 'One or more episodes expected in this release were not imported or missing from the release'
          : 'One or more movies expected in this release were not imported or missing from the release',
      );
      for (const o of [...result.outcomes].sort((a, b) => a.path.localeCompare(b.path))) {
        if (o.status === 'imported') continue;
        const reasons = o.error ? [o.error] : o.rejections.map((r) => r.message);
        lines.push(`${basename(o.path)}: ${reasons.join(', ')}`);
      }
    }
    const onlyTemporary =
      (decisions.length > 0 &&
        result.outcomes.every((o) => o.status === 'imported' || (o.rejections.length > 0 && o.rejections.every((r) => r.type === 'temporary')))) ||
      (decisions.length === 0 && scan.unpacking);
    if (onlyTemporary) this.retryable.add(item.id);
    return this.block(item, result, lines);
  }

  /** Re-runs imports that failed only on temporary rejections (unpacking, sample undetermined). */
  async retryPendingImports(): Promise<number> {
    if (this.retryable.size === 0) return 0;
    const items = this.downloads.listTracked(['importPending']).filter((i) => this.retryable.has(i.id));
    for (const item of items) await this.importCompletedDownload(item);
    return items.length;
  }

  private block(item: TrackedDownload, result: ImportRunResult, lines: string[]): ImportRunResult {
    const messages: QueueStatusMessage[] = [{ title: item.title, messages: lines }];
    result.messages = messages;
    try {
      this.downloads.setState(item.id, 'importPending', { statusMessages: messages, trackedStatus: 'warning' });
    } catch (err) {
      this.log?.warn({ err, id: item.id }, 'could not update tracked download state');
    }
    this.bus?.publish({
      type: 'import',
      action: 'manualRequired',
      title: item.title,
      ...(item.mediaType ? { mediaType: item.mediaType } : {}),
      ...(item.seriesId !== undefined ? { mediaId: item.seriesId } : item.movieId !== undefined ? { mediaId: item.movieId } : {}),
      message: lines.join('; '),
    });
    void this.callHook(() => this.deps.notifications?.onManualInteractionRequired?.(item, lines));
    void this.callHook(() =>
      this.deps.history?.recordImportFailed?.({
        downloadId: item.downloadId,
        sourceTitle: item.title,
        ...(item.mediaType ? { mediaType: item.mediaType } : {}),
        ...(item.seriesId !== undefined ? { seriesId: item.seriesId } : {}),
        ...(item.movieId !== undefined ? { movieId: item.movieId } : {}),
        ...(item.episodeIds ? { episodeIds: item.episodeIds } : {}),
        message: lines.join('; '),
      }),
    );
    return result;
  }

  private async callHook(fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log?.error({ err }, 'imports hook failed');
    }
  }

  private grabFor(item: TrackedDownload): GrabbedInfo | null {
    const fromRelease = readGrabbedRelease(item.grabbedRelease) ?? {};
    const grab: GrabbedInfo = { ...fromRelease };
    if (item.mediaType) grab.mediaType = item.mediaType;
    if (item.seriesId !== undefined) grab.seriesId = item.seriesId;
    if (item.movieId !== undefined) grab.movieId = item.movieId;
    if (item.episodeIds && item.episodeIds.length > 0) grab.episodeIds = item.episodeIds;
    return Object.keys(grab).length > 0 ? grab : null;
  }

  /** Tracked ids first, then the release title through the parser (spec 3.2 step 5). */
  private resolveTarget(item: TrackedDownload, grab: GrabbedInfo | null): Target | null {
    const seriesId = item.seriesId ?? grab?.seriesId;
    const movieId = item.movieId ?? grab?.movieId;
    if (seriesId !== undefined && item.mediaType !== 'movie') {
      const series = this.trySeries(seriesId);
      if (series) return { mediaType: 'series', series, trackedEpisodeIds: item.episodeIds ?? grab?.episodeIds };
    }
    if (movieId !== undefined) {
      const movie = this.tryMovie(movieId);
      if (movie) return { mediaType: 'movie', movie };
    }
    const parsed = safeParseRelease(item.title, item.mediaType ?? 'auto');
    if (!parsed) return null;
    if (parsed.series && item.mediaType !== 'movie') {
      const series = this.findSeriesByTitle(parsed);
      if (series) return { mediaType: 'series', series };
    }
    if (parsed.movie && item.mediaType !== 'series') {
      const movie = this.findMovieByTitle(parsed);
      if (movie) return { mediaType: 'movie', movie };
    }
    return null;
  }

  private previouslyImported(item: TrackedDownload): boolean {
    const rows = this.db.select().from(importedDownloads).where(eq(importedDownloads.downloadId, item.downloadId)).all();
    if (rows.length === 0) return false;
    if (item.mediaType === 'movie') return true;
    const expected = item.episodeIds ?? [];
    if (expected.length === 0) return true;
    const done = new Set(rows.flatMap((r) => r.episodeIds));
    return expected.every((id) => done.has(id));
  }

  private async cleanupSourceFolder(path: string, settings: MediaManagementSettings): Promise<void> {
    try {
      const remaining = await scanPath(path, { filterExtras: false, workingFolders: settings.downloadClientWorkingFolders });
      if (shouldDeleteFolder(remaining, (f) => isSampleByName(f.path))) {
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      }
    } catch (err) {
      this.log?.debug({ err, path }, 'source folder cleanup skipped');
    }
  }

  // -------------------------------------------------------------------------------------
  // Failed downloads (spec 12)
  // -------------------------------------------------------------------------------------

  async handleFailedDownload(item: TrackedDownload): Promise<void> {
    const clientMessage = item.statusMessages.flatMap((m) => m.messages).find((m) => m.trim() !== '');
    const message = clientMessage ?? 'Failed download detected';
    this.downloads.setState(item.id, 'failed', {
      trackedStatus: 'error',
      statusMessages: [{ title: item.title, messages: [message] }],
    });
    this.bus?.publish({
      type: 'import',
      action: 'failed',
      title: item.title,
      ...(item.mediaType ? { mediaType: item.mediaType } : {}),
      message,
    });
    await this.callHook(() => this.deps.blocklist?.add({ item, message, grabbedRelease: item.grabbedRelease }));
    await this.callHook(() => this.deps.history?.recordDownloadFailed?.(item, message));
    await this.callHook(() => this.deps.notifications?.onDownloadFailed?.(item, message));

    const settings = this.getMediaManagement();
    if (!settings.autoRedownloadFailed || !item.mediaType || !this.deps.releases) return;
    const releases = this.deps.releases;
    if (item.mediaType === 'series' && item.seriesId !== undefined) {
      await this.callHook(() =>
        releases.researchFor({
          mediaType: 'series',
          seriesId: item.seriesId!,
          ...(item.episodeIds ? { episodeIds: item.episodeIds } : {}),
          reason: 'failedDownload',
        }),
      );
    } else if (item.mediaType === 'movie' && item.movieId !== undefined) {
      await this.callHook(() => releases.researchFor({ mediaType: 'movie', movieId: item.movieId!, reason: 'failedDownload' }));
    }
  }

  // -------------------------------------------------------------------------------------
  // Library lookups
  // -------------------------------------------------------------------------------------

  private trySeries(id: number): Series | undefined {
    try {
      return libraryService.getSeries(this.db, id, { includeStatistics: false });
    } catch {
      return undefined;
    }
  }

  private tryMovie(id: number): Movie | undefined {
    try {
      return libraryService.getMovie(this.db, id);
    } catch {
      return undefined;
    }
  }

  private findSeriesByTitle(parsed: ParsedRelease): Series | undefined {
    const info = parsed.series;
    if (!info) return undefined;
    const candidates = new Set(
      [info.title, info.titleInfo.title, info.titleInfo.titleWithoutYear].filter(Boolean).map(libraryService.toCleanTitle),
    );
    const all = libraryService.listSeries(this.db, SeriesListQuery.parse({ includeStatistics: false }));
    const matches = all.filter((s) => candidates.has(s.cleanTitle) || candidates.has(libraryService.toCleanTitle(`${s.title} ${s.year}`)));
    if (matches.length === 1) return matches[0];
    const year = info.titleInfo.year;
    return year ? matches.find((s) => s.year === year) : undefined;
  }

  private findMovieByTitle(parsed: ParsedRelease): Movie | undefined {
    const info = parsed.movie;
    if (!info) return undefined;
    const clean = libraryService.toCleanTitle(info.titleWithoutYear || info.title);
    const all = libraryService.listMovies(this.db, MovieListQuery.parse({}));
    const matches = all.filter(
      (m) => m.cleanTitle === clean || libraryService.toCleanTitle(m.originalTitle) === clean,
    );
    if (info.year) {
      const exact = matches.find((m) => m.year === info.year) ?? matches.find((m) => Math.abs(m.year - info.year) <= 1);
      return exact;
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  private findSeriesForPath(path: string): Series | undefined {
    const all = libraryService.listSeries(this.db, SeriesListQuery.parse({ includeStatistics: false }));
    return all.find((s) => isUnder(path, s.path));
  }

  private findMovieForPath(path: string): Movie | undefined {
    const all = libraryService.listMovies(this.db, MovieListQuery.parse({}));
    return all.find((m) => isUnder(path, m.path));
  }

  private episodesFor(series: Series, parsed: ParsedRelease | null): { episodes: Episode[]; parsedCount: number } {
    const info = parsed?.series;
    if (!info) return { episodes: [], parsedCount: 0 };
    const all = libraryService.listEpisodes(this.db, { seriesId: series.id });
    if (info.airDate) {
      const hits = all.filter((e) => e.airDate === info.airDate);
      return { episodes: hits.slice(0, 1), parsedCount: 1 };
    }
    const season = info.seasons[0];
    if (season !== undefined && info.episodes.length > 0 && !(series.seriesType === 'anime' && info.absoluteEpisodes.length > 0)) {
      const hits = info.episodes
        .map((n) => all.find((e) => e.seasonNumber === season && e.episodeNumber === n))
        .filter((e): e is Episode => e !== undefined);
      return { episodes: dedupeEpisodes(hits), parsedCount: new Set(info.episodes).size };
    }
    if (info.absoluteEpisodes.length > 0) {
      const hits = info.absoluteEpisodes
        .map((n) => all.find((e) => e.absoluteEpisodeNumber === n))
        .filter((e): e is Episode => e !== undefined);
      return { episodes: dedupeEpisodes(hits), parsedCount: new Set(info.absoluteEpisodes).size };
    }
    return { episodes: [], parsedCount: 0 };
  }

  private filesOf(target: { seriesId?: number; movieId?: number }): MediaFile[] {
    if (target.seriesId !== undefined) return libraryService.listMediaFiles(this.db, { seriesId: target.seriesId });
    if (target.movieId !== undefined) return libraryService.listMediaFiles(this.db, { movieId: target.movieId });
    return [];
  }

  private profileFor(id: number | undefined, cache: Map<number, QualityProfile | null>): QualityProfile | null {
    if (id === undefined) return null;
    if (!cache.has(id)) {
      try {
        cache.set(id, this.profiles.getQualityProfile(id));
      } catch {
        cache.set(id, null);
      }
    }
    return cache.get(id) ?? null;
  }

  private customFormats(): CustomFormat[] {
    try {
      return this.profiles.listCustomFormats();
    } catch {
      return [];
    }
  }

  private score(
    profile: QualityProfile | null,
    formats: CustomFormat[],
    subject: { title: string; quality: QualityModel; languages: string[]; releaseGroup: string | null; sizeBytes: number; mediaType: MediaType },
  ): number {
    if (!profile || formats.length === 0) return 0;
    try {
      return scoreRelease(profile, formats, {
        title: subject.title,
        quality: subject.quality,
        languages: subject.languages,
        sizeBytes: subject.sizeBytes,
        mediaType: subject.mediaType,
        ...(subject.releaseGroup ? { releaseGroup: subject.releaseGroup } : {}),
      }).score;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------------------
  // Building local items (aggregation, spec 6)
  // -------------------------------------------------------------------------------------

  private async buildItems(files: readonly ScannedFile[], target: Target, opts: BuildOptions): Promise<LocalItem[]> {
    const profileCache = new Map<number, QualityProfile | null>();
    const formats = this.customFormats();
    const items: LocalItem[] = [];
    for (const file of files) {
      items.push(await this.buildItem(file, target, opts, profileCache, formats));
    }
    return items;
  }

  private async buildItem(
    file: ScannedFile,
    target: Target,
    opts: BuildOptions,
    profileCache: Map<number, QualityProfile | null>,
    formats: CustomFormat[],
  ): Promise<LocalItem> {
    const parsed = safeParsePath(file.path, target.mediaType);
    const single = opts.videoCount === 1;

    // Quality: file name, then client title, then grab, then extension (spec 6.4).
    let quality: QualityModel;
    if (parsed && parsed.quality.detectionSource === 'name') quality = toQualityModel(parsed.quality);
    else if (opts.clientParsed && opts.clientParsed.quality.detectionSource === 'name') quality = toQualityModel(opts.clientParsed.quality);
    else if (opts.grab?.quality) quality = opts.grab.quality;
    else if (parsed && parsed.quality.quality.id !== 0) quality = toQualityModel(parsed.quality);
    else quality = toQualityModel({ quality: qualityForExtension(file.extension) });

    const original = target.series?.originalLanguage ?? target.movie?.originalLanguage ?? 'en';
    const languages =
      parsed && parsed.languages.length > 0
        ? parsed.languages
        : opts.clientParsed && opts.clientParsed.languages.length > 0
          ? opts.clientParsed.languages
          : [original];
    const releaseGroup = parsed?.releaseGroup ?? opts.clientParsed?.releaseGroup ?? null;

    let episodes: Episode[] = [];
    let parsedEpisodeCount = 0;
    let series = target.series;
    let movie = target.movie;
    if (target.mediaType === 'series') {
      if (!series && parsed) series = this.findSeriesByTitle(parsed) ?? this.findSeriesForPath(file.path);
      if (series) {
        ({ episodes, parsedCount: parsedEpisodeCount } = this.episodesFor(series, parsed));
        if (episodes.length === 0 && single && opts.clientParsed?.series && !opts.clientParsed.series.fullSeason) {
          ({ episodes, parsedCount: parsedEpisodeCount } = this.episodesFor(series, opts.clientParsed));
        }
        if (episodes.length === 0 && single && target.trackedEpisodeIds && target.trackedEpisodeIds.length > 0) {
          const ids = new Set(target.trackedEpisodeIds);
          episodes = libraryService.listEpisodes(this.db, { seriesId: series.id }).filter((e) => ids.has(e.id));
          parsedEpisodeCount = episodes.length;
        }
      }
    } else if (!movie && parsed) {
      movie = this.findMovieByTitle(parsed) ?? this.findMovieForPath(file.path);
    }

    const libraryPath = series?.path ?? movie?.path;
    const existingFile = libraryPath ? isUnder(file.path, libraryPath) : false;
    let existingFiles: MediaFile[] = [];
    if (series && episodes.length > 0) {
      const fileIds = new Set(episodes.map((e) => e.episodeFileId).filter((v): v is number => typeof v === 'number'));
      existingFiles = this.filesOf({ seriesId: series.id }).filter((f) => fileIds.has(f.id));
    } else if (movie?.movieFileId) {
      existingFiles = this.filesOf({ movieId: movie.id }).filter((f) => f.id === movie!.movieFileId);
    }
    existingFiles = existingFiles.filter((f) => resolve(f.path) !== resolve(file.path));

    const profile = this.profileFor(series?.qualityProfileId ?? movie?.qualityProfileId, profileCache);
    const sceneTitle = single && opts.clientTitle ? opts.clientTitle : stripExt(file.name);
    const formatScore = this.score(profile, formats, {
      title: sceneTitle,
      quality,
      languages,
      releaseGroup,
      sizeBytes: file.sizeBytes,
      mediaType: target.mediaType,
    });
    const existingFormatScores: Record<number, number> = {};
    for (const f of existingFiles) {
      existingFormatScores[f.id] = this.score(profile, formats, {
        title: f.sceneName ?? stripExt(basename(f.relativePath)),
        quality: f.quality,
        languages: f.languages,
        releaseGroup: f.releaseGroup ?? null,
        sizeBytes: f.sizeBytes,
        mediaType: target.mediaType,
      });
    }

    let runtimeSeconds: number | null | undefined;
    let audioStreams: number | undefined;
    if (this.deps.probe && !existingFile) {
      const probed = await this.deps.probe(file.path).catch(() => null);
      runtimeSeconds = probed?.runtimeSeconds ?? null;
      audioStreams = probed?.audioStreams;
    }

    return {
      path: file.path,
      sizeBytes: file.sizeBytes,
      extension: file.extension,
      mtimeMs: file.mtimeMs,
      mediaType: target.mediaType,
      parsed,
      quality,
      languages,
      releaseGroup,
      series,
      episodes,
      parsedEpisodeCount,
      movie,
      existingFile,
      existingFiles,
      formatScore,
      existingFormatScores,
      runtimeSeconds,
      audioStreams,
    };
  }

  private async decide(
    items: readonly LocalItem[],
    opts: { grab: GrabbedInfo | null; downloadId?: string | undefined; addedAt?: string | undefined },
  ): Promise<ImportDecision[]> {
    const settings = this.getMediaManagement();
    const naming = this.getNaming();
    const libraryPaths = new Set(this.db.select({ path: mediaFiles.path }).from(mediaFiles).all().map((r) => r.path));
    const profileCache = new Map<number, QualityProfile | null>();
    const freeCache = new Map<string, number | null>();
    const episodesCache = new Map<number, Episode[]>();
    const alreadyImported = opts.downloadId ? this.importedSinceGrab(opts.downloadId, opts.addedAt) : false;
    const out: ImportDecision[] = [];
    for (const item of items) {
      const root = item.series?.rootFolderPath ?? item.movie?.rootFolderPath;
      let freeSpaceBytes: number | null = null;
      if (root && !settings.skipFreeSpaceCheck) {
        if (!freeCache.has(root)) freeCache.set(root, await this.freeSpace(root));
        freeSpaceBytes = freeCache.get(root) ?? null;
      }
      let seriesEpisodes: Episode[] = [];
      if (item.series) {
        if (!episodesCache.has(item.series.id)) episodesCache.set(item.series.id, libraryService.listEpisodes(this.db, { seriesId: item.series.id }));
        seriesEpisodes = episodesCache.get(item.series.id)!;
      }
      const ctx: DecisionContext = {
        settings,
        naming,
        profile: this.profileFor(item.series?.qualityProfileId ?? item.movie?.qualityProfileId, profileCache),
        freeSpaceBytes,
        grab: opts.grab,
        alreadyImported,
        seriesEpisodes,
        videoCount: items.length,
        libraryPaths,
        platform: this.platform,
        now: this.now(),
      };
      out.push(evaluate(item, ctx));
    }
    return out;
  }

  private importedSinceGrab(downloadId: string, addedAt: string | undefined): boolean {
    const where = addedAt
      ? and(eq(importedDownloads.downloadId, downloadId), gte(importedDownloads.importedAt, addedAt))
      : eq(importedDownloads.downloadId, downloadId);
    return this.db.select({ id: importedDownloads.id }).from(importedDownloads).where(where).get() !== undefined;
  }

  private async freeSpace(path: string): Promise<number | null> {
    if (this.deps.freeSpace) return this.deps.freeSpace(path);
    try {
      const s = await statfs(path);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------
  // Executing decisions (spec 9)
  // -------------------------------------------------------------------------------------

  private async execute(
    decisions: readonly ImportDecision[],
    opts: {
      mode: 'move' | 'copy';
      downloadId: string | null;
      sourceTitle: string | null;
      manual: boolean;
      folderImport: boolean;
      nonSampleVideos: number;
    },
  ): Promise<ImportOutcome[]> {
    const outcomes: ImportOutcome[] = [];
    const approved = decisions.filter((d) => d.approved);
    for (const d of decisions) {
      if (!d.approved) outcomes.push({ path: d.item.path, status: 'rejected', rejections: d.rejections });
    }
    const profileCache = new Map<number, QualityProfile | null>();
    const ordered = orderForImport(approved, this.profileFor(approved[0]?.item.series?.qualityProfileId ?? approved[0]?.item.movie?.qualityProfileId, profileCache));
    const doneEpisodes = new Set<number>();
    const doneMovies = new Set<number>();
    for (const d of ordered) {
      const item = d.item;
      if (item.mediaType === 'series' && item.episodes.some((e) => doneEpisodes.has(e.id))) {
        outcomes.push({
          path: item.path,
          status: 'rejected',
          rejections: [{ reason: 'alreadyImported', message: 'Episode has already been imported', type: 'permanent' }],
        });
        continue;
      }
      if (item.mediaType === 'movie' && item.movie && doneMovies.has(item.movie.id)) {
        outcomes.push({
          path: item.path,
          status: 'rejected',
          rejections: [{ reason: 'alreadyImported', message: 'Movie has already been imported', type: 'permanent' }],
        });
        continue;
      }
      try {
        const placed = await this.importOne(item, opts);
        for (const e of item.episodes) doneEpisodes.add(e.id);
        if (item.movie) doneMovies.add(item.movie.id);
        outcomes.push({
          path: item.path,
          status: 'imported',
          rejections: [],
          mediaFileId: placed.file.id,
          destination: placed.file.path,
          replacedFileIds: placed.replacedFileIds,
        });
      } catch (err) {
        const message = failureMessage(err, item.mediaType);
        this.log?.warn({ err, path: item.path }, 'import failed');
        this.bus?.publish({ type: 'import', action: 'failed', title: basename(item.path), mediaType: item.mediaType, message });
        outcomes.push({ path: item.path, status: 'failed', rejections: [], error: message });
      }
    }
    return outcomes;
  }

  /** Destination path for an item (spec 9.4, naming spec 4). */
  buildDestination(item: Pick<LocalItem, 'mediaType' | 'series' | 'movie' | 'episodes' | 'path' | 'quality' | 'releaseGroup' | 'extension'> & { sceneName?: string | null }, naming = this.getNaming()): string {
    const file: NamingFile = {
      path: item.path,
      relativePath: basename(item.path),
      releaseGroup: item.releaseGroup,
      quality: item.quality,
      // With renaming off the original file name is kept (a scene name would rename it).
      sceneName: (item.mediaType === 'series' ? naming.renameEpisodes : naming.renameMovies) ? (item.sceneName ?? null) : null,
    };
    const extras = { extension: item.extension, pathSeparator: sep };
    if (item.mediaType === 'series') {
      const series = item.series!;
      const ns = { title: series.title, year: series.year, seriesType: series.seriesType, tvdbId: series.tvdbId ?? null, imdbId: series.imdbId ?? null, tmdbId: series.tmdbId };
      const episodes = item.episodes.map(namingEpisode);
      const season = item.episodes[0]?.seasonNumber ?? 0;
      const seasonFolder = series.seasonFolder ? buildSeasonFolder(naming, ns, season) : '';
      const folder = seasonFolder ? join(series.path, seasonFolder) : series.path;
      const name = buildEpisodeFileName(naming, ns, episodes, file, { ...extras, seasonPath: folder });
      return join(folder, name);
    }
    const movie = item.movie!;
    const nm = {
      title: movie.title,
      year: movie.year,
      originalTitle: movie.originalTitle,
      collection: movie.collection ? { title: movie.collection.title } : null,
      certification: movie.certification ?? null,
      imdbId: movie.imdbId ?? null,
      tmdbId: movie.tmdbId,
    };
    const name = buildMovieFileName(naming, nm, file, { ...extras, seasonPath: movie.path });
    return join(movie.path, name);
  }

  private async importOne(
    item: LocalItem,
    opts: { mode: 'move' | 'copy'; downloadId: string | null; sourceTitle: string | null; manual: boolean; folderImport: boolean; nonSampleVideos: number },
  ): Promise<{ file: MediaFile; replacedFileIds: number[] }> {
    const settings = this.getMediaManagement();
    const series = item.series;
    const movie = item.movie;
    const root = series?.rootFolderPath ?? movie?.rootFolderPath;
    const libraryPath = series?.path ?? movie?.path;
    if (!root || !libraryPath) throw new ImportsError('VALIDATION', 'Item is not mapped to a series or movie');
    if (!(await isDirectory(root))) throw new ImportFileError('ROOT_FOLDER_NOT_FOUND', `Root folder ${root} is missing`);

    // Scene name: the release title when the download held a single video (spec 6.2).
    const sceneName = opts.sourceTitle && opts.nonSampleVideos === 1 ? opts.sourceTitle : null;
    let destination: string;
    let replacedFiles: MediaFile[] = [];
    let transfer: TransferResult | 'none' = 'none';

    if (item.existingFile) {
      // Already inside the library (manual override): register in place, no move (spec 9.2.3).
      destination = item.path;
      for (const row of this.db.select().from(mediaFiles).where(eq(mediaFiles.path, item.path)).all()) {
        await libraryService.deleteMediaFile(this.db, row.id, { deleteFromDisk: false });
      }
    } else {
      destination = this.buildDestination({ ...item, sceneName });
      // Upgrade routine (spec 9.3): recycle files fully covered by the new one, then place.
      const newEpisodeIds = new Set(item.episodes.map((e) => e.id));
      replacedFiles = item.existingFiles.filter(
        (f) => item.mediaType === 'movie' || f.episodeIds.every((id) => newEpisodeIds.has(id)),
      );
      const bin = this.recycleBin(settings);
      for (const old of replacedFiles) {
        if (await exists(old.path)) {
          await bin.recycle(old.path, relative(root, dirname(old.path)));
        } else {
          this.log?.warn({ path: old.path }, 'replaced file was not on disk');
        }
        // Free the path in the database when the new file lands on the same name.
        if (resolve(old.path) === resolve(destination)) await libraryService.deleteMediaFile(this.db, old.id, { deleteFromDisk: false });
      }

      const copyMode: TransferMode = settings.useHardlinks ? 'hardlinkOrCopy' : 'copy';
      const mode: TransferMode = opts.mode === 'move' ? 'move' : copyMode;
      const libraryExisted = await isDirectory(libraryPath);
      if (settings.importExtraFiles) {
        await importExtraFiles(item.path, destination, {
          extensions: settings.extraFileExtensions,
          recursive: opts.folderImport,
          mode: opts.mode === 'move' ? 'move' : copyMode,
        });
      }
      transfer = await transferFile(item.path, destination, mode, this.fsOps ? { ops: this.fsOps } : {});
      if (settings.setPermissions) {
        await setPermissions(destination, settings.chmodFolder, false);
        if (!libraryExisted) await setPermissions(libraryPath, settings.chmodFolder, true);
        if (dirname(destination) !== libraryPath) await setPermissions(dirname(destination), settings.chmodFolder, true);
      }
      await this.applyFileDate(destination, item, settings);
    }

    const size = (await stat(destination)).size;
    const { file, replacedFileIds } = libraryService.addMediaFile(this.db, {
      mediaType: item.mediaType,
      ...(series ? { seriesId: series.id, seasonNumber: item.episodes[0]?.seasonNumber ?? 0, episodeIds: item.episodes.map((e) => e.id) } : {}),
      ...(movie ? { movieId: movie.id } : {}),
      relativePath: relative(libraryPath, destination),
      path: destination,
      sizeBytes: size,
      dateAdded: this.now().toISOString(),
      quality: item.quality,
      languages: item.languages,
      releaseGroup: item.releaseGroup,
      sceneName,
      edition: item.parsed?.movie?.edition ?? null,
    });
    const allReplaced = [...new Set([...replacedFiles.map((f) => f.id), ...replacedFileIds])];

    if (opts.downloadId) {
      this.db
        .insert(importedDownloads)
        .values({
          downloadId: opts.downloadId,
          mediaType: item.mediaType,
          seriesId: series?.id ?? null,
          movieId: movie?.id ?? null,
          episodeIds: item.episodes.map((e) => e.id),
          mediaFileId: file.id,
          sourcePath: item.path,
          destinationPath: destination,
          importedAt: this.now().toISOString(),
        })
        .run();
    }

    const mediaId = series?.id ?? movie?.id ?? 0;
    this.bus?.publish({ type: 'library', action: 'fileAdded', mediaType: item.mediaType, id: mediaId });
    const title = series ? `${series.title} ${item.episodes.map((e) => `S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}`).join('')}` : `${movie!.title} (${movie!.year})`;
    this.bus?.publish({ type: 'import', action: 'imported', title, mediaType: item.mediaType, mediaId });

    const event: ImportedEvent = {
      mediaType: item.mediaType,
      ...(series ? { seriesId: series.id } : {}),
      ...(movie ? { movieId: movie.id } : {}),
      episodeIds: item.episodes.map((e) => e.id),
      file,
      replacedFiles,
      sourcePath: item.path,
      downloadId: opts.downloadId,
      sourceTitle: opts.sourceTitle ?? basename(item.path),
      isUpgrade: allReplaced.length > 0,
      importMode: transfer === 'none' ? 'move' : transfer,
      manual: opts.manual,
    };
    await this.callHook(() => this.deps.history?.recordImport(event));
    await this.callHook(() => this.deps.notifications?.onImported(event));
    return { file, replacedFileIds: allReplaced };
  }

  private async applyFileDate(path: string, item: LocalItem, settings: MediaManagementSettings): Promise<void> {
    let when: string | null | undefined = null;
    if (settings.fileDateMode === 'utcAirDate') when = item.episodes[0]?.airDateUtc;
    else if (settings.fileDateMode === 'localAirDate') when = item.episodes[0]?.airDate ?? item.episodes[0]?.airDateUtc;
    else if (settings.fileDateMode === 'releaseDate') when = item.movie?.digitalRelease ?? item.movie?.physicalRelease ?? item.movie?.inCinemas;
    if (!when) return;
    const t = new Date(when);
    if (Number.isNaN(t.getTime())) return;
    await utimes(path, t, t).catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------
  // Manual import (spec 11)
  // -------------------------------------------------------------------------------------

  async listManualImport(query: ManualImportQuery): Promise<ManualImportItem[]> {
    const settings = this.getMediaManagement();
    let folder = query.folder;
    let tracked: TrackedDownload | undefined;
    let target: Target | null = null;
    let filterExtras = true;

    if (query.downloadId) {
      tracked = this.downloads.listTracked().find((t) => t.downloadId === query.downloadId);
      if (!tracked) throw new ImportsError('NOT_FOUND', `Download ${query.downloadId} is not tracked`);
      folder ??= tracked.outputPath;
      target = this.resolveTarget(tracked, this.grabFor(tracked));
    } else if (query.seriesId !== undefined) {
      const series = this.trySeries(query.seriesId);
      if (!series) throw new ImportsError('NOT_FOUND', `Series ${query.seriesId} not found`);
      folder ??= series.path;
      target = { mediaType: 'series', series };
      filterExtras = false;
    } else if (query.movieId !== undefined) {
      const movie = this.tryMovie(query.movieId);
      if (!movie) throw new ImportsError('NOT_FOUND', `Movie ${query.movieId} not found`);
      folder ??= movie.path;
      target = { mediaType: 'movie', movie };
      filterExtras = false;
    }
    if (!folder) throw new ImportsError('VALIDATION', 'No folder to scan');

    let scan: ScanResult;
    try {
      scan = await scanPath(folder, { filterExtras, workingFolders: settings.downloadClientWorkingFolders });
    } catch (err) {
      if (err instanceof ScanError) throw new ImportsError('NOT_FOUND', err.message);
      throw err;
    }
    let videos = scan.videos;
    if (query.filterExistingFiles) {
      const known = new Set(this.db.select({ path: mediaFiles.path }).from(mediaFiles).all().map((r) => resolve(r.path)));
      videos = videos.filter((v) => !known.has(resolve(v.path)));
    }

    // Unknown target: guess per file. Over 100 files without a target, skip parsing (11.2).
    const skipParsing = !target && videos.length > 100;
    const clientParsed = tracked ? safeParseRelease(tracked.title, target?.mediaType ?? 'auto') : safeParseRelease(basename(folder), 'auto');
    const grab = tracked ? this.grabFor(tracked) : null;
    const results: ManualImportItem[] = [];
    for (const v of videos) {
      if (skipParsing) {
        results.push(this.bareManualItem(v, tracked?.downloadId));
        continue;
      }
      let t = target;
      if (!t) {
        const parsed = safeParsePath(v.path, 'auto') ?? clientParsed;
        const mediaType: MediaType = parsed?.series ? 'series' : 'movie';
        t =
          mediaType === 'series'
            ? { mediaType, series: (parsed && this.findSeriesByTitle(parsed)) ?? this.findSeriesForPath(v.path) }
            : { mediaType, movie: (parsed && this.findMovieByTitle(parsed)) ?? this.findMovieForPath(v.path) };
      }
      const [item] = await this.buildItems([v], t, {
        grab,
        clientParsed,
        clientTitle: tracked?.title ?? null,
        videoCount: videos.length,
      });
      const [decision] = await this.decide([item!], { grab, downloadId: tracked?.downloadId, addedAt: tracked?.added });
      results.push(this.toManualItem(decision!, v, tracked?.downloadId));
    }
    return results;
  }

  private bareManualItem(v: ScannedFile, downloadId: string | undefined): ManualImportItem {
    return {
      path: v.path,
      relativePath: v.relativePath,
      name: v.name,
      sizeBytes: v.sizeBytes,
      quality: toQualityModel({ quality: qualityForExtension(v.extension) }),
      languages: [],
      releaseGroup: null,
      rejections: [],
      ...(downloadId ? { downloadId } : {}),
    };
  }

  private toManualItem(d: ImportDecision, v: ScannedFile, downloadId: string | undefined): ManualImportItem {
    const item = d.item;
    const known = item.mediaType === 'series' ? item.series !== undefined : item.movie !== undefined;
    return {
      path: v.path,
      relativePath: v.relativePath,
      name: v.name,
      sizeBytes: v.sizeBytes,
      quality: item.quality,
      languages: item.languages,
      releaseGroup: item.releaseGroup,
      ...(known ? { mediaType: item.mediaType } : {}),
      ...(item.series ? { seriesId: item.series.id } : {}),
      ...(item.episodes.length > 0 ? { seasonNumber: item.episodes[0]!.seasonNumber, episodeIds: item.episodes.map((e) => e.id) } : {}),
      ...(item.movie ? { movieId: item.movie.id } : {}),
      rejections: d.rejections,
      ...(downloadId ? { downloadId } : {}),
    };
  }

  /** Imports the user's choices with no specs applied (spec 11.5). */
  async executeManualImport(request: ManualImportRequest): Promise<ManualImportResult> {
    const result: ManualImportResult = { imported: [], failed: [] };
    const trackedById = new Map<string, TrackedDownload>();
    for (const t of this.downloads.listTracked()) trackedById.set(t.downloadId, t);
    const importedPerDownload = new Map<string, Set<number>>();

    for (const req of request.items) {
      try {
        const info = await stat(req.path).catch(() => null);
        if (!info?.isFile()) throw new ImportsError('NOT_FOUND', `File not found: ${req.path}`);
        const parsed = safeParsePath(req.path, req.mediaType);
        const ext = extensionOf(req.path);
        let series: Series | undefined;
        let movie: Movie | undefined;
        let episodes: Episode[] = [];
        if (req.mediaType === 'series') {
          series = this.trySeries(req.seriesId!);
          if (!series) throw new ImportsError('NOT_FOUND', `Series ${req.seriesId} not found`);
          const ids = new Set(req.episodeIds ?? []);
          episodes = libraryService.listEpisodes(this.db, { seriesId: series.id }).filter((e) => ids.has(e.id));
          if (episodes.length !== ids.size) throw new ImportsError('VALIDATION', 'Episodes not selected or not part of the series');
        } else {
          movie = this.tryMovie(req.movieId!);
          if (!movie) throw new ImportsError('NOT_FOUND', `Movie ${req.movieId} not found`);
        }
        const tracked = req.downloadId ? trackedById.get(req.downloadId) : undefined;
        const quality =
          req.quality ??
          (parsed && parsed.quality.quality.id !== 0 ? toQualityModel(parsed.quality) : toQualityModel({ quality: qualityForExtension(ext) }));
        const libraryPath = series?.path ?? movie!.path;
        const existingFile = isUnder(req.path, libraryPath);
        const fileIds = new Set(episodes.map((e) => e.episodeFileId).filter((v): v is number => typeof v === 'number'));
        const existingFiles = (series ? this.filesOf({ seriesId: series.id }).filter((f) => fileIds.has(f.id)) : this.filesOf({ movieId: movie!.id })).filter(
          (f) => resolve(f.path) !== resolve(req.path),
        );
        const item: LocalItem = {
          path: req.path,
          sizeBytes: info.size,
          extension: ext,
          mtimeMs: info.mtimeMs,
          mediaType: req.mediaType,
          parsed,
          quality,
          languages: req.languages ?? parsed?.languages ?? [series?.originalLanguage ?? movie?.originalLanguage ?? 'en'],
          releaseGroup: req.releaseGroup !== undefined ? req.releaseGroup : (parsed?.releaseGroup ?? null),
          series,
          episodes,
          parsedEpisodeCount: episodes.length,
          movie,
          existingFile,
          existingFiles,
          formatScore: 0,
          existingFormatScores: {},
          runtimeSeconds: undefined,
        };
        const mode: 'move' | 'copy' =
          request.importMode === 'move' ? 'move' : request.importMode === 'copy' ? 'copy' : tracked && !tracked.canMoveFiles ? 'copy' : 'move';
        const placed = await this.importOne(item, {
          mode,
          downloadId: req.downloadId ?? null,
          sourceTitle: tracked?.title ?? null,
          manual: true,
          folderImport: false,
          nonSampleVideos: 0,
        });
        result.imported.push({ path: req.path, mediaFileId: placed.file.id, destination: placed.file.path });
        if (req.downloadId) {
          const set = importedPerDownload.get(req.downloadId) ?? new Set<number>();
          for (const e of episodes) set.add(e.id);
          if (movie) set.add(-movie.id);
          importedPerDownload.set(req.downloadId, set);
        }
      } catch (err) {
        result.failed.push({ path: req.path, error: failureMessage(err, req.mediaType) });
      }
    }

    // Tracked downloads reach Imported once the expected count is met (spec 11.6).
    for (const [downloadId, done] of importedPerDownload) {
      const tracked = trackedById.get(downloadId);
      if (!tracked) continue;
      const expected = tracked.mediaType === 'series' ? Math.max(1, tracked.episodeIds?.length ?? 0) : 1;
      const already = new Set(
        this.db
          .select()
          .from(importedDownloads)
          .where(eq(importedDownloads.downloadId, downloadId))
          .all()
          .flatMap((r) => (r.mediaType === 'movie' ? [-(r.movieId ?? 0)] : r.episodeIds)),
      );
      for (const id of done) already.add(id);
      if (already.size >= expected) await this.downloads.markImported(tracked.id);
    }
    return result;
  }

  // -------------------------------------------------------------------------------------
  // Rescan (disk → media_files)
  // -------------------------------------------------------------------------------------

  async rescanSeries(seriesId: number): Promise<RescanResult> {
    const series = this.trySeries(seriesId);
    if (!series) throw new ImportsError('NOT_FOUND', `Series ${seriesId} not found`);
    return this.rescan({ mediaType: 'series', series });
  }

  async rescanMovie(movieId: number): Promise<RescanResult> {
    const movie = this.tryMovie(movieId);
    if (!movie) throw new ImportsError('NOT_FOUND', `Movie ${movieId} not found`);
    return this.rescan({ mediaType: 'movie', movie });
  }

  async rescanAll(mediaType: MediaType): Promise<RescanResult> {
    const total: RescanResult = { scanned: 0, added: [], removed: [], unmapped: [] };
    const ids =
      mediaType === 'series'
        ? libraryService.listSeries(this.db, SeriesListQuery.parse({ includeStatistics: false })).map((s) => s.id)
        : libraryService.listMovies(this.db, MovieListQuery.parse({})).map((m) => m.id);
    for (const id of ids) {
      try {
        const r = mediaType === 'series' ? await this.rescanSeries(id) : await this.rescanMovie(id);
        total.scanned += r.scanned;
        total.added.push(...r.added);
        total.removed.push(...r.removed);
        total.unmapped.push(...r.unmapped);
      } catch (err) {
        this.log?.warn({ err, mediaType, id }, 'rescan failed');
      }
    }
    return total;
  }

  private async rescan(target: Target): Promise<RescanResult> {
    const settings = this.getMediaManagement();
    const series = target.series;
    const movie = target.movie;
    const libraryPath = (series?.path ?? movie?.path)!;
    const root = (series?.rootFolderPath ?? movie?.rootFolderPath)!;
    const result: RescanResult = { scanned: 0, added: [], removed: [], unmapped: [] };

    // An unmounted or empty root folder must not wipe the library (spec 10.5, 16.5).
    const rootEntries = await readdir(root).catch(() => null);
    if (!rootEntries || rootEntries.length === 0) {
      this.log?.warn({ root }, 'root folder missing or empty; rescan skipped');
      return result;
    }

    let scan: ScanResult | null = null;
    if (await isDirectory(libraryPath)) {
      scan = await scanPath(libraryPath, { filterExtras: false, workingFolders: [] });
    } else if (series && settings.createEmptySeriesFolders) {
      await mkdir(libraryPath, { recursive: true });
    }
    const videos = scan?.videos ?? [];
    result.scanned = videos.length;
    const onDisk = new Set(videos.map((v) => resolve(v.path)));

    const files = this.filesOf(series ? { seriesId: series.id } : { movieId: movie!.id });
    for (const f of files) {
      if (onDisk.has(resolve(f.path))) continue;
      await libraryService.deleteMediaFile(this.db, f.id, { deleteFromDisk: false });
      result.removed.push({ path: f.path, mediaFileId: f.id });
      this.bus?.publish({ type: 'library', action: 'fileDeleted', mediaType: target.mediaType, id: series?.id ?? movie!.id });
    }

    const known = new Set(files.filter((f) => onDisk.has(resolve(f.path))).map((f) => resolve(f.path)));
    const candidates = videos.filter((v) => !known.has(resolve(v.path)) && !isSampleByName(v.path));
    if (movie) candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);

    for (const v of candidates) {
      const parsed = safeParsePath(v.path, target.mediaType);
      const quality =
        parsed && parsed.quality.quality.id !== 0 ? toQualityModel(parsed.quality) : toQualityModel({ quality: qualityForExtension(v.extension) });
      const languages = parsed && parsed.languages.length > 0 ? parsed.languages : [series?.originalLanguage ?? movie!.originalLanguage];
      const common = {
        relativePath: relative(libraryPath, v.path),
        path: v.path,
        sizeBytes: v.sizeBytes,
        quality,
        languages,
        releaseGroup: parsed?.releaseGroup ?? null,
        dateAdded: this.now().toISOString(),
      };
      try {
        if (series) {
          const { episodes } = this.episodesFor(series, parsed);
          // Never steal episodes from a file that is still on disk.
          const current = libraryService.listEpisodes(this.db, { seriesId: series.id });
          const taken = episodes.some((e) => current.find((c) => c.id === e.id)?.episodeFileId != null);
          if (episodes.length === 0 || taken) {
            result.unmapped.push(v.path);
            continue;
          }
          const { file } = libraryService.addMediaFile(this.db, {
            ...common,
            mediaType: 'series',
            seriesId: series.id,
            seasonNumber: episodes[0]!.seasonNumber,
            episodeIds: episodes.map((e) => e.id),
          });
          result.added.push({ path: v.path, mediaFileId: file.id });
        } else {
          const fresh = libraryService.getMovie(this.db, movie!.id);
          if (fresh.movieFileId != null) {
            result.unmapped.push(v.path);
            continue;
          }
          const { file } = libraryService.addMediaFile(this.db, {
            ...common,
            mediaType: 'movie',
            movieId: movie!.id,
            edition: parsed?.movie?.edition ?? null,
          });
          result.added.push({ path: v.path, mediaFileId: file.id });
        }
        this.bus?.publish({ type: 'library', action: 'fileAdded', mediaType: target.mediaType, id: series?.id ?? movie!.id });
      } catch (err) {
        this.log?.warn({ err, path: v.path }, 'rescan could not register file');
        result.unmapped.push(v.path);
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------------------
  // Rename
  // -------------------------------------------------------------------------------------

  previewRename(query: RenamePreviewQuery): RenamePreviewItem[] {
    const naming = this.getNaming();
    if (query.seriesId !== undefined) {
      const series = this.trySeries(query.seriesId);
      if (!series) throw new ImportsError('NOT_FOUND', `Series ${query.seriesId} not found`);
      const episodes = libraryService.listEpisodes(this.db, { seriesId: series.id });
      const files = this.filesOf({ seriesId: series.id }).filter((f) => query.seasonNumber === undefined || f.seasonNumber === query.seasonNumber);
      const out: RenamePreviewItem[] = [];
      for (const f of files) {
        const eps = episodes.filter((e) => f.episodeIds.includes(e.id));
        if (eps.length === 0) continue;
        const next = this.renameTarget(naming, f, { mediaType: 'series', series, episodes: eps });
        const nextRel = relative(series.path, next);
        if (nextRel === f.relativePath) continue;
        out.push({
          mediaFileId: f.id,
          mediaType: 'series',
          seriesId: series.id,
          seasonNumber: eps[0]!.seasonNumber,
          episodeNumbers: eps.map((e) => e.episodeNumber),
          existingPath: f.relativePath,
          newPath: nextRel,
        });
      }
      return out;
    }
    const movie = this.tryMovie(query.movieId!);
    if (!movie) throw new ImportsError('NOT_FOUND', `Movie ${query.movieId} not found`);
    const out: RenamePreviewItem[] = [];
    for (const f of this.filesOf({ movieId: movie.id })) {
      const next = this.renameTarget(naming, f, { mediaType: 'movie', movie, episodes: [] });
      const nextRel = relative(movie.path, next);
      if (nextRel === f.relativePath) continue;
      out.push({ mediaFileId: f.id, mediaType: 'movie', movieId: movie.id, existingPath: f.relativePath, newPath: nextRel });
    }
    return out;
  }

  private renameTarget(naming: NamingConfig, f: MediaFile, t: { mediaType: MediaType; series?: Series; movie?: Movie; episodes: Episode[] }): string {
    const file: NamingFile = {
      id: f.id,
      path: f.path,
      relativePath: f.relativePath,
      sceneName: f.sceneName ?? null,
      releaseGroup: f.releaseGroup ?? null,
      edition: f.edition ?? null,
      quality: f.quality,
      mediaInfo: f.mediaInfo ?? null,
    };
    const extras = { extension: extensionOf(f.path), pathSeparator: sep };
    if (t.mediaType === 'series') {
      const series = t.series!;
      const ns = { title: series.title, year: series.year, seriesType: series.seriesType, tvdbId: series.tvdbId ?? null, imdbId: series.imdbId ?? null, tmdbId: series.tmdbId };
      const season = t.episodes[0]?.seasonNumber ?? 0;
      const seasonFolder = series.seasonFolder ? buildSeasonFolder(naming, ns, season) : '';
      const folder = seasonFolder ? join(series.path, seasonFolder) : series.path;
      if (!naming.renameEpisodes) return join(folder, basename(f.path));
      return join(folder, buildEpisodeFileName(naming, ns, t.episodes.map(namingEpisode), file, { ...extras, seasonPath: folder }));
    }
    const movie = t.movie!;
    if (!naming.renameMovies) return f.path;
    const nm = {
      title: movie.title,
      year: movie.year,
      originalTitle: movie.originalTitle,
      collection: movie.collection ? { title: movie.collection.title } : null,
      certification: movie.certification ?? null,
      imdbId: movie.imdbId ?? null,
      tmdbId: movie.tmdbId,
    };
    return join(movie.path, buildMovieFileName(naming, nm, file, { ...extras, seasonPath: movie.path }));
  }

  async executeRename(command: RenameCommand): Promise<RenameResult> {
    const preview = this.previewRename(
      command.seriesId !== undefined ? { seriesId: command.seriesId } : { movieId: command.movieId! },
    ).filter((p) => !command.files || command.files.includes(p.mediaFileId));
    const settings = this.getMediaManagement();
    const base = command.seriesId !== undefined ? this.trySeries(command.seriesId)!.path : this.tryMovie(command.movieId!)!.path;
    const result: RenameResult = { renamed: [], failed: [] };
    for (const p of preview) {
      const from = join(base, p.existingPath);
      const to = join(base, p.newPath);
      try {
        await transferFile(from, to, 'move', this.fsOps ? { ops: this.fsOps } : {});
        // The library module has no "move file" service; the path columns are updated here.
        this.db.update(mediaFiles).set({ path: to, relativePath: p.newPath }).where(eq(mediaFiles.id, p.mediaFileId)).run();
        result.renamed.push(p);
      } catch (err) {
        result.failed.push({ mediaFileId: p.mediaFileId, error: errorMessage(err) });
      }
    }
    if (result.renamed.length > 0) {
      if (settings.deleteEmptyFolders) await deleteEmptyFolders(base);
      const mediaType: MediaType = command.seriesId !== undefined ? 'series' : 'movie';
      this.bus?.publish({ type: 'library', action: 'updated', mediaType, id: command.seriesId ?? command.movieId! });
    }
    return result;
  }

  // -------------------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------------------

  async cleanupRecycleBin(): Promise<{ deletedFiles: number; deletedFolders: number }> {
    const settings = this.getMediaManagement();
    return this.recycleBin(settings).cleanup(settings.recycleBinCleanupDays);
  }

  // -------------------------------------------------------------------------------------
  // Filesystem browser
  // -------------------------------------------------------------------------------------

  async listFileSystem(query: FileSystemQuery): Promise<FileSystemListing> {
    const requested = query.path?.trim() ?? '';
    if (requested === '') {
      if (this.platform === 'win32') {
        const drives: FileSystemListing['directories'] = [];
        for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
          const p = `${letter}:\\`;
          if (await isDirectory(p)) drives.push({ name: `${letter}:`, path: p, type: 'drive' });
        }
        return { path: '', parent: null, directories: drives, files: [] };
      }
    }
    // A bare drive letter (`C:`) resolves to the process's cwd on that drive; mean the root.
    const normalized = this.platform === 'win32' && /^[A-Za-z]:$/.test(requested) ? `${requested}\\` : requested;
    const path = normalized === '' ? (SUPPORTED_ROOT ?? '/') : resolve(normalized);
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      throw new ImportsError('NOT_FOUND', `Cannot read ${path}`);
    }
    const parsed = parsePathParts(path);
    const parent = parsed.root === path ? (this.platform === 'win32' ? '' : null) : dirname(path);
    const directories: FileSystemListing['directories'] = [];
    const files: FileSystemListing['files'] = [];
    for (const e of entries) {
      const full = join(path, e.name);
      if (e.isDirectory()) directories.push({ name: e.name, path: full, type: 'directory' });
      else if (e.isFile() && query.includeFiles) {
        const s = await stat(full).catch(() => null);
        files.push({
          name: e.name,
          path: full,
          type: 'file',
          ...(s ? { sizeBytes: s.size, lastModified: s.mtime.toISOString() } : {}),
        });
      }
    }
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return { path, parent, directories: directories.sort(byName), files: files.sort(byName) };
  }

  /** Create a folder for the path picker. Returns the new (or already existing) directory. */
  async makeDirectory(req: FileSystemMkdirRequest): Promise<FileSystemEntry> {
    let target: string;
    if (req.path !== undefined) {
      target = req.path.trim();
    } else {
      const name = (req.name ?? '').trim();
      if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name) || (this.platform === 'win32' && /[<>:"|?*]/.test(name))) {
        throw new ImportsError('VALIDATION', `Invalid folder name: ${name}`);
      }
      const parent = (req.parent ?? '').trim();
      if (!(await isDirectory(parent))) throw new ImportsError('NOT_FOUND', `Parent folder does not exist: ${parent}`);
      target = join(parent, name);
    }
    if (!isAbsolute(target)) throw new ImportsError('VALIDATION', 'Folder path must be absolute');
    target = resolve(target);
    if (await exists(target)) {
      if (!(await isDirectory(target))) throw new ImportsError('CONFLICT', `A file already exists at ${target}`);
    } else {
      try {
        await mkdir(target, { recursive: true });
      } catch (err) {
        throw new ImportsError('VALIDATION', `Cannot create ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const s = await stat(target);
    return { name: basename(target) || target, path: target, type: 'directory', lastModified: s.mtime.toISOString() };
  }

  /** Ids of media files the given list references (test/diagnostic helper). */
  mediaFileIdsAt(paths: readonly string[]): number[] {
    if (paths.length === 0) return [];
    return this.db.select({ id: mediaFiles.id }).from(mediaFiles).where(inArray(mediaFiles.path, [...paths])).all().map((r) => r.id);
  }
}

function dedupeEpisodes(list: Episode[]): Episode[] {
  const seen = new Set<number>();
  return list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** Spec 9.6 failure messages. */
function failureMessage(err: unknown, mediaType: MediaType): string {
  const what = mediaType === 'movie' ? 'movie' : 'episode';
  if (err instanceof ImportFileError) {
    switch (err.code) {
      case 'ROOT_FOLDER_NOT_FOUND':
        return `Failed to import ${what}, Root folder missing.`;
      case 'DESTINATION_EXISTS':
        return `Failed to import ${what}, Destination already exists.`;
      case 'RECYCLE_BIN':
        return `Failed to import ${what}, unable to move existing file to the Recycle Bin.`;
      default:
        return `Failed to import ${what}: ${err.message}`;
    }
  }
  if (err instanceof ImportsError) return err.message;
  return `Failed to import ${what}: ${errorMessage(err)}`;
}
