import { basename, dirname, relative, sep } from 'node:path';
import { parseAudiobookPath } from '@arclight/parser';
import { scanAudioPath, type AudioScanFile, type TagReader } from '../imports/audio/index.js';
import { libraryService } from '../library/index.js';

// RescanAuthor (design 4.4, 9): read an author folder into book file groups and match each
// group to one of the author's books. One book is one folder (parts in `CD 1` / `Part 2`
// subfolders fold into it) or, directly in the author folder, one file. Matching, in order:
// the ASIN tag (or an `[ASIN ...]` in the path), the series and position, then the title (with
// or without the subtitle). Filesystem and tag reads only; the service writes the result.

/** The author's book as the matcher sees it. */
export interface KnownBook {
  id: number;
  title: string;
  subtitle: string | null;
  asin: string | null;
  language: string | null;
  monitored: boolean;
  series: Array<{ name: string; position: string | null; positionSort: number | null }>;
}

export interface BookFileGroup {
  /** The book folder (or the file itself for a loose file in the author folder). */
  folder: string;
  /** Natural order: disc tag, track tag, then file name. */
  files: AudioScanFile[];
  asin: string | null;
  title: string | null;
  series: string | null;
  seriesPosition: string | null;
  /** Album / title tags of the files, tried as titles too. */
  tagTitles: string[];
}

export interface BookAssignment {
  bookId: number;
  /** Where the book lives: its folder, or the folder of a loose file. */
  folder: string;
  files: AudioScanFile[];
  matchedBy: 'asin' | 'series' | 'title';
}

export interface AuthorRescanResult {
  assignments: BookAssignment[];
  unmatched: BookFileGroup[];
  unreadable: number;
}

const PART_FOLDER = /^(?:cd|disc|disk|part|teil|side)[-_. ]?\d{1,3}(?:\s*[-:]\s*.*)?$/i;
const ASIN = /^[0-9A-Z]{10}$/;

const clean = (s: string | null | undefined): string => (s ? libraryService.toCleanTitle(s) : '');

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function orderFiles(files: AudioScanFile[]): AudioScanFile[] {
  return [...files].sort(
    (a, b) =>
      (a.tags?.discNo ?? a.discFromFolder ?? 0) - (b.tags?.discNo ?? b.discFromFolder ?? 0) ||
      (a.tags?.trackNo ?? 0) - (b.tags?.trackNo ?? 0) ||
      naturalCompare(a.relativePath, b.relativePath),
  );
}

function normalizeAsin(value: string | null | undefined): string | null {
  const v = value?.trim().toUpperCase();
  return v && ASIN.test(v) ? v : null;
}

/** Groups the scanned files into book candidates. */
export function groupBookFiles(authorFolder: string, files: readonly AudioScanFile[]): BookFileGroup[] {
  const byFolder = new Map<string, AudioScanFile[]>();
  for (const f of files) {
    let dir = dirname(f.path);
    while (dir !== authorFolder && dir.length > authorFolder.length && PART_FOLDER.test(basename(dir).trim())) dir = dirname(dir);
    // A file directly in the author folder is a book of its own.
    const key = dir === authorFolder || dir.length <= authorFolder.length ? f.path : dir;
    byFolder.set(key, [...(byFolder.get(key) ?? []), f]);
  }
  const authorName = basename(authorFolder);
  const groups: BookFileGroup[] = [];
  for (const [folder, list] of byFolder) {
    const ordered = orderFiles(list);
    const first = ordered[0]!;
    // The parser reads `Author/Series/Book 3 - Title/file` shapes: give it the author folder too.
    const parsed = parseAudiobookPath([authorName, ...relative(authorFolder, first.path).split(sep)].join('/')).audiobook;
    const tagged = ordered.find((f) => normalizeAsin(f.tags?.asin));
    const tagTitles = [...new Set(ordered.flatMap((f) => [f.tags?.album ?? null, ordered.length === 1 ? (f.tags?.title ?? null) : null]).filter((t): t is string => !!t))];
    const seriesTag = ordered.find((f) => f.tags?.series)?.tags;
    groups.push({
      folder,
      files: ordered,
      asin: normalizeAsin(tagged?.tags?.asin) ?? normalizeAsin(parsed?.asin),
      title: parsed?.title ?? null,
      series: parsed?.series ?? seriesTag?.series ?? null,
      seriesPosition: parsed?.seriesPosition ?? seriesTag?.seriesPart ?? null,
      tagTitles,
    });
  }
  return groups.sort((a, b) => naturalCompare(a.folder, b.folder));
}

function samePosition(a: string | null, b: { position: string | null; positionSort: number | null }): boolean {
  if (a === null) return false;
  if (b.position !== null && clean(a) === clean(b.position)) return true;
  const n = Number(a.replace(/^0+(?=\d)/, ''));
  return Number.isFinite(n) && b.positionSort !== null && n === b.positionSort;
}

/**
 * The book a group belongs to, or null. Among several books with the same title (the same book
 * in two languages has two ASINs), books in `preferredLanguages` win, then books without a file
 * matched yet, then monitored ones, then the oldest row.
 */
export function matchBookGroup(
  group: BookFileGroup,
  books: readonly KnownBook[],
  opts: { preferredLanguages?: readonly string[]; taken?: ReadonlySet<number> } = {},
): { bookId: number; matchedBy: BookAssignment['matchedBy'] } | null {
  if (group.asin) {
    const hit = books.find((b) => b.asin === group.asin);
    if (hit) return { bookId: hit.id, matchedBy: 'asin' };
  }
  const prefs = new Set((opts.preferredLanguages ?? []).map((l) => l.toLowerCase()));
  const pick = (list: readonly KnownBook[]): KnownBook | undefined =>
    [...list].sort(
      (a, b) =>
        Number(prefs.has((b.language ?? '').toLowerCase())) - Number(prefs.has((a.language ?? '').toLowerCase())) ||
        Number(!opts.taken?.has(b.id)) - Number(!opts.taken?.has(a.id)) ||
        Number(b.monitored) - Number(a.monitored) ||
        a.id - b.id,
    )[0];

  if (group.series && group.seriesPosition) {
    const name = clean(group.series);
    const inSeries = books.filter((b) => b.series.some((s) => clean(s.name) === name && samePosition(group.seriesPosition, s)));
    const hit = pick(inSeries);
    if (hit) return { bookId: hit.id, matchedBy: 'series' };
  }

  const titles = new Set([group.title, ...group.tagTitles].map(clean).filter((t) => t.length > 0));
  if (titles.size === 0) return null;
  const byTitle = books.filter(
    (b) => titles.has(clean(b.title)) || (b.subtitle !== null && (titles.has(clean(`${b.title} ${b.subtitle}`)) || titles.has(clean(`${b.title}: ${b.subtitle}`)))),
  );
  const hit = pick(byTitle);
  return hit ? { bookId: hit.id, matchedBy: 'title' } : null;
}

export interface ScanAuthorInput {
  authorFolder: string;
  books: readonly KnownBook[];
  tagReader?: TagReader;
  preferredLanguages?: readonly string[];
}

/** Scans the author folder and matches its book groups. Groups matching one book are merged. */
export async function scanAuthorFolder(input: ScanAuthorInput): Promise<AuthorRescanResult> {
  const scan = await scanAudioPath(input.authorFolder, input.tagReader ? { tagReader: input.tagReader } : {});
  const groups = groupBookFiles(scan.root, scan.files);
  const byBook = new Map<number, BookAssignment>();
  const unmatched: BookFileGroup[] = [];
  for (const g of groups) {
    const m = matchBookGroup(g, input.books, { taken: new Set(byBook.keys()), ...(input.preferredLanguages ? { preferredLanguages: input.preferredLanguages } : {}) });
    if (!m) {
      unmatched.push(g);
      continue;
    }
    const folder = g.files.length === 1 && g.folder === g.files[0]!.path ? dirname(g.folder) : g.folder;
    const prior = byBook.get(m.bookId);
    if (prior) prior.files = orderFiles([...prior.files, ...g.files]);
    else byBook.set(m.bookId, { bookId: m.bookId, folder, files: g.files, matchedBy: m.matchedBy });
  }
  return { assignments: [...byBook.values()], unmatched, unreadable: scan.unreadable.length };
}
