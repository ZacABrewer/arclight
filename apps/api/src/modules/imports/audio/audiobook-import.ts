import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import { buildBookFileName, buildBookFolder, type NamingAuthor, type NamingBook, type NamingFile } from '@arclight/organizer';
import { audiobookQualityFor, parseAudiobookPath, parseAudiobookRelease, type ParsedAudiobookInfo } from '@arclight/parser';
import {
  QUALITIES,
  type AudioFile,
  type AudioFileTags,
  type AudioImportSettings,
  type AudioManualImportQuery,
  type AudioManualImportRequest,
  type AudioManualImportResult,
  type AudiobookManualImportFileTags,
  type AudiobookManualImportItem,
  type AudiobookManualImportRequestItem,
  type ImportRejection,
  type ImportRejectionReason,
  type MediaManagementSettings,
  type NamingConfig,
  type QualityModel,
  type QualityProfile,
} from '@arclight/shared';
import type { Db } from '../../../db/index.js';
import { audioFiles, authors, books, bookSeries, bookSeriesEntries } from '../../../db/schema.js';
import type { EventBus } from '../../../events.js';
import type { AuthorRow, BookRow } from '../../audiobooks/schema.js';
import type { TrackedDownload } from '../../download-clients/index.js';
import { libraryService } from '../../library/index.js';
import { audioCodecOf } from '../../music/quality.js';
import type { ProfilesService } from '../../profiles/index.js';
import { getSection } from '../../settings/service.js';
import { absolutePathSpec, compareQ, freeSpaceSpec, notUnpackingSpec, sameFileSpec } from '../decisions.js';
import type { AudiobookImportedEvent, ImportsDeps } from '../deps.js';
import { ImportsError } from '../errors.js';
import { ImportFileError, RecycleBin, setPermissions, transferFile, type FsOps, type TransferMode, type TransferResult } from '../mover.js';
import { ScanError, isUnder } from '../scan.js';
import { importedDownloads } from '../schema.js';
import { bookFolderOf, naturalCompare, orderParts } from './book-layout.js';
import { discNumberFromFolder, isAudioExtension, scanAudioPath, type AudioExtraFile, type AudioScanFile, type AudioScanResult } from './scan-audio.js';
import { createCombinedTagReader, type AudioTags, type TagReader } from './tags.js';

// The audiobook importer (docs/design/music-audiobooks.md 9.3). A completed download (or a
// folder picked for manual import) is scanned and split into books: one book is one folder (disc
// and part sub-folders fold into it) or, inside one folder, one group of files sharing an ASIN or
// album tag. Each book is matched to the download's target books (the author's books otherwise)
// by ASIN/ISBN, title and series position; its files are ordered into parts (disc tag, track tag,
// natural file-name sort; a chapter-only m4b is a single part), checked against the import specs
// (the music ones plus `durationMismatch`: the total must be within `audio.audiobookDurationTolerance`
// percent of the book's runtime) and transferred into `<author>/<book folder>/` with `transferFile`
// (hard link, copy or move; replaced files go to the recycle bin). Files are never retagged.
// Optional Audiobookshelf sidecars (`desc.txt`, `reader.txt`, `cover.jpg`) sit behind
// `audio.writeAbsSidecars`. Every imported file gets an `audio_files` row (`media_type =
// 'audiobook'`, part number, chapter count) and the book is marked `has_file`.

/** What the importer needs from the imports service (the same shape the music importer takes). */
export interface AudiobookImporterOptions {
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

/** Per-file result, the same shape the video and music importers report. */
export interface AudiobookImportOutcome {
  path: string;
  status: 'imported' | 'rejected' | 'failed';
  rejections: ImportRejection[];
  warnings?: string[];
  error?: string;
  audioFileId?: number;
  destination?: string;
  replacedFileIds?: number[];
  bookId?: number;
  partNumber?: number;
}

export interface AudiobookImportRun {
  verified: boolean;
  outcomes: AudiobookImportOutcome[];
  /** Queue lines when the download needs attention (empty when verified). */
  messages: string[];
  /** Every rejection was temporary (still unpacking): retry later. */
  retryable: boolean;
  importedBookIds: number[];
  /** Book-level notes (narrator mismatch). */
  warnings: string[];
  isFile: boolean;
}

type AudioFileRow = typeof audioFiles.$inferSelect;

/** One book's worth of files found in a scan. */
export interface BookUnit {
  /** Stable within one scan. */
  key: string;
  /** The book folder (disc/part sub-folders fold into it), or the file's folder. */
  folder: string;
  /** In part order. */
  files: AudioScanFile[];
  extras: AudioExtraFile[];
  hint: UnitHint;
}

export interface UnitHint {
  titles: string[];
  asin: string | null;
  isbn: string | null;
  narrator: string | null;
  series: string | null;
  seriesPosition: string | null;
  author: string | null;
}

interface BookCandidate {
  book: BookRow;
  seriesTitle: string | null;
  seriesPosition: string | null;
}

interface PlannedPart {
  file: AudioScanFile;
  partNumber: number;
  quality: QualityModel;
  releaseGroup: string | null;
  /** Already inside the author folder: registered in place. */
  inPlace: boolean;
}

interface BookPlan {
  candidate: BookCandidate;
  unit: BookUnit;
  confidence: number;
  parts: PlannedPart[];
  /** The book's current files. */
  existing: AudioFileRow[];
  totalDurationMs: number | null;
  rejections: ImportRejection[];
  warnings: string[];
}

interface Rejected {
  file: AudioScanFile;
  rejections: ImportRejection[];
  bookId?: number;
  unitKey: string;
  partNumber?: number;
  partCount?: number;
}

interface ScanPlan {
  books: BookPlan[];
  rejected: Rejected[];
  /** Queue lines about whole units (unknown books). */
  unitMessages: string[];
}

interface ExecuteOptions {
  mode: 'move' | 'copy';
  downloadId: string | null;
  sourceTitle: string | null;
  manual: boolean;
}

export { bookFolderOf, naturalCompare, orderParts } from './book-layout.js';

const permanent = (reason: ImportRejectionReason, message: string): ImportRejection => ({ reason, message, type: 'permanent' });

/** A unit maps to a book when its best score reaches this (ASIN/ISBN 1, exact title 1, contained title 0.9). */
const MATCH_THRESHOLD = 0.6;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

const round = (n: number | null | undefined) => (n == null ? null : Math.round(n));

const clean = (s: string | null | undefined): string => (s ? libraryService.toCleanTitle(s) : '');

function mostCommon(values: ReadonlyArray<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v && v.trim()) counts.set(v.trim(), (counts.get(v.trim()) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

/** "3", "03", "Book 3" -> "3"; null when absent. */
function positionKey(p: string | number | null | undefined): string | null {
  if (p === null || p === undefined) return null;
  const m = /\d+(?:\.\d+)?/.exec(String(p));
  return m ? String(Number(m[0])) : String(p).trim().toLowerCase() || null;
}

/** Container preference when the same part comes in several formats: audiobook-native first. */
const FORMAT_RANK = ['m4b', 'm4a', 'mp3', 'opus', 'flac', 'aac', 'ogg', 'oga', 'wma', 'wav'];

const extOf = (f: Pick<AudioScanFile, 'path'>) => extname(f.path).slice(1).toLowerCase();

/**
 * One format per part. Archive listings carry each part in several formats (`01.mp3` next to
 * `01.ogg`); importing them all would double the book. When parts share a file stem across
 * formats, the whole unit keeps the one format with the best measured quality (container rank
 * breaks ties) and drops the others. Units with one format per stem are returned as they are.
 */
export function onePerPart<T extends Pick<AudioScanFile, 'path' | 'tags'>>(files: readonly T[]): T[] {
  const stems = new Map<string, Set<string>>();
  for (const f of files) {
    const stem = join(dirname(f.path), basename(f.path, extname(f.path))).toLowerCase();
    stems.set(stem, (stems.get(stem) ?? new Set()).add(extOf(f)));
  }
  if (![...stems.values()].some((exts) => exts.size > 1)) return [...files];
  const formats = [...new Set(files.map(extOf))];
  const score = (ext: string) => {
    const of = files.filter((f) => extOf(f) === ext);
    const weight = Math.min(...of.map((f) => audiobookQualityOf({ path: f.path, extension: ext, tags: f.tags }).quality.weight));
    const rank = FORMAT_RANK.indexOf(ext);
    return { count: of.length, weight, rank: rank < 0 ? FORMAT_RANK.length : rank };
  };
  const best = formats
    .map((ext) => ({ ext, ...score(ext) }))
    .sort((a, b) => b.count - a.count || b.weight - a.weight || a.rank - b.rank)[0]!.ext;
  return files.filter((f) => extOf(f) === best);
}

/**
 * Splits a scan into book units: files group by book folder, and inside one folder by ASIN or
 * album tag when the files carry more than one (a pack of single-file books in one folder).
 */
export function bookUnitsOf(scan: Pick<AudioScanResult, 'files' | 'extras'>): BookUnit[] {
  const byFolder = new Map<string, AudioScanFile[]>();
  for (const f of scan.files) {
    const folder = bookFolderOf(f.path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]);
  }
  const units: BookUnit[] = [];
  for (const [folder, files] of byFolder) {
    const identities = new Map<string, AudioScanFile[]>();
    const identityOf = (f: AudioScanFile) => f.tags?.asin?.trim().toUpperCase() || clean(f.tags?.album) || '';
    const distinct = new Set(files.map(identityOf).filter((k) => k !== ''));
    for (const f of files) {
      const id = distinct.size > 1 ? identityOf(f) : '';
      identities.set(id, [...(identities.get(id) ?? []), f]);
    }
    for (const [id, group] of identities) {
      const ordered = orderParts(onePerPart(group));
      const extras = scan.extras.filter((e) => bookFolderOf(e.path) === folder || dirname(e.path) === folder);
      units.push({ key: `${folder}|${id}`, folder, files: ordered, extras: identities.size > 1 ? extras.filter((e) => e.kind !== 'cover') : extras, hint: hintOf(ordered, folder) });
    }
  }
  return units.sort((a, b) => naturalCompare(a.key, b.key));
}

export function hintOf(files: readonly AudioScanFile[], folder: string): UnitHint {
  const tags = files.map((f) => f.tags).filter((t): t is AudioTags => t !== null);
  const parsed: ParsedAudiobookInfo | null = files[0] ? (safe(() => parseAudiobookPath(files[0]!.path).audiobook) ?? null) : null;
  const titles = [
    mostCommon(tags.map((t) => t.album)),
    files.length === 1 ? (tags[0]?.title ?? null) : null,
    parsed?.title ?? null,
    safe(() => parseAudiobookRelease(basename(folder)).audiobook?.title) ?? null,
    basename(folder),
  ].filter((t): t is string => !!t && t.trim() !== '');
  return {
    titles: [...new Set(titles)],
    asin: mostCommon(tags.map((t) => t.asin))?.toUpperCase() ?? parsed?.asin?.toUpperCase() ?? null,
    isbn: mostCommon(tags.map((t) => t.isbn)) ?? parsed?.isbn ?? null,
    narrator: mostCommon(tags.map((t) => t.narrator)) ?? (parsed?.narrators.length ? parsed.narrators.join(', ') : null),
    series: mostCommon(tags.map((t) => t.series)) ?? parsed?.series ?? null,
    seriesPosition: positionKey(mostCommon(tags.map((t) => t.seriesPart)) ?? parsed?.seriesPosition ?? null),
    author: mostCommon(tags.map((t) => t.albumArtist ?? t.artist)) ?? parsed?.authors[0] ?? null,
  };
}

export function titleSimilarity(a: string, b: string): number {
  const x = clean(a);
  const y = clean(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if ((x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y))) return 0.9;
  const words = (s: string) =>
    new Set(
      s
        .normalize('NFKD')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1),
    );
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return (common / Math.max(wa.size, wb.size)) * 0.85;
}

/** How well a unit fits a book (0-1): ASIN/ISBN, title, then series position. */
export function scoreUnit(hint: UnitHint, c: BookCandidate): number {
  const book = c.book;
  if (hint.asin && book.asin && hint.asin.toUpperCase() === book.asin.toUpperCase()) return 1;
  if (hint.isbn && book.isbn13 && hint.isbn.replace(/[\s-]/g, '') === book.isbn13.replace(/[\s-]/g, '')) return 1;
  const full = book.subtitle ? `${book.title} ${book.subtitle}` : book.title;
  let score = 0;
  for (const t of hint.titles) score = Math.max(score, titleSimilarity(t, book.title), titleSimilarity(t, full));
  const pos = positionKey(c.seriesPosition);
  if (pos && hint.seriesPosition === pos) {
    const sameSeries = !hint.series || !c.seriesTitle || titleSimilarity(hint.series, c.seriesTitle) >= 0.85;
    if (sameSeries) score = Math.max(score, hint.series ? 0.85 : 0.65);
  }
  return Math.min(1, score);
}

/** Quality of one audiobook file: measured codec and bitrate, then the path, then the release title. */
export function audiobookQualityOf(file: { path: string; extension: string; tags: AudioTags | null }, releaseTitle: string | null = null): QualityModel {
  const fromPath = safe(() => parseAudiobookPath(file.path).audio);
  const revision = fromPath?.revision ?? { version: 1, real: 0, isRepack: false };
  const model = (q: (typeof QUALITIES)[keyof typeof QUALITIES]): QualityModel => ({
    quality: { ...q, mediaTypes: [...q.mediaTypes] },
    revision: { version: revision.version, real: revision.real, isRepack: revision.isRepack },
  });
  if (file.tags) {
    const codec = audioCodecOf(file.tags.codec, file.tags.container);
    if (codec !== 'Unknown') {
      const q = audiobookQualityFor({ codec, bitrateKbps: file.tags.bitrateKbps !== null ? Math.round(file.tags.bitrateKbps) : null });
      if (q.id !== QUALITIES.Unknown.id) return model(q);
    }
  }
  if (fromPath && fromPath.quality.id !== QUALITIES.Unknown.id) return model(fromPath.quality);
  if (releaseTitle) {
    const fromTitle = safe(() => parseAudiobookRelease(releaseTitle).audio.quality);
    if (fromTitle && fromTitle.id !== QUALITIES.Unknown.id) return model(fromTitle);
  }
  return model(QUALITIES.Unknown);
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

function manualTags(t: AudioTags | null): AudiobookManualImportFileTags {
  return {
    title: t?.title ?? null,
    author: t?.albumArtist ?? t?.artist ?? null,
    album: t?.album ?? null,
    narrator: t?.narrator ?? null,
    series: t?.series ?? null,
    seriesPart: t?.seriesPart ?? null,
    asin: t?.asin ?? null,
    isbn: t?.isbn ?? null,
    trackNo: t?.trackNo ?? null,
    discNo: t?.discNo ?? null,
    durationMs: round(t?.durationMs),
    chapterCount: t?.chapters ? t.chapters.length : null,
    codec: t?.codec ?? null,
    bitrateKbps: round(t?.bitrateKbps),
  };
}

/** "11 h 20 min". */
function hm(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function totalDuration(files: ReadonlyArray<Pick<AudioScanFile, 'tags'>>): number | null {
  let total = 0;
  for (const f of files) {
    const d = f.tags?.durationMs;
    if (d === null || d === undefined || !Number.isFinite(d)) return null;
    total += d;
  }
  return Math.round(total);
}

/**
 * The durationMismatch spec: the files' total must lie within `tolerance` percent of the book's
 * runtime. Books without a runtime, or files whose duration is unknown, pass.
 */
export function durationMismatchSpec(totalMs: number | null, runtimeMinutes: number | null | undefined, tolerancePercent: number): ImportRejection | null {
  if (totalMs === null || !runtimeMinutes || runtimeMinutes <= 0) return null;
  const runtimeMs = runtimeMinutes * 60_000;
  const off = (Math.abs(totalMs - runtimeMs) / runtimeMs) * 100;
  if (off <= tolerancePercent + 1e-9) return null;
  return permanent(
    'durationMismatch',
    `Total duration ${hm(totalMs)} is ${Math.round(off)}% off the book's runtime of ${hm(runtimeMs)} (tolerance ${tolerancePercent}%)`,
  );
}

/** A warning when the tagged narrator is none of the catalogue's narrators. */
export function narratorWarning(tagged: string | null, narrators: readonly string[], title: string): string | null {
  if (!tagged || narrators.length === 0) return null;
  const wanted = narrators.map(clean).filter(Boolean);
  const got = tagged
    .split(/\s*(?:,|;|&|\band\b)\s*/i)
    .map(clean)
    .filter(Boolean);
  if (got.some((g) => wanted.some((w) => w === g || w.includes(g) || g.includes(w)))) return null;
  return `${title}: the files are narrated by ${tagged}, the catalogue lists ${narrators.join(', ')}`;
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

function stripHtml(text: string): string {
  return text
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Global fetch for the cover sidecar: 20 s timeout, 15 MB cap, images only. */
async function defaultFetchImage(url: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Arclight' } });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type && !type.startsWith('image/')) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length <= 15 * 1024 * 1024 ? bytes : null;
  } finally {
    clearTimeout(timer);
  }
}

export class AudiobookImporter {
  private reader: TagReader | null = null;

  constructor(private readonly o: AudiobookImporterOptions) {}

  private get db(): Db {
    return this.o.db;
  }

  private tagReader(): TagReader {
    const injected = this.o.deps().tagReader;
    if (injected) return injected;
    this.reader ??= createCombinedTagReader();
    return this.reader;
  }

  private audioSettings(): AudioImportSettings {
    return getSection(this.db, 'audio');
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

  /** Imports a completed audiobook download. The caller (ImportsService) handles queue state. */
  async importCompletedDownload(item: TrackedDownload, path: string): Promise<AudiobookImportRun> {
    const settings = this.o.mediaManagement();
    const run: AudiobookImportRun = { verified: false, outcomes: [], messages: [], retryable: false, importedBookIds: [], warnings: [], isFile: false };
    const target = this.targetOf(item);
    const author = target.authorId !== undefined ? this.tryAuthor(target.authorId) : this.findAuthorByTitle(item.title);
    if (!author) {
      run.messages = ['Author title mismatch; automatic import is not possible. Manual Import required.'];
      return run;
    }
    if (resolve(path) === resolve(author.path)) {
      run.messages = ['Import path is mapped to an author folder'];
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

    const candidates = this.candidates(author.id, target.bookIds.length > 0 ? target.bookIds : null);
    const plan = this.plan(scan, author, candidates, { releaseTitle: item.title, forceSingle: target.bookIds.length === 1 });
    await this.applySpecs(plan, author, { downloadId: item.downloadId, addedAt: item.added, settings });

    run.outcomes = plan.rejected.map((r) => ({ path: r.file.path, status: 'rejected' as const, rejections: r.rejections, ...(r.bookId !== undefined ? { bookId: r.bookId } : {}) }));
    const mode: 'move' | 'copy' = item.canMoveFiles ? 'move' : 'copy';
    for (const book of plan.books) {
      const outcomes = await this.executeBook(author, book, { mode, downloadId: item.downloadId, sourceTitle: item.title, manual: false });
      run.outcomes.push(...outcomes);
      if (outcomes.some((o) => o.status === 'imported')) {
        run.importedBookIds.push(book.candidate.book.id);
        run.warnings.push(...book.warnings);
      }
    }

    // Verification: every targeted book got its files (a pack without targets: at least one).
    const imported = new Set(run.importedBookIds);
    const previously = this.previouslyImportedBooks(item.downloadId);
    const expected = target.bookIds;
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
      lines.push('One or more books expected in this release were not imported or missing from the release');
      lines.push(...plan.unitMessages);
      const seen = new Set<string>();
      for (const o of [...run.outcomes].sort((a, b) => naturalCompare(a.path, b.path))) {
        if (o.status === 'imported') continue;
        const reasons = o.error ? [o.error] : o.rejections.map((r) => r.message);
        const line = `${basename(o.path)}: ${reasons.join(', ')}`;
        if (reasons.length > 0 && !seen.has(line)) lines.push(line);
        seen.add(line);
      }
    }
    run.messages = lines;
    const notImported = run.outcomes.filter((o) => o.status !== 'imported');
    run.retryable =
      (scan.files.length === 0 && scan.unpacking) ||
      (notImported.length > 0 && notImported.every((o) => o.rejections.length > 0 && o.rejections.every((r) => r.type === 'temporary')));
    return run;
  }

  /** Author and books of a tracked download (queue item first, then the grab snapshot). */
  private targetOf(item: TrackedDownload): { authorId?: number; bookIds: number[] } {
    const raw = item.grabbedRelease && typeof item.grabbedRelease === 'object' ? (item.grabbedRelease as Record<string, unknown>) : {};
    const authorId = item.authorId ?? (typeof raw['authorId'] === 'number' ? raw['authorId'] : undefined);
    const bookIds =
      item.bookIds && item.bookIds.length > 0
        ? item.bookIds
        : Array.isArray(raw['bookIds'])
          ? raw['bookIds'].filter((v): v is number => typeof v === 'number')
          : [];
    return { ...(authorId !== undefined ? { authorId } : {}), bookIds: [...new Set(bookIds)] };
  }

  private tryAuthor(id: number): AuthorRow | undefined {
    return this.db.select().from(authors).where(eq(authors.id, id)).get();
  }

  private findAuthorByName(name: string): AuthorRow | undefined {
    const c = clean(name);
    if (!c) return undefined;
    const rows = this.db.select().from(authors).where(eq(authors.cleanName, c)).all();
    if (rows.length === 1) return rows[0];
    // Stored clean names may be cleaned differently: compare with this module's cleaner.
    const all = this.db.select().from(authors).all().filter((a) => clean(a.name) === c);
    return all.length === 1 ? all[0] : undefined;
  }

  /** "Author - Title (2015) [m4b]" -> the library author with that name. */
  private findAuthorByTitle(title: string): AuthorRow | undefined {
    const parsed = safe(() => parseAudiobookRelease(title).audiobook);
    for (const name of parsed?.authors ?? []) {
      const found = this.findAuthorByName(name);
      if (found) return found;
    }
    return undefined;
  }

  private previouslyImportedBooks(downloadId: string): Set<number> {
    const rows = this.db.select({ bookIds: importedDownloads.bookIds }).from(importedDownloads).where(eq(importedDownloads.downloadId, downloadId)).all();
    return new Set(rows.flatMap((r) => r.bookIds ?? []));
  }

  private importedSinceGrab(downloadId: string, addedAt: string | undefined): boolean {
    const where = addedAt
      ? and(eq(importedDownloads.downloadId, downloadId), gte(importedDownloads.importedAt, addedAt))
      : eq(importedDownloads.downloadId, downloadId);
    return this.db.select({ id: importedDownloads.id }).from(importedDownloads).where(where).get() !== undefined;
  }

  /** The author's books (or only `bookIds`) with their primary series and position. */
  private candidates(authorId: number, bookIds: readonly number[] | null): BookCandidate[] {
    const rows = bookIds
      ? bookIds.length
        ? this.db.select().from(books).where(inArray(books.id, [...bookIds])).all()
        : []
      : this.db.select().from(books).where(eq(books.authorId, authorId)).all();
    return rows.map((book) => ({ book, ...this.seriesOf(book.id) }));
  }

  private seriesOf(bookId: number): { seriesTitle: string | null; seriesPosition: string | null } {
    const row = this.db
      .select({ name: bookSeries.name, position: bookSeriesEntries.position })
      .from(bookSeriesEntries)
      .innerJoin(bookSeries, eq(bookSeriesEntries.seriesId, bookSeries.id))
      .where(eq(bookSeriesEntries.bookId, bookId))
      .orderBy(desc(bookSeriesEntries.isPrimary), asc(bookSeriesEntries.positionSort))
      .get();
    return { seriesTitle: row?.name ?? null, seriesPosition: row?.position ?? null };
  }

  private existingFiles(bookId: number): AudioFileRow[] {
    return this.db
      .select()
      .from(audioFiles)
      .where(and(eq(audioFiles.bookId, bookId), eq(audioFiles.mediaType, 'audiobook')))
      .orderBy(asc(audioFiles.partNumber), asc(audioFiles.path))
      .all();
  }

  // -------------------------------------------------------------------------------------
  // Matching: units -> books
  // -------------------------------------------------------------------------------------

  /**
   * Scan -> per-book plans (no specs yet). Each unit goes to its best scoring book; a book
   * claimed by two units of the same folder takes both (untagged parts of one book), by units
   * of different folders only the better one. `forceSingle`: a download aimed at one book whose
   * files form one unit is that book whatever the names say (the duration spec still checks it).
   */
  private plan(scan: AudioScanResult, author: AuthorRow, candidates: readonly BookCandidate[], opts: { releaseTitle: string | null; forceSingle: boolean }): ScanPlan {
    const plan: ScanPlan = { books: [], rejected: [], unitMessages: [] };
    const units = bookUnitsOf(scan);
    const scored = units.map((unit) => {
      const ranked = candidates.map((c) => ({ c, score: scoreUnit(unit.hint, c) })).sort((a, b) => b.score - a.score || a.c.book.id - b.c.book.id);
      return { unit, best: ranked[0] };
    });
    if (opts.forceSingle && units.length === 1 && candidates.length === 1) {
      scored[0]!.best = { c: candidates[0]!, score: Math.max(MATCH_THRESHOLD, scored[0]!.best?.score ?? 0) };
    }

    const byBook = new Map<number, Array<{ unit: BookUnit; score: number; c: BookCandidate }>>();
    for (const s of scored) {
      if (!s.best || s.best.score < MATCH_THRESHOLD) {
        const name = basename(s.unit.folder);
        const best = s.best && s.best.score > 0 ? ` (best: ${s.best.c.book.title}, ${Math.round(s.best.score * 100)}%)` : '';
        const rejection = candidates.length === 0 ? permanent('unknownBook', `No book of ${author.name} to import into`) : permanent('unknownBook', `No book matched well enough${best}`);
        plan.unitMessages.push(`${name}: ${rejection.message}`);
        this.rejectUnit(plan, s.unit, rejection, s.best && s.best.score > 0 ? s.best.c.book.id : undefined);
        continue;
      }
      const list = byBook.get(s.best.c.book.id) ?? [];
      list.push({ unit: s.unit, score: s.best.score, c: s.best.c });
      byBook.set(s.best.c.book.id, list);
    }

    for (const [, claims] of byBook) {
      claims.sort((a, b) => b.score - a.score);
      const winner = claims[0]!;
      const sameFolder = claims.filter((x) => x.unit.folder === winner.unit.folder);
      for (const loser of claims.filter((x) => x.unit.folder !== winner.unit.folder)) {
        this.rejectUnit(plan, loser.unit, permanent('unknownBook', `${winner.c.book.title} is already provided by another folder of this download`), winner.c.book.id);
      }
      const unit: BookUnit =
        sameFolder.length === 1
          ? winner.unit
          : {
              key: winner.unit.key,
              folder: winner.unit.folder,
              files: orderParts(sameFolder.flatMap((x) => x.unit.files)),
              extras: [...new Map(sameFolder.flatMap((x) => x.unit.extras).map((e) => [e.path, e])).values()],
              hint: winner.unit.hint,
            };
      const parts: PlannedPart[] = unit.files.map((file, i) => ({
        file,
        partNumber: i + 1,
        quality: audiobookQualityOf(file, opts.releaseTitle),
        releaseGroup: safe(() => parseAudiobookPath(file.path).releaseGroup) ?? null,
        inPlace: isUnder(file.path, author.path),
      }));
      const warnings: string[] = [];
      const narrator = narratorWarning(unit.hint.narrator, winner.c.book.narrators, winner.c.book.title);
      if (narrator) warnings.push(narrator);
      plan.books.push({
        candidate: winner.c,
        unit,
        confidence: Math.min(1, winner.score),
        parts,
        existing: this.existingFiles(winner.c.book.id),
        totalDurationMs: totalDuration(unit.files),
        rejections: [],
        warnings,
      });
    }
    plan.books.sort((a, b) => naturalCompare(a.unit.key, b.unit.key));
    return plan;
  }

  private rejectUnit(plan: ScanPlan, unit: BookUnit, rejection: ImportRejection, bookId: number | undefined): void {
    unit.files.forEach((file, i) =>
      plan.rejected.push({ file, rejections: [rejection], unitKey: unit.key, partNumber: i + 1, partCount: unit.files.length, ...(bookId !== undefined ? { bookId } : {}) }),
    );
  }

  // -------------------------------------------------------------------------------------
  // Specs
  // -------------------------------------------------------------------------------------

  private profileOf(author: AuthorRow): QualityProfile | null {
    try {
      return this.o.profiles.getQualityProfile(author.qualityProfileId);
    } catch {
      return null;
    }
  }

  /** Best quality of a set of files (profile order, else weight). */
  private bestQuality(profile: QualityProfile | null, qualities: readonly QualityModel[]): QualityModel {
    return qualities.reduce((a, b) => (compareQ(profile, b, a) > 0 ? b : a));
  }

  /**
   * Import specs over whole books (a book imports all of its parts or none): absolutePath,
   * freeSpace, notUnpacking, sameFile, alreadyImported, upgrade (strictly better only, best part
   * against best existing file) and durationMismatch. Rejected books move to `plan.rejected`.
   */
  private async applySpecs(plan: ScanPlan, author: AuthorRow, opts: { downloadId: string | null; addedAt?: string | undefined; settings: MediaManagementSettings }): Promise<void> {
    const { settings } = opts;
    const tolerance = this.audioSettings().audiobookDurationTolerance;
    const profile = this.profileOf(author);
    const libraryPaths = new Set(this.db.select({ path: audioFiles.path }).from(audioFiles).all().map((r) => r.path));
    const alreadyImported = opts.downloadId ? this.importedSinceGrab(opts.downloadId, opts.addedAt) : false;
    const now = this.o.now();
    const freeSpaceBytes = settings.skipFreeSpaceCheck ? null : await this.o.freeSpace(author.rootFolderPath);

    for (const book of plan.books) {
      const r: ImportRejection[] = [];
      const push = (x: ImportRejection | null) => {
        if (x && !r.some((y) => y.reason === x.reason && y.message === x.message)) r.push(x);
      };
      const needed = book.parts.filter((p) => !p.inPlace).reduce((n, p) => n + p.file.sizeBytes, 0);
      push(freeSpaceSpec({ existingFile: needed === 0, sizeBytes: needed }, { settings, freeSpaceBytes }));
      for (const p of book.parts) {
        push(absolutePathSpec(p.file));
        push(notUnpackingSpec(p.file, { settings, platform: this.o.platform, now }));
        push(sameFileSpec(p.file, { libraryPaths }));
      }
      const replacing = book.existing.filter((e) => !book.parts.some((p) => resolve(p.file.path) === resolve(e.path)));
      if (alreadyImported && book.existing.length > 0) push(permanent('alreadyImported', 'Book file already imported'));
      if (replacing.length > 0 && !book.parts.every((p) => p.inPlace)) {
        const incoming = this.bestQuality(profile, book.parts.map((p) => p.quality));
        const current = this.bestQuality(profile, replacing.map((e) => e.quality));
        if (compareQ(profile, incoming, current) <= 0) {
          push(permanent('notQualityUpgrade', `Not an upgrade for existing book file. Existing quality: ${current.quality.name}`));
        }
      }
      push(durationMismatchSpec(book.totalDurationMs, book.candidate.book.runtimeMinutes, tolerance));
      book.rejections = r;
      if (r.length > 0) {
        book.parts.forEach((p) =>
          plan.rejected.push({ file: p.file, rejections: r, bookId: book.candidate.book.id, unitKey: book.unit.key, partNumber: p.partNumber, partCount: book.parts.length }),
        );
      }
    }
    plan.books = plan.books.filter((b) => b.rejections.length === 0);
  }

  // -------------------------------------------------------------------------------------
  // Transfer
  // -------------------------------------------------------------------------------------

  private namingAuthor(author: AuthorRow): NamingAuthor {
    return { name: author.name };
  }

  private namingBook(c: BookCandidate): NamingBook {
    return {
      title: c.book.title,
      subtitle: c.book.subtitle,
      seriesTitle: c.seriesTitle,
      seriesPosition: c.seriesPosition,
      narrators: c.book.narrators,
      releaseDate: c.book.releaseDate,
      year: c.book.year,
    };
  }

  /** `<author path>/<book folder>` (the series format when the book is in a series). */
  bookFolderFor(author: AuthorRow, c: BookCandidate, naming = this.o.naming()): string {
    return join(author.path, buildBookFolder(naming, this.namingAuthor(author), this.namingBook(c), { pathSeparator: sep }));
  }

  /**
   * Destination of one part. A single-file book keeps its name unless `renameAudiobooks`
   * (then `bookFileFormat`). Multi-part books are renamed with `bookPartFormat`
   * (`{Part:00} - {Book Title}`) when `renameAudiobooks` or `audio.renameAudiobookParts` is on;
   * otherwise they keep their paths below the source book folder.
   */
  partDestination(author: AuthorRow, c: BookCandidate, bookFolder: string, unitFolder: string, p: PlannedPart, partCount: number, naming = this.o.naming(), renameParts = this.audioSettings().renameAudiobookParts): string {
    const multi = partCount > 1;
    const rename = naming.renameAudiobooks || (multi && renameParts);
    if (!rename) {
      const rel = relative(unitFolder, p.file.path);
      return join(bookFolder, multi && !rel.startsWith('..') && !isAbsolute(rel) ? rel : basename(p.file.path));
    }
    const file: NamingFile = { path: p.file.path, relativePath: basename(p.file.path), quality: p.quality, releaseGroup: p.releaseGroup, sceneName: null };
    const name = buildBookFileName({ ...naming, renameAudiobooks: true }, this.namingAuthor(author), this.namingBook(c), file, {
      extension: p.file.extension,
      part: p.partNumber,
      partCount,
      pathSeparator: sep,
    });
    return join(bookFolder, name);
  }

  private transferMode(mode: 'move' | 'copy', settings: MediaManagementSettings): TransferMode {
    if (mode === 'move') return 'move';
    return settings.useHardlinks ? 'hardlinkOrCopy' : 'copy';
  }

  /**
   * Places a book's parts, writes rows, publishes one import event for the book. All or
   * nothing: when a part fails, the parts already placed are taken back and the book's
   * previous files are restored.
   */
  private async executeBook(author: AuthorRow, plan: BookPlan, opts: ExecuteOptions): Promise<AudiobookImportOutcome[]> {
    const settings = this.o.mediaManagement();
    const naming = this.o.naming();
    const audio = this.audioSettings();
    const book = plan.candidate.book;
    const failAll = (message: string): AudiobookImportOutcome[] =>
      plan.parts.map((p) => ({ path: p.file.path, status: 'failed' as const, rejections: [], error: message, bookId: book.id, partNumber: p.partNumber }));
    if (!(await isDirectory(author.rootFolderPath))) return failAll('Failed to import book, Root folder missing.');

    const bookFolder = this.bookFolderFor(author, plan.candidate, naming);
    const authorExisted = await isDirectory(author.path);
    const mode = this.transferMode(opts.mode, settings);
    const bin = new RecycleBin(settings.recycleBinPath, this.o.now);
    const partCount = plan.parts.length;
    const destinations = plan.parts.map((p) =>
      p.inPlace ? p.file.path : this.partDestination(author, plan.candidate, bookFolder, plan.unit.folder, p, partCount, naming, audio.renameAudiobookParts),
    );
    if (new Set(destinations.map((d) => resolve(d).toLowerCase())).size !== destinations.length) {
      return failAll('Failed to import book, two parts would get the same file name.');
    }
    const incoming = new Set(plan.parts.map((p) => resolve(p.file.path)));
    // The book's current files that this import replaces (files being registered in place stay).
    const replaced = plan.existing.filter((e) => !incoming.has(resolve(e.path)));
    const setAside = new Map<string, string>();
    const placed: Array<{ part: PlannedPart; destination: string; transfer: TransferResult | 'none' }> = [];

    const rollback = async () => {
      for (const done of placed.reverse()) {
        if (done.transfer === 'none') continue;
        try {
          if (done.transfer === 'move') {
            await mkdir(dirname(done.part.file.path), { recursive: true });
            await rename(done.destination, done.part.file.path);
          } else {
            await rm(done.destination, { force: true });
          }
        } catch (err) {
          this.o.log?.error({ err, path: done.destination }, 'could not take back a placed book part');
        }
      }
      for (const [original, aside] of setAside) {
        await rename(aside, original).catch((err: unknown) => this.o.log?.error({ err, path: original }, 'could not restore the file being replaced'));
      }
    };

    try {
      // Files of the old version sitting where a new part goes are set aside until the end.
      for (const e of replaced) {
        if (destinations.some((d) => resolve(d) === resolve(e.path)) && (await exists(e.path))) {
          const aside = `${e.path}.arclight-replacing`;
          await rename(e.path, aside);
          setAside.set(e.path, aside);
        }
      }
      for (const [i, part] of plan.parts.entries()) {
        const destination = destinations[i]!;
        if (part.inPlace) {
          placed.push({ part, destination, transfer: 'none' });
          continue;
        }
        const downloadId = opts.downloadId;
        const onProgress =
          downloadId && this.o.downloads.setImportProgress
            ? (copied: number, total: number) => this.o.downloads.setImportProgress?.(downloadId, { copiedBytes: copied, totalBytes: total })
            : undefined;
        try {
          const transfer = await transferFile(part.file.path, destination, mode, { ...(this.o.fsOps ? { ops: this.o.fsOps } : {}), ...(onProgress ? { onProgress } : {}) });
          placed.push({ part, destination, transfer });
        } finally {
          if (downloadId) this.o.downloads.setImportProgress?.(downloadId, null);
        }
        if (settings.setPermissions) await setPermissions(destination, settings.chmodFolder, false);
      }
    } catch (err) {
      const message = failureMessage(err);
      this.o.log?.warn({ err, bookId: book.id }, 'book import failed');
      await rollback();
      this.o.bus?.publish({ type: 'import', action: 'failed', title: `${author.name} – ${book.title}`, mediaType: 'audiobook', mediaId: author.id, message });
      return failAll(message);
    }

    // The old version goes to the recycle bin (set-aside files under their own names).
    for (const e of replaced) {
      const current = setAside.get(e.path) ?? e.path;
      if (!(await exists(current))) continue;
      try {
        await bin.recycle(current, relative(author.rootFolderPath, dirname(e.path)), basename(e.path));
      } catch (err) {
        this.o.log?.warn({ err, path: current }, 'could not recycle the replaced book file');
      }
    }

    await this.importExtras(plan, bookFolder, mode);
    if (audio.writeAbsSidecars) await this.writeSidecars(plan.candidate, bookFolder);
    if (settings.setPermissions) {
      if (!authorExisted) await setPermissions(author.path, settings.chmodFolder, true);
      await setPermissions(bookFolder, settings.chmodFolder, true);
    }

    const at = this.o.now().toISOString();
    const rows: AudioFileRow[] = [];
    for (const p of placed) rows.push(await this.rowValues(author, book, p.part, p.destination, partCount));
    const saved = this.db.transaction((tx) => {
      for (const e of replaced) tx.delete(audioFiles).where(eq(audioFiles.id, e.id)).run();
      const out: AudioFileRow[] = [];
      for (const values of rows) {
        const { id: _id, dateAdded: _added, ...rest } = values;
        const prior = tx.select().from(audioFiles).where(eq(audioFiles.path, values.path)).get();
        out.push(
          prior
            ? tx.update(audioFiles).set(rest).where(eq(audioFiles.id, prior.id)).returning().get()
            : tx.insert(audioFiles).values({ ...rest, dateAdded: at }).returning().get(),
        );
      }
      tx.update(books).set({ hasFile: true, path: bookFolder }).where(eq(books.id, book.id)).run();
      if (opts.downloadId) {
        for (const [i, row] of out.entries()) {
          tx.insert(importedDownloads)
            .values({
              downloadId: opts.downloadId,
              mediaType: 'audiobook',
              seriesId: null,
              movieId: null,
              episodeIds: [],
              mediaFileId: row.id,
              sourcePath: placed[i]!.part.file.path,
              destinationPath: row.path,
              importedAt: at,
              authorId: author.id,
              bookIds: [book.id],
            })
            .run();
        }
      }
      return out;
    });

    const files: AudioFile[] = saved.map((r) => ({ ...r }));
    const replacedFiles: AudioFile[] = replaced.map((r) => ({ ...r }));
    const profile = this.profileOf(author);
    const transfers = placed.map((p) => p.transfer).filter((t): t is TransferResult => t !== 'none');
    const event: AudiobookImportedEvent = {
      mediaType: 'audiobook',
      authorId: author.id,
      bookId: book.id,
      bookIds: [book.id],
      files,
      replacedFiles,
      quality: this.bestQuality(profile, files.map((f) => f.quality)),
      bookFolder,
      sourcePath: plan.unit.folder,
      downloadId: opts.downloadId,
      sourceTitle: opts.sourceTitle ?? basename(plan.unit.folder),
      isUpgrade: replacedFiles.length > 0,
      importMode: transfers.includes('hardlink') ? 'hardlink' : transfers.includes('copy') ? 'copy' : 'move',
      manual: opts.manual,
      durationMs: plan.totalDurationMs,
      warnings: plan.warnings,
    };
    this.o.bus?.publish({ type: 'import', action: 'imported', title: `${author.name} – ${book.title}`, mediaType: 'audiobook', mediaId: author.id });
    const deps = this.o.deps();
    await this.callHook(() => deps.history?.recordAudiobookImport?.(event));
    await this.callHook(() => deps.notifications?.onAudiobookImported?.(event));
    // Media servers (Audiobookshelf, Jellyfin/Emby book libraries, Plex) rescan the book folder; detached.
    void this.callHook(() => deps.mediaServers?.refreshPath({ path: bookFolder, mediaType: 'audiobook', updateType: event.isUpgrade ? 'Modified' : 'Created' }));

    return placed.map((p, i) => ({
      path: p.part.file.path,
      status: 'imported' as const,
      rejections: [],
      ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
      audioFileId: saved[i]!.id,
      destination: p.destination,
      replacedFileIds: i === 0 ? replaced.map((r) => r.id) : [],
      bookId: book.id,
      partNumber: p.part.partNumber,
    }));
  }

  private async rowValues(author: AuthorRow, book: BookRow, p: PlannedPart, destination: string, partCount: number): Promise<AudioFileRow> {
    const size = (await stat(destination)).size;
    const t = p.file.tags;
    return {
      id: 0,
      dateAdded: '',
      mediaType: 'audiobook',
      artistId: null,
      albumId: null,
      authorId: author.id,
      bookId: book.id,
      path: destination,
      relativePath: relative(author.path, destination),
      sizeBytes: size,
      mtime: new Date(p.file.mtimeMs).toISOString(),
      quality: p.quality,
      releaseGroup: p.releaseGroup,
      sceneName: null,
      codec: t?.codec ?? null,
      container: t?.container ?? null,
      bitrateKbps: round(t?.bitrateKbps),
      sampleRateHz: round(t?.sampleRateHz),
      bitDepth: round(t?.bitDepth),
      channels: t?.channels ?? null,
      durationMs: round(t?.durationMs),
      discNumber: t?.discNo ?? p.file.discFromFolder ?? null,
      trackNumber: t?.trackNo ?? null,
      partNumber: partCount > 1 ? p.partNumber : 1,
      chapterCount: t?.chapters ? t.chapters.length : null,
      tags: t ? fileTags(t) : null,
      mediaInfo: t ? { source: t.source, lossless: t.lossless } : null,
    };
  }

  /** Cover images and cue sheets of the book's folder, next to the parts. */
  private async importExtras(plan: BookPlan, bookFolder: string, mode: TransferMode): Promise<void> {
    for (const extra of plan.unit.extras) {
      if (extra.kind !== 'cover' && extra.kind !== 'cue') continue;
      const destination = join(bookFolder, basename(extra.path));
      if (resolve(destination) === resolve(extra.path) || (await exists(destination))) continue;
      try {
        await transferFile(extra.path, destination, mode, this.o.fsOps ? { ops: this.o.fsOps } : {});
      } catch (err) {
        this.o.log?.warn({ err, path: extra.path }, 'book extra not imported');
      }
    }
  }

  /**
   * Audiobookshelf sidecars: `desc.txt` (overview), `reader.txt` (narrators) and `cover.jpg`
   * (the book's catalogue cover, fetched only here, only with the setting on). Failures are
   * logged, never fatal.
   */
  private async writeSidecars(c: BookCandidate, bookFolder: string): Promise<void> {
    const book = c.book;
    try {
      await mkdir(bookFolder, { recursive: true });
      const overview = stripHtml(book.overview ?? '');
      if (overview) await writeFile(join(bookFolder, 'desc.txt'), `${overview}\n`, 'utf8');
      if (book.narrators.length > 0) await writeFile(join(bookFolder, 'reader.txt'), `${book.narrators.join(', ')}\n`, 'utf8');
    } catch (err) {
      this.o.log?.warn({ err, bookFolder }, 'could not write book sidecars');
    }
    const coverPath = join(bookFolder, 'cover.jpg');
    if (await exists(coverPath)) return;
    const image = book.images.find((i) => i.coverType === 'cover') ?? book.images[0];
    const url = [image?.remoteUrl, image?.url].find((u): u is string => !!u && /^https?:\/\//i.test(u));
    if (!url) return;
    try {
      const fetchImage = this.o.deps().fetchImage ?? defaultFetchImage;
      const bytes = await fetchImage(url);
      if (bytes && bytes.length > 0) await writeFile(coverPath, bytes);
    } catch (err) {
      this.o.log?.warn({ err, bookId: book.id }, 'could not fetch the book cover');
    }
  }

  // -------------------------------------------------------------------------------------
  // Manual import, audio mode (audiobooks)
  // -------------------------------------------------------------------------------------

  /** GET /manualimport/audio?mediaType=audiobook: scan and propose author, book and part order per file. */
  async listManualImport(query: AudioManualImportQuery): Promise<AudiobookManualImportItem[]> {
    const settings = this.o.mediaManagement();
    let folder = query.folder;
    let tracked: TrackedDownload | undefined;
    let author: AuthorRow | undefined;
    let bookIds: number[] | null = null;
    if (query.downloadId) {
      tracked = this.o.downloads.listTracked().find((t) => t.downloadId === query.downloadId);
      if (!tracked) throw new ImportsError('NOT_FOUND', `Download ${query.downloadId} is not tracked`);
      folder ??= tracked.outputPath;
      const target = this.targetOf(tracked);
      if (target.authorId !== undefined) author = this.tryAuthor(target.authorId);
      if (target.bookIds.length > 0) bookIds = target.bookIds;
    }
    if (query.authorId !== undefined) {
      author = this.tryAuthor(query.authorId);
      if (!author) throw new ImportsError('NOT_FOUND', `Author ${query.authorId} not found`);
      folder ??= author.path;
    }
    if (!folder) throw new ImportsError('VALIDATION', 'No folder to scan');

    let scan: AudioScanResult;
    try {
      scan = await scanAudioPath(folder, { tagReader: this.tagReader(), workingFolders: settings.downloadClientWorkingFolders });
    } catch (err) {
      if (err instanceof ScanError) throw new ImportsError('NOT_FOUND', err.message);
      throw err;
    }
    if (query.bookId !== undefined) {
      const book = this.db.select().from(books).where(eq(books.id, query.bookId)).get();
      if (!book) throw new ImportsError('NOT_FOUND', `Book ${query.bookId} not found`);
      author ??= this.tryAuthor(book.authorId);
      if (author && book.authorId !== author.id) throw new ImportsError('VALIDATION', `Book ${query.bookId} is not a book of author ${author.id}`);
      bookIds = [book.id];
    }
    if (!author) author = this.guessAuthor(scan, tracked?.title ?? basename(folder));
    const known = new Set(query.filterExistingFiles ? this.db.select({ path: audioFiles.path }).from(audioFiles).all().map((r) => resolve(r.path)) : []);
    const keep = (f: AudioScanFile) => !known.has(resolve(f.path));
    const releaseTitle = tracked?.title ?? null;
    const downloadId = tracked?.downloadId;

    if (!author) {
      return bookUnitsOf(scan).flatMap((u) =>
        u.files
          .map((f, i) => ({ f, i }))
          .filter(({ f }) => keep(f))
          .map(({ f, i }) =>
            this.manualItem(f, u, { partNumber: i + 1, partCount: u.files.length, confidence: 0, rejections: [permanent('unknownAuthor', 'Unknown Author')], releaseTitle, downloadId }),
          ),
      );
    }
    const a = author;
    const candidates = this.candidates(a.id, bookIds);
    const plan = this.plan(scan, a, candidates, { releaseTitle, forceSingle: bookIds?.length === 1 });
    await this.applySpecs(plan, a, { downloadId: downloadId ?? null, addedAt: tracked?.added, settings });

    const items: AudiobookManualImportItem[] = [];
    const proposals = new Map<string, BookPlan>();
    for (const b of plan.books) {
      proposals.set(b.unit.key, b);
      for (const p of b.parts) {
        if (!keep(p.file)) continue;
        items.push(this.manualItem(p.file, b.unit, { authorId: a.id, plan: b, partNumber: p.partNumber, partCount: b.parts.length, quality: p.quality, confidence: b.confidence, rejections: [], warnings: b.warnings, releaseTitle, downloadId }));
      }
    }
    const units = new Map(bookUnitsOf(scan).map((u) => [u.key, u]));
    const candidateById = new Map(candidates.map((c) => [c.book.id, c]));
    for (const r of plan.rejected) {
      if (!keep(r.file)) continue;
      const unit = units.get(r.unitKey) ?? { key: r.unitKey, folder: bookFolderOf(r.file.path), files: [r.file], extras: [], hint: hintOf([r.file], dirname(r.file.path)) };
      const c = r.bookId !== undefined ? candidateById.get(r.bookId) : undefined;
      items.push(
        this.manualItem(r.file, unit, {
          authorId: a.id,
          ...(c ? { candidate: c } : {}),
          partNumber: r.partNumber ?? 1,
          partCount: r.partCount ?? 1,
          confidence: c ? scoreUnit(unit.hint, c) : 0,
          rejections: r.rejections,
          releaseTitle,
          downloadId,
        }),
      );
    }
    return items.sort((x, y) => naturalCompare(x.groupKey, y.groupKey) || x.partNumber - y.partNumber || naturalCompare(x.path, y.path));
  }

  private guessAuthor(scan: AudioScanResult, title: string): AuthorRow | undefined {
    const names = new Map<string, number>();
    for (const f of scan.files) {
      for (const n of [f.tags?.albumArtist, f.tags?.artist]) if (n) names.set(n, (names.get(n) ?? 0) + 1);
    }
    for (const [name] of [...names.entries()].sort((a, b) => b[1] - a[1])) {
      const found = this.findAuthorByName(name);
      if (found) return found;
    }
    const fromPath = scan.files
      .flatMap((f) => safe(() => parseAudiobookPath(f.path).audiobook?.authors) ?? [])
      .map((n) => this.findAuthorByName(n))
      .find((x) => x !== undefined);
    if (fromPath) return fromPath;
    return this.findAuthorByTitle(title) ?? scan.files.map((f) => this.db.select().from(authors).all().find((x) => isUnder(f.path, x.path))).find((x) => x !== undefined);
  }

  private manualItem(
    f: AudioScanFile,
    unit: BookUnit,
    o: {
      authorId?: number;
      plan?: BookPlan;
      candidate?: BookCandidate;
      partNumber: number;
      partCount: number;
      quality?: QualityModel;
      confidence: number;
      rejections: ImportRejection[];
      warnings?: string[];
      releaseTitle: string | null;
      downloadId: string | undefined;
    },
  ): AudiobookManualImportItem {
    const c = o.plan?.candidate ?? o.candidate;
    const runtime = c?.book.runtimeMinutes;
    return {
      path: f.path,
      relativePath: f.relativePath,
      name: f.name,
      sizeBytes: f.sizeBytes,
      quality: o.quality ?? audiobookQualityOf(f, o.releaseTitle),
      mediaType: 'audiobook',
      groupKey: unit.key,
      groupFolder: unit.folder,
      ...(o.authorId !== undefined ? { authorId: o.authorId } : {}),
      ...(c ? { bookId: c.book.id, bookTitle: c.book.title } : {}),
      partNumber: o.partNumber,
      partCount: o.partCount,
      confidence: Math.min(1, Math.max(0, o.confidence)),
      groupDurationMs: totalDuration(unit.files),
      runtimeMs: runtime ? runtime * 60_000 : null,
      tags: manualTags(f.tags),
      rejections: o.rejections,
      warnings: o.warnings ?? [],
      ...(o.downloadId ? { downloadId: o.downloadId } : {}),
    };
  }

  /**
   * POST /manualimport/audio (audiobook items): imports the user's mapping. Files with the same
   * book and download import together as that book, ordered by `partNumber` (the proposed order
   * when omitted). Specs are bypassed, like video manual import.
   */
  async executeManualImport(request: { items: readonly AudiobookManualImportRequestItem[]; importMode: AudioManualImportRequest['importMode'] }): Promise<AudioManualImportResult> {
    const result: AudioManualImportResult = { imported: [], failed: [] };
    const trackedById = new Map(this.o.downloads.listTracked().map((t) => [t.downloadId, t]));
    const batches = new Map<string, { author: AuthorRow; candidate: BookCandidate; downloadId: string | null; files: Array<{ file: AudioScanFile; partNumber: number | undefined; quality: QualityModel | undefined }> }>();
    const claimed = new Map<string, number>();
    for (const req of request.items) {
      try {
        const info = await stat(req.path).catch(() => null);
        if (!info?.isFile()) throw new ImportsError('NOT_FOUND', `File not found: ${req.path}`);
        const author = this.tryAuthor(req.authorId);
        if (!author) throw new ImportsError('NOT_FOUND', `Author ${req.authorId} not found`);
        const book = this.db.select().from(books).where(eq(books.id, req.bookId)).get();
        if (!book || book.authorId !== author.id) throw new ImportsError('VALIDATION', `Book ${req.bookId} is not a book of author ${author.id}`);
        const key = `${book.id}|${req.downloadId ?? ''}`;
        const other = claimed.get(resolve(req.path));
        if (other !== undefined) throw new ImportsError('VALIDATION', `${basename(req.path)} is listed twice`);
        claimed.set(resolve(req.path), book.id);
        const tags = await this.tagReader().read(req.path).catch(() => null);
        // Relative to the book folder and with the disc folder's number, so `CD1/02.mp3` still
        // orders before `CD2/01.mp3` when the files carry no disc tags.
        const file: AudioScanFile = {
          path: req.path,
          relativePath: relative(bookFolderOf(req.path), req.path),
          name: basename(req.path),
          extension: extname(req.path).toLowerCase(),
          sizeBytes: info.size,
          mtimeMs: info.mtimeMs,
          tags,
          error: null,
          discFromFolder: discNumberFromFolder(basename(dirname(req.path))),
        };
        let batch = batches.get(key);
        if (!batch) {
          batch = { author, candidate: { book, ...this.seriesOf(book.id) }, downloadId: req.downloadId ?? null, files: [] };
          batches.set(key, batch);
        }
        batch.files.push({ file, partNumber: req.partNumber, quality: req.quality });
      } catch (err) {
        result.failed.push({ path: req.path, error: failureMessage(err) });
      }
    }

    const importedPerDownload = new Set<string>();
    for (const batch of batches.values()) {
      const numbers = batch.files.map((f) => f.partNumber);
      if (numbers.every((n) => n !== undefined) && new Set(numbers).size !== numbers.length) {
        for (const f of batch.files) result.failed.push({ path: f.file.path, error: `Two files of ${batch.candidate.book.title} have the same part number` });
        continue;
      }
      const proposed = orderParts(batch.files.map((f) => f.file));
      const rank = (f: { file: AudioScanFile; partNumber: number | undefined }) => f.partNumber ?? 10_000 + proposed.indexOf(f.file);
      const ordered = [...batch.files].sort((x, y) => rank(x) - rank(y));
      const tracked = batch.downloadId ? trackedById.get(batch.downloadId) : undefined;
      const mode: 'move' | 'copy' =
        request.importMode === 'move' ? 'move' : request.importMode === 'copy' ? 'copy' : tracked && !tracked.canMoveFiles ? 'copy' : 'move';
      const folders = [...new Set(ordered.map((f) => bookFolderOf(f.file.path)))];
      const unit: BookUnit = {
        key: `manual:${folders[0] ?? ''}`,
        folder: folders.length === 1 ? folders[0]! : dirname(ordered[0]!.file.path),
        files: ordered.map((f) => f.file),
        extras: folders.length === 1 ? await this.extrasNear(folders[0]!) : [],
        hint: hintOf(ordered.map((f) => f.file), folders[0] ?? ''),
      };
      const plan: BookPlan = {
        candidate: batch.candidate,
        unit,
        confidence: 1,
        parts: ordered.map((f, i) => ({
          file: f.file,
          partNumber: i + 1,
          quality: f.quality ?? audiobookQualityOf(f.file, tracked?.title ?? null),
          releaseGroup: safe(() => parseAudiobookPath(f.file.path).releaseGroup) ?? null,
          inPlace: isUnder(f.file.path, batch.author.path),
        })),
        existing: this.existingFiles(batch.candidate.book.id),
        totalDurationMs: totalDuration(ordered.map((f) => f.file)),
        rejections: [],
        warnings: [],
      };
      const narrator = narratorWarning(unit.hint.narrator, batch.candidate.book.narrators, batch.candidate.book.title);
      if (narrator) plan.warnings.push(narrator);
      const outcomes = await this.executeBook(batch.author, plan, { mode, downloadId: batch.downloadId, sourceTitle: tracked?.title ?? null, manual: true });
      for (const o of outcomes) {
        if (o.status === 'imported') {
          result.imported.push({ path: o.path, audioFileId: o.audioFileId!, bookId: o.bookId!, partNumber: o.partNumber!, destination: o.destination! });
          if (batch.downloadId) importedPerDownload.add(batch.downloadId);
        } else {
          result.failed.push({ path: o.path, error: o.error ?? o.rejections.map((r) => r.message).join(', ') });
        }
      }
    }

    // A tracked download reaches Imported once all of its books have files from it.
    for (const downloadId of importedPerDownload) {
      const tracked = trackedById.get(downloadId);
      if (!tracked) continue;
      const expected = this.targetOf(tracked).bookIds;
      const done = this.previouslyImportedBooks(downloadId);
      if (expected.length === 0 ? done.size > 0 : expected.every((id) => done.has(id))) await this.o.downloads.markImported(tracked.id);
    }
    return result;
  }

  /** Cover images and cue sheets in the folder of manually imported files. */
  private async extrasNear(folder: string): Promise<AudioExtraFile[]> {
    try {
      const scan = await scanAudioPath(folder, { tagReader: { read: async () => Promise.reject(new Error('not read')) } });
      return scan.extras.filter((e) => bookFolderOf(e.path) === folder || dirname(e.path) === folder);
    } catch {
      return [];
    }
  }
}

/** Failure lines like the video importer's (spec 9.6), for books. */
function failureMessage(err: unknown): string {
  if (err instanceof ImportFileError) {
    switch (err.code) {
      case 'ROOT_FOLDER_NOT_FOUND':
        return 'Failed to import book, Root folder missing.';
      case 'DESTINATION_EXISTS':
        return 'Failed to import book, Destination already exists.';
      case 'RECYCLE_BIN':
        return 'Failed to import book, unable to move existing file to the Recycle Bin.';
      default:
        return `Failed to import book: ${err.message}`;
    }
  }
  if (err instanceof ImportsError) return err.message;
  return `Failed to import book: ${errorMessage(err)}`;
}
