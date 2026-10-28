import { stat, rm } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import { parsePath, parseRelease, type ParsedRelease } from '@arclight/parser';
import type {
  DuplicateReason,
  HygieneDeleteResult,
  HygieneFinding,
  HygieneFindingType,
  HygieneListQuery,
  HygieneListResponse,
  HygieneMapRequest,
  HygieneMapResult,
  HygieneParsedGuess,
  HygieneScanSummary,
  HygieneSuggestion,
  ManualImportRequest,
  ManualImportResult,
  MediaType,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, movies, rootFolders, series } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { RecycleBin } from '../imports/index.js';
import { isUnder } from '../imports/scan.js';
import { libraryService } from '../library/index.js';
import { getSection } from '../settings/service.js';
import { libraryHygieneFindings, type HygieneFindingRow } from './schema.js';
import { hashPrefix, isFolderEmpty, walkRoot, type WalkedFile } from './walk.js';

// Orphan, duplicate and empty-folder detection over every root folder (OrphanScan job), and
// the two actions on a finding: map an orphan into the library through manual import, or
// delete the file/folder (files go through the recycle bin).

export type HygieneErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT';

export class HygieneError extends Error {
  constructor(
    readonly code: HygieneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HygieneError';
  }
}

/** The manual-import entry point of the imports module. */
export interface ManualImporter {
  executeManualImport(request: ManualImportRequest): Promise<ManualImportResult>;
}

export interface LibraryHygieneOptions {
  db: Db;
  importer: () => ManualImporter;
  bus?: EventBus;
  log?: Logger;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

interface SeriesLite {
  id: number;
  title: string;
  year: number;
  path: string;
  cleanTitle: string;
}

interface MovieLite extends SeriesLite {
  originalTitle: string;
  movieFileId: number | null;
}

interface PendingFinding {
  type: HygieneFindingType;
  path: string;
  rootFolderPath: string;
  sizeBytes: number;
  mediaFileId?: number | null;
  seriesId?: number | null;
  movieId?: number | null;
  duplicateReason?: DuplicateReason | null;
  duplicateOf?: string[];
  parsed?: HygieneParsedGuess | null;
  suggestions?: HygieneSuggestion[];
}

const SUGGESTION_MIN_SCORE = 0.5;
const MAX_SUGGESTIONS = 3;

/** Dice coefficient over character bigrams of two clean titles (0..1). */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      overlap++;
      grams.set(g, n - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

function safeParse(path: string, hint: MediaType): ParsedRelease | null {
  try {
    const fromPath = parsePath(path, hint);
    if (fromPath.series || fromPath.movie) return fromPath;
    // "Some Movie (2021)/abc123.mkv": fall back to the folder name.
    const folder = basename(dirname(path));
    const fromFolder = folder ? parseRelease(folder, hint) : null;
    return fromFolder && (fromFolder.series || fromFolder.movie) ? { ...fromFolder, quality: fromPath.quality } : fromPath;
  } catch {
    return null;
  }
}

function guessFrom(parsed: ParsedRelease | null): HygieneParsedGuess | null {
  if (!parsed) return null;
  const s = parsed.series;
  const m = parsed.movie;
  return {
    title: s?.titleInfo.titleWithoutYear || s?.title || m?.titleWithoutYear || m?.title || null,
    year: (s?.titleInfo.year || m?.year) || null,
    mediaType: s ? 'series' : m ? 'movie' : null,
    seasonNumber: s?.seasons[0] ?? null,
    episodeNumbers: s ? [...s.episodes] : [],
    quality: parsed.quality.quality.id !== 0 ? parsed.quality.quality.name : null,
    releaseGroup: parsed.releaseGroup,
  };
}

export class LibraryHygieneService {
  private readonly db: Db;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;
  private lastScanAt: string | null = null;

  constructor(private readonly opts: LibraryHygieneOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.platform = opts.platform ?? process.platform;
  }

  private norm(path: string): string {
    const r = resolve(path);
    return this.platform === 'win32' ? r.toLowerCase() : r;
  }

  // -------------------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------------------

  async scan(opts: { signal?: AbortSignal } = {}): Promise<HygieneScanSummary> {
    // Video-only module: music/audiobook roots are not walked, but still excluded when nested.
    const allRoots = this.db.select().from(rootFolders).all();
    const roots = allRoots.filter(
      (r): r is (typeof allRoots)[number] & { mediaType: 'series' | 'movie' } => r.mediaType === 'series' || r.mediaType === 'movie',
    );
    const settings = getSection(this.db, 'mediaManagement');
    const recycleBin = settings.recycleBinPath?.trim() || null;
    const allSeries: SeriesLite[] = this.db
      .select({ id: series.id, title: series.title, year: series.year, path: series.path, cleanTitle: series.cleanTitle })
      .from(series)
      .all();
    const allMovies: MovieLite[] = this.db
      .select({
        id: movies.id,
        title: movies.title,
        year: movies.year,
        path: movies.path,
        cleanTitle: movies.cleanTitle,
        originalTitle: movies.originalTitle,
        movieFileId: movies.movieFileId,
      })
      .from(movies)
      .all();
    const files = this.db
      .select({ id: mediaFiles.id, path: mediaFiles.path, seriesId: mediaFiles.seriesId, movieId: mediaFiles.movieId, mediaType: mediaFiles.mediaType, sizeBytes: mediaFiles.sizeBytes })
      .from(mediaFiles)
      .all();
    const known = new Map(files.map((f) => [this.norm(f.path), f]));
    const mediaFolders = new Set([...allSeries, ...allMovies].map((i) => this.norm(i.path)));

    const findings: PendingFinding[] = [];
    const summary: HygieneScanSummary = { rootFolders: 0, filesScanned: 0, orphans: 0, duplicates: 0, emptyFolders: 0, skippedRootFolders: [] };
    const walked: Array<{ root: (typeof roots)[number]; file: WalkedFile }> = [];

    for (const root of roots) {
      if (opts.signal?.aborted) throw new HygieneError('CONFLICT', 'scan cancelled');
      const info = await stat(root.path).catch(() => null);
      if (!info?.isDirectory()) {
        summary.skippedRootFolders.push(root.path);
        continue;
      }
      summary.rootFolders++;
      const nested = allRoots.filter((r) => r.id !== root.id && isUnder(r.path, root.path) && this.norm(r.path) !== this.norm(root.path)).map((r) => r.path);
      const result = await walkRoot(root.path, { excluded: [...nested, ...(recycleBin ? [recycleBin] : [])] });
      summary.filesScanned += result.videos.length;
      for (const file of result.videos) walked.push({ root, file });
      for (const folder of result.emptyFolders) {
        if (mediaFolders.has(this.norm(folder))) continue; // an item's own (still empty) folder is expected
        findings.push({ type: 'empty', path: folder, rootFolderPath: root.path, sizeBytes: 0 });
      }
    }

    // ---- content duplicates: same size, same leading-bytes hash, not hard links ----------
    const bySize = new Map<number, Array<{ root: (typeof roots)[number]; file: WalkedFile }>>();
    for (const w of walked) {
      if (w.file.sizeBytes <= 0) continue;
      const list = bySize.get(w.file.sizeBytes) ?? [];
      list.push(w);
      bySize.set(w.file.sizeBytes, list);
    }
    const contentDuplicates = new Set<string>();
    for (const group of bySize.values()) {
      if (group.length < 2) continue;
      const byHash = new Map<string, typeof group>();
      for (const w of group) {
        const h = await hashPrefix(w.file.path);
        if (!h) continue;
        const list = byHash.get(h) ?? [];
        list.push(w);
        byHash.set(h, list);
      }
      for (const same of byHash.values()) {
        const inodes = new Set(same.map((w) => (w.file.ino ? `${w.file.dev}:${w.file.ino}` : w.file.path)));
        if (same.length < 2 || inodes.size < 2) continue;
        for (const w of same) {
          const lib = known.get(this.norm(w.file.path));
          contentDuplicates.add(this.norm(w.file.path));
          findings.push({
            type: 'duplicate',
            path: w.file.path,
            rootFolderPath: w.root.path,
            sizeBytes: w.file.sizeBytes,
            mediaFileId: lib?.id ?? null,
            seriesId: lib?.seriesId ?? null,
            movieId: lib?.movieId ?? null,
            duplicateReason: 'content',
            duplicateOf: same.filter((o) => o !== w).map((o) => o.file.path),
          });
        }
      }
    }

    // ---- orphans (and orphans that duplicate an episode/movie that has a file) ----------
    const fileById = new Map(files.map((f) => [f.id, f]));
    for (const { root, file } of walked) {
      const key = this.norm(file.path);
      if (known.has(key) || contentDuplicates.has(key) || file.extra) continue;
      const parsed = safeParse(file.path, root.mediaType);
      const guess = guessFrom(parsed);
      const suggestions = root.mediaType === 'series' ? this.suggestSeries(file.path, guess, allSeries) : this.suggestMovies(file.path, guess, allMovies);
      const inFolder = suggestions[0]?.score === 1 ? suggestions[0] : undefined;
      const existing = inFolder ? this.existingFilesFor(inFolder, allMovies, fileById) : [];
      if (inFolder && existing.length > 0) {
        findings.push({
          type: 'duplicate',
          path: file.path,
          rootFolderPath: root.path,
          sizeBytes: file.sizeBytes,
          seriesId: inFolder.seriesId ?? null,
          movieId: inFolder.movieId ?? null,
          duplicateReason: inFolder.mediaType === 'series' ? 'episode' : 'movie',
          duplicateOf: existing,
          parsed: guess,
          suggestions,
        });
        continue;
      }
      findings.push({ type: 'orphan', path: file.path, rootFolderPath: root.path, sizeBytes: file.sizeBytes, parsed: guess, suggestions });
    }

    // ---- library rows: extra movie files, series files no episode points at -------------
    const rootOf = (path: string) => roots.find((r) => isUnder(path, r.path))?.path ?? dirname(path);
    const movieCounts = this.db
      .select({ movieId: mediaFiles.movieId, n: count() })
      .from(mediaFiles)
      .where(isNotNull(mediaFiles.movieId))
      .groupBy(mediaFiles.movieId)
      .all()
      .filter((r) => r.n > 1);
    for (const { movieId } of movieCounts) {
      const rows = files.filter((f) => f.movieId === movieId);
      for (const row of rows) {
        if (contentDuplicates.has(this.norm(row.path))) continue;
        findings.push({
          type: 'duplicate',
          path: row.path,
          rootFolderPath: rootOf(row.path),
          sizeBytes: row.sizeBytes,
          mediaFileId: row.id,
          movieId,
          duplicateReason: 'movie',
          duplicateOf: rows.filter((o) => o !== row).map((o) => o.path),
        });
      }
    }
    const linked = new Set(
      this.db
        .select({ fileId: episodes.episodeFileId })
        .from(episodes)
        .where(isNotNull(episodes.episodeFileId))
        .all()
        .map((r) => r.fileId),
    );
    for (const row of files) {
      if (row.mediaType !== 'series' || linked.has(row.id) || contentDuplicates.has(this.norm(row.path))) continue;
      findings.push({
        type: 'duplicate',
        path: row.path,
        rootFolderPath: rootOf(row.path),
        sizeBytes: row.sizeBytes,
        mediaFileId: row.id,
        seriesId: row.seriesId,
        duplicateReason: 'episode',
        duplicateOf: [],
      });
    }

    const foundAt = this.now().toISOString();
    this.db.transaction((tx) => {
      tx.delete(libraryHygieneFindings).run();
      for (const f of findings) {
        tx.insert(libraryHygieneFindings)
          .values({
            type: f.type,
            path: f.path,
            rootFolderPath: f.rootFolderPath,
            sizeBytes: f.sizeBytes,
            mediaFileId: f.mediaFileId ?? null,
            seriesId: f.seriesId ?? null,
            movieId: f.movieId ?? null,
            duplicateReason: f.duplicateReason ?? null,
            duplicateOf: f.duplicateOf ?? [],
            parsed: f.parsed ?? null,
            suggestions: f.suggestions ?? [],
            foundAt,
          })
          .run();
      }
    });
    this.lastScanAt = foundAt;
    summary.orphans = findings.filter((f) => f.type === 'orphan').length;
    summary.duplicates = findings.filter((f) => f.type === 'duplicate').length;
    summary.emptyFolders = findings.filter((f) => f.type === 'empty').length;
    this.log?.info(summary, 'library hygiene scan finished');
    return summary;
  }

  private suggestSeries(path: string, guess: HygieneParsedGuess | null, all: SeriesLite[]): HygieneSuggestion[] {
    const clean = guess?.title ? libraryService.toCleanTitle(guess.title) : '';
    const scored = all
      .map((s) => {
        if (isUnder(path, s.path)) return { s, score: 1 };
        let score = Math.max(titleSimilarity(clean, s.cleanTitle), titleSimilarity(clean, libraryService.toCleanTitle(`${s.title} ${s.year}`)));
        if (guess?.year && guess.year === s.year) score = Math.min(0.99, score + 0.1);
        return { s, score: Math.min(score, 0.99) };
      })
      .filter((x) => x.score >= SUGGESTION_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS);
    return scored.map(({ s, score }) => {
      const suggestion: HygieneSuggestion = { mediaType: 'series', seriesId: s.id, title: s.title, year: s.year, score: Math.round(score * 100) / 100 };
      if (guess?.seasonNumber != null && guess.episodeNumbers.length > 0) {
        const wanted = new Set(guess.episodeNumbers);
        const eps = this.db
          .select({ id: episodes.id, episodeNumber: episodes.episodeNumber })
          .from(episodes)
          .where(and(eq(episodes.seriesId, s.id), eq(episodes.seasonNumber, guess.seasonNumber)))
          .all()
          .filter((e) => wanted.has(e.episodeNumber));
        if (eps.length > 0) {
          suggestion.seasonNumber = guess.seasonNumber;
          suggestion.episodeIds = eps.map((e) => e.id);
        }
      }
      return suggestion;
    });
  }

  private suggestMovies(path: string, guess: HygieneParsedGuess | null, all: MovieLite[]): HygieneSuggestion[] {
    const clean = guess?.title ? libraryService.toCleanTitle(guess.title) : '';
    return all
      .map((m) => {
        if (isUnder(path, m.path)) return { m, score: 1 };
        let score = Math.max(titleSimilarity(clean, m.cleanTitle), titleSimilarity(clean, libraryService.toCleanTitle(m.originalTitle)));
        if (guess?.year) score += guess.year === m.year ? 0.1 : Math.abs(guess.year - m.year) <= 1 ? 0.05 : -0.2;
        return { m, score: Math.max(0, Math.min(score, 0.99)) };
      })
      .filter((x) => x.score >= SUGGESTION_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS)
      .map(({ m, score }) => ({ mediaType: 'movie' as const, movieId: m.id, title: m.title, year: m.year, score: Math.round(score * 100) / 100 }));
  }

  /** Library files already covering what an in-folder suggestion points at. */
  private existingFilesFor(s: HygieneSuggestion, allMovies: MovieLite[], fileById: Map<number, { path: string }>): string[] {
    if (s.mediaType === 'movie') {
      const movie = allMovies.find((m) => m.id === s.movieId);
      const file = movie?.movieFileId ? fileById.get(movie.movieFileId) : undefined;
      return file ? [file.path] : [];
    }
    if (!s.episodeIds?.length) return [];
    const rows = this.db.select({ fileId: episodes.episodeFileId }).from(episodes).where(inArray(episodes.id, s.episodeIds)).all();
    // Only a duplicate when every episode the orphan covers already has a file.
    if (rows.length !== s.episodeIds.length || rows.some((r) => r.fileId === null)) return [];
    const paths = rows.map((r) => fileById.get(r.fileId!)?.path).filter((p): p is string => !!p);
    return [...new Set(paths)];
  }

  // -------------------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------------------

  list(query: HygieneListQuery = {}): HygieneListResponse {
    const rows = this.db.select().from(libraryHygieneFindings).orderBy(libraryHygieneFindings.path).all();
    const counts = { orphan: 0, duplicate: 0, empty: 0 };
    for (const r of rows) counts[r.type]++;
    const records = rows
      .filter((r) => (!query.type || r.type === query.type) && (!query.rootFolderPath || this.norm(r.rootFolderPath) === this.norm(query.rootFolderPath)))
      .map(toFinding);
    const lastScan = this.lastScanAt ?? rows.reduce<string | null>((max, r) => (max === null || r.foundAt > max ? r.foundAt : max), null);
    return { lastScan, counts, records };
  }

  get(id: number): HygieneFinding {
    return toFinding(this.row(id));
  }

  orphanCount(): number {
    return this.db.select({ n: count() }).from(libraryHygieneFindings).where(eq(libraryHygieneFindings.type, 'orphan')).get()?.n ?? 0;
  }

  private row(id: number): HygieneFindingRow {
    const row = this.db.select().from(libraryHygieneFindings).where(eq(libraryHygieneFindings.id, id)).get();
    if (!row) throw new HygieneError('NOT_FOUND', `finding ${id} not found`);
    return row;
  }

  private ensureInsideRoot(row: HygieneFindingRow): void {
    const root = this.db.select().from(rootFolders).all().find((r) => this.norm(r.path) === this.norm(row.rootFolderPath));
    if (!root || !isUnder(row.path, root.path) || this.norm(row.path) === this.norm(root.path)) {
      throw new HygieneError('VALIDATION', `${row.path} is not inside a root folder`);
    }
  }

  // -------------------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------------------

  /** Import an orphan into a series (episodes) or movie through the manual-import path. */
  async map(id: number, request: HygieneMapRequest): Promise<HygieneMapResult> {
    const row = this.row(id);
    if (row.type === 'empty') throw new HygieneError('VALIDATION', 'empty folders cannot be mapped');
    if (row.mediaFileId !== null) throw new HygieneError('VALIDATION', 'this file is already in the library');
    const best = row.suggestions[0];
    const mediaType: MediaType | undefined =
      request.mediaType ?? (request.seriesId !== undefined ? 'series' : request.movieId !== undefined ? 'movie' : best?.mediaType);
    if (!mediaType) throw new HygieneError('VALIDATION', 'no series or movie given and no suggestion to fall back on');

    let item: ManualImportRequest['items'][number];
    if (mediaType === 'series') {
      const fromBest = best?.mediaType === 'series' ? best : undefined;
      const seriesId = request.seriesId ?? fromBest?.seriesId;
      const episodeIds = request.episodeIds ?? (fromBest && fromBest.seriesId === seriesId ? fromBest.episodeIds : undefined);
      if (seriesId === undefined || !episodeIds?.length) throw new HygieneError('VALIDATION', 'series mapping needs seriesId and episodeIds');
      item = { path: row.path, mediaType, seriesId, episodeIds };
    } else {
      const movieId = request.movieId ?? (best?.mediaType === 'movie' ? best.movieId : undefined);
      if (movieId === undefined) throw new HygieneError('VALIDATION', 'movie mapping needs movieId');
      item = { path: row.path, mediaType, movieId };
    }
    const result = await this.opts.importer().executeManualImport({ items: [item], importMode: request.importMode });
    const imported = result.imported[0];
    if (!imported) throw new HygieneError('CONFLICT', result.failed[0]?.error ?? 'import failed');
    this.db.delete(libraryHygieneFindings).where(eq(libraryHygieneFindings.id, id)).run();
    return { mediaFileId: imported.mediaFileId, destination: imported.destination };
  }

  /** Delete a finding's file (through the recycle bin) or empty folder. */
  async delete(id: number): Promise<HygieneDeleteResult> {
    const row = this.row(id);
    this.ensureInsideRoot(row);
    const result: HygieneDeleteResult = { recycledTo: null, removedMediaFileId: null };
    if (row.type === 'empty') {
      if (!(await isFolderEmpty(row.path))) throw new HygieneError('CONFLICT', `${row.path} is no longer empty`);
      await rm(row.path, { recursive: true, force: true });
    } else {
      const info = await stat(row.path).catch(() => null);
      if (info && !info.isFile()) throw new HygieneError('VALIDATION', `${row.path} is not a file`);
      if (info) {
        const bin = new RecycleBin(getSection(this.db, 'mediaManagement').recycleBinPath, this.now);
        result.recycledTo = await bin.recycle(row.path, relative(row.rootFolderPath, dirname(row.path)));
      }
      if (row.mediaFileId !== null) {
        const lib = this.db.select().from(mediaFiles).where(eq(mediaFiles.id, row.mediaFileId)).get();
        if (lib && this.norm(lib.path) === this.norm(row.path)) {
          await libraryService.deleteMediaFile(this.db, lib.id, { deleteFromDisk: false });
          result.removedMediaFileId = lib.id;
          const parentId = lib.seriesId ?? lib.movieId;
          if (parentId != null) this.bus?.publish({ type: 'library', action: 'fileDeleted', mediaType: lib.mediaType, id: parentId });
        }
      }
    }
    this.db.delete(libraryHygieneFindings).where(eq(libraryHygieneFindings.id, id)).run();
    return result;
  }
}

function toFinding(row: HygieneFindingRow): HygieneFinding {
  return {
    id: row.id,
    type: row.type,
    path: row.path,
    rootFolderPath: row.rootFolderPath,
    sizeBytes: row.sizeBytes,
    mediaFileId: row.mediaFileId,
    seriesId: row.seriesId,
    movieId: row.movieId,
    duplicateReason: row.duplicateReason ?? null,
    duplicateOf: row.duplicateOf,
    parsed: row.parsed ?? null,
    suggestions: row.suggestions,
    foundAt: row.foundAt,
  };
}
