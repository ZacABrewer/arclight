import { basename, dirname } from 'node:path';
import type { AudioScanFile } from './scan-audio.js';

// How audiobook files sit on disk, shared by the importer, the author rescan and the library
// import: one book is one folder, and `CD 1` / `Disc 02 (Bonus)` / `Part 3` / `Pt.4` sub-folders
// fold into it. Parts are ordered by disc tag (else the disc or part folder's number), then
// track tag, then natural file-name order, so `Part 1/02.mp3` never lands after `Part 2/01.mp3`.

/** `CD1`, `Disc 02`, `Disc 1 (Bonus)`, `Part 3 - Title`, `Pt.4`: sub-folders that fold into the book folder. */
export const BOOK_PART_FOLDER = /^(?:cd|disc|disk|part|pt\.?|teil|side)\s*[-_.]?\s*(\d{1,3})\b/i;

/** Natural order: "Part 2" before "Part 10". */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** True for a `CD 1` / `Part 2` style folder name. */
export function isBookPartFolder(name: string): boolean {
  return BOOK_PART_FOLDER.test(name.trim());
}

/** The book folder of a file: its folder, or the folder above `CD2` / `Part 3` style sub-folders. */
export function bookFolderOf(filePath: string): string {
  let dir = dirname(filePath);
  while (isBookPartFolder(basename(dir)) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/** The number of the part folder a file sits in (`Part 3/01.mp3` → 3), or null. */
export function partFolderNumber(filePath: string): number | null {
  const m = BOOK_PART_FOLDER.exec(basename(dirname(filePath)).trim());
  return m ? Number(m[1]) : null;
}

type Orderable = Pick<AudioScanFile, 'path' | 'relativePath' | 'tags' | 'discFromFolder'>;

/** Without the extension, so "Title.m4b" orders before "Title - Part 2.m4b". */
const stem = (path: string): string => path.replace(/\.[^.\\/]+$/, '');

const discOf = (f: Orderable): number => f.tags?.discNo ?? f.discFromFolder ?? partFolderNumber(f.path) ?? 0;

/** Part order of a book's files: disc tag (or folder number), then track tag, then natural file-name sort. */
export function orderParts<T extends Orderable>(files: readonly T[]): T[] {
  return [...files].sort(
    (a, b) =>
      discOf(a) - discOf(b) ||
      (a.tags?.trackNo ?? 0) - (b.tags?.trackNo ?? 0) ||
      naturalCompare(stem(a.relativePath), stem(b.relativePath)) ||
      naturalCompare(a.path, b.path),
  );
}
