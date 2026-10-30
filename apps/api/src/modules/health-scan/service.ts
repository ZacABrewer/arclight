import { open, stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { and, asc, desc, eq, inArray, isNotNull, lt, max, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  BlocklistAddRequestInput,
  HealthAction,
  HealthActionItemResult,
  HealthActionResult,
  HealthCounts,
  HealthFileRef,
  HealthFileSource,
  HealthFinding,
  HealthFindingData,
  HealthFindingType,
  HealthListQuery,
  HealthListResponse,
  HealthMediaType,
  HealthScanMode,
  HealthScanRequest,
  HealthScanSettings,
  HealthSeverity,
  MediaVersion,
  QualityModel,
  ReleaseProtocol,
} from '@arclight/shared';
import { HealthFindingType as FindingTypes, HealthSeverity as Severities } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import {
  additionalLanguages,
  albums,
  artists,
  audioFiles,
  authors,
  books,
  episodes,
  episodeVersionFiles,
  history,
  mediaFiles,
  movies,
  qualityProfiles,
  rootFolders,
  series,
  tracks,
} from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { requiredAudioFor } from '../additional-languages/audio.js';
import { RecycleBin } from '../imports/index.js';
import { isUnder } from '../imports/scan.js';
import { libraryService } from '../library/index.js';
import { findVersion, profileIdForSlot, slotOf } from '../library/versions.js';
import type { SearchTarget } from '../releases/service.js';
import { getSection } from '../settings/service.js';
import {
  bookPartProblems,
  checkFile,
  describe,
  insideWindow,
  languageRequirement,
  trackGaps,
  truncation,
  type Detected,
  type FileKind,
  type LanguageRequirement,
  type StatOutcome,
} from './checks.js';
import { healthFindings, healthScanFiles, type HealthFindingRow } from './schema.js';
import type { HealthTools } from './tools.js';

// The health scan: gathers library files (movies, episodes, music tracks, audiobook parts),
// checks each one (stat, ffprobe, ffmpeg decode, metadata runtime, audio languages), checks
// album / book structure from the database, and reconciles the findings table. Plus the fix
// actions on findings (replace, re-check, ignore, delete).

export type HealthScanErrorCode = 'NOT_FOUND' | 'VALIDATION';

export class HealthScanError extends Error {
  constructor(
    readonly code: HealthScanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HealthScanError';
  }
}

/** A summary line of the "Health scan found problems" notification. */
export interface HealthNotificationLine {
  title: string;
  type: HealthFindingType;
  severity: HealthSeverity;
  details: string;
}

export interface HealthScanSummaryEvent {
  newFindings: HealthNotificationLine[];
  totalNew: number;
  totalOpen: number;
  filesChecked: number;
}

export interface HealthScanServiceOptions {
  db: Db;
  tools: HealthTools;
  bus?: EventBus | undefined;
  log?: Logger | undefined;
  now?: () => Date;
  /** File system probe (tests replace it). */
  statFile?: (path: string) => Promise<StatOutcome>;
  /** Blocklist a release (video). */
  blocklist?: ((input: BlocklistAddRequestInput) => void) | undefined;
  /** Search for replacements; answers the job id of the search (null when none started). */
  search?: ((targets: SearchTarget[]) => number | null) | undefined;
  /** Sends the "Health scan found problems" notification. */
  notify?: ((summary: HealthScanSummaryEvent) => Promise<unknown>) | undefined;
}

export interface ScanRunOptions {
  signal?: AbortSignal | undefined;
  /** The scheduled run: honours the time window (manual runs do not). */
  scheduled?: boolean;
}

export interface ScanResult {
  /** Files in scope. */
  files: number;
  checked: number;
  /** Unchanged since their last check (resume). */
  skipped: number;
  /** Findings that are new (or came back) in this run. */
  newFindings: number;
  fixed: number;
  /** Stopped at the end of the time window (or cancelled) before every file was checked. */
  stoppedEarly: boolean;
}

/** One library file to check, with what the library expects of it. */
export interface ScanItem {
  source: HealthFileSource;
  fileId: number;
  path: string;
  kind: FileKind;
  mediaType: HealthMediaType;
  title: string;
  seriesId: number | null;
  movieId: number | null;
  artistId: number | null;
  albumId: number | null;
  authorId: number | null;
  bookId: number | null;
  episodeIds: number[];
  expectedSeconds: number | null;
  trackNumber: number | null;
  language: LanguageRequirement | null;
  /** Release the file was imported from, for blocklisting (video). */
  sceneName: string | null;
  quality: QualityModel | null;
  languages: string[];
}

interface Scope {
  all: boolean;
  seriesIds: number[];
  movieIds: number[];
  artistIds: number[];
  albumIds: number[];
  authorIds: number[];
  bookIds: number[];
  files: HealthFileRef[];
}

/** Fixed findings are kept this long for the "fixed" view, then pruned. */
const FIXED_RETENTION_DAYS = 30;
const NOTIFY_LINES = 10;

export async function defaultStat(path: string): Promise<StatOutcome> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'unreadable', message: code ?? (err instanceof Error ? err.message : String(err)) };
  }
  if (!info.isFile()) return { kind: 'unreadable', message: 'not a regular file' };
  if (info.size > 0) {
    try {
      const handle = await open(path, 'r');
      try {
        await handle.read(Buffer.alloc(1), 0, 1, 0);
      } finally {
        await handle.close();
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { kind: 'unreadable', message: code ?? (err instanceof Error ? err.message : String(err)) };
    }
  }
  return { kind: 'ok', sizeBytes: info.size, mtimeMs: Math.round(info.mtimeMs) };
}

function signatureOf(s: StatOutcome): string {
  return s.kind === 'ok' ? `${s.sizeBytes}:${s.mtimeMs}` : s.kind;
}

function pad2(n: number | null | undefined): string {
  return String(n ?? 0).padStart(2, '0');
}

function fileKey(source: HealthFileSource, fileId: number): string {
  return `${source}:${fileId}:`;
}

function emptyCounts(): HealthCounts {
  return {
    open: 0,
    ignored: 0,
    fixed: 0,
    byType: Object.fromEntries(FindingTypes.options.map((t) => [t, 0])) as HealthCounts['byType'],
    bySeverity: Object.fromEntries(Severities.options.map((s) => [s, 0])) as HealthCounts['bySeverity'],
  };
}

export class HealthScanService {
  readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly statFile: (path: string) => Promise<StatOutcome>;
  private running = 0;

  constructor(private readonly opts: HealthScanServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.statFile = opts.statFile ?? defaultStat;
  }

  get tools(): HealthTools {
    return this.opts.tools;
  }

  get isRunning(): boolean {
    return this.running > 0;
  }

  settings(): HealthScanSettings {
    return getSection(this.db, 'healthScan');
  }

  // -------------------------------------------------------------------------------------
  // Gathering
  // -------------------------------------------------------------------------------------

  private scopeOf(req: HealthScanRequest | { all: true }): Scope {
    const r = req as Partial<HealthScanRequest>;
    return {
      all: r.all === true,
      seriesIds: r.seriesIds ?? [],
      movieIds: r.movieIds ?? [],
      artistIds: r.artistIds ?? [],
      albumIds: r.albumIds ?? [],
      authorIds: r.authorIds ?? [],
      bookIds: r.bookIds ?? [],
      files: r.files ?? [],
    };
  }

  /** The files of a scope, with what the library expects of each. */
  gather(scope: Scope): ScanItem[] {
    return [...this.gatherVideo(scope), ...this.gatherAudio(scope)];
  }

  private gatherVideo(scope: Scope): ScanItem[] {
    const ids = new Set(scope.files.filter((f) => f.source === 'media').map((f) => f.id));
    if (!scope.all && scope.seriesIds.length === 0 && scope.movieIds.length === 0 && ids.size === 0) return [];
    let rows = this.db.select().from(mediaFiles).all();
    if (!scope.all) {
      const s = new Set(scope.seriesIds);
      const m = new Set(scope.movieIds);
      rows = rows.filter((f) => ids.has(f.id) || (f.seriesId !== null && s.has(f.seriesId)) || (f.movieId !== null && m.has(f.movieId)));
    }
    if (rows.length === 0) return [];
    const seriesById = new Map(this.db.select().from(series).all().map((r) => [r.id, r]));
    const moviesById = new Map(this.db.select().from(movies).all().map((r) => [r.id, r]));
    const profiles = new Map(this.db.select({ id: qualityProfiles.id, languages: qualityProfiles.languages }).from(qualityProfiles).all().map((p) => [p.id, p.languages]));
    const audioRows = this.db.select().from(additionalLanguages).all().filter((r) => r.kind === 'audio');
    const eps = this.db
      .select({ id: episodes.id, fileId: episodes.episodeFileId, seasonNumber: episodes.seasonNumber, episodeNumber: episodes.episodeNumber, runtimeMinutes: episodes.runtimeMinutes })
      .from(episodes)
      .where(isNotNull(episodes.episodeFileId))
      .all();
    const epById = new Map(eps.map((e) => [e.id, e]));
    const epsByFile = new Map<number, typeof eps>();
    for (const e of eps) {
      const list = epsByFile.get(e.fileId!) ?? [];
      list.push(e);
      epsByFile.set(e.fileId!, list);
    }
    for (const v of this.db.select().from(episodeVersionFiles).all()) {
      const ep = epById.get(v.episodeId) ?? this.db.select({ id: episodes.id, fileId: episodes.episodeFileId, seasonNumber: episodes.seasonNumber, episodeNumber: episodes.episodeNumber, runtimeMinutes: episodes.runtimeMinutes }).from(episodes).where(eq(episodes.id, v.episodeId)).get();
      if (!ep) continue;
      const list = epsByFile.get(v.mediaFileId) ?? [];
      if (!list.some((e) => e.id === ep.id)) list.push(ep);
      epsByFile.set(v.mediaFileId, list);
    }
    const checkLanguages = this.settings().checkLanguages;

    const out: ScanItem[] = [];
    for (const f of rows) {
      const base = {
        source: 'media' as const,
        fileId: f.id,
        path: f.path,
        kind: 'video' as const,
        artistId: null,
        albumId: null,
        authorId: null,
        bookId: null,
        trackNumber: null,
        sceneName: f.sceneName,
        quality: f.quality,
        languages: f.languages,
      };
      if (f.mediaType === 'movie') {
        const m = f.movieId !== null ? moviesById.get(f.movieId) : undefined;
        if (!m) continue;
        const slot = slotOf(f.versionTag, m.versions);
        out.push({
          ...base,
          mediaType: 'movie',
          title: `${m.title} (${m.year})${f.versionTag ? ` · ${f.versionTag}` : ''}`,
          seriesId: null,
          movieId: m.id,
          episodeIds: [],
          expectedSeconds: m.runtimeMinutes ? m.runtimeMinutes * 60 : null,
          language: checkLanguages ? this.languageFor(profiles, audioRows, m, slot, { movieId: m.id }) : null,
        });
      } else {
        const s = f.seriesId !== null ? seriesById.get(f.seriesId) : undefined;
        if (!s) continue;
        const fileEps = (epsByFile.get(f.id) ?? []).sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
        const runtimes = fileEps.map((e) => e.runtimeMinutes ?? s.runtimeMinutes ?? null);
        const expected = fileEps.length > 0 && runtimes.every((r) => r !== null && r > 0) ? runtimes.reduce<number>((a, r) => a + (r ?? 0), 0) * 60 : null;
        const first = fileEps[0];
        const last = fileEps[fileEps.length - 1];
        const label = first
          ? `S${pad2(first.seasonNumber)}E${pad2(first.episodeNumber)}${last && last !== first ? `-E${pad2(last.episodeNumber)}` : ''}`
          : f.relativePath;
        const slot = slotOf(f.versionTag, s.versions);
        out.push({
          ...base,
          mediaType: 'series',
          title: `${s.title} ${label}`,
          seriesId: s.id,
          movieId: null,
          episodeIds: fileEps.map((e) => e.id),
          expectedSeconds: expected,
          language: checkLanguages
            ? this.languageFor(profiles, audioRows, s, slot, { seriesId: s.id, episodes: fileEps.map((e) => ({ id: e.id, seasonNumber: e.seasonNumber })) })
            : null,
        });
      }
    }
    return out;
  }

  private languageFor(
    profiles: Map<number, string[]>,
    audioRows: Parameters<typeof requiredAudioFor>[0],
    item: { qualityProfileId: number; versions: MediaVersion[] | null; originalLanguage: string },
    slot: string | null,
    covered: Parameters<typeof requiredAudioFor>[1],
  ): LanguageRequirement | null {
    const profileLanguages = profiles.get(profileIdForSlot(item, slot)) ?? [];
    const required = requiredAudioFor(audioRows, covered, findVersion(item.versions, slot));
    return languageRequirement(profileLanguages, item.originalLanguage, required?.languages ?? []);
  }

  private gatherAudio(scope: Scope): ScanItem[] {
    const ids = new Set(scope.files.filter((f) => f.source === 'audio').map((f) => f.id));
    if (!scope.all && scope.artistIds.length === 0 && scope.albumIds.length === 0 && scope.authorIds.length === 0 && scope.bookIds.length === 0 && ids.size === 0) return [];
    let rows = this.db.select().from(audioFiles).all();
    if (!scope.all) {
      const ar = new Set(scope.artistIds);
      const al = new Set(scope.albumIds);
      const au = new Set(scope.authorIds);
      const bk = new Set(scope.bookIds);
      rows = rows.filter(
        (f) =>
          ids.has(f.id) ||
          (f.artistId !== null && ar.has(f.artistId)) ||
          (f.albumId !== null && al.has(f.albumId)) ||
          (f.authorId !== null && au.has(f.authorId)) ||
          (f.bookId !== null && bk.has(f.bookId)),
      );
    }
    if (rows.length === 0) return [];
    const artistById = new Map(this.db.select({ id: artists.id, name: artists.name }).from(artists).all().map((r) => [r.id, r]));
    const albumById = new Map(this.db.select({ id: albums.id, title: albums.title }).from(albums).all().map((r) => [r.id, r]));
    const authorById = new Map(this.db.select({ id: authors.id, name: authors.name }).from(authors).all().map((r) => [r.id, r]));
    const bookById = new Map(this.db.select({ id: books.id, title: books.title }).from(books).all().map((r) => [r.id, r]));
    const trackByFile = new Map(
      this.db
        .select({ fileId: tracks.audioFileId, title: tracks.title, durationMs: tracks.durationMs })
        .from(tracks)
        .where(isNotNull(tracks.audioFileId))
        .all()
        .map((t) => [t.fileId!, t]),
    );
    const out: ScanItem[] = [];
    for (const f of rows) {
      const base = {
        source: 'audio' as const,
        fileId: f.id,
        path: f.path,
        seriesId: null,
        movieId: null,
        episodeIds: [],
        language: null,
        sceneName: f.sceneName,
        quality: f.quality,
        languages: [],
        artistId: f.artistId,
        albumId: f.albumId,
        authorId: f.authorId,
        bookId: f.bookId,
      };
      if (f.mediaType === 'music') {
        const track = trackByFile.get(f.id);
        const artist = f.artistId !== null ? artistById.get(f.artistId)?.name : undefined;
        const album = f.albumId !== null ? albumById.get(f.albumId)?.title : undefined;
        out.push({
          ...base,
          kind: 'track',
          mediaType: 'music',
          title: [artist, album, track?.title ?? f.relativePath].filter(Boolean).join(' – '),
          expectedSeconds: track?.durationMs ? track.durationMs / 1000 : null,
          trackNumber: f.trackNumber,
        });
      } else {
        const author = f.authorId !== null ? authorById.get(f.authorId)?.name : undefined;
        const book = f.bookId !== null ? bookById.get(f.bookId)?.title : undefined;
        out.push({
          ...base,
          kind: 'audiobook',
          mediaType: 'audiobook',
          title: [author, book].filter(Boolean).join(' – ') + (f.partNumber ? ` · part ${f.partNumber}` : ''),
          // Book runtime is compared with all parts together (book-level check).
          expectedSeconds: null,
          trackNumber: null,
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------------------

  /** Run a scan over a scope. Files are checked `concurrency` at a time. */
  async scan(req: HealthScanRequest | { all: true; force?: boolean; mode?: HealthScanMode }, opts: ScanRunOptions = {}): Promise<ScanResult> {
    this.running++;
    try {
      return await this.runScan(req, opts);
    } finally {
      this.running--;
    }
  }

  private async runScan(req: HealthScanRequest | { all: true; force?: boolean; mode?: HealthScanMode }, opts: ScanRunOptions): Promise<ScanResult> {
    const settings = this.settings();
    const scope = this.scopeOf(req);
    const mode: HealthScanMode = req.mode ?? settings.mode;
    // Only whole-library runs resume; a scan of chosen items is "check now".
    const resume = scope.all && !req.force;
    const honourWindow = scope.all && opts.scheduled === true;
    const items = this.gather(scope);
    const result: ScanResult = { files: items.length, checked: 0, skipped: 0, newFindings: 0, fixed: 0, stoppedEarly: false };
    const prior = new Map(
      this.db
        .select()
        .from(healthScanFiles)
        .all()
        .map((r) => [`${r.source}:${r.fileId}`, r]),
    );
    const available = await this.opts.tools.available();
    const newLines: HealthNotificationLine[] = [];

    let next = 0;
    const worker = async () => {
      for (;;) {
        if (opts.signal?.aborted) {
          result.stoppedEarly = true;
          return;
        }
        if (honourWindow && !insideWindow(this.now(), settings.window)) {
          result.stoppedEarly = true;
          return;
        }
        const item = items[next++];
        if (!item) return;
        try {
          await this.checkOne(item, { mode, resume, settings, available, prior, result, newLines, signal: opts.signal });
        } catch (err) {
          if (opts.signal?.aborted) {
            result.stoppedEarly = true;
            return;
          }
          this.log?.warn({ err, path: item.path }, 'health check failed');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, settings.concurrency) }, () => worker()));

    // Album / book structure: database only, so it runs even when the file loop stopped early.
    this.checkGroups(items, scope, settings, result, newLines);
    if (scope.all && !result.stoppedEarly) this.prune();

    if (result.newFindings > 0 && settings.notify && this.opts.notify) {
      const totalOpen = this.counts().open;
      await this.opts
        .notify({ newFindings: newLines.slice(0, NOTIFY_LINES), totalNew: result.newFindings, totalOpen, filesChecked: result.checked })
        .catch((err: unknown) => this.log?.warn({ err }, 'health scan notification failed'));
    }
    return result;
  }

  private async checkOne(
    item: ScanItem,
    c: {
      mode: HealthScanMode;
      resume: boolean;
      settings: HealthScanSettings;
      available: { ffprobe: boolean; ffmpeg: boolean };
      prior: Map<string, typeof healthScanFiles.$inferSelect>;
      result: ScanResult;
      newLines: HealthNotificationLine[];
      signal?: AbortSignal | undefined;
    },
  ): Promise<void> {
    const st = await this.statFile(item.path);
    const before = c.prior.get(`${item.source}:${item.fileId}`);
    if (
      c.resume &&
      before &&
      st.kind === 'ok' &&
      before.sizeBytes === st.sizeBytes &&
      before.mtimeMs === st.mtimeMs &&
      before.path === item.path &&
      (before.mode === 'deep' || c.mode === 'quick')
    ) {
      c.result.skipped++;
      return;
    }
    const toolOpts = { lowPriority: c.settings.lowPriority, signal: c.signal };
    let probe = undefined as Awaited<ReturnType<HealthTools['probe']>> | undefined;
    let decode = undefined as Awaited<ReturnType<HealthTools['decode']>> | undefined;
    if (st.kind === 'ok' && st.sizeBytes > 0) {
      probe = c.available.ffprobe ? await this.opts.tools.probe(item.path, toolOpts) : null;
      if (c.available.ffmpeg && (probe === null || probe.ok)) {
        decode = await this.opts.tools.decode(item.path, item.kind, c.mode, probe?.ok ? probe.info.durationSeconds : null, toolOpts);
      }
    }
    const detected = checkFile({
      kind: item.kind,
      path: item.path,
      stat: st,
      probe,
      decode,
      decodeMode: c.mode,
      expectedSeconds: item.expectedSeconds,
      trackNumber: item.trackNumber,
      language: item.language,
      truncatedPercent: c.settings.truncatedPercent,
    });
    const at = this.now().toISOString();
    const signature = signatureOf(st);
    const prefix = fileKey(item.source, item.fileId);
    this.reconcile(prefix, item, detected, signature, at, c.result, c.newLines);
    this.db
      .insert(healthScanFiles)
      .values({
        source: item.source,
        fileId: item.fileId,
        path: item.path,
        sizeBytes: st.kind === 'ok' ? st.sizeBytes : null,
        mtimeMs: st.kind === 'ok' ? st.mtimeMs : null,
        mode: c.mode,
        checkedAt: at,
      })
      .onConflictDoUpdate({
        target: [healthScanFiles.source, healthScanFiles.fileId],
        set: { path: item.path, sizeBytes: st.kind === 'ok' ? st.sizeBytes : null, mtimeMs: st.kind === 'ok' ? st.mtimeMs : null, mode: c.mode, checkedAt: at },
      })
      .run();
    c.result.checked++;
  }

  /**
   * Writes what one check found for one file (or album / book): new problems open, problems
   * seen again keep their status (an ignored one reopens when the signature changed), problems
   * no longer found become fixed.
   */
  private reconcile(
    prefix: string,
    item: Omit<ScanItem, 'kind' | 'expectedSeconds' | 'trackNumber' | 'language' | 'sceneName' | 'quality' | 'languages' | 'source' | 'fileId'> & {
      source: HealthFileSource | null;
      fileId: number | null;
    },
    detected: Array<Detected & { keySuffix?: string }>,
    signature: string,
    at: string,
    result: ScanResult,
    newLines: HealthNotificationLine[],
  ): void {
    const existing = this.db
      .select()
      .from(healthFindings)
      .where(sql`${healthFindings.key} LIKE ${`${prefix}%`}`)
      .all();
    const byKey = new Map(existing.map((r) => [r.key, r]));
    const seen = new Set<string>();
    this.db.transaction((tx) => {
      for (const d of detected) {
        const key = `${prefix}${d.type}${d.keySuffix ?? ''}`;
        seen.add(key);
        const values = {
          type: d.type,
          severity: d.severity,
          source: item.source,
          fileId: item.fileId,
          mediaType: item.mediaType,
          path: item.path,
          title: item.title,
          seriesId: item.seriesId,
          movieId: item.movieId,
          artistId: item.artistId,
          albumId: item.albumId,
          authorId: item.authorId,
          bookId: item.bookId,
          episodeIds: item.episodeIds,
          details: d.details,
          data: d.data,
          lastChecked: at,
        };
        const row = byKey.get(key);
        if (!row) {
          tx.insert(healthFindings).values({ ...values, key, status: 'open', firstSeen: at, fixedAt: null, ignoredSignature: null }).run();
          result.newFindings++;
          newLines.push({ title: item.title, type: d.type, severity: d.severity, details: d.details });
          continue;
        }
        let status = row.status;
        let firstSeen = row.firstSeen;
        let ignoredSignature = row.ignoredSignature;
        if (row.status === 'fixed' || (row.status === 'ignored' && row.ignoredSignature !== signature)) {
          // Back again, or the ignored file changed: the user should look at it again.
          status = 'open';
          ignoredSignature = null;
          if (row.status === 'fixed') firstSeen = at;
          result.newFindings++;
          newLines.push({ title: item.title, type: d.type, severity: d.severity, details: d.details });
        }
        tx.update(healthFindings).set({ ...values, status, firstSeen, ignoredSignature, fixedAt: null }).where(eq(healthFindings.id, row.id)).run();
      }
      for (const row of existing) {
        if (seen.has(row.key) || row.status === 'fixed') continue;
        tx.update(healthFindings).set({ status: 'fixed', fixedAt: at, lastChecked: at, ignoredSignature: null }).where(eq(healthFindings.id, row.id)).run();
        result.fixed++;
      }
    });
  }

  /** Album track gaps and audiobook parts / runtime, for the albums and books in scope. */
  private checkGroups(items: readonly ScanItem[], scope: Scope, settings: HealthScanSettings, result: ScanResult, newLines: HealthNotificationLine[]): void {
    const albumIds = new Set<number>();
    const bookIds = new Set<number>();
    for (const i of items) {
      if (i.mediaType === 'music' && i.albumId !== null) albumIds.add(i.albumId);
      if (i.mediaType === 'audiobook' && i.bookId !== null) bookIds.add(i.bookId);
    }
    for (const id of scope.albumIds) albumIds.add(id);
    for (const id of scope.bookIds) bookIds.add(id);
    const at = this.now().toISOString();

    if (albumIds.size > 0) {
      const files = this.db.select().from(audioFiles).where(and(eq(audioFiles.mediaType, 'music'), inArray(audioFiles.albumId, [...albumIds]))).all();
      const albumRows = new Map(
        this.db
          .select({ id: albums.id, title: albums.title, artistId: albums.artistId, artist: artists.name, path: artists.path })
          .from(albums)
          .leftJoin(artists, eq(artists.id, albums.artistId))
          .where(inArray(albums.id, [...albumIds]))
          .all()
          .map((a) => [a.id, a]),
      );
      for (const id of albumIds) {
        const album = albumRows.get(id);
        if (!album) continue;
        const own = files.filter((f) => f.albumId === id);
        const detected = trackGaps(own).map((g) => {
          const data: HealthFindingData = { missingNumbers: g.missing, disc: g.disc };
          return { type: 'trackGaps' as const, severity: 'warning' as const, details: describe('trackGaps', data), data, keySuffix: `:d${g.disc}` };
        });
        this.reconcile(
          `album:${id}:`,
          {
            source: null,
            fileId: null,
            mediaType: 'music',
            path: own[0] ? dirname(own[0].path) : (album.path ?? ''),
            title: [album.artist, album.title].filter(Boolean).join(' – '),
            seriesId: null,
            movieId: null,
            artistId: album.artistId,
            albumId: id,
            authorId: null,
            bookId: null,
            episodeIds: [],
          },
          detected,
          groupSignature(own),
          at,
          result,
          newLines,
        );
      }
    }

    if (bookIds.size > 0) {
      const files = this.db.select().from(audioFiles).where(and(eq(audioFiles.mediaType, 'audiobook'), inArray(audioFiles.bookId, [...bookIds]))).all();
      const bookRows = new Map(
        this.db
          .select({ id: books.id, title: books.title, runtimeMinutes: books.runtimeMinutes, authorId: books.authorId, author: authors.name, path: books.path })
          .from(books)
          .leftJoin(authors, eq(authors.id, books.authorId))
          .where(inArray(books.id, [...bookIds]))
          .all()
          .map((b) => [b.id, b]),
      );
      for (const id of bookIds) {
        const book = bookRows.get(id);
        if (!book) continue;
        const own = files.filter((f) => f.bookId === id);
        const detected: Array<Detected & { keySuffix?: string }> = [];
        const parts = bookPartProblems(own);
        if (parts) {
          const data: HealthFindingData = { missingNumbers: parts.missingNumbers, duplicateNumbers: parts.duplicateNumbers, outOfOrder: parts.outOfOrder };
          detected.push({ type: 'bookParts', severity: parts.missingNumbers.length > 0 ? 'error' : 'warning', details: describe('bookParts', data), data });
        }
        const durations = own.map((f) => f.durationMs);
        if (own.length > 0 && durations.every((d) => d !== null && d > 0) && book.runtimeMinutes) {
          const actual = durations.reduce<number>((a, d) => a + (d ?? 0), 0) / 1000;
          const expected = book.runtimeMinutes * 60;
          if (truncation('audiobook', actual, expected, settings.truncatedPercent)) {
            const data: HealthFindingData = { actualSeconds: actual, expectedSeconds: expected };
            detected.push({ type: 'truncated', severity: 'warning', details: describe('truncated', data), data });
          }
        }
        this.reconcile(
          `book:${id}:`,
          {
            source: null,
            fileId: null,
            mediaType: 'audiobook',
            path: book.path ?? (own[0] ? dirname(own[0].path) : ''),
            title: [book.author, book.title].filter(Boolean).join(' – '),
            seriesId: null,
            movieId: null,
            artistId: null,
            albumId: null,
            authorId: book.authorId,
            bookId: id,
            episodeIds: [],
          },
          detected,
          groupSignature(own),
          at,
          result,
          newLines,
        );
      }
    }
  }

  /** Whole-library runs: forget files, albums and books that left the library; old fixed rows. */
  prune(): void {
    const media = new Set(this.db.select({ id: mediaFiles.id }).from(mediaFiles).all().map((r) => r.id));
    const audio = new Set(this.db.select({ id: audioFiles.id }).from(audioFiles).all().map((r) => r.id));
    const albumIds = new Set(this.db.select({ id: albums.id }).from(albums).all().map((r) => r.id));
    const bookIds = new Set(this.db.select({ id: books.id }).from(books).all().map((r) => r.id));
    const gone = (source: HealthFileSource | null, fileId: number | null) => source !== null && fileId !== null && !(source === 'media' ? media : audio).has(fileId);
    const cutoff = new Date(this.now().getTime() - FIXED_RETENTION_DAYS * 86_400_000).toISOString();
    this.db.transaction((tx) => {
      for (const r of tx.select({ id: healthScanFiles.id, source: healthScanFiles.source, fileId: healthScanFiles.fileId }).from(healthScanFiles).all()) {
        if (gone(r.source, r.fileId)) tx.delete(healthScanFiles).where(eq(healthScanFiles.id, r.id)).run();
      }
      for (const r of tx.select().from(healthFindings).all()) {
        const groupGone = (r.key.startsWith('album:') && (r.albumId === null || !albumIds.has(r.albumId))) || (r.key.startsWith('book:') && (r.bookId === null || !bookIds.has(r.bookId)));
        if (gone(r.source, r.fileId) || groupGone) tx.delete(healthFindings).where(eq(healthFindings.id, r.id)).run();
      }
      tx.delete(healthFindings).where(and(eq(healthFindings.status, 'fixed'), lt(healthFindings.fixedAt, cutoff))).run();
    });
  }

  // -------------------------------------------------------------------------------------
  // Read side
  // -------------------------------------------------------------------------------------

  counts(): HealthCounts {
    const out = emptyCounts();
    const rows = this.db
      .select({ status: healthFindings.status, type: healthFindings.type, severity: healthFindings.severity, n: sql<number>`count(*)` })
      .from(healthFindings)
      .groupBy(healthFindings.status, healthFindings.type, healthFindings.severity)
      .all();
    for (const r of rows) {
      const n = Number(r.n);
      out[r.status] += n;
      if (r.status === 'open') {
        out.byType[r.type] = (out.byType[r.type] ?? 0) + n;
        out.bySeverity[r.severity] = (out.bySeverity[r.severity] ?? 0) + n;
      }
    }
    return out;
  }

  async list(query: Partial<HealthListQuery> = {}): Promise<HealthListResponse> {
    const conds = [];
    const status = query.status ?? 'open';
    if (status !== 'all') conds.push(eq(healthFindings.status, status));
    if (query.type) conds.push(eq(healthFindings.type, query.type));
    if (query.severity) conds.push(eq(healthFindings.severity, query.severity));
    if (query.mediaType) conds.push(eq(healthFindings.mediaType, query.mediaType));
    if (query.seriesId !== undefined) conds.push(eq(healthFindings.seriesId, query.seriesId));
    if (query.movieId !== undefined) conds.push(eq(healthFindings.movieId, query.movieId));
    if (query.artistId !== undefined) conds.push(eq(healthFindings.artistId, query.artistId));
    if (query.albumId !== undefined) conds.push(eq(healthFindings.albumId, query.albumId));
    if (query.authorId !== undefined) conds.push(eq(healthFindings.authorId, query.authorId));
    if (query.bookId !== undefined) conds.push(eq(healthFindings.bookId, query.bookId));
    if (query.ids?.length) conds.push(inArray(healthFindings.id, query.ids));
    const rows = this.db
      .select()
      .from(healthFindings)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(healthFindings.title), asc(healthFindings.id))
      .all();
    const lastScan = this.db.select({ at: max(healthScanFiles.checkedAt) }).from(healthScanFiles).get()?.at ?? null;
    const filesChecked = this.db.select({ n: sql<number>`count(*)` }).from(healthScanFiles).get()?.n ?? 0;
    const filesTotal =
      Number(this.db.select({ n: sql<number>`count(*)` }).from(mediaFiles).get()?.n ?? 0) + Number(this.db.select({ n: sql<number>`count(*)` }).from(audioFiles).get()?.n ?? 0);
    const available = await this.opts.tools.available();
    return {
      lastScan,
      running: this.isRunning,
      filesChecked: Number(filesChecked),
      filesTotal,
      ffprobe: available.ffprobe,
      ffmpeg: available.ffmpeg,
      counts: this.counts(),
      records: rows.map(toFinding),
    };
  }

  private row(id: number): HealthFindingRow {
    const row = this.db.select().from(healthFindings).where(eq(healthFindings.id, id)).get();
    if (!row) throw new HealthScanError('NOT_FOUND', `finding ${id} not found`);
    return row;
  }

  // -------------------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------------------

  /** The files a re-check of these findings covers (album / book findings: all their files). */
  filesFor(ids: readonly number[]): { files: HealthFileRef[]; albumIds: number[]; bookIds: number[] } {
    const files: HealthFileRef[] = [];
    const albumIds: number[] = [];
    const bookIds: number[] = [];
    for (const id of ids) {
      const r = this.row(id);
      if (r.source !== null && r.fileId !== null) files.push({ source: r.source, id: r.fileId });
      else if (r.albumId !== null) albumIds.push(r.albumId);
      else if (r.bookId !== null) bookIds.push(r.bookId);
    }
    const dedupe = new Map(files.map((f) => [`${f.source}:${f.id}`, f]));
    return { files: [...dedupe.values()], albumIds: [...new Set(albumIds)], bookIds: [...new Set(bookIds)] };
  }

  ignore(ids: readonly number[]): HealthActionItemResult[] {
    return ids.map((id) => {
      try {
        const r = this.row(id);
        this.db.update(healthFindings).set({ status: 'ignored', ignoredSignature: this.currentSignature(r), fixedAt: null }).where(eq(healthFindings.id, id)).run();
        return { id, ok: true };
      } catch (err) {
        return { id, ok: false, error: errorText(err) };
      }
    });
  }

  unignore(ids: readonly number[]): HealthActionItemResult[] {
    return ids.map((id) => {
      try {
        const r = this.row(id);
        if (r.status === 'ignored') this.db.update(healthFindings).set({ status: 'open', ignoredSignature: null }).where(eq(healthFindings.id, id)).run();
        return { id, ok: true };
      } catch (err) {
        return { id, ok: false, error: errorText(err) };
      }
    });
  }

  /** What "the file did not change" is compared with: the last check's size:mtime. */
  private currentSignature(r: HealthFindingRow): string {
    if (r.source !== null && r.fileId !== null) {
      const f = this.db.select().from(healthScanFiles).where(and(eq(healthScanFiles.source, r.source), eq(healthScanFiles.fileId, r.fileId))).get();
      if (!f) return 'unknown';
      return f.sizeBytes === null ? 'missing' : `${f.sizeBytes}:${f.mtimeMs}`;
    }
    const own =
      r.albumId !== null && r.key.startsWith('album:')
        ? this.db.select().from(audioFiles).where(eq(audioFiles.albumId, r.albumId)).all()
        : r.bookId !== null
          ? this.db.select().from(audioFiles).where(eq(audioFiles.bookId, r.bookId)).all()
          : [];
    return groupSignature(own);
  }

  /** Delete (or recycle) the files of these findings and drop them from the library. */
  async deleteFiles(ids: readonly number[]): Promise<HealthActionItemResult[]> {
    const out: HealthActionItemResult[] = [];
    const done = new Map<string, HealthActionItemResult>();
    for (const id of ids) {
      try {
        const r = this.row(id);
        if (r.source === null || r.fileId === null) throw new HealthScanError('VALIDATION', 'album and book findings have no single file to delete');
        const k = `${r.source}:${r.fileId}`;
        const prev = done.get(k);
        if (prev) {
          out.push({ ...prev, id });
          continue;
        }
        const recycledTo = await this.removeFile(r.source, r.fileId);
        const res = { id, ok: true, recycledTo };
        done.set(k, res);
        out.push(res);
      } catch (err) {
        out.push({ id, ok: false, error: errorText(err) });
      }
    }
    return out;
  }

  /**
   * Replace: blocklist the release the file came from (video, when history knows it), delete or
   * recycle the file, then one search for every affected item.
   */
  async replace(ids: readonly number[]): Promise<{ results: HealthActionItemResult[]; jobId: number | null }> {
    const results: HealthActionItemResult[] = [];
    const targets = new Map<string, SearchTarget>();
    const done = new Map<string, HealthActionItemResult>();
    for (const id of ids) {
      try {
        const r = this.row(id);
        if (r.source === null || r.fileId === null) throw new HealthScanError('VALIDATION', 'album and book findings cannot be replaced file by file; search the album or book instead');
        const k = `${r.source}:${r.fileId}`;
        const prev = done.get(k);
        if (prev) {
          results.push({ ...prev, id });
          continue;
        }
        const blocklisted = r.source === 'media' ? this.blocklistFor(r) : false;
        const target = searchTargetOf(r);
        const recycledTo = await this.removeFile(r.source, r.fileId);
        if (target) targets.set(JSON.stringify(target), target);
        const res = { id, ok: true, blocklisted, recycledTo };
        done.set(k, res);
        results.push(res);
      } catch (err) {
        results.push({ id, ok: false, error: errorText(err) });
      }
    }
    const jobId = targets.size > 0 && this.opts.search ? this.opts.search(mergeTargets([...targets.values()])) : null;
    return { results, jobId };
  }

  async act(action: HealthAction, ids: readonly number[], recheck: (files: { files: HealthFileRef[]; albumIds: number[]; bookIds: number[] }) => number | null): Promise<HealthActionResult> {
    let results: HealthActionItemResult[];
    let jobId: number | null = null;
    switch (action) {
      case 'ignore':
        results = this.ignore(ids);
        break;
      case 'unignore':
        results = this.unignore(ids);
        break;
      case 'delete':
        results = await this.deleteFiles(ids);
        break;
      case 'replace': {
        const r = await this.replace(ids);
        results = r.results;
        jobId = r.jobId;
        break;
      }
      case 'recheck': {
        const valid: number[] = [];
        results = ids.map((id) => {
          try {
            this.row(id);
            valid.push(id);
            return { id, ok: true };
          } catch (err) {
            return { id, ok: false, error: errorText(err) };
          }
        });
        if (valid.length > 0) jobId = recheck(this.filesFor(valid));
        break;
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return { action, succeeded, failed: results.length - succeeded, results, jobId };
  }

  /** The newest import of this file in history, and the grab with the same download id. */
  private blocklistFor(r: HealthFindingRow): boolean {
    if (!this.opts.blocklist || r.fileId === null) return false;
    const parent = r.movieId !== null ? eq(history.movieId, r.movieId) : r.seriesId !== null ? eq(history.seriesId, r.seriesId) : undefined;
    if (!parent) return false;
    const imports = this.db
      .select()
      .from(history)
      .where(and(parent, eq(history.eventType, 'downloadFolderImported')))
      .orderBy(desc(history.date), desc(history.id))
      .all()
      .filter((h) => h.data['fileId'] === String(r.fileId));
    const imported = imports[0];
    if (!imported) return false;
    const grabbed = imported.downloadId
      ? this.db
          .select()
          .from(history)
          .where(and(parent, eq(history.eventType, 'grabbed'), eq(history.downloadId, imported.downloadId)))
          .orderBy(desc(history.date), desc(history.id))
          .get()
      : undefined;
    const data = grabbed?.data ?? {};
    const hash = data['torrentInfoHash'] ?? null;
    const protocol: ReleaseProtocol = data['protocol'] === 'torrent' || data['protocol'] === 'usenet' ? data['protocol'] : hash ? 'torrent' : 'usenet';
    const size = Number(data['size'] ?? imported.data['size']);
    const episodeIds = [...new Set([...r.episodeIds, ...imports.filter((h) => h.downloadId === imported.downloadId).map((h) => h.episodeId).filter((e): e is number => e !== null)])];
    try {
      this.opts.blocklist({
        mediaType: r.movieId !== null ? 'movie' : 'series',
        ...(r.movieId !== null ? { movieId: r.movieId } : { seriesId: r.seriesId!, episodeIds }),
        sourceTitle: grabbed?.sourceTitle ?? imported.sourceTitle,
        quality: grabbed?.quality ?? imported.quality,
        languages: grabbed?.languages ?? imported.languages,
        publishedDate: data['publishedDate'] ?? null,
        size: Number.isFinite(size) && size >= 0 ? Math.round(size) : null,
        protocol,
        indexer: data['indexer'] ?? null,
        message: `Health scan: ${r.details}`,
        torrentInfoHash: protocol === 'torrent' ? (hash ?? imported.downloadId ?? null) : null,
        source: 'Health scan',
      });
      return true;
    } catch (err) {
      this.log?.warn({ err, findingId: r.id }, 'could not blocklist the release of a broken file');
      return false;
    }
  }

  /**
   * Recycles (or deletes, per the recycle-bin setting) a library file and removes it from the
   * library, then drops its findings and check record.
   */
  private async removeFile(source: HealthFileSource, fileId: number): Promise<string | null> {
    const bin = new RecycleBin(getSection(this.db, 'mediaManagement').recycleBinPath, this.now);
    const roots = this.db.select().from(rootFolders).all();
    const subFolder = (path: string) => {
      const root = roots.find((r) => isUnder(path, r.path));
      return root ? relative(root.path, dirname(path)) : '';
    };
    let recycledTo: string | null = null;
    if (source === 'media') {
      const f = this.db.select().from(mediaFiles).where(eq(mediaFiles.id, fileId)).get();
      if (!f) throw new HealthScanError('NOT_FOUND', `media file ${fileId} is no longer in the library`);
      if ((await this.statFile(f.path)).kind !== 'missing') recycledTo = await bin.recycle(f.path, subFolder(f.path));
      await libraryService.deleteMediaFile(this.db, f.id, { deleteFromDisk: false });
      const parentId = f.mediaType === 'series' ? f.seriesId : f.movieId;
      if (parentId !== null) this.opts.bus?.publish({ type: 'library', action: 'fileDeleted', mediaType: f.mediaType, id: parentId });
    } else {
      const f = this.db.select().from(audioFiles).where(eq(audioFiles.id, fileId)).get();
      if (!f) throw new HealthScanError('NOT_FOUND', `audio file ${fileId} is no longer in the library`);
      if ((await this.statFile(f.path)).kind !== 'missing') recycledTo = await bin.recycle(f.path, subFolder(f.path));
      this.db.transaction((tx) => {
        tx.update(tracks).set({ hasFile: false, audioFileId: null }).where(eq(tracks.audioFileId, f.id)).run();
        tx.delete(audioFiles).where(eq(audioFiles.id, f.id)).run();
        if (f.bookId !== null) {
          const left = tx.select({ id: audioFiles.id }).from(audioFiles).where(eq(audioFiles.bookId, f.bookId)).get();
          if (!left) tx.update(books).set({ hasFile: false }).where(eq(books.id, f.bookId)).run();
        }
      });
    }
    this.db.delete(healthFindings).where(and(eq(healthFindings.source, source), eq(healthFindings.fileId, fileId))).run();
    this.db.delete(healthScanFiles).where(and(eq(healthScanFiles.source, source), eq(healthScanFiles.fileId, fileId))).run();
    return recycledTo;
  }
}

/** Album / book signature: the count and total size of its files. */
function groupSignature(files: ReadonlyArray<{ sizeBytes: number; trackNumber?: number | null; partNumber?: number | null }>): string {
  return `${files.length}:${files.reduce((a, f) => a + f.sizeBytes, 0)}:${files.map((f) => f.trackNumber ?? f.partNumber ?? '').join(',')}`;
}

function searchTargetOf(r: HealthFindingRow): SearchTarget | null {
  if (r.movieId !== null) return { movieId: r.movieId };
  if (r.seriesId !== null) return r.episodeIds.length ? { seriesId: r.seriesId, episodeIds: [...r.episodeIds] } : { seriesId: r.seriesId };
  if (r.albumId !== null) return { albumIds: [r.albumId] };
  if (r.bookId !== null) return { bookIds: [r.bookId] };
  return null;
}

/** One search per series (episodes merged), movie, album and book. */
export function mergeTargets(targets: readonly SearchTarget[]): SearchTarget[] {
  const out: SearchTarget[] = [];
  const bySeries = new Map<number, Set<number> | null>();
  const seen = new Set<string>();
  for (const t of targets) {
    if ('seriesId' in t) {
      const prev = bySeries.get(t.seriesId);
      if (prev === null) continue;
      if (!t.episodeIds?.length) bySeries.set(t.seriesId, null);
      else bySeries.set(t.seriesId, new Set([...(prev ?? []), ...t.episodeIds]));
      continue;
    }
    const k = JSON.stringify(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  for (const [seriesId, eps] of bySeries) out.push(eps ? { seriesId, episodeIds: [...eps].sort((a, b) => a - b) } : { seriesId });
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toFinding(r: HealthFindingRow): HealthFinding {
  return {
    id: r.id,
    type: r.type,
    severity: r.severity,
    status: r.status,
    source: r.source ?? null,
    fileId: r.fileId,
    mediaType: r.mediaType,
    path: r.path,
    title: r.title,
    seriesId: r.seriesId,
    movieId: r.movieId,
    artistId: r.artistId,
    albumId: r.albumId,
    authorId: r.authorId,
    bookId: r.bookId,
    episodeIds: r.episodeIds,
    details: r.details,
    data: r.data,
    firstSeen: r.firstSeen,
    lastChecked: r.lastChecked,
    fixedAt: r.fixedAt,
  };
}
