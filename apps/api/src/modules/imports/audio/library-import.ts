import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { chooseRelease, isMetadataError, type CatalogBook, type CatalogBookQuery, type MbReleaseGroup } from '@arclight/metadata';
import { parseAudiobookPath } from '@arclight/parser';
import type {
  LibraryImportCandidate,
  LibraryImportDetected,
  LibraryImportLookupQuery,
  LibraryImportMatch,
  LibraryImportMediaType,
  LibraryImportRequest,
  LibraryImportScan,
  LibraryImportScanRequest,
  LibraryImportScanSummary,
} from '@arclight/shared';
import type { AppContext } from '../../../app.js';
import type { Db } from '../../../db/index.js';
import { albums, audioFiles, rootFolders, tracks } from '../../../db/schema.js';
import type { Scheduler } from '../../../scheduler.js';
import * as ab from '../../audiobooks/service.js';
import { LibraryError, libraryService } from '../../library/index.js';
import { ffprobeRunnerFor } from '../../media-analysis/index.js';
import { albumCoverImages, audiobookMetadataFor, audiobookRefresherFor, musicMetadataFor, musicRefresherFor } from '../../metadata/index.js';
import * as music from '../../music/service.js';
import { getSection } from '../../settings/service.js';
import { getImportsService } from '../index.js';
import { ScanError } from '../scan.js';
import { durationMismatchSpec, onePerPart, titleSimilarity as bookTitleSimilarity, totalDuration } from './audiobook-import.js';
import { bookFolderOf, naturalCompare, orderParts } from './book-layout.js';
import { albumTitleFromFolder, matchArtistScan } from './rescan.js';
import { groupAudioFiles, scanAudioPath, type AudioGroup, type AudioScanFile, type AudioScanResult } from './scan-audio.js';
import { createCombinedTagReader, createFfprobeTagReader, type AudioTags, type TagReader } from './tags.js';
import { titleSimilarity } from './track-match.js';

// Library import (docs/API.md "libraryimport"): bring an existing music or audiobook collection
// into the library. A scan job walks a folder, leaves out files `audio_files` already knows,
// groups the rest into books (one folder, part sub-folders folded in; loose files in an author or
// scanned folder are books of their own) or albums (the music grouping of scan-audio.ts), reads
// what the tags and the path say, and proposes a catalogue book (ASIN / ISBN tag, else a title +
// author search) or a MusicBrainz release group (release-group / release id tag, else an artist
// + album search) with a confidence and alternatives. The import job adds what is missing (the
// artist or author with only the imported items monitored and no search), then links the files
// where they are, or moves them with the manual-import mover. Checks that guard downloads (the
// runtime check) are warnings here: an existing collection is what it is.
//
// Scans live in memory (the last few per app); they are cheap to redo.

/** Scans kept per app (finished ones beyond this are dropped, oldest first). */
const KEPT_SCANS = 6;
/** Proposals below this are offered as alternatives only. */
const PROPOSE_THRESHOLD = 0.35;
/** Track-match threshold for an album the user picked (the edition is chosen by file count first). */
const PICKED_ALBUM_THRESHOLD = 0.3;
const ALTERNATIVES = 5;

const ASIN = /^[0-9A-Z]{10}$/;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = (s: string | null | undefined): string => (s ? libraryService.toCleanTitle(s) : '');
const stemOf = (name: string): string => name.replace(/\.[^.]+$/, '');
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function mostCommon(values: ReadonlyArray<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v && v.trim()) counts.set(v.trim(), (counts.get(v.trim()) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

function validAsin(value: string | null | undefined): string | null {
  const v = value?.trim().toUpperCase();
  return v && ASIN.test(v) ? v : null;
}

function yearOf(date: string | null | undefined): number | null {
  const m = date ? /\b(1[89]\d{2}|20\d{2})\b/.exec(date) : null;
  return m ? Number(m[1]) : null;
}

/** "Author; Narrator", "Author / Narrator": the first credit. */
function firstCredit(value: string | null): string | null {
  const first = value?.split(/\s*(?:;|\/|\|)\s*/)[0]?.trim();
  return first || null;
}

// ---------------------------------------------------------------------------------------
// Grouping (pure)
// ---------------------------------------------------------------------------------------

export interface LibraryBookUnit {
  key: string;
  /** The book folder, or the folder loose single-file books sit in. */
  folder: string;
  /** A loose file (or loose files sharing a title) in an author / scanned folder. */
  loose: boolean;
  /** In part order. */
  files: AudioScanFile[];
}

const SINGLE_FILE_BOOK = new Set(['.m4b', '.m4a', '.mp4', '.aax', '.aaxc']);
/** "Title - Part 2", "Title CD1": an explicit part suffix. */
const PART_SUFFIX = /[\s._-]*(?:part|pt|cd|disc|disk|teil)[\s._-]*\d{1,3}$/i;
/** "Title - 05", "Title Chapter 3", "Title_track07": a sequence suffix. */
const SEQUENCE_SUFFIX = /(?:[\s._-]*(?:part|pt|cd|disc|disk|chapter|chap|ch|track|teil)?[\s._-]*\d{1,4})+$/i;

/** Which book a file of a mixed folder belongs to, from its tags. Empty when the tags do not say. */
function tagIdentity(f: AudioScanFile): string {
  const asin = validAsin(f.tags?.asin);
  if (asin) return `asin:${asin}`;
  const album = clean(f.tags?.album);
  return album ? `album:${album}` : '';
}

/**
 * Which book a file belongs to by its name: a single-file container (`.m4b`) is a book of its
 * own unless it carries an explicit part suffix; other files ("Title - 05.mp3") share the title
 * without their sequence number. Empty for bare numbers ("01.mp3").
 */
function nameIdentity(f: AudioScanFile): string {
  const stem = stemOf(f.name);
  const base = (SINGLE_FILE_BOOK.has(f.extension) ? stem.replace(PART_SUFFIX, '') : stem.replace(SEQUENCE_SUFFIX, '')).trim();
  if (/^[\d\s._-]*$/.test(base)) return '';
  const c = clean(base);
  return c ? `name:${c}` : '';
}

function splitBy(files: readonly AudioScanFile[], identity: (f: AudioScanFile) => string): Map<string, AudioScanFile[]> {
  const out = new Map<string, AudioScanFile[]>();
  for (const f of files) {
    const id = identity(f);
    out.set(id, [...(out.get(id) ?? []), f]);
  }
  return out;
}

/**
 * Groups audiobook files into books. One book is one folder (part sub-folders fold in). Inside
 * a folder that also holds other book folders (an author folder) or the scanned folder itself,
 * every loose file is a book of its own, unless tags (ASIN, album) or the file name tie several
 * together. A plain book folder splits only when its files carry different ASIN / album tags or
 * are several distinct single-file books.
 */
export function groupLibraryBooks(root: string, files: readonly AudioScanFile[]): LibraryBookUnit[] {
  const base = resolve(root);
  const byFolder = new Map<string, AudioScanFile[]>();
  for (const f of files) {
    let folder = bookFolderOf(f.path);
    if (!isInside(base, folder)) folder = dirname(f.path);
    if (!isInside(base, folder)) folder = base;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]);
  }
  const folders = [...byFolder.keys()];
  const isContainer = (folder: string) => resolve(folder) === base || folders.some((g) => g !== folder && isInside(folder, g));

  const units: LibraryBookUnit[] = [];
  for (const [folder, list] of byFolder) {
    let groups: Map<string, AudioScanFile[]>;
    let loose = false;
    if (isContainer(folder) && (folders.length > 1 || list.length === 1 || list.every((f) => SINGLE_FILE_BOOK.has(f.extension)) || new Set(list.map(tagIdentity)).size > 1)) {
      // Loose files: by tag, else by name; files neither tells about form one book.
      loose = true;
      groups = splitBy(list, (f) => tagIdentity(f) || nameIdentity(f));
    } else {
      const tagged = new Set(list.map(tagIdentity).filter((k) => k !== ''));
      if (tagged.size > 1) groups = splitBy(list, tagIdentity);
      else if (list.length > 1 && list.every((f) => SINGLE_FILE_BOOK.has(f.extension)) && tagged.size === 0) {
        const named = splitBy(list, nameIdentity);
        groups = named.size > 1 && !named.has('') ? named : new Map([['', list]]);
      } else groups = new Map([['', list]]);
    }
    for (const [id, group] of groups) {
      units.push({ key: `${folder}|${id}`, folder, loose, files: orderParts(onePerPart(group)) });
    }
  }
  return units.sort((a, b) => naturalCompare(a.key, b.key));
}

// ---------------------------------------------------------------------------------------
// What the files say (pure)
// ---------------------------------------------------------------------------------------

/** Search hints: every title / author spelling worth trying, best first. */
export interface DetectedHints {
  detected: LibraryImportDetected;
  titles: string[];
  authors: string[];
}

/** "Title (Unabridged)", "Book 3 - Title", "01 - Title", "Title [2019]": the title to search for. */
export function searchableTitle(title: string): string {
  return title
    .replace(/\s*[[({][^\])}]*[\])}]\s*/g, ' ')
    .replace(/^\s*(?:book|vol(?:ume)?|band|teil|part)\.?\s*\d+(?:\.\d+)?\s*[-:.]\s*/i, '')
    .replace(/^\s*\d{1,3}(?:\.\d+)?\s*[-:.]\s+/, '')
    .replace(/\b(?:unabridged|abridged|audiobook|audio book|ungekürzt)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s:,-]+$/, '')
    .trim();
}

function unique(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (!t || seen.has(clean(t))) continue;
    seen.add(clean(t));
    out.push(t);
  }
  return out;
}

const tagsOf = (files: readonly AudioScanFile[]): AudioTags[] => files.map((f) => f.tags).filter((t): t is AudioTags => t !== null);

/** Folders of `folder` relative to `base` (the scanned root's own name when they are the same). */
function segmentsOf(base: string, folder: string): string[] {
  const rel = relative(base, folder);
  return rel && !rel.startsWith('..') ? rel.split(sep) : [basename(base)];
}

/** What the tags and the path say about a book. `base` is the library root (or the scanned folder). */
export function detectBook(base: string, unit: LibraryBookUnit): DetectedHints {
  const tags = tagsOf(unit.files);
  const first = unit.files[0]!;
  // The parser reads the book folder; a loose `Author/Title.m4b` reads as `Author/Title/Title.m4b`
  // and a multi-file book by its folder alone (file names like "Title - 05" mislead it).
  const segments = segmentsOf(base, unit.folder);
  const synthetic = unit.loose ? [...segments, stemOf(first.name), first.name] : [...segments, `01${first.extension}`];
  let parsed: ReturnType<typeof parseAudiobookPath>['audiobook'] = null;
  try {
    parsed = parseAudiobookPath(synthetic.join('/')).audiobook;
  } catch {
    parsed = null;
  }
  const tagAuthor = firstCredit(mostCommon(tags.map((t) => t.albumArtist))) ?? firstCredit(mostCommon(tags.map((t) => t.artist)));
  const pathAuthor = parsed?.authors[0] ?? null;
  const album = mostCommon(tags.map((t) => t.album));
  const single = unit.files.length === 1 ? (tags[0]?.title ?? null) : null;
  const parsedTitle = parsed?.title ? (parsed.subtitle ? `${parsed.title}: ${parsed.subtitle}` : parsed.title) : null;
  const titles = unique([album, single, parsed?.title, parsedTitle].map((t) => (t ? searchableTitle(t) : null)));
  const authors = unique([tagAuthor, pathAuthor]);
  const composer = mostCommon(tags.map((t) => t.composer));
  const narrator =
    mostCommon(tags.map((t) => t.narrator)) ??
    (composer && !authors.some((a) => personFit(a, composer) >= 0.75) ? composer : null) ??
    (parsed?.narrators.length ? parsed.narrators.join(', ') : null);
  const asin = validAsin(mostCommon(tags.map((t) => validAsin(t.asin)))) ?? validAsin(parsed?.asin);
  const isbn = mostCommon(tags.map((t) => t.isbn?.replace(/[\s-]/g, '') ?? null)) ?? parsed?.isbn ?? null;
  return {
    titles,
    authors,
    detected: {
      author: authors[0] ?? null,
      title: titles[0] ?? null,
      series: mostCommon(tags.map((t) => t.series)) ?? parsed?.series ?? null,
      seriesPosition: mostCommon(tags.map((t) => t.seriesPart)) ?? parsed?.seriesPosition ?? null,
      narrator,
      year: yearOf(mostCommon(tags.map((t) => t.date))) ?? parsed?.year ?? null,
      asin,
      isbn: isbn && /^(?:\d{9}[\dX]|\d{13})$/i.test(isbn) ? isbn.toUpperCase() : null,
      mbReleaseGroupId: null,
      mbReleaseId: null,
      mbArtistId: null,
    },
  };
}

/** What the tags and the path say about an album (`Artist/Album (Year)`, `Artist - Album`). */
export function detectAlbum(base: string, group: AudioGroup): DetectedHints {
  const tags = tagsOf(group.files);
  const segments = segmentsOf(base, group.folder);
  const albumFolder = segments[segments.length - 1] ?? basename(group.folder);
  const artistFolder = segments.length >= 2 ? segments[segments.length - 2]! : null;
  let pathArtist = artistFolder;
  let pathTitle = albumTitleFromFolder(albumFolder);
  const dash = /^(.+?)\s+-\s+(.+)$/.exec(albumFolder);
  if (dash && !/^\d{4}$/.test(dash[1]!.trim()) && (!artistFolder || clean(dash[1]) === clean(artistFolder))) {
    pathArtist = dash[1]!.trim();
    pathTitle = albumTitleFromFolder(dash[2]!);
  }
  const folderYear = /[[(](\d{4})[\])]|^(\d{4})\s*-/.exec(albumFolder);
  const titles = unique([group.album, pathTitle]);
  const authors = unique([group.albumArtist, firstCredit(mostCommon(tags.map((t) => t.artist))), pathArtist]);
  return {
    titles,
    authors,
    detected: {
      author: authors[0] ?? null,
      title: titles[0] ?? null,
      series: null,
      seriesPosition: null,
      narrator: null,
      year: yearOf(mostCommon(tags.map((t) => t.date))) ?? (folderYear ? Number(folderYear[1] ?? folderYear[2]) : null),
      asin: null,
      isbn: null,
      mbReleaseGroupId: group.mbReleaseGroupId,
      mbReleaseId: group.mbReleaseId,
      mbArtistId: mostCommon(tags.map((t) => t.mbAlbumArtistId ?? t.mbArtistId)),
    },
  };
}

// ---------------------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------------------

function personTokens(name: string): string[] {
  const turned = /^([^,]+),\s*([^,]+)$/.exec(name.trim());
  const full = turned ? `${turned[2]} ${turned[1]}` : name;
  return full
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** 0-1: the same person? "Tolkien, J. R. R." and "J.R.R. Tolkien" are. */
export function personFit(a: string, b: string): number {
  const x = personTokens(a);
  const y = personTokens(b);
  if (x.length === 0 || y.length === 0) return 0;
  if (x.join('') === y.join('')) return 1;
  const common = x.filter((t) => y.includes(t)).length;
  const overlap = common / Math.max(x.length, y.length);
  if (x[x.length - 1] === y[y.length - 1]) return 0.75 + 0.25 * overlap;
  return overlap * 0.6;
}

function seriesPositionKey(p: string | null | undefined): string | null {
  const m = p ? /\d+(?:\.\d+)?/.exec(p) : null;
  return m ? String(Number(m[0])) : null;
}

/** 0-1: how well a catalogue book fits the hints (title 65%, author 25%, series / narrator / runtime 10%). */
export function scoreBook(h: DetectedHints, durationMs: number | null, cb: CatalogBook): number {
  const full = cb.subtitle ? `${cb.title} ${cb.subtitle}` : cb.title;
  let title = 0;
  for (const t of h.titles) title = Math.max(title, bookTitleSimilarity(t, cb.title), bookTitleSimilarity(t, full));
  const names = cb.authors.map((a) => ab.creditRole(a.name).name);
  const author = h.authors.length === 0 || names.length === 0 ? 0.5 : Math.max(...h.authors.flatMap((a) => names.map((n) => personFit(a, n))));
  let extra = 0;
  const pos = seriesPositionKey(h.detected.seriesPosition);
  if (pos && cb.series.some((s) => seriesPositionKey(s.position) === pos)) extra += 0.05;
  const narrator = h.detected.narrator;
  if (narrator && cb.narrators.some((n) => narrator.split(/\s*(?:,|;|&|\band\b)\s*/i).some((x) => personFit(x, n) >= 0.75))) extra += 0.05;
  let score = title * 0.65 + author * 0.25 + extra;
  if (durationMs !== null && cb.runtimeMinutes) {
    const off = Math.abs(durationMs - cb.runtimeMinutes * 60_000) / (cb.runtimeMinutes * 60_000);
    if (off <= 0.15) score += 0.05;
    else if (off > 0.5) score -= 0.1;
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * 0-1: how well a release group fits the hints (title 60%, artist 30%, year 10%), less a type
 * penalty when `fileCount` is known: a folder of many tracks is rarely a single, and a
 * compilation, live or remix album only fits when its title says so (a self-titled album and
 * its single share title, artist and year, so this tells them apart).
 */
export function scoreAlbum(h: DetectedHints, rg: MbReleaseGroup, fileCount?: number): number {
  let title = 0;
  for (const t of h.titles) title = Math.max(title, titleSimilarity(t, rg.title));
  const names = rg.artistCredits.flatMap((c) => [c.name, c.creditedName]);
  const artist = h.authors.length === 0 || names.length === 0 ? 0.5 : Math.max(...h.authors.flatMap((a) => names.map((n) => Math.max(personFit(a, n), titleSimilarity(a, n)))));
  const year = rg.year ?? yearOf(rg.firstReleaseDate);
  const yearFit = h.detected.year === null || year === null ? 0.5 : year === h.detected.year ? 1 : Math.abs(year - h.detected.year) === 1 ? 0.5 : 0;
  let typeFit = 0;
  if (fileCount !== undefined) {
    const type = rg.primaryType?.toLowerCase();
    if (type === 'single' && fileCount >= 5) typeFit -= 0.15;
    else if (type === 'album' && fileCount <= 2) typeFit -= 0.1;
    if (rg.secondaryTypes.length > 0 && fileCount >= 5) typeFit -= 0.05;
  }
  return Math.max(0, Math.min(1, title * 0.6 + artist * 0.3 + yearFit * 0.1 + typeFit));
}

// ---------------------------------------------------------------------------------------
// Lookups (the metadata services; replaceable in tests)
// ---------------------------------------------------------------------------------------

export interface LibraryImportLookups {
  books: {
    getBook(ref: { asin?: string; isbn?: string }): Promise<CatalogBook | null>;
    search(query: CatalogBookQuery): Promise<CatalogBook[]>;
  } | null;
  albums: {
    releaseGroup(mbid: string): Promise<MbReleaseGroup | null>;
    /** The release group of a release id. */
    releaseGroupOfRelease(mbid: string): Promise<MbReleaseGroup | null>;
    search(query: string | { artist?: string; title: string }): Promise<MbReleaseGroup[]>;
  } | null;
}

async function orNull<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (err) {
    if (isMetadataError(err, 'not-found')) return null;
    throw err;
  }
}

function defaultLookups(ctx: AppContext): LibraryImportLookups {
  const opts = { priority: 'background' as const };
  return {
    books: (() => {
      const m = audiobookMetadataFor(ctx);
      if (!m) return null;
      return {
        getBook: (ref) => orNull(() => m.getBook(ref, opts)),
        search: (query) => m.catalog().searchBooks(query, opts),
      };
    })(),
    albums: (() => {
      const m = musicMetadataFor(ctx);
      if (!m) return null;
      const mb = () => m.musicBrainz();
      return {
        releaseGroup: (mbid) => orNull(() => mb().getReleaseGroup(mbid, opts)),
        releaseGroupOfRelease: async (mbid) => {
          const release = await orNull(() => mb().getRelease(mbid, opts));
          return release?.releaseGroupMbid ? orNull(() => mb().getReleaseGroup(release.releaseGroupMbid!, opts)) : null;
        },
        search: async (query) => (await mb().searchReleaseGroups(query, { ...opts, limit: 10 })).results,
      };
    })(),
  };
}

// ---------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------

interface CandidateState extends LibraryImportCandidate {
  scanFiles: AudioScanFile[];
  group: AudioGroup | null;
  loose: boolean;
  /** Match details by foreign id (the proposal and the alternatives). */
  known: Map<string, LibraryImportMatch>;
}

interface ScanState extends Omit<LibraryImportScanSummary, 'stats'> {
  stats: LibraryImportScanSummary['stats'];
  candidates: CandidateState[];
}

class MusicDisabled extends Error {
  readonly code = 'MUSIC_DISABLED';
  constructor() {
    super('music is not enabled (Settings → Features)');
  }
}

class AudiobooksDisabled extends Error {
  readonly code = 'AUDIOBOOKS_DISABLED';
  constructor() {
    super('audiobooks are not enabled (Settings → Features)');
  }
}

export const LIBRARY_IMPORT_SCAN_JOB = 'LibraryImportScan';
export const LIBRARY_IMPORT_JOB = 'LibraryImport';

export interface LibraryImportDeps {
  ctx: AppContext;
  lookups?: () => LibraryImportLookups;
  tagReader?: () => TagReader;
}

export class LibraryImportService {
  private readonly scans = new Map<string, ScanState>();
  private readonly pending = new Set<Promise<unknown>>();
  private reader: TagReader | null = null;

  constructor(private readonly deps: LibraryImportDeps) {}

  private get db(): Db {
    return this.deps.ctx.db;
  }

  private get scheduler(): Scheduler {
    return this.deps.ctx.scheduler;
  }

  private get log(): Logger {
    return this.deps.ctx.log;
  }

  private lookups(): LibraryImportLookups {
    return this.deps.lookups?.() ?? defaultLookups(this.deps.ctx);
  }

  private tagReader(): TagReader {
    this.reader ??= this.deps.tagReader?.() ?? createCombinedTagReader({ ffprobe: createFfprobeTagReader({ runner: ffprobeRunnerFor(this.deps.ctx) }) });
    return this.reader;
  }

  /** Resolves once every job this service started has settled (tests). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private requireEnabled(mediaType: LibraryImportMediaType): void {
    if (mediaType === 'audiobook' ? !ab.audiobooksEnabled(this.db) : !music.musicEnabled(this.db)) {
      throw mediaType === 'audiobook' ? new AudiobooksDisabled() : new MusicDisabled();
    }
  }

  private requireScan(id: string): ScanState {
    const scan = this.scans.get(id);
    if (!scan) throw LibraryError.notFound('library import scan', id);
    this.requireEnabled(scan.mediaType);
    return scan;
  }

  private summary(s: ScanState): LibraryImportScanSummary {
    const { candidates: _c, ...rest } = s;
    return { ...rest, progress: { ...s.progress }, stats: { ...s.stats } };
  }

  private publicCandidate(c: CandidateState): LibraryImportCandidate {
    const { scanFiles: _f, group: _g, loose: _l, known: _k, ...rest } = c;
    return rest;
  }

  list(): LibraryImportScanSummary[] {
    return [...this.scans.values()].filter((s) => this.enabled(s.mediaType)).map((s) => this.summary(s)).reverse();
  }

  private enabled(mediaType: LibraryImportMediaType): boolean {
    return mediaType === 'audiobook' ? ab.audiobooksEnabled(this.db) : music.musicEnabled(this.db);
  }

  get(id: string): LibraryImportScan {
    const s = this.requireScan(id);
    return { ...this.summary(s), candidates: s.candidates.map((c) => this.publicCandidate(c)) };
  }

  remove(id: string): void {
    const s = this.requireScan(id);
    if (s.status === 'scanning' || s.status === 'matching' || s.status === 'importing') throw new LibraryError('CONFLICT', 'the scan is still running');
    this.scans.delete(id);
  }

  /** The registered root folder (of the media type) that holds `path`, or the requested one. */
  private rootFor(mediaType: LibraryImportMediaType, path: string, requested: string | undefined): string {
    const roots = this.db.select().from(rootFolders).where(eq(rootFolders.mediaType, mediaType)).all();
    if (requested !== undefined) {
      const hit = roots.find((r) => resolve(r.path) === resolve(requested));
      if (!hit) throw new LibraryError('VALIDATION', `${requested} is not a registered ${mediaType} root folder`);
      return hit.path;
    }
    const containing = roots.filter((r) => isInside(r.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!containing) throw new LibraryError('VALIDATION', `${path} is not inside a ${mediaType} root folder; pick the root folder new ${mediaType === 'audiobook' ? 'authors' : 'artists'} go under (rootFolderPath)`);
    return containing.path;
  }

  private prune(): void {
    const finished = [...this.scans.values()].filter((s) => s.status === 'ready' || s.status === 'failed');
    while (this.scans.size > KEPT_SCANS && finished.length > 0) this.scans.delete(finished.shift()!.id);
  }

  private track(done: Promise<unknown>): void {
    const p = done.finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  // ---- scan ----------------------------------------------------------------------------

  /** POST /libraryimport/scan: validates and starts the scan job. */
  async startScan(req: LibraryImportScanRequest): Promise<LibraryImportScan> {
    this.requireEnabled(req.mediaType);
    if (!isAbsolute(req.path)) throw new LibraryError('VALIDATION', 'path must be absolute');
    const info = await stat(req.path).catch(() => null);
    if (!info?.isDirectory()) throw new LibraryError('NOT_FOUND', `${req.path} does not exist or is not a folder the Arclight service can read`);
    const rootFolderPath = this.rootFor(req.mediaType, req.path, req.rootFolderPath);
    const busy = [...this.scans.values()].find((s) => s.mediaType === req.mediaType && resolve(s.path) === resolve(req.path) && (s.status === 'scanning' || s.status === 'matching'));
    if (busy) return this.get(busy.id);
    const scan: ScanState = {
      id: randomUUID(),
      mediaType: req.mediaType,
      path: req.path,
      rootFolderPath,
      status: 'scanning',
      progress: { done: 0, total: 0 },
      jobId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      stats: { files: 0, alreadyInLibrary: 0, unreadable: 0, candidates: 0, imported: 0, failed: 0 },
      candidates: [],
    };
    this.scans.set(scan.id, scan);
    this.prune();
    const started = this.scheduler.runTask(LIBRARY_IMPORT_SCAN_JOB, 'manual', async ({ signal, log }) => {
      try {
        await this.runScan(scan, signal);
        scan.status = 'ready';
        return `${scan.stats.candidates} ${scan.mediaType === 'audiobook' ? 'books' : 'albums'} to import, ${scan.stats.alreadyInLibrary} files already in the library`;
      } catch (err) {
        log.warn({ err, path: scan.path }, 'library import scan failed');
        scan.status = 'failed';
        scan.error = err instanceof ScanError ? err.message : errorText(err);
        throw err;
      } finally {
        scan.finishedAt = new Date().toISOString();
      }
    }, { key: `${LIBRARY_IMPORT_SCAN_JOB}:${scan.id}` });
    scan.jobId = started.job.id;
    this.track(started.done);
    return this.get(scan.id);
  }

  private async runScan(scan: ScanState, signal: AbortSignal): Promise<void> {
    const result = await scanAudioPath(scan.path, {
      tagReader: this.tagReader(),
      onProgress: (done, total) => {
        scan.progress = { done, total };
      },
    });
    if (signal.aborted) throw new Error('cancelled');
    const linked = new Set(this.db.select({ path: audioFiles.path }).from(audioFiles).all().map((r) => resolve(r.path)));
    const fresh = result.files.filter((f) => !linked.has(resolve(f.path)));
    scan.stats.files = result.files.length;
    scan.stats.alreadyInLibrary = result.files.length - fresh.length;
    scan.stats.unreadable = fresh.filter((f) => f.tags === null).length;
    const base = isInside(scan.rootFolderPath, scan.path) ? scan.rootFolderPath : scan.path;

    const units =
      scan.mediaType === 'audiobook'
        ? groupLibraryBooks(scan.path, fresh).map((u) => ({ key: u.key, folder: u.folder, files: u.files, loose: u.loose, group: null as AudioGroup | null }))
        : groupAudioFiles(fresh, result.extras).map((g) => ({ key: g.key, folder: g.folder, files: g.files, loose: false, group: g as AudioGroup | null }));
    scan.status = 'matching';
    scan.progress = { done: 0, total: units.length };
    const tolerance = getSection(this.db, 'audio').audiobookDurationTolerance;
    const lookups = this.lookups();
    for (const unit of units) {
      if (signal.aborted) throw new Error('cancelled');
      const hints = unit.group ? detectAlbum(base, unit.group) : detectBook(base, { key: unit.key, folder: unit.folder, loose: unit.loose, files: unit.files });
      const durationMs = totalDuration(unit.files);
      const candidate: CandidateState = {
        id: randomUUID(),
        mediaType: scan.mediaType,
        folder: unit.folder,
        relativeFolder: relative(scan.path, unit.folder) || '.',
        files: unit.files.map((f) => ({
          path: f.path,
          relativePath: relative(unit.folder, f.path),
          sizeBytes: f.sizeBytes,
          durationMs: f.tags?.durationMs != null ? Math.round(f.tags.durationMs) : null,
          readable: f.tags !== null,
        })),
        sizeBytes: unit.files.reduce((n, f) => n + f.sizeBytes, 0),
        durationMs,
        detected: hints.detected,
        match: null,
        alternatives: [],
        confidence: 0,
        matchedBy: 'none',
        warnings: [],
        status: 'pending',
        message: null,
        scanFiles: unit.files,
        group: unit.group,
        loose: unit.loose,
        known: new Map(),
      };
      const unreadable = unit.files.filter((f) => f.tags === null).length;
      if (unreadable > 0) candidate.warnings.push(`${unreadable} of ${unit.files.length} files could not be read; they are imported by their folder and name`);
      if (unit.group && unit.group.releaseIds.length > 1) candidate.warnings.push('The files carry more than one MusicBrainz release id (mixed editions)');
      try {
        if (scan.mediaType === 'audiobook') await this.matchBook(candidate, hints, lookups);
        else await this.matchAlbum(candidate, hints, lookups);
      } catch (err) {
        if (signal.aborted) throw err;
        this.log.debug({ err, folder: unit.folder }, 'library import lookup failed');
        candidate.warnings.push(`Lookup failed: ${errorText(err)}`);
      }
      if (scan.mediaType === 'audiobook' && candidate.match?.runtimeMinutes) {
        // The import's runtime check refuses downloads; an existing collection only gets a note.
        const off = durationMismatchSpec(durationMs, candidate.match.runtimeMinutes, tolerance);
        if (off) candidate.warnings.push(off.message);
      }
      scan.candidates.push(candidate);
      scan.stats.candidates = scan.candidates.length;
      scan.progress = { done: scan.progress.done + 1, total: units.length };
    }
    scan.candidates.sort((a, b) => naturalCompare(a.relativeFolder, b.relativeFolder));
  }

  private bookMatch(cb: CatalogBook, score: number): LibraryImportMatch | null {
    const asin = validAsin(cb.asin);
    const isbn = cb.isbn ?? cb.isbns[0];
    const foreignId = asin ?? (isbn ? `isbn:${isbn}` : null);
    if (!foreignId) return null;
    const credits = cb.authors.filter((a) => ab.creditRole(a.name).role === 'author');
    const primary = credits.find((a) => a.asin) ?? credits[0] ?? cb.authors[0];
    const series = cb.series[0];
    return {
      foreignId,
      title: cb.title,
      subtitle: cb.subtitle ?? null,
      creditName: primary ? ab.creditRole(primary.name).name : null,
      creditForeignId: primary?.asin?.toUpperCase() ?? null,
      year: yearOf(cb.releaseDate),
      coverUrl: cb.images.thumbnail ?? cb.images.cover ?? null,
      narrators: cb.narrators,
      runtimeMinutes: cb.runtimeMinutes != null ? Math.round(cb.runtimeMinutes) : null,
      series: series?.name ?? null,
      seriesPosition: series?.position ?? null,
      albumType: null,
      inLibrary: asin ? ab.booksByAsin(this.db, [asin]).size > 0 : false,
      score: Math.round(score * 100) / 100,
    };
  }

  private albumMatch(rg: MbReleaseGroup, score: number): LibraryImportMatch {
    const credit = rg.artistCredits[0];
    const mbid = rg.mbid.toLowerCase();
    return {
      foreignId: mbid,
      title: rg.title,
      subtitle: rg.disambiguation ?? null,
      creditName: rg.artistCredits.length > 0 ? rg.artistCredits.map((c) => `${c.creditedName}${c.joinPhrase}`).join('') : null,
      creditForeignId: credit?.artistMbid.toLowerCase() ?? null,
      year: rg.year ?? yearOf(rg.firstReleaseDate),
      coverUrl: albumCoverImages(mbid)[0]?.url ?? null,
      narrators: [],
      runtimeMinutes: null,
      series: null,
      seriesPosition: null,
      albumType: rg.primaryType ?? null,
      inLibrary: this.db.select({ id: albums.id }).from(albums).where(eq(albums.mbReleaseGroupId, mbid)).get() !== undefined,
      score: Math.round(score * 100) / 100,
    };
  }

  /** Proposes the best of `scored` (when good enough) and keeps the rest as alternatives. */
  private propose(c: CandidateState, scored: LibraryImportMatch[], matchedBy: LibraryImportCandidate['matchedBy']): void {
    const list = [...new Map(scored.map((m) => [m.foreignId, m])).values()].sort((a, b) => b.score - a.score);
    for (const m of list) c.known.set(m.foreignId, m);
    const best = list[0];
    if (best && (matchedBy !== 'search' || best.score >= PROPOSE_THRESHOLD)) {
      c.match = best;
      c.confidence = best.score;
      c.matchedBy = matchedBy;
      c.alternatives = list.slice(1, ALTERNATIVES + 1);
    } else {
      c.alternatives = list.slice(0, ALTERNATIVES);
    }
    if (c.match?.inLibrary) c.warnings.push(`${c.match.title} is already in the library; the files are added to it`);
  }

  private async matchBook(c: CandidateState, h: DetectedHints, lookups: LibraryImportLookups): Promise<void> {
    const books = lookups.books;
    if (!books) throw new Error('audiobook metadata is not available');
    const d = h.detected;
    if (d.asin) {
      const cb = await books.getBook({ asin: d.asin });
      const m = cb && this.bookMatch(cb, 1);
      if (m) return this.propose(c, [m], 'asin');
    }
    if (d.isbn) {
      const cb = await books.getBook({ isbn: d.isbn });
      const m = cb && this.bookMatch(cb, 1);
      if (m) return this.propose(c, [m], 'isbn');
    }
    const title = h.titles[0];
    if (!title) return;
    let found = await books.search({ title, ...(h.authors[0] ? { author: h.authors[0] } : {}) });
    if (found.length === 0 && h.titles[1]) found = await books.search({ title: h.titles[1], ...(h.authors[0] ? { author: h.authors[0] } : {}) });
    if (found.length === 0 && h.authors.length > 0) found = await books.search({ title });
    const scored = found.flatMap((cb) => this.bookMatch(cb, scoreBook(h, c.durationMs, cb)) ?? []);
    this.propose(c, scored, 'search');
  }

  private async matchAlbum(c: CandidateState, h: DetectedHints, lookups: LibraryImportLookups): Promise<void> {
    const albumsPort = lookups.albums;
    if (!albumsPort) throw new Error('music metadata is not available');
    const d = h.detected;
    if (d.mbReleaseGroupId && MBID.test(d.mbReleaseGroupId)) {
      const rg = await albumsPort.releaseGroup(d.mbReleaseGroupId);
      if (rg) return this.propose(c, [this.albumMatch(rg, 1)], 'mbid');
    }
    if (d.mbReleaseId && MBID.test(d.mbReleaseId)) {
      const rg = await albumsPort.releaseGroupOfRelease(d.mbReleaseId);
      if (rg) return this.propose(c, [this.albumMatch(rg, 1)], 'mbid');
    }
    const title = h.titles[0];
    if (!title) return;
    let found = await albumsPort.search({ title, ...(h.authors[0] ? { artist: h.authors[0] } : {}) });
    if (found.length === 0 && h.titles[1]) found = await albumsPort.search({ title: h.titles[1], ...(h.authors[0] ? { artist: h.authors[0] } : {}) });
    if (found.length === 0) found = await albumsPort.search(h.authors[0] ? `${h.authors[0]} ${title}` : title);
    this.propose(c, found.map((rg) => this.albumMatch(rg, scoreAlbum(h, rg, c.scanFiles.length))), 'search');
  }

  // ---- lookup --------------------------------------------------------------------------

  /** GET /libraryimport/lookup: search to change a match (scores are the search order). */
  async lookup(q: LibraryImportLookupQuery): Promise<LibraryImportMatch[]> {
    this.requireEnabled(q.mediaType);
    const lookups = this.lookups();
    const rank = (i: number, n: number) => (n <= 1 ? 1 : 1 - i / n);
    if (q.mediaType === 'audiobook') {
      if (!lookups.books) throw new LibraryError('VALIDATION', 'audiobook metadata is not available');
      const asin = validAsin(q.term.replace(/^(?:asin|audible):/i, ''));
      if (asin && /\d/.test(asin)) {
        const cb = await lookups.books.getBook({ asin });
        if (cb) return [this.bookMatch(cb, 1)].filter((m): m is LibraryImportMatch => m !== null);
      }
      const found = await lookups.books.search(q.term);
      return found.flatMap((cb, i) => this.bookMatch(cb, rank(i, found.length)) ?? []);
    }
    if (!lookups.albums) throw new LibraryError('VALIDATION', 'music metadata is not available');
    const term = q.term.replace(/^(?:mbid|musicbrainz):/i, '').trim();
    if (MBID.test(term)) {
      const rg = (await lookups.albums.releaseGroup(term)) ?? (await lookups.albums.releaseGroupOfRelease(term));
      return rg ? [this.albumMatch(rg, 1)] : [];
    }
    const found = await lookups.albums.search(term);
    return found.map((rg, i) => this.albumMatch(rg, rank(i, found.length)));
  }

  // ---- import --------------------------------------------------------------------------

  /** POST /libraryimport/import: validates and starts the import job. */
  startImport(req: LibraryImportRequest): LibraryImportScan {
    const scan = this.requireScan(req.scanId);
    if (scan.status !== 'ready') throw new LibraryError('CONFLICT', scan.status === 'importing' ? 'an import of this scan is running' : `the scan is ${scan.status}`);
    const byId = new Map(scan.candidates.map((c) => [c.id, c]));
    const work: Array<{ c: CandidateState; foreignId: string }> = [];
    for (const item of req.items) {
      const c = byId.get(item.candidateId);
      if (!c) throw LibraryError.notFound('candidate', item.candidateId);
      if (c.status === 'imported') continue;
      const foreignId = item.foreignId ?? c.match?.foreignId;
      if (!foreignId) throw new LibraryError('VALIDATION', `${c.relativeFolder}: choose a match first`);
      work.push({ c, foreignId });
    }
    scan.status = 'importing';
    scan.progress = { done: 0, total: work.length };
    for (const { c } of work) {
      c.status = 'importing';
      c.message = null;
    }
    const started = this.scheduler.runTask(LIBRARY_IMPORT_JOB, 'manual', async ({ signal, log }) => {
      let ok = 0;
      let failed = 0;
      try {
        for (const { c, foreignId } of work) {
          if (signal.aborted) {
            c.status = 'pending';
            continue;
          }
          try {
            c.message = scan.mediaType === 'audiobook' ? await this.importBook(scan, c, foreignId, req) : await this.importAlbum(scan, c, foreignId, req);
            c.status = 'imported';
            ok++;
          } catch (err) {
            log.warn({ err, folder: c.folder }, 'library import of a folder failed');
            c.status = 'failed';
            c.message = errorText(err);
            failed++;
          }
          scan.progress = { done: scan.progress.done + 1, total: work.length };
          scan.stats.imported = scan.candidates.filter((x) => x.status === 'imported').length;
          scan.stats.failed = scan.candidates.filter((x) => x.status === 'failed').length;
        }
      } finally {
        scan.status = 'ready';
        scan.jobId = null;
      }
      if (ok > 0) this.deps.ctx.bus.publish({ type: 'import', action: 'imported', title: `Library import: ${ok} ${scan.mediaType === 'audiobook' ? 'books' : 'albums'}`, mediaType: scan.mediaType });
      return `${ok} imported${failed ? `, ${failed} failed` : ''}`;
    }, { key: `${LIBRARY_IMPORT_JOB}:${scan.id}` });
    scan.jobId = started.job.id;
    this.track(started.done);
    return this.get(scan.id);
  }

  /** The candidate's match details for `foreignId` (proposal, alternative, or a lookup). */
  private async matchFor(scan: ScanState, c: CandidateState, foreignId: string): Promise<LibraryImportMatch | null> {
    const known = c.known.get(foreignId);
    if (known) return known;
    const found = await this.lookup({ mediaType: scan.mediaType, term: foreignId.replace(/^isbn:/, '') });
    return found.find((m) => m.foreignId.toLowerCase() === foreignId.toLowerCase()) ?? found[0] ?? null;
  }

  /**
   * The folder that is this author's / artist's own: the nearest ancestor of the item (below the
   * root) named like them. Null when there is none (a flat `Author - Title` layout); then the
   * generated `<root>/<Name>` path stays.
   */
  private ownFolder(scan: ScanState, c: CandidateState, name: string): string | null {
    const root = resolve(scan.rootFolderPath);
    let dir = c.loose ? resolve(c.folder) : dirname(resolve(c.folder));
    while (isInside(root, dir) && dir !== root) {
      if (personFit(basename(dir), name) >= 0.9 || clean(basename(dir)) === clean(name)) return dir;
      dir = dirname(dir);
    }
    return null;
  }

  private async importBook(scan: ScanState, c: CandidateState, foreignId: string, req: LibraryImportRequest): Promise<string> {
    const refresher = audiobookRefresherFor(this.deps.ctx);
    if (!refresher) throw new Error('audiobook metadata is not available');
    const isbn = foreignId.startsWith('isbn:') ? foreignId.slice(5) : null;
    const asin = isbn ? null : validAsin(foreignId);
    if (!isbn && !asin) throw new Error(`${foreignId} is not an ASIN`);
    let target = asin ? ab.booksByAsin(this.db, [asin]).get(asin) : undefined;
    if (!target) {
      const added = await refresher.addBook({
        ...(asin ? { asin } : { isbn: isbn! }),
        monitored: true,
        searchOnAdd: false,
        author: { rootFolderPath: scan.rootFolderPath, qualityProfileId: req.qualityProfileId, monitored: true, monitorNewBooks: 'none', tags: req.tags },
      });
      target = { id: added.book.id, authorId: added.author.id };
      if (added.started) {
        // A new author: their folder is where the files are, when the layout has one.
        const own = this.ownFolder(scan, c, added.author.name);
        if (own && own !== resolve(added.author.path)) {
          try {
            ab.updateAuthor(this.db, added.author.id, { path: own });
          } catch (err) {
            this.log.debug({ err, path: own }, 'author folder not taken over');
          }
        }
        // Let AuthorAdd load the bibliography (and rescan the folder) before the files are linked.
        await added.started.done;
      }
    }
    const book = ab.getBook(this.db, target.id);
    const files = orderParts(c.scanFiles);
    if (req.mode === 'move') {
      const result = await getImportsService(this.deps.ctx).executeAudioManualImport({
        items: files.map((f, i) => ({ path: f.path, mediaType: 'audiobook' as const, authorId: book.authorId, bookId: book.id, partNumber: i + 1 })),
        importMode: 'move',
      });
      if (result.failed.length > 0) throw new Error(result.failed.map((f) => `${basename(f.path)}: ${f.error}`).join('; '));
      return `Moved ${result.imported.length} files to ${book.title}`;
    }
    const folder = c.loose && files.length === 1 ? dirname(files[0]!.path) : c.folder;
    const linked = ab.linkBookFiles(this.db, book.id, folder, files);
    return `Linked ${linked.fileIds.length} ${linked.fileIds.length === 1 ? 'file' : 'files'} to ${book.title}`;
  }

  private async importAlbum(scan: ScanState, c: CandidateState, foreignId: string, req: LibraryImportRequest): Promise<string> {
    const refresher = musicRefresherFor(this.deps.ctx);
    const service = musicMetadataFor(this.deps.ctx);
    if (!refresher || !service) throw new Error('music metadata is not available');
    const rgId = foreignId.toLowerCase();
    if (!MBID.test(rgId)) throw new Error(`${foreignId} is not a MusicBrainz release-group id`);
    const mb = service.musicBrainz();
    const opts = { priority: 'background' as const };
    let album = this.db.select().from(albums).where(eq(albums.mbReleaseGroupId, rgId)).get();
    if (!album) {
      const match = await this.matchFor(scan, c, rgId);
      const artistMbid = match?.creditForeignId ?? (await mb.getReleaseGroup(rgId, opts)).artistCredits[0]?.artistMbid ?? null;
      if (!artistMbid) throw new Error('MusicBrainz lists no artist for this release group');
      let artist = music.findArtistByMbid(this.db, artistMbid);
      if (!artist) {
        const added = await refresher.addArtist({
          mbArtistId: artistMbid.toLowerCase(),
          rootFolderPath: scan.rootFolderPath,
          qualityProfileId: req.qualityProfileId,
          ...(req.albumTypeProfileId !== undefined ? { albumTypeProfileId: req.albumTypeProfileId } : {}),
          monitored: true,
          monitorOption: 'none',
          monitorNewAlbums: 'none',
          tags: req.tags,
          searchOnAdd: false,
        });
        const own = this.ownFolder(scan, c, added.artist.name);
        if (own && own !== resolve(added.artist.path)) {
          try {
            music.updateArtist(this.db, added.artist.id, { path: own });
          } catch (err) {
            this.log.debug({ err, path: own }, 'artist folder not taken over');
          }
        }
        // ArtistAdd loads the albums and editions (and rescans the folder) first. Adding with
        // `monitorOption: none` leaves the artist unmonitored; the imported album is wanted.
        await added.done;
        if (music.findArtistByMbid(this.db, artistMbid)) music.updateArtist(this.db, added.artist.id, { monitored: true });
        artist = music.findArtistByMbid(this.db, artistMbid);
        if (!artist) throw new Error('the artist was removed while importing');
      }
      album = this.db.select().from(albums).where(eq(albums.mbReleaseGroupId, rgId)).get();
      if (!album) {
        // Not listed by the artist's album-type profile (or owned by a collaborator row): add it alone.
        const group = await mb.getReleaseGroup(rgId, opts);
        const id = music.addReleaseGroupAlbum(this.db, artist.id, group, albumCoverImages, false);
        album = music.albumRow(this.db, id);
      }
    }
    const artist = music.artistRow(this.db, album.artistId);

    // The edition: the one the files are tagged with, else one with as many tracks as files.
    let rows = music.releaseRows(this.db, album.id);
    if (rows.length === 0) rows = music.saveReleases(this.db, album.id, await mb.browseReleases(rgId, opts));
    const files = c.scanFiles;
    const taggedId = mostCommon(files.map((f) => f.tags?.mbReleaseId));
    const sameCount = rows.filter((r) => r.trackCount === files.length);
    const current = rows.find((r) => r.id === album.selectedReleaseId);
    const target =
      rows.find((r) => taggedId && r.mbReleaseId.toLowerCase() === taggedId.toLowerCase()) ??
      (current && current.trackCount === files.length ? current : undefined) ??
      chooseRelease(
        (sameCount.length > 0 ? sameCount : rows).map((r) => ({
          mbid: r.mbReleaseId,
          ...(r.status ? { status: r.status } : {}),
          ...(r.country ? { country: r.country } : {}),
          ...(r.date ? { date: r.date } : {}),
          formats: r.formats,
          trackCount: r.trackCount,
          row: r,
        })),
        service.releasePreferences(),
      )?.row;
    if (!target) throw new Error(`MusicBrainz lists no edition of ${album.title}`);
    const hasTracks = this.db.select({ id: tracks.id }).from(tracks).where(eq(tracks.albumReleaseId, target.id)).limit(1).get() !== undefined;
    if (album.selectedReleaseId !== target.id || !hasTracks) {
      music.selectRelease(this.db, album.id, await mb.getRelease(target.mbReleaseId, opts), artist.name);
    }

    const known = music.knownAlbumsFor(this.db, artist.id).filter((a) => a.albumId === album.id);
    const group = c.group;
    const scan2: AudioScanResult = {
      root: c.folder,
      isFile: false,
      groups: group ? [{ ...group, files }] : [],
      files,
      extras: group?.extras ?? [],
      unreadable: files.filter((f) => f.tags === null),
      skipped: [],
      unpacking: false,
      tagReadMs: 0,
    };
    const result = matchArtistScan(scan2, known, { threshold: PICKED_ALBUM_THRESHOLD });
    if (result.assignments.length === 0) {
      throw new Error(`No file fits a track of ${album.title} (${target.trackCount} tracks in the chosen edition${files.every((f) => f.tags === null) ? '; the files could not be read' : ''})`);
    }
    const left = files.length - result.assignments.length;
    const tail = left > 0 ? ` (${left} ${left === 1 ? 'file fits' : 'files fit'} no track)` : '';
    if (req.mode === 'move') {
      const out = await getImportsService(this.deps.ctx).executeAudioManualImport({
        items: result.assignments.map((a) => ({ path: a.path, mediaType: 'music' as const, artistId: artist.id, albumId: album.id, trackIds: [a.trackRef as number] })),
        importMode: 'move',
      });
      if (out.failed.length > 0) throw new Error(out.failed.map((f) => `${basename(f.path)}: ${f.error}`).join('; '));
      // Monitored only once its files are in: a failed import must not leave a wanted album behind.
      music.updateAlbumFlags(this.db, album.id, { monitored: true });
      return `Moved ${out.imported.length} files to ${album.title}${tail}`;
    }
    const linked = music.linkTrackFiles(this.db, artist.id, result.assignments);
    music.updateAlbumFlags(this.db, album.id, { monitored: true });
    return `Linked ${linked.linked} ${linked.linked === 1 ? 'file' : 'files'} to ${album.title}${tail}`;
  }
}

// One service per app context (scans are kept in memory).
const services = new WeakMap<AppContext, LibraryImportService>();
const lookupOverrides = new WeakMap<AppContext, LibraryImportLookups>();

export function libraryImportFor(ctx: AppContext): LibraryImportService {
  let s = services.get(ctx);
  if (!s) {
    s = new LibraryImportService({ ctx, lookups: () => lookupOverrides.get(ctx) ?? defaultLookups(ctx) });
    services.set(ctx, s);
  }
  return s;
}

/** Test seam: scripted catalogue / MusicBrainz answers for matching and lookups. */
export function setLibraryImportLookups(ctx: AppContext, lookups: LibraryImportLookups | undefined): void {
  if (lookups) lookupOverrides.set(ctx, lookups);
  else lookupOverrides.delete(ctx);
}

