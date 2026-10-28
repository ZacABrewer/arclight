import { and, eq, gte, inArray } from 'drizzle-orm';
import { readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import { formatArtistCredit, type MbRelease } from '@arclight/metadata';
import { buildAlbumFolder, buildTrackFileName, type NamingAlbum, type NamingArtist, type NamingFile } from '@arclight/organizer';
import { parseAudioPath, parseAudioQuality, parseMusicRelease, type ParsedAudioQuality } from '@arclight/parser';
import {
  QUALITIES,
  type AudioFileTags,
  type AudioManualImportFileTags,
  type AudioManualImportItem,
  type AudioManualImportQuery,
  type AudioManualImportRequest,
  type AudioManualImportResult,
  type ImportRejection,
  type ImportRejectionReason,
  type MediaManagementSettings,
  type NamingConfig,
  type QualityModel,
  type QualityProfile,
} from '@arclight/shared';
import type { Db } from '../../../db/index.js';
import { albumReleases, albums, artists, audioFiles, tracks } from '../../../db/schema.js';
import type { EventBus } from '../../../events.js';
import type { TrackedDownload } from '../../download-clients/index.js';
import { libraryService } from '../../library/index.js';
import type { AlbumReleaseRow, AlbumRow, ArtistRow, TrackRow } from '../../music/schema.js';
import * as music from '../../music/service.js';
import { musicQualityFor } from '../../music/quality.js';
import type { ProfilesService } from '../../profiles/index.js';
import { getSection } from '../../settings/service.js';
import { absolutePathSpec, compareQ, freeSpaceSpec, notUnpackingSpec, sameFileSpec } from '../decisions.js';
import type { AudioImportedEvent, ImportsDeps } from '../deps.js';
import { ImportsError } from '../errors.js';
import { ImportFileError, RecycleBin, setPermissions, transferFile, type FsOps, type TransferMode, type TransferResult } from '../mover.js';
import { ScanError, isUnder } from '../scan.js';
import { importedDownloads } from '../schema.js';
import { type KnownAlbum, matchArtistScan, type RescanArtistResult } from './rescan.js';
import { albumFolderOf, isAudioExtension, scanAudioPath, type AudioExtraFile, type AudioGroup, type AudioScanFile, type AudioScanResult } from './scan-audio.js';
import { createCombinedTagReader, type AudioTags, type TagReader } from './tags.js';
import { matchFileFrom, scoreRelease, type ReleaseCandidate } from './track-match.js';

// The music importer (docs/design/music-audiobooks.md 9.2): a completed download (or a folder
// picked for manual import) is scanned, its album groups matched to the artist's albums and
// editions, the files checked against the import specs and transferred into
// `<artist>/<album folder>/<track file>` with `transferFile` (hard link, copy or move; replaced
// files go to the recycle bin). Files are never retagged: rewriting tags would break hard links
// and seeding. Each imported file gets an `audio_files` row linked from `tracks.audio_file_id`,
// so album/artist statistics (computed from those columns) reflect the import at once.

/** What the importer needs from the imports service. */
export interface MusicImporterOptions {
  db: Db;
  bus?: EventBus | undefined;
  log?: Logger | undefined;
  /** Read at call time: hooks may be wired after construction. */
  deps: () => ImportsDeps;
  profiles: ProfilesService;
  platform: NodeJS.Platform;
  now: () => Date;
  fsOps?: Partial<FsOps> | undefined;
  mediaManagement: () => MediaManagementSettings;
  naming: () => NamingConfig;
  freeSpace: (path: string) => Promise<number | null>;
  downloads: {
    listTracked(): TrackedDownload[];
    markImported(id: number): unknown;
    setImportProgress?: ((downloadId: string, progress: { copiedBytes: number; totalBytes: number } | null) => void) | undefined;
  };
}

/** Per-file result, the same shape the video importer reports. */
export interface MusicImportOutcome {
  path: string;
  status: 'imported' | 'rejected' | 'failed';
  rejections: ImportRejection[];
  warnings?: string[];
  error?: string;
  audioFileId?: number;
  destination?: string;
  replacedFileIds?: number[];
  albumId?: number;
  trackId?: number;
}

export interface MusicImportRun {
  verified: boolean;
  outcomes: MusicImportOutcome[];
  /** Queue lines when the download needs attention (empty when verified). */
  messages: string[];
  /** Every rejection was temporary (still unpacking): retry later. */
  retryable: boolean;
  /** Albums that received files. */
  importedAlbumIds: number[];
  /** Album-level notes (incomplete albums stay wanted). */
  warnings: string[];
  isFile: boolean;
}

type AudioFileRow = typeof audioFiles.$inferSelect;

interface PlannedFile {
  file: AudioScanFile;
  /** The source album folder (disc sub-folders fold into it); rename-off keeps paths below it. */
  groupFolder: string;
  track: TrackRow;
  score: number;
  quality: QualityModel;
  releaseGroup: string | null;
  /** The track's current file, if any. */
  existing: AudioFileRow | null;
  /** The file already lives inside the artist folder: register in place. */
  inPlace: boolean;
  rejections: ImportRejection[];
}

interface AlbumPlan {
  album: AlbumRow;
  release: AlbumReleaseRow;
  confidence: number;
  mediumCount: number;
  groups: AudioGroup[];
  files: PlannedFile[];
  extras: AudioExtraFile[];
  missingTrackCount: number;
  releaseChanged: boolean;
  warnings: string[];
}

interface Rejected {
  file: AudioScanFile;
  rejections: ImportRejection[];
  albumId?: number;
}

interface ScanPlan {
  albums: AlbumPlan[];
  rejected: Rejected[];
  /** Queue lines about whole groups (cue images, unknown albums). */
  groupMessages: string[];
  cueImages: number;
}

interface ExecuteOptions {
  mode: 'move' | 'copy';
  downloadId: string | null;
  sourceTitle: string | null;
  manual: boolean;
}

const permanent = (reason: ImportRejectionReason, message: string): ImportRejection => ({ reason, message, type: 'permanent' });

const EXTRA_KINDS = new Set(['cue', 'log', 'cover', 'lyrics']);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toQualityModel(q: ParsedAudioQuality): QualityModel {
  return {
    quality: { ...q.quality, mediaTypes: [...q.quality.mediaTypes] },
    revision: { version: q.revision.version, real: q.revision.real, isRepack: q.revision.isRepack },
  };
}

function unknownQuality(): QualityModel {
  const q = QUALITIES.Unknown;
  return { quality: { ...q, mediaTypes: [...q.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
}

/** Quality of one file: measured tags first, then the path (file + folder names), then the release title. */
export function audioQualityOf(file: { path: string; extension: string; tags: AudioTags | null }, releaseTitle: string | null = null): QualityModel {
  const fromPath = safe(() => parseAudioPath(file.path, 'music').audio);
  const revision = fromPath?.revision ?? { version: 1, real: 0, isRepack: false };
  if (file.tags) {
    const measured = musicQualityFor({ codec: file.tags.codec, container: file.tags.container, bitrateKbps: file.tags.bitrateKbps, bitDepth: file.tags.bitDepth });
    if (measured.quality.id !== QUALITIES.Unknown.id) return { ...measured, revision: { ...revision } };
  }
  if (fromPath && fromPath.quality.id !== QUALITIES.Unknown.id) return toQualityModel(fromPath);
  if (releaseTitle) {
    const fromTitle = safe(() => parseAudioQuality(releaseTitle, file.extension));
    if (fromTitle && fromTitle.quality.id !== QUALITIES.Unknown.id) return toQualityModel(fromTitle);
  }
  return unknownQuality();
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function fileTags(t: AudioTags): AudioFileTags {
  return {
    title: t.title,
    artist: t.artist,
    albumArtist: t.albumArtist,
    album: t.album,
    date: t.date,
    trackNo: t.trackNo,
    trackOf: t.trackOf,
    discNo: t.discNo,
    discOf: t.discOf,
    mbRecordingId: t.mbRecordingId,
    mbReleaseId: t.mbReleaseId,
    mbReleaseGroupId: t.mbReleaseGroupId,
    mbArtistId: t.mbArtistId,
  };
}

const round = (n: number | null) => (n === null ? null : Math.round(n));

function manualTags(t: AudioTags | null): AudioManualImportFileTags {
  return {
    title: t?.title ?? null,
    artist: t?.artist ?? null,
    albumArtist: t?.albumArtist ?? null,
    album: t?.album ?? null,
    trackNo: t?.trackNo ?? null,
    discNo: t?.discNo ?? null,
    durationMs: round(t?.durationMs ?? null),
    codec: t?.codec ?? null,
    bitrateKbps: round(t?.bitrateKbps ?? null),
    sampleRateHz: round(t?.sampleRateHz ?? null),
    bitDepth: round(t?.bitDepth ?? null),
  };
}

/** A full MusicBrainz release as a matcher candidate (refs: the MusicBrainz ids). */
function candidateFromMb(release: MbRelease): ReleaseCandidate {
  return {
    id: release.mbid,
    title: release.title,
    ref: release.mbid,
    media: release.media.map((m) => ({
      position: m.position,
      format: m.format ?? null,
      tracks: m.tracks.map((t) => ({
        position: t.position,
        number: t.number,
        title: t.title,
        durationMs: t.durationMs ?? null,
        recordingId: t.recordingMbid,
        trackId: t.mbid,
        artist: formatArtistCredit(t.artistCredits) || null,
      })),
    })),
  };
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

/** Any audio file left below `dir`? */
async function containsAudio(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory() && (await containsAudio(full))) return true;
    if (e.isFile() && isAudioExtension(extname(e.name))) return true;
  }
  return false;
}

export class MusicImporter {
  private reader: TagReader | null = null;

  constructor(private readonly o: MusicImporterOptions) {}

  private get db(): Db {
    return this.o.db;
  }

  private tagReader(): TagReader {
    const injected = this.o.deps().tagReader;
    if (injected) return injected;
    this.reader ??= createCombinedTagReader();
    return this.reader;
  }

  private threshold(): number {
    return getSection(this.db, 'audio').trackMatchThreshold;
  }

  private async callHook(fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.o.log?.error({ err }, 'imports hook failed');
    }
  }

  // -------------------------------------------------------------------------------------
  // Completed downloads
  // -------------------------------------------------------------------------------------

  /** Imports a completed music download. The caller (ImportsService) handles queue state. */
  async importCompletedDownload(item: TrackedDownload, path: string): Promise<MusicImportRun> {
    const settings = this.o.mediaManagement();
    const run: MusicImportRun = { verified: false, outcomes: [], messages: [], retryable: false, importedAlbumIds: [], warnings: [], isFile: false };
    const target = this.targetOf(item);
    const artist = target.artistId !== undefined ? this.tryArtist(target.artistId) : this.findArtistByTitle(item.title);
    if (!artist) {
      run.messages = ['Artist title mismatch; automatic import is not possible. Manual Import required.'];
      return run;
    }
    if (resolve(path) === resolve(artist.path)) {
      run.messages = ['Import path is mapped to an artist folder'];
      return run;
    }

    let scan: AudioScanResult;
    try {
      scan = await scanAudioPath(path, { tagReader: this.tagReader(), workingFolders: settings.downloadClientWorkingFolders });
    } catch (err) {
      run.messages = [err instanceof ScanError ? err.message : `Import failed: ${errorMessage(err)}`];
      return run;
    }
    run.isFile = scan.isFile;

    const candidates = target.albumIds.length > 0 ? target.albumIds : this.albumIdsOf(artist.id);
    const plan = await this.plan(scan, artist, candidates, { switchReleases: true, releaseTitle: item.title });
    await this.applySpecs(plan, artist, { downloadId: item.downloadId, addedAt: item.added, settings });

    run.outcomes = plan.rejected.map((r) => ({ path: r.file.path, status: 'rejected' as const, rejections: r.rejections, ...(r.albumId !== undefined ? { albumId: r.albumId } : {}) }));
    const mode: 'move' | 'copy' = item.canMoveFiles ? 'move' : 'copy';
    for (const album of plan.albums) {
      const outcomes = await this.executeAlbum(artist, album, { mode, downloadId: item.downloadId, sourceTitle: item.title, manual: false });
      run.outcomes.push(...outcomes);
      if (outcomes.some((o) => o.status === 'imported')) {
        run.importedAlbumIds.push(album.album.id);
        run.warnings.push(...album.warnings);
      }
    }

    // Verification: every targeted album got files (a pack without targets: at least one).
    const imported = new Set(run.importedAlbumIds);
    const previously = this.previouslyImportedAlbums(item.downloadId);
    const expected = target.albumIds;
    run.verified =
      expected.length > 0
        ? expected.every((id) => imported.has(id) || previously.has(id))
        : imported.size > 0 || (previously.size > 0 && run.outcomes.every((o) => o.status !== 'failed'));

    if (run.verified) {
      if (mode === 'move' && !scan.isFile && !(await containsAudio(path))) {
        await rm(path, { recursive: true, force: true }).catch((err: unknown) => this.o.log?.debug({ err, path }, 'source folder cleanup skipped'));
      }
      return run;
    }

    const lines: string[] = [];
    if (scan.files.length === 0) {
      if (scan.unpacking) lines.push('Download is still being unpacked');
      lines.push(`No audio files found are eligible for import in ${path}`);
    } else {
      lines.push('One or more albums expected in this release were not imported or missing from the release');
      lines.push(...plan.groupMessages);
      for (const o of [...run.outcomes].sort((a, b) => a.path.localeCompare(b.path))) {
        if (o.status === 'imported') continue;
        const reasons = o.error ? [o.error] : o.rejections.map((r) => r.message);
        if (reasons.length > 0) lines.push(`${basename(o.path)}: ${reasons.join(', ')}`);
      }
    }
    run.messages = lines;
    const notImported = run.outcomes.filter((o) => o.status !== 'imported');
    run.retryable =
      (scan.files.length === 0 && scan.unpacking) ||
      (notImported.length > 0 && notImported.every((o) => o.rejections.length > 0 && o.rejections.every((r) => r.type === 'temporary')) && plan.cueImages === 0);
    return run;
  }

  /** Artist and albums of a tracked download (queue item first, then the grab snapshot). */
  private targetOf(item: TrackedDownload): { artistId?: number; albumIds: number[] } {
    const raw = item.grabbedRelease && typeof item.grabbedRelease === 'object' ? (item.grabbedRelease as Record<string, unknown>) : {};
    const artistId = item.artistId ?? (typeof raw['artistId'] === 'number' ? raw['artistId'] : undefined);
    const albumIds =
      item.albumIds && item.albumIds.length > 0
        ? item.albumIds
        : Array.isArray(raw['albumIds'])
          ? raw['albumIds'].filter((v): v is number => typeof v === 'number')
          : [];
    return { ...(artistId !== undefined ? { artistId } : {}), albumIds: [...new Set(albumIds)] };
  }

  private tryArtist(id: number): ArtistRow | undefined {
    return this.db.select().from(artists).where(eq(artists.id, id)).get();
  }

  private albumIdsOf(artistId: number): number[] {
    return this.db.select({ id: albums.id }).from(albums).where(eq(albums.artistId, artistId)).all().map((r) => r.id);
  }

  /** "Artist - Album (2001) [FLAC]" -> the library artist with that clean name. */
  private findArtistByTitle(title: string): ArtistRow | undefined {
    const parsed = safe(() => parseMusicRelease(title));
    const name = parsed?.music?.artist;
    return name ? this.findArtistByName(name) : undefined;
  }

  private findArtistByName(name: string): ArtistRow | undefined {
    const clean = libraryService.toCleanTitle(name);
    if (!clean) return undefined;
    const rows = this.db.select().from(artists).where(eq(artists.cleanName, clean)).all();
    return rows.length === 1 ? rows[0] : undefined;
  }

  private previouslyImportedAlbums(downloadId: string): Set<number> {
    const rows = this.db.select({ albumIds: importedDownloads.albumIds }).from(importedDownloads).where(eq(importedDownloads.downloadId, downloadId)).all();
    return new Set(rows.flatMap((r) => r.albumIds ?? []));
  }

  private importedSinceGrab(downloadId: string, addedAt: string | undefined): boolean {
    const where = addedAt
      ? and(eq(importedDownloads.downloadId, downloadId), gte(importedDownloads.importedAt, addedAt))
      : eq(importedDownloads.downloadId, downloadId);
    return this.db.select({ id: importedDownloads.id }).from(importedDownloads).where(where).get() !== undefined;
  }

  // -------------------------------------------------------------------------------------
  // Matching (design 9.2): groups -> albums -> editions -> tracks
  // -------------------------------------------------------------------------------------

  private known(artistId: number, albumIds: readonly number[]): KnownAlbum[] {
    const wanted = new Set(albumIds);
    return music.knownAlbumsFor(this.db, artistId).filter((k) => wanted.has(Number(k.albumId)));
  }

  /**
   * With `anyReleaseOk`, an album whose stored edition fits the files badly (below the
   * threshold, files left over, tracks missing) is matched again against its other editions
   * (loaded through `deps.musicReleases`); a better fit becomes the selected edition through the
   * music service's `selectRelease` (tracks reloaded, existing files re-linked). Albums that
   * already have files keep their edition. Returns whether anything was switched.
   */
  private async switchReleases(scan: AudioScanResult, artist: ArtistRow, albumIds: readonly number[], first: RescanArtistResult): Promise<boolean> {
    const loader = this.o.deps().musicReleases;
    if (!loader || albumIds.length === 0) return false;
    const threshold = this.threshold();
    const known = this.known(artist.id, albumIds);
    const rows = new Map(this.db.select().from(albums).where(inArray(albums.id, [...albumIds])).all().map((a) => [a.id, a]));
    const groupSize = new Map(scan.groups.map((g) => [g.key, g.files.length]));
    const accepted = new Map(first.albums.map((a) => [Number(a.albumId), a]));

    // Albums worth another look, with the file count their best group has.
    const look = new Map<number, number>();
    for (const a of first.albums) {
      if (a.incomplete || a.matchedCount < a.fileCount) look.set(Number(a.albumId), a.fileCount);
    }
    for (const u of first.unmatchedGroups) {
      if (u.reason !== 'belowThreshold' || !u.best) continue;
      const id = Number(u.best.albumId);
      if (!accepted.has(id)) look.set(id, Math.max(look.get(id) ?? 0, groupSize.get(u.group.key) ?? 0));
    }
    const expanded: KnownAlbum[] = [];
    const loaded = new Map<string, MbRelease>();
    for (const [albumId, fileCount] of look) {
      const album = rows.get(albumId);
      const base = known.find((k) => Number(k.albumId) === albumId);
      if (!album || !album.anyReleaseOk || this.albumHasFiles(albumId)) continue;
      const others = music
        .releaseRows(this.db, albumId)
        .filter((r) => r.id !== album.selectedReleaseId)
        .sort((a, b) => Math.abs(a.trackCount - fileCount) - Math.abs(b.trackCount - fileCount) || a.id - b.id)
        .slice(0, 6);
      const extra: ReleaseCandidate[] = [];
      for (const r of others) {
        try {
          const release = await loader.getRelease(r.mbReleaseId);
          loaded.set(release.mbid, release);
          extra.push(candidateFromMb(release));
        } catch (err) {
          this.o.log?.warn({ err, mbReleaseId: r.mbReleaseId }, 'edition not loaded for import matching');
        }
      }
      if (extra.length === 0) continue;
      expanded.push({
        albumId,
        title: album.title,
        mbReleaseGroupId: album.mbReleaseGroupId,
        selectedReleaseId: base?.selectedReleaseId ?? null,
        anyReleaseOk: true,
        releases: [...(base?.releases ?? []), ...extra],
      });
    }
    if (expanded.length === 0) return false;

    const ids = new Set(expanded.map((k) => Number(k.albumId)));
    const second = matchArtistScan(scan, [...known.filter((k) => !ids.has(Number(k.albumId))), ...expanded], { threshold });
    let switched = false;
    for (const a of second.albums) {
      const albumId = Number(a.albumId);
      const release = loaded.get(a.releaseId);
      if (!ids.has(albumId) || !release) continue;
      const before = accepted.get(albumId);
      const better =
        !before ||
        a.matchedCount > before.matchedCount ||
        (a.matchedCount === before.matchedCount && a.missingTracks.length < before.missingTracks.length) ||
        (a.matchedCount === before.matchedCount && a.missingTracks.length === before.missingTracks.length && a.confidence > before.confidence);
      if (!better) continue;
      music.selectRelease(this.db, albumId, release, artist.name);
      this.o.log?.info({ albumId, mbReleaseId: release.mbid }, 'import switched the album edition to fit the files');
      switched = true;
    }
    return switched;
  }

  private albumHasFiles(albumId: number): boolean {
    return this.db.select({ id: tracks.id }).from(tracks).where(and(eq(tracks.albumId, albumId), eq(tracks.hasFile, true))).limit(1).get() !== undefined;
  }

  /** Scan result -> per-album plans and rejected files (no specs yet). */
  private async plan(
    scan: AudioScanResult,
    artist: ArtistRow,
    albumIds: readonly number[],
    opts: { switchReleases: boolean; releaseTitle: string | null },
  ): Promise<ScanPlan> {
    const threshold = this.threshold();
    let result = matchArtistScan(scan, this.known(artist.id, albumIds), { threshold });
    const releaseChanged = new Set<number>();
    if (opts.switchReleases) {
      const ids = albumIds.length ? [...albumIds] : [-1];
      const selectedBefore = new Map(this.db.select().from(albums).where(inArray(albums.id, ids)).all().map((a) => [a.id, a.selectedReleaseId]));
      if (await this.switchReleases(scan, artist, albumIds, result)) {
        result = matchArtistScan(scan, this.known(artist.id, albumIds), { threshold });
        for (const a of this.db.select().from(albums).where(inArray(albums.id, ids)).all()) {
          if (selectedBefore.get(a.id) !== a.selectedReleaseId) releaseChanged.add(a.id);
        }
      }
    }
    return this.toPlan(scan, artist, result, { releaseTitle: opts.releaseTitle, releaseChanged });
  }

  private toPlan(
    scan: AudioScanResult,
    artist: ArtistRow,
    result: RescanArtistResult,
    opts: { releaseTitle: string | null; releaseChanged: ReadonlySet<number> },
  ): ScanPlan {
    const plan: ScanPlan = { albums: [], rejected: [], groupMessages: [], cueImages: 0 };
    const groupByKey = new Map(scan.groups.map((g) => [g.key, g]));
    const groupOfFile = new Map<string, AudioGroup>();
    for (const g of scan.groups) for (const f of g.files) groupOfFile.set(f.path, g);
    const albumRows = new Map(
      this.db
        .select()
        .from(albums)
        .where(inArray(albums.id, result.albums.length ? result.albums.map((a) => Number(a.albumId)) : [-1]))
        .all()
        .map((a) => [a.id, a]),
    );
    const trackIds = result.assignments.map((a) => a.trackRef).filter((r): r is number => typeof r === 'number');
    const trackRows = new Map(
      (trackIds.length ? this.db.select().from(tracks).where(inArray(tracks.id, trackIds)).all() : []).map((t) => [t.id, t]),
    );
    const linkedFileIds = [...trackRows.values()].map((t) => t.audioFileId).filter((id): id is number => id != null);
    const fileRows = new Map(
      (linkedFileIds.length ? this.db.select().from(audioFiles).where(inArray(audioFiles.id, linkedFileIds)).all() : []).map((f) => [f.id, f]),
    );

    for (const summary of result.albums) {
      const albumId = Number(summary.albumId);
      const album = albumRows.get(albumId);
      const releaseId = typeof summary.releaseRef === 'number' ? summary.releaseRef : album?.selectedReleaseId;
      if (!album || releaseId == null) continue;
      const release = music.releaseRow(this.db, albumId, releaseId);
      const groups = summary.groupKeys.map((k) => groupByKey.get(k)).filter((g): g is AudioGroup => g !== undefined);
      // Mixed releases: the files of one group carry more than one edition's release id.
      const mixed = groups.find((g) => g.releaseIds.length > 1);
      const files: PlannedFile[] = [];
      for (const a of result.assignments) {
        if (Number(a.albumId) !== albumId || typeof a.trackRef !== 'number') continue;
        const track = trackRows.get(a.trackRef);
        const scanned = scan.files.find((f) => f.path === a.path);
        if (!track || !scanned) continue;
        const group = groupOfFile.get(a.path);
        files.push({
          file: scanned,
          groupFolder: group?.folder ?? albumFolderOf(a.path),
          track,
          score: a.score,
          quality: audioQualityOf(scanned, opts.releaseTitle),
          releaseGroup: safe(() => parseAudioPath(a.path, 'music').releaseGroup) ?? null,
          existing: track.audioFileId != null ? (fileRows.get(track.audioFileId) ?? null) : null,
          inPlace: isUnder(a.path, artist.path),
          rejections: mixed
            ? [permanent('mixedReleases', `Files of more than one edition of ${album.title} are mixed in ${basename(mixed.folder)}`)]
            : [],
        });
      }
      const mediumCount = Math.max(1, release.mediumCount, ...files.map((f) => f.track.mediumNumber));
      const warnings: string[] = [];
      if (summary.incomplete) {
        warnings.push(`${album.title}: ${summary.missingTracks.length} of ${summary.missingTracks.length + summary.matchedCount} tracks are missing; the album stays wanted`);
      }
      plan.albums.push({
        album,
        release,
        confidence: summary.confidence,
        mediumCount,
        groups,
        files,
        extras: summary.extras,
        missingTrackCount: summary.missingTracks.length,
        releaseChanged: opts.releaseChanged.has(albumId),
        warnings,
      });
    }
    // Files of matched groups that map to no track of the edition.
    const albumOfGroup = new Map<string, AlbumPlan>();
    for (const p of plan.albums) for (const g of p.groups) albumOfGroup.set(g.key, p);
    for (const f of result.unmatchedFiles) {
      const p = albumOfGroup.get(groupOfFile.get(f.path)?.key ?? '');
      plan.rejected.push({
        file: f,
        rejections: [permanent('trackMapping', p ? `Does not match a track of ${p.album.title}` : 'Does not match a track of the release')],
        ...(p ? { albumId: p.album.id } : {}),
      });
    }
    // Whole groups that were not matched.
    for (const u of result.unmatchedGroups) {
      const name = basename(u.group.folder);
      const bestTitle = u.best ? albumRows.get(Number(u.best.albumId))?.title ?? this.albumTitle(Number(u.best.albumId)) : null;
      let rejection: ImportRejection;
      switch (u.reason) {
        case 'cueImage':
          plan.cueImages++;
          rejection = permanent('cueImage', 'Single-file album image with a cue sheet; use Manual Import');
          plan.groupMessages.push(`${name}: album image with a cue sheet, Manual Import required`);
          break;
        case 'albumAlreadyMatched': {
          const winner = plan.albums.find((p) => p.album.id === Number(u.best?.albumId));
          const mixed = winner && u.best && winner.release.mbReleaseId !== u.best.releaseId;
          rejection = mixed
            ? permanent('mixedReleases', `Another edition of ${winner.album.title} was matched in this download`)
            : permanent('trackMapping', `Tracks already provided by another folder of this download${bestTitle ? ` (${bestTitle})` : ''}`);
          break;
        }
        case 'belowThreshold':
          rejection = permanent('unknownAlbum', `No album matched well enough${bestTitle && u.best ? ` (best: ${bestTitle}, ${Math.round(u.best.confidence * 100)}%)` : ''}`);
          plan.groupMessages.push(`${name}: ${rejection.message}`);
          break;
        case 'unreadable':
          rejection = permanent('unableToParse', 'Unable to read the audio files');
          break;
        default:
          rejection = permanent('unknownAlbum', `No album of ${artist.name} matches`);
      }
      for (const f of u.group.files) plan.rejected.push({ file: f, rejections: [rejection], ...(u.best ? { albumId: Number(u.best.albumId) } : {}) });
    }
    return plan;
  }

  private albumTitle(id: number): string | null {
    return this.db.select({ title: albums.title }).from(albums).where(eq(albums.id, id)).get()?.title ?? null;
  }

  // -------------------------------------------------------------------------------------
  // Specs
  // -------------------------------------------------------------------------------------

  private profileOf(artist: ArtistRow): QualityProfile | null {
    try {
      return this.o.profiles.getQualityProfile(artist.qualityProfileId);
    } catch {
      return null;
    }
  }

  /**
   * Import specs over the planned files: absolutePath, freeSpace (per album), notUnpacking,
   * sameFile, alreadyImported, upgrade (strictly better only) and trackMapping (one file per
   * track); mixedReleases was decided while planning. Rejected files move to `plan.rejected`.
   */
  private async applySpecs(plan: ScanPlan, artist: ArtistRow, opts: { downloadId: string | null; addedAt?: string | undefined; settings: MediaManagementSettings }): Promise<void> {
    const { settings } = opts;
    const profile = this.profileOf(artist);
    const libraryPaths = new Set(this.db.select({ path: audioFiles.path }).from(audioFiles).all().map((r) => r.path));
    const alreadyImported = opts.downloadId ? this.importedSinceGrab(opts.downloadId, opts.addedAt) : false;
    const now = this.o.now();
    const freeSpaceBytes = settings.skipFreeSpaceCheck ? null : await this.o.freeSpace(artist.rootFolderPath);

    for (const album of plan.albums) {
      const needed = album.files.filter((f) => !f.inPlace).reduce((n, f) => n + f.file.sizeBytes, 0);
      const space = freeSpaceSpec({ existingFile: needed === 0, sizeBytes: needed }, { settings, freeSpaceBytes });
      const seenTracks = new Set<number>();
      for (const f of album.files) {
        const r = f.rejections;
        const push = (x: ImportRejection | null) => {
          if (x) r.push(x);
        };
        push(absolutePathSpec(f.file));
        push(space);
        push(notUnpackingSpec(f.file, { settings, platform: this.o.platform, now }));
        push(sameFileSpec(f.file, { libraryPaths }));
        if (alreadyImported && f.existing) push(permanent('alreadyImported', 'Track file already imported'));
        if (seenTracks.has(f.track.id)) push(permanent('trackMapping', 'Another file maps to the same track'));
        seenTracks.add(f.track.id);
        if (f.existing && !f.inPlace) {
          const cmp = compareQ(profile, f.quality, f.existing.quality);
          if (cmp <= 0) {
            push(permanent('notQualityUpgrade', `Not an upgrade for existing track file. Existing quality: ${f.existing.quality.quality.name}`));
          }
        }
      }
      const rejected = album.files.filter((f) => f.rejections.length > 0);
      for (const f of rejected) plan.rejected.push({ file: f.file, rejections: f.rejections, albumId: album.album.id });
      album.files = album.files.filter((f) => f.rejections.length === 0);
    }
    plan.albums = plan.albums.filter((a) => a.files.length > 0);
  }

  // -------------------------------------------------------------------------------------
  // Transfer
  // -------------------------------------------------------------------------------------

  private namingArtist(artist: ArtistRow): NamingArtist {
    return { name: artist.name, disambiguation: artist.disambiguation, mbArtistId: artist.mbArtistId };
  }

  private namingAlbum(album: AlbumRow): NamingAlbum {
    return {
      title: album.title,
      albumType: album.primaryType,
      releaseDate: album.releaseDate,
      year: album.year,
      disambiguation: album.disambiguation,
      mbReleaseGroupId: album.mbReleaseGroupId,
    };
  }

  /** `<artist path>/<album folder>`. */
  albumFolderFor(artist: ArtistRow, album: AlbumRow, naming = this.o.naming()): string {
    return join(artist.path, buildAlbumFolder(naming, this.namingArtist(artist), this.namingAlbum(album), { pathSeparator: sep }));
  }

  /** Destination of one track file: built name with `renameTracks`, else the original path below the album folder. */
  trackDestination(
    artist: ArtistRow,
    album: AlbumRow,
    albumFolder: string,
    f: Pick<PlannedFile, 'file' | 'groupFolder' | 'track' | 'quality' | 'releaseGroup'>,
    mediumCount: number,
    naming = this.o.naming(),
  ): string {
    if (!naming.renameTracks) {
      const rel = relative(f.groupFolder, f.file.path);
      return join(albumFolder, rel.startsWith('..') || isAbsolute(rel) ? basename(f.file.path) : rel);
    }
    const file: NamingFile = { path: f.file.path, relativePath: basename(f.file.path), quality: f.quality, releaseGroup: f.releaseGroup, sceneName: null };
    const name = buildTrackFileName(
      naming,
      this.namingArtist(artist),
      this.namingAlbum(album),
      { title: f.track.title, trackNumber: f.track.trackNumber, mediumNumber: f.track.mediumNumber, artistName: f.track.artistCredit },
      file,
      { extension: f.file.extension, mediumCount, pathSeparator: sep },
    );
    return join(albumFolder, name);
  }

  private transferMode(mode: 'move' | 'copy', settings: MediaManagementSettings): TransferMode {
    if (mode === 'move') return 'move';
    return settings.useHardlinks ? 'hardlinkOrCopy' : 'copy';
  }

  /** Places an album's approved files, writes rows, publishes one import event for the album. */
  private async executeAlbum(artist: ArtistRow, plan: AlbumPlan, opts: ExecuteOptions): Promise<MusicImportOutcome[]> {
    const settings = this.o.mediaManagement();
    const naming = this.o.naming();
    const outcomes: MusicImportOutcome[] = [];
    if (!(await isDirectory(artist.rootFolderPath))) {
      return plan.files.map((f) => ({ path: f.file.path, status: 'failed', rejections: [], error: 'Failed to import track, Root folder missing.', albumId: plan.album.id }));
    }
    const albumFolder = this.albumFolderFor(artist, plan.album, naming);
    const artistExisted = await isDirectory(artist.path);
    const mode = this.transferMode(opts.mode, settings);
    const bin = new RecycleBin(settings.recycleBinPath, this.o.now);
    const placed: Array<{ f: PlannedFile; row: AudioFileRow; destination: string; replaced: AudioFileRow | null; transfer: TransferResult | 'none' }> = [];

    for (const f of plan.files) {
      try {
        const done = await this.placeFile(artist, plan, f, albumFolder, { mode, bin, settings, naming, downloadId: opts.downloadId });
        placed.push({ f, ...done });
        outcomes.push({
          path: f.file.path,
          status: 'imported',
          rejections: [],
          ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
          audioFileId: done.row.id,
          destination: done.destination,
          replacedFileIds: done.replaced ? [done.replaced.id] : [],
          albumId: plan.album.id,
          trackId: f.track.id,
        });
      } catch (err) {
        const message = failureMessage(err);
        this.o.log?.warn({ err, path: f.file.path }, 'track import failed');
        this.o.bus?.publish({ type: 'import', action: 'failed', title: basename(f.file.path), mediaType: 'music', mediaId: artist.id, albumIds: [plan.album.id], message });
        outcomes.push({ path: f.file.path, status: 'failed', rejections: [], error: message, albumId: plan.album.id, trackId: f.track.id });
      }
    }
    if (placed.length === 0) return outcomes;

    await this.importExtras(plan, albumFolder, placed, mode);
    if (settings.setPermissions) {
      if (!artistExisted) await setPermissions(artist.path, settings.chmodFolder, true);
      await setPermissions(albumFolder, settings.chmodFolder, true);
    }

    if (opts.downloadId) {
      const at = this.o.now().toISOString();
      for (const p of placed) {
        this.db
          .insert(importedDownloads)
          .values({
            downloadId: opts.downloadId,
            mediaType: 'music',
            seriesId: null,
            movieId: null,
            episodeIds: [],
            mediaFileId: p.row.id,
            sourcePath: p.f.file.path,
            destinationPath: p.destination,
            importedAt: at,
            artistId: artist.id,
            albumIds: [plan.album.id],
          })
          .run();
      }
    }

    const files = placed.map((p) => music.toAudioFile(p.row));
    const replacedFiles = placed.flatMap((p) => (p.replaced ? [music.toAudioFile(p.replaced)] : []));
    const profile = this.profileOf(artist);
    const best = files.map((f) => f.quality).reduce((a, b) => (compareQ(profile, b, a) > 0 ? b : a));
    const missing = this.db
      .select({ id: tracks.id })
      .from(tracks)
      .where(and(eq(tracks.albumId, plan.album.id), eq(tracks.albumReleaseId, plan.release.id), eq(tracks.hasFile, false)))
      .all().length;
    const transfers = placed.map((p) => p.transfer).filter((t): t is TransferResult => t !== 'none');
    const event: AudioImportedEvent = {
      mediaType: 'music',
      artistId: artist.id,
      albumId: plan.album.id,
      albumIds: [plan.album.id],
      trackIds: placed.map((p) => p.f.track.id),
      files,
      replacedFiles,
      quality: best,
      albumFolder,
      sourcePath: plan.groups[0]?.folder ?? dirname(placed[0]!.f.file.path),
      downloadId: opts.downloadId,
      sourceTitle: opts.sourceTitle ?? basename(plan.groups[0]?.folder ?? albumFolder),
      isUpgrade: replacedFiles.length > 0,
      importMode: transfers.includes('hardlink') ? 'hardlink' : transfers.includes('copy') ? 'copy' : 'move',
      manual: opts.manual,
      incomplete: missing > 0,
    };
    this.o.bus?.publish({ type: 'import', action: 'imported', title: `${artist.name} – ${plan.album.title}`, mediaType: 'music', mediaId: artist.id, albumIds: [plan.album.id] });
    const deps = this.o.deps();
    await this.callHook(() => deps.history?.recordAudioImport?.(event));
    await this.callHook(() => deps.notifications?.onAudioImported?.(event));
    // Media servers rescan the album folder; detached so a slow server does not hold the import.
    void this.callHook(() => deps.mediaServers?.refreshPath({ path: albumFolder, mediaType: 'music', updateType: event.isUpgrade ? 'Modified' : 'Created' }));
    return outcomes;
  }

  private async placeFile(
    artist: ArtistRow,
    plan: AlbumPlan,
    f: PlannedFile,
    albumFolder: string,
    o: { mode: TransferMode; bin: RecycleBin; settings: MediaManagementSettings; naming: NamingConfig; downloadId: string | null },
  ): Promise<{ row: AudioFileRow; destination: string; replaced: AudioFileRow | null; transfer: TransferResult | 'none' }> {
    let destination: string;
    let transfer: TransferResult | 'none' = 'none';
    // The track's current file, unless it is the very file being imported.
    const replaced = f.existing && resolve(f.existing.path) !== resolve(f.file.path) ? f.existing : null;
    if (f.inPlace) {
      destination = f.file.path;
      if (replaced && (await exists(replaced.path))) {
        await o.bin.recycle(replaced.path, relative(artist.rootFolderPath, dirname(replaced.path))).catch((err: unknown) =>
          this.o.log?.warn({ err, path: replaced.path }, 'could not recycle the replaced track file'),
        );
      }
    } else {
      destination = this.trackDestination(artist, plan.album, albumFolder, f, plan.mediumCount, o.naming);
      // The new file is placed first; a replaced file on the same path is set aside meanwhile
      // and put back when the transfer fails (the same routine as video upgrades).
      let setAside: string | null = null;
      if (replaced && resolve(replaced.path) === resolve(destination) && (await exists(replaced.path))) {
        setAside = `${replaced.path}.arclight-replacing`;
        await rename(replaced.path, setAside);
      }
      const downloadId = o.downloadId;
      const onProgress =
        downloadId && this.o.downloads.setImportProgress
          ? (copied: number, total: number) => this.o.downloads.setImportProgress?.(downloadId, { copiedBytes: copied, totalBytes: total })
          : undefined;
      try {
        transfer = await transferFile(f.file.path, destination, o.mode, { ...(this.o.fsOps ? { ops: this.o.fsOps } : {}), ...(onProgress ? { onProgress } : {}) });
      } catch (err) {
        if (setAside) await rename(setAside, replaced!.path).catch((e: unknown) => this.o.log?.error({ err: e, path: replaced!.path }, 'could not restore the file being replaced'));
        throw err;
      } finally {
        if (downloadId) this.o.downloads.setImportProgress?.(downloadId, null);
      }
      if (o.settings.setPermissions) await setPermissions(destination, o.settings.chmodFolder, false);
      if (replaced) {
        const current = setAside ?? replaced.path;
        if (await exists(current)) {
          try {
            await o.bin.recycle(current, relative(artist.rootFolderPath, dirname(replaced.path)), basename(replaced.path));
          } catch (err) {
            this.o.log?.warn({ err, path: current }, 'could not recycle the replaced track file');
          }
        }
      }
    }

    const size = (await stat(destination)).size;
    const t = f.file.tags;
    const now = this.o.now().toISOString();
    const values = {
      mediaType: 'music' as const,
      artistId: artist.id,
      albumId: plan.album.id,
      authorId: null,
      bookId: null,
      path: destination,
      relativePath: relative(artist.path, destination),
      sizeBytes: size,
      mtime: new Date(f.file.mtimeMs).toISOString(),
      quality: f.quality,
      releaseGroup: f.releaseGroup,
      sceneName: null,
      codec: t?.codec ?? null,
      container: t?.container ?? null,
      bitrateKbps: round(t?.bitrateKbps ?? null),
      sampleRateHz: round(t?.sampleRateHz ?? null),
      bitDepth: round(t?.bitDepth ?? null),
      channels: t?.channels ?? null,
      durationMs: round(t?.durationMs ?? null),
      discNumber: f.track.mediumNumber,
      trackNumber: f.track.trackNumber,
      partNumber: null,
      chapterCount: t?.chapters ? t.chapters.length : null,
      tags: t ? fileTags(t) : null,
      mediaInfo: t ? { source: t.source, lossless: t.lossless } : null,
    };
    const row = this.db.transaction((tx) => {
      // A replaced file's row goes; tracks that pointed at it lose their file.
      if (replaced) {
        tx.update(tracks).set({ hasFile: false, audioFileId: null }).where(eq(tracks.audioFileId, replaced.id)).run();
        tx.delete(audioFiles).where(eq(audioFiles.id, replaced.id)).run();
      }
      const prior = tx.select().from(audioFiles).where(eq(audioFiles.path, destination)).get();
      const saved = prior
        ? tx.update(audioFiles).set(values).where(eq(audioFiles.id, prior.id)).returning().get()
        : tx.insert(audioFiles).values({ ...values, dateAdded: now }).returning().get();
      tx.update(tracks).set({ hasFile: true, audioFileId: saved.id }).where(eq(tracks.id, f.track.id)).run();
      return saved;
    });
    return { row, destination, replaced, transfer };
  }

  /** Cue sheets, rip logs, covers and lyrics of the album's groups, next to the tracks. */
  private async importExtras(
    plan: AlbumPlan,
    albumFolder: string,
    placed: ReadonlyArray<{ f: PlannedFile; destination: string }>,
    mode: TransferMode,
  ): Promise<void> {
    const byTrackSource = new Map(placed.map((p) => [resolve(p.f.file.path), p.destination]));
    const seen = new Set<string>();
    for (const extra of plan.extras) {
      if (!EXTRA_KINDS.has(extra.kind) || seen.has(extra.path)) continue;
      seen.add(extra.path);
      let destination: string;
      if (extra.kind === 'lyrics') {
        const track = extra.forFile ? byTrackSource.get(resolve(extra.forFile)) : undefined;
        if (!track) continue; // lyrics of a track that was not imported
        destination = track.slice(0, track.length - extname(track).length) + extname(extra.path);
      } else {
        const group = plan.groups.find((g) => isUnder(extra.path, g.folder));
        const rel = group ? relative(group.folder, extra.path) : basename(extra.path);
        destination = join(albumFolder, rel.startsWith('..') ? basename(extra.path) : rel);
      }
      if (resolve(destination) === resolve(extra.path) || (await exists(destination))) continue;
      try {
        await transferFile(extra.path, destination, mode, this.o.fsOps ? { ops: this.o.fsOps } : {});
      } catch (err) {
        this.o.log?.warn({ err, path: extra.path }, 'album extra not imported');
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // Manual import, audio mode
  // -------------------------------------------------------------------------------------

  /** GET /manualimport/audio: scan and propose artist, album, edition and track per file. */
  async listManualImport(query: AudioManualImportQuery): Promise<AudioManualImportItem[]> {
    const settings = this.o.mediaManagement();
    let folder = query.folder;
    let tracked: TrackedDownload | undefined;
    let artist: ArtistRow | undefined;
    let albumIds: number[] | null = null;
    if (query.downloadId) {
      tracked = this.o.downloads.listTracked().find((t) => t.downloadId === query.downloadId);
      if (!tracked) throw new ImportsError('NOT_FOUND', `Download ${query.downloadId} is not tracked`);
      folder ??= tracked.outputPath;
      const target = this.targetOf(tracked);
      if (target.artistId !== undefined) artist = this.tryArtist(target.artistId);
    }
    if (query.artistId !== undefined) {
      artist = this.tryArtist(query.artistId);
      if (!artist) throw new ImportsError('NOT_FOUND', `Artist ${query.artistId} not found`);
      folder ??= artist.path;
    }
    if (!folder) throw new ImportsError('VALIDATION', 'No folder to scan');

    let scan: AudioScanResult;
    try {
      scan = await scanAudioPath(folder, { tagReader: this.tagReader(), workingFolders: settings.downloadClientWorkingFolders });
    } catch (err) {
      if (err instanceof ScanError) throw new ImportsError('NOT_FOUND', err.message);
      throw err;
    }
    if (!artist) artist = this.guessArtist(scan, tracked?.title ?? basename(folder));
    if (query.albumId !== undefined) {
      const album = this.db.select().from(albums).where(eq(albums.id, query.albumId)).get();
      if (!album) throw new ImportsError('NOT_FOUND', `Album ${query.albumId} not found`);
      artist ??= this.tryArtist(album.artistId);
      if (artist && album.artistId !== artist.id) throw new ImportsError('VALIDATION', `Album ${query.albumId} is not an album of artist ${artist.id}`);
      albumIds = [album.id];
    }
    const known = new Set(query.filterExistingFiles ? this.db.select({ path: audioFiles.path }).from(audioFiles).all().map((r) => resolve(r.path)) : []);
    const keep = (f: AudioScanFile) => !known.has(resolve(f.path));
    const releaseTitle = tracked?.title ?? null;
    const downloadId = tracked?.downloadId;

    if (!artist) {
      return scan.groups.flatMap((g) =>
        g.files.filter(keep).map((f) =>
          this.manualItem(f, g, { confidence: 0, rejections: [permanent('unknownArtist', 'Unknown Artist')], releaseTitle, downloadId }),
        ),
      );
    }
    const a = artist;
    const candidates = albumIds ?? this.albumIdsOf(a.id);
    const plan = await this.plan(scan, a, candidates, { switchReleases: false, releaseTitle });
    await this.applySpecs(plan, a, { downloadId: downloadId ?? null, addedAt: tracked?.added, settings });

    const groupOf = new Map<string, AudioGroup>();
    for (const g of scan.groups) for (const f of g.files) groupOf.set(f.path, g);
    const items: AudioManualImportItem[] = [];
    const albumPlans = new Map(plan.albums.map((p) => [p.album.id, p]));
    for (const p of plan.albums) {
      for (const f of p.files) {
        if (!keep(f.file)) continue;
        items.push(this.manualItem(f.file, groupOf.get(f.file.path)!, { artistId: a.id, plan: p, planned: f, confidence: p.confidence, rejections: [], warnings: p.warnings, releaseTitle, downloadId }));
      }
    }
    // Rejected files: propose what fits best so the user only adjusts.
    const proposals = this.proposeForRejected(plan.rejected, groupOf);
    for (const r of plan.rejected) {
      if (!keep(r.file)) continue;
      const g = groupOf.get(r.file.path)!;
      const p = r.albumId !== undefined ? albumPlans.get(r.albumId) : undefined;
      const proposal = proposals.get(r.file.path);
      items.push(
        this.manualItem(r.file, g, {
          artistId: a.id,
          ...(proposal ?? (p ? { plan: p } : r.albumId !== undefined ? { albumId: r.albumId } : {})),
          confidence: proposal?.confidence ?? p?.confidence ?? 0,
          rejections: r.rejections,
          releaseTitle,
          downloadId,
        }),
      );
    }
    return items.sort((x, y) => x.groupFolder.localeCompare(y.groupFolder, undefined, { numeric: true }) || (x.mediumNumber ?? 0) - (y.mediumNumber ?? 0) || (x.trackNumber ?? 0) - (y.trackNumber ?? 0) || x.path.localeCompare(y.path));
  }

  /** For files the import would reject: the track they fit best on their group's best album (if any). */
  private proposeForRejected(
    rejected: readonly Rejected[],
    groupOf: ReadonlyMap<string, AudioGroup>,
  ): Map<string, { albumId: number; albumReleaseId: number; track: TrackRow; trackScore: number; confidence: number }> {
    const out = new Map<string, { albumId: number; albumReleaseId: number; track: TrackRow; trackScore: number; confidence: number }>();
    const byGroupAlbum = new Map<string, { group: AudioGroup; albumId: number }>();
    for (const r of rejected) {
      const g = groupOf.get(r.file.path);
      if (g && r.albumId !== undefined) byGroupAlbum.set(`${g.key}|${r.albumId}`, { group: g, albumId: r.albumId });
    }
    for (const { group, albumId } of byGroupAlbum.values()) {
      const album = this.db.select().from(albums).where(eq(albums.id, albumId)).get();
      if (!album?.selectedReleaseId) continue;
      const own = this.db.select().from(tracks).where(and(eq(tracks.albumId, albumId), eq(tracks.albumReleaseId, album.selectedReleaseId))).all();
      if (own.length === 0) continue;
      const media = new Map<number, TrackRow[]>();
      for (const t of own) media.set(t.mediumNumber, [...(media.get(t.mediumNumber) ?? []), t]);
      const candidate: ReleaseCandidate = {
        id: String(album.selectedReleaseId),
        media: [...media.entries()].map(([position, list]) => ({
          position,
          tracks: list.map((t) => ({ position: t.trackNumber, title: t.title, durationMs: t.durationMs, recordingId: t.mbRecordingId, artist: t.artistCredit, ref: t.id })),
        })),
      };
      const rejectedHere = group.files.filter((f) => rejected.some((r) => r.file.path === f.path && r.albumId === albumId));
      const match = scoreRelease(rejectedHere.map(matchFileFrom), candidate, { threshold: 0 });
      for (const m of match.mapping) {
        const track = own.find((t) => t.id === m.ref);
        if (track) out.set(m.path, { albumId, albumReleaseId: album.selectedReleaseId, track, trackScore: m.score, confidence: match.confidence });
      }
    }
    return out;
  }

  private guessArtist(scan: AudioScanResult, title: string): ArtistRow | undefined {
    const counts = new Map<string, number>();
    for (const g of scan.groups) if (g.albumArtist) counts.set(g.albumArtist, (counts.get(g.albumArtist) ?? 0) + g.files.length);
    for (const [name] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const found = this.findArtistByName(name);
      if (found) return found;
    }
    const mbids = [...new Set(scan.files.map((f) => f.tags?.mbAlbumArtistId ?? f.tags?.mbArtistId).filter((v): v is string => !!v))];
    for (const id of mbids) {
      const found = music.findArtistByMbid(this.db, id);
      if (found) return found;
    }
    return this.findArtistByTitle(title) ?? scan.files.map((f) => this.findArtistForPath(f.path)).find((a) => a !== undefined);
  }

  private findArtistForPath(path: string): ArtistRow | undefined {
    return this.db.select().from(artists).all().find((a) => isUnder(path, a.path));
  }

  private manualItem(
    f: AudioScanFile,
    g: AudioGroup,
    o: {
      artistId?: number;
      plan?: AlbumPlan;
      planned?: PlannedFile;
      albumId?: number;
      albumReleaseId?: number;
      track?: TrackRow;
      trackScore?: number;
      confidence: number;
      rejections: ImportRejection[];
      warnings?: string[];
      releaseTitle: string | null;
      downloadId: string | undefined;
    },
  ): AudioManualImportItem {
    const track = o.planned?.track ?? o.track;
    const albumId = o.plan?.album.id ?? o.albumId;
    const albumReleaseId = o.plan?.release.id ?? o.albumReleaseId;
    const score = o.planned?.score ?? o.trackScore;
    return {
      path: f.path,
      relativePath: f.relativePath,
      name: f.name,
      sizeBytes: f.sizeBytes,
      quality: o.planned?.quality ?? audioQualityOf(f, o.releaseTitle),
      mediaType: 'music',
      groupKey: g.key,
      groupFolder: g.folder,
      ...(o.artistId !== undefined ? { artistId: o.artistId } : {}),
      ...(albumId !== undefined ? { albumId } : {}),
      ...(albumReleaseId !== undefined ? { albumReleaseId } : {}),
      ...(track ? { trackIds: [track.id], mediumNumber: track.mediumNumber, trackNumber: track.trackNumber, trackTitle: track.title } : {}),
      confidence: Math.min(1, Math.max(0, o.confidence)),
      ...(score !== undefined ? { trackScore: Math.min(1, Math.max(0, score)) } : {}),
      tags: manualTags(f.tags),
      rejections: o.rejections,
      warnings: o.warnings ?? [],
      ...(o.downloadId ? { downloadId: o.downloadId } : {}),
    };
  }

  /** POST /manualimport/audio: imports the user's mapping; specs are bypassed (like video). */
  async executeManualImport(request: AudioManualImportRequest): Promise<AudioManualImportResult> {
    const result: AudioManualImportResult = { imported: [], failed: [] };
    const trackedById = new Map(this.o.downloads.listTracked().map((t) => [t.downloadId, t]));
    // Group by album and download: one import event per album.
    const batches = new Map<string, { artist: ArtistRow; album: AlbumRow; release: AlbumReleaseRow; downloadId: string | null; files: PlannedFile[] }>();
    const claimed = new Map<number, string>();
    for (const req of request.items) {
      try {
        const info = await stat(req.path).catch(() => null);
        if (!info?.isFile()) throw new ImportsError('NOT_FOUND', `File not found: ${req.path}`);
        const artist = this.tryArtist(req.artistId);
        if (!artist) throw new ImportsError('NOT_FOUND', `Artist ${req.artistId} not found`);
        const album = this.db.select().from(albums).where(eq(albums.id, req.albumId)).get();
        if (!album || album.artistId !== artist.id) throw new ImportsError('VALIDATION', `Album ${req.albumId} is not an album of artist ${artist.id}`);
        if (album.selectedReleaseId == null) throw new ImportsError('VALIDATION', `Album ${album.title} has no edition with tracks yet`);
        if (req.albumReleaseId !== undefined && req.albumReleaseId !== album.selectedReleaseId) {
          throw new ImportsError('VALIDATION', `Edition ${req.albumReleaseId} is not the selected edition of ${album.title}; switch editions first`);
        }
        const trackId = req.trackIds[0]!;
        const track = this.db.select().from(tracks).where(eq(tracks.id, trackId)).get();
        if (!track || track.albumId !== album.id || track.albumReleaseId !== album.selectedReleaseId) {
          throw new ImportsError('VALIDATION', `Track ${trackId} is not a track of the selected edition of ${album.title}`);
        }
        const other = claimed.get(trackId);
        if (other && other !== req.path) throw new ImportsError('VALIDATION', `Track ${trackId} is already mapped to ${basename(other)}`);
        claimed.set(trackId, req.path);
        const tags = await this.tagReader().read(req.path).catch(() => null);
        const file: AudioScanFile = {
          path: req.path,
          relativePath: basename(req.path),
          name: basename(req.path),
          extension: extname(req.path).toLowerCase(),
          sizeBytes: info.size,
          mtimeMs: info.mtimeMs,
          tags,
          error: null,
          discFromFolder: null,
        };
        const tracked = req.downloadId ? trackedById.get(req.downloadId) : undefined;
        const existing = track.audioFileId != null ? (this.db.select().from(audioFiles).where(eq(audioFiles.id, track.audioFileId)).get() ?? null) : null;
        const planned: PlannedFile = {
          file,
          groupFolder: albumFolderOf(req.path),
          track,
          score: 1,
          quality: req.quality ?? audioQualityOf(file, tracked?.title ?? null),
          releaseGroup: safe(() => parseAudioPath(req.path, 'music').releaseGroup) ?? null,
          existing,
          inPlace: isUnder(req.path, artist.path),
          rejections: [],
        };
        const key = `${album.id}|${req.downloadId ?? ''}`;
        let batch = batches.get(key);
        if (!batch) {
          batch = { artist, album, release: music.releaseRow(this.db, album.id, album.selectedReleaseId), downloadId: req.downloadId ?? null, files: [] };
          batches.set(key, batch);
        }
        batch.files.push(planned);
      } catch (err) {
        result.failed.push({ path: req.path, error: failureMessage(err) });
      }
    }

    const importedPerDownload = new Map<string, Set<number>>();
    for (const batch of batches.values()) {
      const tracked = batch.downloadId ? trackedById.get(batch.downloadId) : undefined;
      const mode: 'move' | 'copy' =
        request.importMode === 'move' ? 'move' : request.importMode === 'copy' ? 'copy' : tracked && !tracked.canMoveFiles ? 'copy' : 'move';
      const mediumCount = Math.max(1, batch.release.mediumCount, ...batch.files.map((f) => f.track.mediumNumber));
      const groupFolders = [...new Set(batch.files.map((f) => f.groupFolder))];
      const plan: AlbumPlan = {
        album: batch.album,
        release: batch.release,
        confidence: 1,
        mediumCount,
        groups: groupFolders.map((folder) => ({ key: `manual:${folder}`, basis: 'folder', folder, album: null, albumArtist: null, mbReleaseId: null, mbReleaseGroupId: null, releaseIds: [], files: [], extras: [], hasCue: false })),
        files: batch.files,
        extras: await this.extrasNear(groupFolders, batch.files),
        missingTrackCount: 0,
        releaseChanged: false,
        warnings: [],
      };
      const outcomes = await this.executeAlbum(batch.artist, plan, { mode, downloadId: batch.downloadId, sourceTitle: tracked?.title ?? null, manual: true });
      for (const o of outcomes) {
        if (o.status === 'imported') {
          result.imported.push({ path: o.path, audioFileId: o.audioFileId!, trackId: o.trackId!, destination: o.destination! });
          if (batch.downloadId) {
            const set = importedPerDownload.get(batch.downloadId) ?? new Set<number>();
            set.add(batch.album.id);
            importedPerDownload.set(batch.downloadId, set);
          }
        } else {
          result.failed.push({ path: o.path, error: o.error ?? o.rejections.map((r) => r.message).join(', ') });
        }
      }
    }

    // A tracked download reaches Imported once all of its albums have files from it.
    for (const [downloadId] of importedPerDownload) {
      const tracked = trackedById.get(downloadId);
      if (!tracked) continue;
      const expected = this.targetOf(tracked).albumIds;
      const done = this.previouslyImportedAlbums(downloadId);
      if (expected.length === 0 ? done.size > 0 : expected.every((id) => done.has(id))) await this.o.downloads.markImported(tracked.id);
    }
    return result;
  }

  /** Extras (cue, log, covers, lyrics) in the folders of manually imported files. */
  private async extrasNear(folders: readonly string[], files: readonly PlannedFile[]): Promise<AudioExtraFile[]> {
    const out: AudioExtraFile[] = [];
    const stems = new Map(files.map((f) => [f.file.path.slice(0, f.file.path.length - f.file.extension.length).toLowerCase(), f.file.path]));
    for (const folder of folders) {
      try {
        const scan = await scanAudioPath(folder, { tagReader: { read: async () => Promise.reject(new Error('not read')) } });
        for (const e of scan.extras) {
          const stem = e.path.slice(0, e.path.length - extname(e.path).length).toLowerCase();
          out.push(e.kind === 'lyrics' ? { ...e, forFile: stems.get(stem) ?? null } : e);
        }
      } catch {
        // folder gone: no extras
      }
    }
    return out;
  }
}

/** Failure lines like the video importer's (spec 9.6), for tracks. */
function failureMessage(err: unknown): string {
  if (err instanceof ImportFileError) {
    switch (err.code) {
      case 'ROOT_FOLDER_NOT_FOUND':
        return 'Failed to import track, Root folder missing.';
      case 'DESTINATION_EXISTS':
        return 'Failed to import track, Destination already exists.';
      case 'RECYCLE_BIN':
        return 'Failed to import track, unable to move existing file to the Recycle Bin.';
      default:
        return `Failed to import track: ${err.message}`;
    }
  }
  if (err instanceof ImportsError) return err.message;
  return `Failed to import track: ${errorMessage(err)}`;
}

