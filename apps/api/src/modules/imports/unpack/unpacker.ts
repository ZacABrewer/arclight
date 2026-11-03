import { lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { findArchiveSets, type ArchiveSet } from './archives.js';
import { SevenZipError, type SevenZip, type SevenZipFailure } from './sevenzip.js';

// Unpacking a completed download's archives so its media can be imported. Archives are
// extracted into a staging folder next to the download (never inside it, so a torrent keeps
// seeding the original files untouched), archives found in what came out are extracted once
// more (nested at most one level), and the import then moves the media out of staging. The
// caller removes the staging folder afterwards.

/** Staging folders live in this dot-folder next to the download (scans skip dot-folders). */
export const STAGING_FOLDER = '.arclight-unpacked';

/**
 * `tooLarge`: the listing breaks a decompression-bomb cap (size ratio, absolute size or entry
 * count). `links`: the archive holds links and the installed 7-Zip cannot extract them safely.
 */
export type UnpackFailure = SevenZipFailure | 'diskSpace' | 'tooLarge' | 'links';

/** Unpacked bytes allowed per archive byte, per set (media barely compresses; bombs do 1000:1). */
export const MAX_RATIO = 20;
/** Head-room for small archives (a tiny zip of subtitles may compress well). */
export const RATIO_SLACK_BYTES = 256 * 1024 ** 2;
/** Everything unpacked (first level and nested) may not exceed this multiple of the download's archives. */
export const MAX_TOTAL_MULTIPLE = 20;
/** Entries listed across every set of one download. */
export const MAX_ENTRIES = 20_000;

export class UnpackError extends Error {
  constructor(
    readonly kind: UnpackFailure,
    message: string,
  ) {
    super(message);
    this.name = 'UnpackError';
  }

  /** Bad archives mean a bad release: it is rejected, blocklisted and searched for again. */
  get rejectsRelease(): boolean {
    return (
      this.kind === 'encrypted' ||
      this.kind === 'missingVolume' ||
      this.kind === 'corrupt' ||
      this.kind === 'unsupported' ||
      this.kind === 'tooLarge' ||
      this.kind === 'links'
    );
  }
}

export interface UnpackOptions {
  sevenZip: SevenZip;
  /** Bytes free on the volume holding a path; null when unknown. */
  freeSpace: (path: string) => Promise<number | null>;
  /** Free space that must remain after extracting (Settings > Media Management minimum). */
  minimumFreeBytes: number;
  onProgress?: (fraction: number) => void;
}

export interface UnpackResult {
  stagingDir: string;
  /** Absolute paths of every file extracted (after nested archives were unpacked). */
  files: string[];
  /** Archive sets extracted, first level and nested. */
  sets: number;
}

/** `<parent of the download>/.arclight-unpacked/<download name without archive extension>`. */
export function stagingDirFor(downloadPath: string, isFile: boolean): string {
  const name = basename(downloadPath);
  const stem = isFile ? name.slice(0, name.length - extname(name).length) || name : name;
  // The name comes from the download client: `..`, `.` or an empty name would make staging the
  // shared staging (or downloads) folder, which is removed after the import.
  return join(dirname(downloadPath), STAGING_FOLDER, stagingSegment(stem));
}

/** One safe folder name: separators and reserved characters become `_`, and so do `''`, `.` and `..`. */
function stagingSegment(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\\/<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  return s === '' || /^\.+$/.test(s) ? '_' : s;
}

/**
 * Extracts every archive set among `archivePaths` (files of the download at `root`) into
 * `stagingDir`, keeping each set's sub-folder. Throws UnpackError; on failure nothing is left
 * in staging.
 */
export async function unpackArchives(
  root: string,
  archivePaths: readonly string[],
  stagingDir: string,
  options: UnpackOptions,
): Promise<UnpackResult> {
  const sets = findArchiveSets(archivePaths);
  const broken = sets.find((s) => s.incomplete !== undefined);
  if (broken) throw new UnpackError('missingVolume', `${broken.name} is incomplete: ${broken.incomplete}`);
  if (sets.length === 0) return { stagingDir, files: [], sets: 0 };

  // List first: password-protected sets are rejected before anything is written, and the
  // unpacked size is known for the disk check.
  const sizes: number[] = [];
  const budget = { entries: 0 };
  let packed = 0;
  for (const set of sets) {
    const listed = await listedSize(options.sevenZip, set, budget);
    const setPacked = await packedSize(set);
    checkRatio(set, listed, setPacked);
    sizes.push(listed);
    packed += setPacked;
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  const totalCap = packed * MAX_TOTAL_MULTIPLE + RATIO_SLACK_BYTES;
  await checkSpace(stagingDir, total, options);

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  let extractedSets = 0;
  try {
    let done = 0;
    for (const [i, set] of sets.entries()) {
      const weight = total > 0 ? sizes[i]! / total : 1 / sets.length;
      const sub = relative(root, dirname(set.first));
      const out = sub && !sub.startsWith('..') ? join(stagingDir, sub) : stagingDir;
      await extract(options.sevenZip, set, out, (f) => options.onProgress?.(Math.min(1, done + f * weight)));
      done += weight;
      extractedSets++;
    }

    // Nested once: archives that came out of archives (a .rar inside a .zip, ...).
    const firstLevel = await listFiles(stagingDir);
    const nested = findArchiveSets(firstLevel);
    // List every nested set before extracting any: the same caps and disk check as the first level.
    let nestedTotal = 0;
    for (const set of nested) {
      if (set.incomplete !== undefined) throw new UnpackError('missingVolume', `${set.name} is incomplete: ${set.incomplete}`);
      const listed = await listedSize(options.sevenZip, set, budget);
      checkRatio(set, listed, await packedSize(set));
      nestedTotal += listed;
    }
    if (total + nestedTotal > totalCap) {
      throw new UnpackError('tooLarge', `Archives in this download unpack to ${gib(total + nestedTotal)} GiB, far more than the download itself (likely a decompression bomb)`);
    }
    if (nested.length > 0) await checkSpace(stagingDir, nestedTotal, options);
    for (const set of nested) {
      await extract(options.sevenZip, set, dirname(set.first));
      for (const v of set.volumes) await rm(v, { force: true });
      extractedSets++;
    }
    options.onProgress?.(1);
    const files = await listFiles(stagingDir);
    return { stagingDir, files, sets: extractedSets };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function listedSize(sevenZip: SevenZip, set: ArchiveSet, budget: { entries: number }): Promise<number> {
  try {
    const listing = await sevenZip.list(set.first, set.name);
    if (listing.entries.some((e) => e.encrypted)) throw new UnpackError('encrypted', `${set.name} is password-protected`);
    budget.entries += listing.entries.length;
    if (budget.entries > MAX_ENTRIES) {
      throw new UnpackError('tooLarge', `${set.name} lists more than ${MAX_ENTRIES} entries (likely a decompression bomb)`);
    }
    // Before 7-Zip 25.00 an archive link can make a later entry write outside staging.
    if (!(sevenZip.info?.linkSafe ?? false) && listing.entries.some((e) => e.link)) {
      const version = sevenZip.info?.version ? `7-Zip ${sevenZip.info.version}` : 'The installed 7-Zip';
      throw new UnpackError('links', `${set.name} contains links, and ${version} cannot extract links safely (update to 7-Zip 25.00 or newer)`);
    }
    return listing.entries.reduce((sum, e) => sum + (e.folder ? 0 : e.sizeBytes), 0);
  } catch (err) {
    throw asUnpackError(err);
  }
}

/** Bytes the set's volumes take on disk (0 for a volume that cannot be read). */
async function packedSize(set: ArchiveSet): Promise<number> {
  let sum = 0;
  for (const v of set.volumes) sum += (await stat(v).catch(() => null))?.size ?? 0;
  return sum;
}

function checkRatio(set: ArchiveSet, listed: number, packed: number): void {
  if (listed > packed * MAX_RATIO + RATIO_SLACK_BYTES) {
    throw new UnpackError(
      'tooLarge',
      `${set.name} would unpack to ${gib(listed)} GiB from ${gib(packed)} GiB (likely a decompression bomb)`,
    );
  }
}

async function extract(sevenZip: SevenZip, set: ArchiveSet, out: string, onProgress?: (fraction: number) => void): Promise<void> {
  try {
    await sevenZip.extract(set.first, out, onProgress, set.name);
  } catch (err) {
    throw asUnpackError(err);
  }
}

function asUnpackError(err: unknown): UnpackError {
  if (err instanceof UnpackError) return err;
  if (err instanceof SevenZipError) return new UnpackError(err.kind, err.message);
  return new UnpackError('failed', `Could not run 7-Zip: ${err instanceof Error ? err.message : String(err)}`);
}

async function checkSpace(stagingDir: string, needed: number, options: UnpackOptions): Promise<void> {
  const free = await options.freeSpace(dirname(stagingDir));
  if (free === null) return;
  if (free - needed < options.minimumFreeBytes) {
    throw new UnpackError(
      'diskSpace',
      `Not enough free disk space to unpack: ${gib(needed)} GiB needed, ${gib(free)} GiB free, and ${gib(options.minimumFreeBytes)} GiB must stay free`,
    );
  }
}

function gib(bytes: number): string {
  return (Math.max(0, bytes) / 1024 ** 3).toFixed(1);
}

/**
 * Every regular file under `dir`. Symbolic links are removed rather than followed: an archive
 * must not be able to point the import at files outside its staging folder.
 */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const root = resolve(dir);
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      const info = await lstat(full).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) {
        await rm(full, { force: true });
        continue;
      }
      if (!resolve(full).startsWith(root + sep)) continue;
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) out.push(full);
    }
  };
  await walk(root);
  return out.sort();
}
