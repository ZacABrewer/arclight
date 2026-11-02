import { basename, dirname, join } from 'node:path';

// Archive sets in a download: which files belong together and which one 7-Zip is started on.
// Pure (file names only).
//
// Recognised:
//   Movie.part01.rar, Movie.part02.rar ...   (RAR 3+ volume naming, part1 / part01 / part001)
//   Movie.rar, Movie.r00, Movie.r01 ...      (old-style RAR volumes)
//   Movie.7z.001, Movie.7z.002 ...           (split 7z; also .zip.001 and .rar.001)
//   Movie.7z, Movie.zip, Movie.rar            (single archives)
// A set whose first volume is missing is reported as incomplete instead of being skipped.

export type ArchiveFormat = 'rar' | '7z' | 'zip';

export interface ArchiveSet {
  /** The file 7-Zip is pointed at (the first volume). */
  first: string;
  /** Every file of the set, first volume first. */
  volumes: string[];
  format: ArchiveFormat;
  /** Display name: the first volume's file name. */
  name: string;
  /** Set when the first volume is missing (nothing can be extracted). */
  incomplete?: string;
}

const PART_RAR = /^(.*)\.part(\d+)\.rar$/i;
const OLD_RAR_VOLUME = /^(.*)\.r(\d{2,3})$/i;
const SPLIT = /^(.*)\.(7z|zip|rar)\.(\d{3})$/i;
const SINGLE = /^(.*)\.(7z|zip|rar)$/i;

interface Group {
  format: ArchiveFormat;
  dir: string;
  stem: string;
  kind: 'part' | 'old' | 'split' | 'single';
  members: Array<{ path: string; index: number }>;
}

/** True for any file name that is part of an archive this module can unpack. */
export function isUnpackableArchive(path: string): boolean {
  const name = basename(path);
  return PART_RAR.test(name) || OLD_RAR_VOLUME.test(name) || SPLIT.test(name) || SINGLE.test(name);
}

/** Groups archive files into sets. Non-archives are ignored. */
export function findArchiveSets(paths: readonly string[]): ArchiveSet[] {
  const groups = new Map<string, Group>();
  const add = (key: string, init: Omit<Group, 'members'>, path: string, index: number) => {
    let g = groups.get(key);
    if (!g) {
      g = { ...init, members: [] };
      groups.set(key, g);
    }
    g.members.push({ path, index });
  };
  const singles: Array<{ path: string; dir: string; stem: string; format: ArchiveFormat }> = [];

  for (const path of paths) {
    const dir = dirname(path);
    const name = basename(path);
    let m: RegExpExecArray | null;
    if ((m = PART_RAR.exec(name))) {
      const stem = m[1]!;
      add(`part|${dir}|${stem.toLowerCase()}`, { format: 'rar', dir, stem, kind: 'part' }, path, Number(m[2]));
    } else if ((m = SPLIT.exec(name))) {
      const stem = m[1]!;
      const format = m[2]!.toLowerCase() as ArchiveFormat;
      add(`split|${dir}|${stem.toLowerCase()}.${format}`, { format, dir, stem, kind: 'split' }, path, Number(m[3]));
    } else if ((m = OLD_RAR_VOLUME.exec(name))) {
      const stem = m[1]!;
      // .rar is volume -1 (the first); .r00 is 0, .r01 is 1 ...
      add(`old|${dir}|${stem.toLowerCase()}`, { format: 'rar', dir, stem, kind: 'old' }, path, Number(m[2]));
    } else if ((m = SINGLE.exec(name))) {
      singles.push({ path, dir, stem: m[1]!, format: m[2]!.toLowerCase() as ArchiveFormat });
    }
  }

  // A plain .rar next to .r00/.r01 volumes of the same stem is the first volume of that set.
  for (const s of singles) {
    const old = groups.get(`old|${s.dir}|${s.stem.toLowerCase()}`);
    if (s.format === 'rar' && old) old.members.push({ path: s.path, index: -1 });
    else add(`single|${s.path.toLowerCase()}`, { format: s.format, dir: s.dir, stem: s.stem, kind: 'single' }, s.path, 0);
  }

  const sets: ArchiveSet[] = [];
  for (const g of groups.values()) {
    g.members.sort((a, b) => a.index - b.index);
    const volumes = g.members.map((m) => m.path);
    const head = g.members[0]!;
    const expectedFirst =
      g.kind === 'part' ? head.index === 1 || head.index === 0 : g.kind === 'split' ? head.index === 1 : g.kind === 'old' ? head.index === -1 : true;
    const set: ArchiveSet = { first: head.path, volumes, format: g.format, name: basename(head.path) };
    if (!expectedFirst) {
      const missing =
        g.kind === 'part'
          ? `${g.stem}.part1.rar`
          : g.kind === 'split'
            ? `${g.stem}.${g.format}.001`
            : `${g.stem}.rar`;
      set.name = basename(missing);
      set.first = join(g.dir, basename(missing));
      set.incomplete = `the first volume (${basename(missing)}) is missing`;
    }
    sets.push(set);
  }
  return sets.sort((a, b) => a.first.localeCompare(b.first));
}
