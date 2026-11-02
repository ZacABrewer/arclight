import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
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

export type UnpackFailure = SevenZipFailure | 'diskSpace';

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
    return this.kind === 'encrypted' || this.kind === 'missingVolume' || this.kind === 'corrupt' || this.kind === 'unsupported';
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
  return join(dirname(downloadPath), STAGING_FOLDER, stem);
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
  for (const set of sets) sizes.push(await listedSize(options.sevenZip, set));
  const total = sizes.reduce((a, b) => a + b, 0);
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
    for (const set of nested) {
      if (set.incomplete !== undefined) throw new UnpackError('missingVolume', `${set.name} is incomplete: ${set.incomplete}`);
      await listedSize(options.sevenZip, set);
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

async function listedSize(sevenZip: SevenZip, set: ArchiveSet): Promise<number> {
  try {
    const listing = await sevenZip.list(set.first, set.name);
    if (listing.entries.some((e) => e.encrypted)) throw new UnpackError('encrypted', `${set.name} is password-protected`);
    return listing.entries.reduce((sum, e) => sum + (e.folder ? 0 : e.sizeBytes), 0);
  } catch (err) {
    throw asUnpackError(err);
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
