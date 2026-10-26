import { basename, extname } from 'node:path';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  HistoryCustomFormat,
  HistoryDeleteReason,
  HistoryEpisodeSummary,
  HistoryEventType,
  HistoryListQuery,
  HistoryMovieSummary,
  HistoryPage,
  HistoryRecord,
  HistoryReleaseSource,
  HistorySeriesSummary,
  MediaType,
  QualityModel,
  ReleaseProtocol,
} from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { episodes, movies, series } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { history, type HistoryRow, type NewHistoryRow } from './schema.js';

// ---- errors -------------------------------------------------------------------------

export type HistoryErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'NOT_GRABBED';

export class HistoryError extends Error {
  constructor(
    readonly code: HistoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HistoryError';
  }
}

export function historyHttpStatus(code: HistoryErrorCode): number {
  return code === 'NOT_FOUND' ? 404 : 400;
}

// ---- public input types -------------------------------------------------------------

/** Which items an event touches: the episodes of one series, or one movie. */
export type HistoryTarget =
  | { mediaType: 'series'; seriesId: number; episodeIds: readonly number[] }
  | { mediaType: 'movie'; movieId: number };

/** A single item: one episode or one movie. */
export type HistoryItemRef = { episodeId: number } | { movieId: number };

export type DataInput = Record<string, string | number | boolean | null | undefined>;

/** The release fields a grab records. `ReleaseResource` satisfies this. */
export interface GrabbedRelease {
  title: string;
  protocol: ReleaseProtocol;
  guid?: string;
  indexerName?: string;
  indexerId?: number;
  infoUrl?: string;
  downloadUrl?: string;
  size?: number;
  /** ISO-8601. */
  publishDate?: string;
  /** Torrents only. */
  infoHash?: string;
  age?: number;
  ageHours?: number;
  ageMinutes?: number;
  imdbId?: string;
  tvdbId?: number;
  tmdbId?: number;
  indexerFlags?: readonly string[];
}

/** What the parser/decision engine resolved for the release ("remote episode/movie"). */
export interface GrabMapping {
  target: HistoryTarget;
  quality: QualityModel;
  languages: readonly string[];
  releaseGroup?: string;
  customFormatScore?: number;
  releaseSource?: HistoryReleaseSource;
  /** TV: singleEpisode, multiEpisode, seasonPack. */
  releaseType?: string;
  /** How the parent was matched: title, alias, id. */
  matchType?: string;
  /** Obfuscation hash extracted by the parser, if any. */
  releaseHash?: string;
}

/** A download client name, or name + implementation type. */
export type DownloadClientRef = string | { name: string; implementation?: string };

export interface ImportHistoryInput {
  target: HistoryTarget;
  quality: QualityModel;
  languages: readonly string[];
  /** Scene name stored on the new library file; falls back to the dropped file's base name. */
  sceneName?: string | null;
  droppedPath: string;
  importedPath: string;
  fileId?: number;
  /** Blank triggers the best-effort lookup (spec 1.5.2). */
  downloadId?: string | null;
  downloadClient?: string;
  downloadClientName?: string;
  releaseGroup?: string;
  customFormatScore?: number;
  size?: number;
  indexerFlags?: readonly string[];
  releaseType?: string;
}

/** Live tracked-download values a failed/ignored row prefers over the grabbed row's data. */
export interface TrackedDownloadInfo {
  downloadId: string;
  title?: string;
  protocol?: ReleaseProtocol;
  downloadClientName?: string | null;
  releaseGroup?: string;
  sizeBytes?: number;
  indexer?: string;
}

/** The download-failed domain event (spec 3.2). */
export interface DownloadFailedEvent {
  target: HistoryTarget;
  sourceTitle: string;
  quality: QualityModel;
  languages: readonly string[];
  downloadId: string | null;
  message: string;
  /** Who/what marked it failed. */
  source?: string;
  /** The originating grabbed row's data map. */
  grabbedData: Record<string, string>;
  tracked?: TrackedDownloadInfo | null;
  skipRedownload: boolean;
  releaseSource: HistoryReleaseSource;
}

export type DownloadFailedHandler = (event: DownloadFailedEvent, rows: HistoryRecord[]) => void | Promise<void>;

export interface FileDeletedInput {
  target: HistoryTarget;
  /** Full path of the deleted file. */
  path: string;
  quality: QualityModel;
  languages: readonly string[];
  reason: HistoryDeleteReason;
  releaseGroup?: string;
  size?: number;
  indexerFlags?: readonly string[];
  releaseType?: string;
}

export interface FileRenamedInput {
  target: HistoryTarget;
  sourcePath: string;
  sourceRelativePath?: string;
  path: string;
  relativePath?: string;
  quality: QualityModel;
  languages: readonly string[];
  releaseGroup?: string;
  size?: number;
  indexerFlags?: readonly string[];
  releaseType?: string;
}

export interface IgnoredInput {
  target: HistoryTarget;
  /** The download item's title in the client. */
  sourceTitle: string;
  quality: QualityModel;
  languages: readonly string[];
  downloadId: string;
  downloadClient?: string;
  downloadClientName?: string;
  releaseGroup?: string;
  size?: number;
  indexer?: string;
  releaseType?: string;
}

export interface MarkFailedOptions {
  message?: string;
  source?: string;
  skipRedownload?: boolean;
}

export interface WasGrabbedQuery {
  guid?: string;
  indexer?: string;
  torrentInfoHash?: string;
}

export interface WasGrabbedOptions {
  /** Only consider guid matches grabbed within this many days. Hash matches ignore it. */
  withinDays?: number;
  /** Restrict to one parent. */
  seriesId?: number;
  movieId?: number;
}

export interface IncludeOptions {
  includeSeries?: boolean;
  includeEpisode?: boolean;
  includeMovie?: boolean;
}

export interface CleanupResult {
  orphaned: number;
  expired: number;
}

export type CustomFormatResolver = (record: Omit<HistoryRecord, 'customFormats'>) => HistoryCustomFormat[];

export interface HistoryServiceOptions {
  db: Db;
  log: Logger;
  bus?: EventBus;
  now?: () => Date;
  /** Days to keep history; null/0 keeps forever (the default). */
  retentionDays?: number | null;
  customFormats?: CustomFormatResolver;
}

// ---- data map helpers ---------------------------------------------------------------

/** `Indexer` -> `indexer`, `NzbInfoUrl` -> `nzbInfoUrl`. */
export function normalizeDataKey(key: string): string {
  return key.length === 0 ? key : key.charAt(0).toLowerCase() + key.slice(1);
}

/** Normalises keys and stringifies values; drops null, undefined and empty strings. */
export function normalizeData(input: DataInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    const str = String(value);
    if (str === '') continue;
    out[normalizeDataKey(key)] = str;
  }
  return out;
}

/** Case-insensitive read from a history data map. */
export function dataValue(data: Readonly<Record<string, string>>, key: string): string | undefined {
  const direct = data[key] ?? data[normalizeDataKey(key)];
  if (direct !== undefined) return direct;
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(data)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Reads a protocol stored as a name or as the upstream integer (1 usenet, 2 torrent). */
export function parseProtocol(value: string | undefined): ReleaseProtocol | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'usenet' || v === '1') return 'usenet';
  if (v === 'torrent' || v === '2') return 'torrent';
  return undefined;
}

/** ISO-8601 UTC with second precision and trailing Z. */
export function isoSeconds(value: string | Date): string | undefined {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function clientParts(client: DownloadClientRef | undefined): { name?: string; implementation?: string } {
  if (client === undefined) return {};
  if (typeof client === 'string') return { name: client };
  return client.implementation === undefined ? { name: client.name } : client;
}

function sameQuality(a: QualityModel, b: QualityModel): boolean {
  return (
    a.quality.id === b.quality.id &&
    a.revision.version === b.revision.version &&
    a.revision.real === b.revision.real
  );
}

const RELEASE_SOURCES: readonly HistoryReleaseSource[] = [
  'unknown',
  'rss',
  'search',
  'userInvokedSearch',
  'interactiveSearch',
  'releasePush',
];

function parseReleaseSource(value: string | undefined): HistoryReleaseSource {
  if (value === undefined) return 'unknown';
  const found = RELEASE_SOURCES.find((s) => s.toLowerCase() === value.toLowerCase());
  return found ?? 'unknown';
}

// ---- service ------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export class HistoryService {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly bus: EventBus | undefined;
  private readonly now: () => Date;
  private readonly resolveFormats: CustomFormatResolver | undefined;
  private readonly failedHandlers: { handler: DownloadFailedHandler; priority: number }[] = [];
  private markFailedHook: DownloadFailedHandler | undefined;
  retentionDays: number | null;

  constructor(opts: HistoryServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.bus = opts.bus;
    this.now = opts.now ?? (() => new Date());
    this.retentionDays = opts.retentionDays ?? null;
    this.resolveFormats = opts.customFormats;
  }

  // ---- hooks ------------------------------------------------------------------------

  /**
   * Subscribe to download-failed events. Handlers run after the failed history rows are
   * written, lowest priority first, then in registration order. The blocklist uses 0;
   * automatic redownload should use a high number (e.g. 100) so it always runs last.
   */
  onDownloadFailed(handler: DownloadFailedHandler, priority = 0): () => void {
    const entry = { handler, priority };
    this.failedHandlers.push(entry);
    // Stable sort keeps registration order within a priority.
    this.failedHandlers.sort((a, b) => a.priority - b.priority);
    return () => {
      const i = this.failedHandlers.indexOf(entry);
      if (i >= 0) this.failedHandlers.splice(i, 1);
    };
  }

  /** Extra hook run after a manual "mark as failed" has gone through the failed pipeline. */
  setOnMarkFailed(hook: DownloadFailedHandler | undefined): void {
    this.markFailedHook = hook;
  }

  // ---- writers ----------------------------------------------------------------------

  recordGrab(
    release: GrabbedRelease,
    mapping: GrabMapping,
    downloadId: string | null | undefined,
    client: DownloadClientRef,
  ): HistoryRecord[] {
    const { name, implementation } = clientParts(client);
    const publishMs = release.publishDate ? new Date(release.publishDate).getTime() : Number.NaN;
    const ageMs = Number.isNaN(publishMs) ? undefined : Math.max(0, this.now().getTime() - publishMs);
    const isTorrent = release.protocol === 'torrent';
    const data = normalizeData({
      indexer: release.indexerName,
      indexerId: release.indexerId,
      nzbInfoUrl: release.infoUrl,
      releaseGroup: mapping.releaseGroup,
      age: release.age ?? (ageMs === undefined ? undefined : Math.floor(ageMs / DAY_MS)),
      ageHours: release.ageHours ?? (ageMs === undefined ? undefined : ageMs / 3_600_000),
      ageMinutes: release.ageMinutes ?? (ageMs === undefined ? undefined : ageMs / 60_000),
      publishedDate: release.publishDate ? isoSeconds(release.publishDate) : undefined,
      downloadClient: implementation ?? name,
      downloadClientName: name,
      size: release.size,
      downloadUrl: release.downloadUrl,
      guid: release.guid,
      imdbId: release.imdbId,
      tvdbId: release.tvdbId,
      tmdbId: release.tmdbId,
      protocol: release.protocol,
      customFormatScore: mapping.customFormatScore ?? 0,
      releaseSource: mapping.releaseSource ?? 'unknown',
      indexerFlags: release.indexerFlags && release.indexerFlags.length > 0 ? release.indexerFlags.join(',') : undefined,
      releaseHash: mapping.releaseHash,
      torrentInfoHash: isTorrent ? release.infoHash : undefined,
      releaseType: mapping.target.mediaType === 'series' ? mapping.releaseType : undefined,
      seriesMatchType: mapping.target.mediaType === 'series' ? mapping.matchType : undefined,
      movieMatchType: mapping.target.mediaType === 'movie' ? mapping.matchType : undefined,
    });
    return this.insert(mapping.target, {
      eventType: 'grabbed',
      sourceTitle: release.title,
      quality: mapping.quality,
      languages: [...mapping.languages],
      downloadId: blankToNull(downloadId),
      data,
    });
  }

  recordImport(input: ImportHistoryInput): HistoryRecord[] {
    const sourceTitle =
      input.sceneName && input.sceneName.trim() !== ''
        ? input.sceneName
        : basename(input.droppedPath, extname(input.droppedPath));
    const downloadId = blankToNull(input.downloadId) ?? this.findDownloadIdForImport(input.target, input.quality);
    const data = normalizeData({
      fileId: input.fileId,
      droppedPath: input.droppedPath,
      importedPath: input.importedPath,
      downloadClient: input.downloadClient,
      downloadClientName: input.downloadClientName,
      releaseGroup: input.releaseGroup,
      customFormatScore: input.customFormatScore,
      size: input.size,
      indexerFlags: joinFlags(input.indexerFlags),
      releaseType: input.target.mediaType === 'series' ? input.releaseType : undefined,
    });
    return this.insert(input.target, {
      eventType: 'downloadFolderImported',
      sourceTitle,
      quality: input.quality,
      languages: [...input.languages],
      downloadId,
      data,
    });
  }

  /** Writes the failed row(s) for an event. Prefer `downloadFailed` which also runs subscribers. */
  recordFailed(event: DownloadFailedEvent): HistoryRecord[] {
    const g = event.grabbedData;
    const t = event.tracked ?? undefined;
    const data = normalizeData({
      downloadClient: dataValue(g, 'downloadClient'),
      downloadClientName: t?.downloadClientName ?? undefined,
      message: event.message,
      releaseGroup: t?.releaseGroup ?? dataValue(g, 'releaseGroup'),
      size: t?.sizeBytes ?? dataValue(g, 'size'),
      indexer: t?.indexer ?? dataValue(g, 'indexer'),
      source: event.source,
    });
    return this.insert(event.target, {
      eventType: 'downloadFailed',
      sourceTitle: event.sourceTitle,
      quality: event.quality,
      languages: [...event.languages],
      downloadId: event.downloadId,
      data,
    });
  }

  /** The failed pipeline: history rows, then subscribers in registration order. */
  async downloadFailed(event: DownloadFailedEvent): Promise<HistoryRecord[]> {
    const rows = this.recordFailed(event);
    for (const { handler } of [...this.failedHandlers]) {
      try {
        await handler(event, rows);
      } catch (err) {
        this.log.error({ err, downloadId: event.downloadId }, 'download-failed handler threw');
      }
    }
    return rows;
  }

  recordFileDeleted(input: FileDeletedInput): HistoryRecord[] {
    // Orphan cleanup and manual-import overrides never write history (spec 1.3.4).
    if (input.reason === 'NoLinkedEpisodes' || input.reason === 'ManualOverride') return [];
    const data = normalizeData({
      reason: input.reason,
      releaseGroup: input.releaseGroup,
      size: input.size,
      indexerFlags: joinFlags(input.indexerFlags),
      releaseType: input.target.mediaType === 'series' ? input.releaseType : undefined,
    });
    return this.insert(input.target, {
      eventType: 'fileDeleted',
      sourceTitle: input.path,
      quality: input.quality,
      languages: [...input.languages],
      downloadId: null,
      data,
    });
  }

  recordRenamed(input: FileRenamedInput): HistoryRecord[] {
    const data = normalizeData({
      sourcePath: input.sourcePath,
      sourceRelativePath: input.sourceRelativePath,
      path: input.path,
      relativePath: input.relativePath,
      releaseGroup: input.releaseGroup,
      size: input.size,
      indexerFlags: joinFlags(input.indexerFlags),
      releaseType: input.target.mediaType === 'series' ? input.releaseType : undefined,
    });
    return this.insert(input.target, {
      eventType: 'fileRenamed',
      sourceTitle: input.sourcePath,
      quality: input.quality,
      languages: [...input.languages],
      downloadId: null,
      data,
    });
  }

  recordIgnored(input: IgnoredInput): HistoryRecord[] {
    if (input.target.mediaType === 'series' && input.target.episodeIds.length === 0) {
      this.log.warn({ downloadId: input.downloadId }, 'cannot ignore a download not matched to any episode');
      return [];
    }
    const data = normalizeData({
      downloadClient: input.downloadClient,
      downloadClientName: input.downloadClientName,
      message: 'Manually ignored',
      releaseGroup: input.releaseGroup,
      size: input.size,
      indexer: input.indexer,
      releaseType: input.target.mediaType === 'series' ? input.releaseType : undefined,
    });
    return this.insert(input.target, {
      eventType: 'downloadIgnored',
      sourceTitle: input.sourceTitle,
      quality: input.quality,
      languages: [...input.languages],
      downloadId: input.downloadId,
      data,
    });
  }

  // ---- failure flows ----------------------------------------------------------------

  /** Builds a failed event from the grabbed rows of one download (newest first). */
  failedEventFromGrabbed(
    grabbed: readonly HistoryRecord[],
    opts: { message: string; source?: string; tracked?: TrackedDownloadInfo | null; skipRedownload?: boolean },
  ): DownloadFailedEvent {
    const template = grabbed[0];
    if (!template) throw new HistoryError('NOT_GRABBED', 'No grabbed history to build a failed event from');
    const target: HistoryTarget =
      template.mediaType === 'series'
        ? {
            mediaType: 'series',
            seriesId: template.seriesId ?? 0,
            episodeIds: [...new Set(grabbed.map((r) => r.episodeId).filter((id): id is number => id !== null))].sort(
              (a, b) => a - b,
            ),
          }
        : { mediaType: 'movie', movieId: template.movieId ?? 0 };
    const event: DownloadFailedEvent = {
      target,
      sourceTitle: template.sourceTitle,
      quality: template.quality,
      languages: template.languages,
      downloadId: template.downloadId,
      message: opts.message,
      grabbedData: template.data,
      tracked: opts.tracked ?? null,
      skipRedownload: opts.skipRedownload ?? false,
      releaseSource: parseReleaseSource(dataValue(template.data, 'releaseSource')),
    };
    if (opts.source !== undefined) event.source = opts.source;
    return event;
  }

  /** Manual "mark as failed" on a history row (spec 3.5.1). */
  async markFailed(id: number, opts: MarkFailedOptions = {}): Promise<HistoryRecord[]> {
    const row = this.get(id);
    if (!row) throw new HistoryError('NOT_FOUND', `history item ${id} not found`);

    let grabbed: HistoryRecord[];
    if (!row.downloadId) {
      if (row.eventType !== 'grabbed') {
        throw new HistoryError(
          'VALIDATION',
          'Unable to mark download as failed, history item was not grabbed and has no download ID',
        );
      }
      grabbed = [row];
    } else {
      const byId = this.findByDownloadId(row.downloadId, 'grabbed');
      const seen = new Set<number>();
      grabbed = [...(row.eventType === 'grabbed' ? [row] : []), ...byId].filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
      if (grabbed.length === 0) {
        throw new HistoryError('NOT_GRABBED', `No grabbed history for download ${row.downloadId}`);
      }
    }

    const eventOpts: Parameters<HistoryService['failedEventFromGrabbed']>[1] = {
      message: opts.message ?? 'Manually marked as failed',
      skipRedownload: opts.skipRedownload ?? false,
    };
    if (opts.source !== undefined) eventOpts.source = opts.source;
    const event = this.failedEventFromGrabbed(grabbed, eventOpts);
    const rows = await this.downloadFailed(event);
    if (this.markFailedHook) await this.markFailedHook(event, rows);
    return rows;
  }

  /**
   * Fail a live tracked download: used by failed-download handling (client reported failure)
   * and by queue removal with the blocklist option (spec 3.1, 3.5.2).
   */
  async failTracked(tracked: TrackedDownloadInfo, opts: MarkFailedOptions = {}): Promise<HistoryRecord[]> {
    const grabbed = this.findByDownloadId(tracked.downloadId, 'grabbed');
    if (grabbed.length === 0) {
      throw new HistoryError('NOT_GRABBED', `Download ${tracked.downloadId} was not grabbed by Media-Tron`);
    }
    const eventOpts: Parameters<HistoryService['failedEventFromGrabbed']>[1] = {
      message: opts.message ?? 'Manually marked as failed',
      tracked,
      skipRedownload: opts.skipRedownload ?? false,
    };
    if (opts.source !== undefined) eventOpts.source = opts.source;
    return this.downloadFailed(this.failedEventFromGrabbed(grabbed, eventOpts));
  }

  // ---- lookups ----------------------------------------------------------------------

  get(id: number): HistoryRecord | null {
    const row = this.db.select().from(history).where(eq(history.id, id)).get();
    return row ? this.toRecord(row) : null;
  }

  /** All rows for a download id, newest first, optionally one event type. */
  findByDownloadId(downloadId: string, eventType?: HistoryEventType): HistoryRecord[] {
    const conds: SQL[] = [eq(history.downloadId, downloadId)];
    if (eventType) conds.push(eq(history.eventType, eventType));
    return this.select(and(...conds), 'newest');
  }

  mostRecentForDownloadId(downloadId: string, eventType?: HistoryEventType): HistoryRecord | null {
    return this.findByDownloadId(downloadId, eventType)[0] ?? null;
  }

  /** All rows for one item, newest first. */
  forItem(ref: HistoryItemRef, eventType?: HistoryEventType): HistoryRecord[] {
    const conds: SQL[] = ['episodeId' in ref ? eq(history.episodeId, ref.episodeId) : eq(history.movieId, ref.movieId)];
    if (eventType) conds.push(eq(history.eventType, eventType));
    return this.select(and(...conds), 'newest');
  }

  mostRecentForEpisode(episodeId: number, eventType?: HistoryEventType): HistoryRecord | null {
    return this.mostRecent({ episodeId }, eventType);
  }

  mostRecentForMovie(movieId: number, eventType?: HistoryEventType): HistoryRecord | null {
    return this.mostRecent({ movieId }, eventType);
  }

  private mostRecent(ref: HistoryItemRef, eventType?: HistoryEventType): HistoryRecord | null {
    const conds: SQL[] = ['episodeId' in ref ? eq(history.episodeId, ref.episodeId) : eq(history.movieId, ref.movieId)];
    if (eventType) conds.push(eq(history.eventType, eventType));
    const row = this.db
      .select()
      .from(history)
      .where(and(...conds))
      .orderBy(desc(history.date), desc(history.id))
      .limit(1)
      .get();
    return row ? this.toRecord(row) : null;
  }

  /** Rows for a series, optionally one season and/or event type, newest first. */
  forSeries(
    seriesId: number,
    opts: { seasonNumber?: number; eventType?: HistoryEventType } & IncludeOptions = {},
  ): HistoryRecord[] {
    const conds: SQL[] = [eq(history.seriesId, seriesId), eq(history.mediaType, 'series')];
    if (opts.eventType) conds.push(eq(history.eventType, opts.eventType));
    if (opts.seasonNumber !== undefined) {
      conds.push(
        inArray(
          history.episodeId,
          this.db
            .select({ id: episodes.id })
            .from(episodes)
            .where(and(eq(episodes.seriesId, seriesId), eq(episodes.seasonNumber, opts.seasonNumber))),
        ),
      );
    }
    return this.embed(this.select(and(...conds), 'newest'), opts);
  }

  /** Rows for a movie, newest first. */
  forMovie(movieId: number, opts: { eventType?: HistoryEventType } & IncludeOptions = {}): HistoryRecord[] {
    const conds: SQL[] = [eq(history.movieId, movieId), eq(history.mediaType, 'movie')];
    if (opts.eventType) conds.push(eq(history.eventType, opts.eventType));
    return this.embed(this.select(and(...conds), 'newest'), opts);
  }

  /** Rows at or after `date`, oldest first (third-party pollers). */
  since(date: string, eventType?: HistoryEventType, include: IncludeOptions = {}): HistoryRecord[] {
    const from = new Date(date);
    if (Number.isNaN(from.getTime())) throw new HistoryError('VALIDATION', `invalid date: ${date}`);
    const conds: SQL[] = [gte(history.date, from.toISOString())];
    if (eventType) conds.push(eq(history.eventType, eventType));
    return this.embed(this.select(and(...conds), 'oldest'), include);
  }

  /**
   * The most recent grabbed row for the same release: same torrent hash (as download id or
   * recorded info-hash), or same guid on the same indexer (optionally within N days).
   */
  wasGrabbed(release: WasGrabbedQuery, opts: WasGrabbedOptions = {}): HistoryRecord | null {
    const matches: SQL[] = [];
    const hash = release.torrentInfoHash?.trim().toLowerCase();
    if (hash) {
      matches.push(
        or(
          sql`lower(${history.downloadId}) = ${hash}`,
          sql`lower(json_extract(${history.data}, '$.torrentInfoHash')) = ${hash}`,
        )!,
      );
    }
    const guid = release.guid?.trim();
    if (guid) {
      const guidConds: SQL[] = [sql`json_extract(${history.data}, '$.guid') = ${guid}`];
      const indexer = release.indexer?.trim().toLowerCase();
      if (indexer) guidConds.push(sql`lower(json_extract(${history.data}, '$.indexer')) = ${indexer}`);
      if (opts.withinDays !== undefined) {
        const cutoff = new Date(this.now().getTime() - opts.withinDays * DAY_MS).toISOString();
        guidConds.push(gte(history.date, cutoff));
      }
      matches.push(and(...guidConds)!);
    }
    if (matches.length === 0) return null;
    const conds: SQL[] = [eq(history.eventType, 'grabbed'), or(...matches)!];
    if (opts.seriesId !== undefined) conds.push(eq(history.seriesId, opts.seriesId));
    if (opts.movieId !== undefined) conds.push(eq(history.movieId, opts.movieId));
    const row = this.db
      .select()
      .from(history)
      .where(and(...conds))
      .orderBy(desc(history.date), desc(history.id))
      .limit(1)
      .get();
    return row ? this.toRecord(row) : null;
  }

  /**
   * For the already-imported check (spec 1.7.1): the item's newest grabbed row and the newest
   * imported row with the same download id. Null when either is missing.
   */
  grabImportPair(ref: HistoryItemRef): { grabbed: HistoryRecord; imported: HistoryRecord } | null {
    const grabbed = this.mostRecent(ref, 'grabbed');
    if (!grabbed?.downloadId) return null;
    const itemCond = 'episodeId' in ref ? eq(history.episodeId, ref.episodeId) : eq(history.movieId, ref.movieId);
    const row = this.db
      .select()
      .from(history)
      .where(
        and(itemCond, eq(history.eventType, 'downloadFolderImported'), eq(history.downloadId, grabbed.downloadId)),
      )
      .orderBy(desc(history.date), desc(history.id))
      .limit(1)
      .get();
    return row ? { grabbed, imported: this.toRecord(row) } : null;
  }

  /**
   * Best-effort download id for an import that lacks one (spec 1.5.2). Returns null when
   * nothing is still downloading or the answer is ambiguous.
   */
  findDownloadIdForImport(target: HistoryTarget, quality: QualityModel): string | null {
    const parentCond =
      target.mediaType === 'series' ? eq(history.seriesId, target.seriesId) : eq(history.movieId, target.movieId);
    let rows = this.select(
      and(parentCond, inArray(history.eventType, ['grabbed', 'downloadFailed', 'downloadFolderImported'])),
      'newest',
    ).filter((r) => sameQuality(r.quality, quality));
    if (target.mediaType === 'series') {
      const wanted = new Set(target.episodeIds);
      rows = rows.filter((r) => r.episodeId !== null && wanted.has(r.episodeId));
    }
    const processed = new Set(
      rows.filter((r) => r.eventType !== 'grabbed' && r.downloadId).map((r) => r.downloadId as string),
    );
    const stillDownloading = rows.filter(
      (r) => r.eventType === 'grabbed' && r.downloadId !== null && !processed.has(r.downloadId),
    );
    if (stillDownloading.length === 0) return null;

    if (target.mediaType === 'movie') {
      const ids = new Set(stillDownloading.map((r) => r.downloadId as string));
      return ids.size === 1 ? [...ids][0]! : null;
    }
    // Duplicate grabs of the same download id for one episode collapse to one candidate.
    let agreed: string | null = null;
    for (const episodeId of target.episodeIds) {
      const ids = new Set(stillDownloading.filter((r) => r.episodeId === episodeId).map((r) => r.downloadId as string));
      if (ids.size !== 1) return null;
      const id = [...ids][0]!;
      if (agreed !== null && agreed !== id) return null;
      agreed = id;
    }
    return agreed;
  }

  /** Paged, filtered, sorted list for the activity UI. */
  list(query: HistoryListQuery): HistoryPage {
    const conds: SQL[] = [];
    if (query.eventType && query.eventType.length > 0) conds.push(inArray(history.eventType, query.eventType));
    if (query.mediaType) conds.push(eq(history.mediaType, query.mediaType));
    if (query.seriesId && query.seriesId.length > 0) conds.push(inArray(history.seriesId, query.seriesId));
    if (query.episodeId !== undefined) conds.push(eq(history.episodeId, query.episodeId));
    if (query.movieId && query.movieId.length > 0) conds.push(inArray(history.movieId, query.movieId));
    if (query.downloadId) conds.push(eq(history.downloadId, query.downloadId));
    if (query.quality && query.quality.length > 0) {
      conds.push(
        sql`json_extract(${history.quality}, '$.quality.id') in (${sql.join(
          query.quality.map((q) => sql`${q}`),
          sql`, `,
        )})`,
      );
    }
    if (query.language && query.language.length > 0) {
      conds.push(
        sql`exists (select 1 from json_each(${history.languages}) where json_each.value in (${sql.join(
          query.language.map((l) => sql`${l}`),
          sql`, `,
        )}))`,
      );
    }
    const where = conds.length > 0 ? and(...conds) : undefined;

    const total = this.db
      .select({ n: sql<number>`count(*)` })
      .from(history)
      .where(where)
      .get();

    const dir = query.sortDirection === 'asc' ? asc : desc;
    const sortExpr: SQL = (() => {
      switch (query.sortKey) {
        case 'sourceTitle':
          return sql`lower(${history.sourceTitle})`;
        case 'title':
          return sql`coalesce(${series.sortTitle}, ${movies.sortTitle})`;
        case 'quality':
          return sql`json_extract(${history.quality}, '$.quality.weight')`;
        case 'eventType':
          return sql`${history.eventType}`;
        case 'date':
          return sql`${history.date}`;
      }
    })();

    const rows = this.db
      .select({ h: history })
      .from(history)
      .leftJoin(series, eq(history.seriesId, series.id))
      .leftJoin(movies, eq(history.movieId, movies.id))
      .where(where)
      .orderBy(dir(sortExpr), dir(history.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();

    return {
      page: query.page,
      pageSize: query.pageSize,
      sortKey: query.sortKey,
      sortDirection: query.sortDirection,
      totalRecords: Number(total?.n ?? 0),
      records: this.embed(
        rows.map((r) => this.toRecord(r.h)),
        query,
      ),
    };
  }

  // ---- deletion / housekeeping ------------------------------------------------------

  deleteForParent(mediaType: MediaType, id: number): number {
    const cond = mediaType === 'series' ? eq(history.seriesId, id) : eq(history.movieId, id);
    return this.db.delete(history).where(and(eq(history.mediaType, mediaType), cond)).run().changes;
  }

  /**
   * Removes rows whose parent (or, for TV, episode) no longer exists, plus rows older than
   * the retention period when one is configured.
   */
  cleanup(retentionDays: number | null = this.retentionDays): CleanupResult {
    let orphaned = 0;
    orphaned += this.db
      .delete(history)
      .where(
        and(
          eq(history.mediaType, 'series'),
          or(
            sql`${history.seriesId} is null`,
            notInArray(history.seriesId, this.db.select({ id: series.id }).from(series)),
          ),
        ),
      )
      .run().changes;
    orphaned += this.db
      .delete(history)
      .where(
        and(
          eq(history.mediaType, 'series'),
          isNotNull(history.episodeId),
          notInArray(history.episodeId, this.db.select({ id: episodes.id }).from(episodes)),
        ),
      )
      .run().changes;
    orphaned += this.db
      .delete(history)
      .where(
        and(
          eq(history.mediaType, 'movie'),
          or(
            sql`${history.movieId} is null`,
            notInArray(history.movieId, this.db.select({ id: movies.id }).from(movies)),
          ),
        ),
      )
      .run().changes;

    let expired = 0;
    if (retentionDays !== null && retentionDays > 0) {
      const cutoff = new Date(this.now().getTime() - retentionDays * DAY_MS).toISOString();
      expired = this.db.delete(history).where(lt(history.date, cutoff)).run().changes;
    }
    return { orphaned, expired };
  }

  // ---- internals --------------------------------------------------------------------

  private insert(
    target: HistoryTarget,
    base: Omit<NewHistoryRow, 'id' | 'date' | 'mediaType' | 'seriesId' | 'episodeId' | 'movieId'>,
  ): HistoryRecord[] {
    const date = this.now().toISOString();
    const values: NewHistoryRow[] =
      target.mediaType === 'movie'
        ? [{ ...base, date, mediaType: 'movie', seriesId: null, episodeId: null, movieId: target.movieId }]
        : (target.episodeIds.length > 0 ? [...new Set(target.episodeIds)] : [null]).map((episodeId) => ({
            ...base,
            date,
            mediaType: 'series' as const,
            seriesId: target.seriesId,
            episodeId,
            movieId: null,
          }));
    const rows = this.db.insert(history).values(values).returning().all();
    if (rows.length > 0) this.bus?.publish({ type: 'history', action: 'added' });
    return rows.map((r) => this.toRecord(r));
  }

  private select(where: SQL | undefined, order: 'newest' | 'oldest'): HistoryRecord[] {
    const dir = order === 'newest' ? desc : asc;
    return this.db
      .select()
      .from(history)
      .where(where)
      .orderBy(dir(history.date), dir(history.id))
      .all()
      .map((r) => this.toRecord(r));
  }

  private toRecord(row: HistoryRow): HistoryRecord {
    const score = Number.parseInt(dataValue(row.data, 'customFormatScore') ?? '0', 10);
    const base: Omit<HistoryRecord, 'customFormats'> = {
      id: row.id,
      eventType: row.eventType,
      mediaType: row.mediaType,
      seriesId: row.seriesId,
      episodeId: row.episodeId,
      movieId: row.movieId,
      sourceTitle: row.sourceTitle,
      quality: row.quality,
      languages: row.languages,
      customFormatScore: Number.isNaN(score) ? 0 : score,
      date: row.date,
      downloadId: row.downloadId,
      data: row.data,
    };
    return { ...base, customFormats: this.resolveFormats ? this.resolveFormats(base) : [] };
  }

  private embed(records: HistoryRecord[], include: IncludeOptions): HistoryRecord[] {
    if (records.length === 0) return records;
    const ids = (pick: (r: HistoryRecord) => number | null) =>
      [...new Set(records.map(pick).filter((v): v is number => v !== null))];

    const seriesById = new Map<number, HistorySeriesSummary>();
    if (include.includeSeries) {
      const wanted = ids((r) => r.seriesId);
      if (wanted.length > 0) {
        for (const s of this.db
          .select({
            id: series.id,
            title: series.title,
            sortTitle: series.sortTitle,
            year: series.year,
            qualityProfileId: series.qualityProfileId,
          })
          .from(series)
          .where(inArray(series.id, wanted))
          .all())
          seriesById.set(s.id, s);
      }
    }
    const episodesById = new Map<number, HistoryEpisodeSummary>();
    if (include.includeEpisode) {
      const wanted = ids((r) => r.episodeId);
      if (wanted.length > 0) {
        for (const e of this.db
          .select({
            id: episodes.id,
            seriesId: episodes.seriesId,
            seasonNumber: episodes.seasonNumber,
            episodeNumber: episodes.episodeNumber,
            title: episodes.title,
            airDate: episodes.airDate,
          })
          .from(episodes)
          .where(inArray(episodes.id, wanted))
          .all())
          episodesById.set(e.id, e);
      }
    }
    const moviesById = new Map<number, HistoryMovieSummary>();
    if (include.includeMovie) {
      const wanted = ids((r) => r.movieId);
      if (wanted.length > 0) {
        for (const m of this.db
          .select({
            id: movies.id,
            title: movies.title,
            sortTitle: movies.sortTitle,
            year: movies.year,
            qualityProfileId: movies.qualityProfileId,
          })
          .from(movies)
          .where(inArray(movies.id, wanted))
          .all())
          moviesById.set(m.id, m);
      }
    }

    return records.map((r) => {
      const out: HistoryRecord = { ...r };
      const s = r.seriesId !== null ? seriesById.get(r.seriesId) : undefined;
      if (s) out.series = s;
      const e = r.episodeId !== null ? episodesById.get(r.episodeId) : undefined;
      if (e) out.episode = e;
      const m = r.movieId !== null ? moviesById.get(r.movieId) : undefined;
      if (m) out.movie = m;
      return out;
    });
  }
}

function blankToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value;
}

function joinFlags(flags: readonly string[] | undefined): string | undefined {
  return flags && flags.length > 0 ? flags.join(',') : undefined;
}
