import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { SUBTITLE_EXTENSIONS, extensionOf, isMediaExtension, isSampleByName, isUnder } from './scan.js';

// Disk side of an import (spec 9.4, 9.5, 10, 14): verified move/copy/hard link with a
// cross-device fallback, permissions, the recycle bin, empty-folder cleanup and extra files.

export type TransferMode = 'move' | 'copy' | 'hardlink' | 'hardlinkOrCopy';
/** What actually happened. */
export type TransferResult = 'move' | 'copy' | 'hardlink';

export type ImportFileErrorCode =
  | 'SOURCE_NOT_FOUND'
  | 'SAME_FILE'
  | 'DESTINATION_EXISTS'
  | 'DESTINATION_INSIDE_SOURCE'
  | 'VERIFY_FAILED'
  | 'HARDLINK_FAILED'
  | 'ROOT_FOLDER_NOT_FOUND'
  | 'RECYCLE_BIN';

export class ImportFileError extends Error {
  constructor(
    readonly code: ImportFileErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ImportFileError';
  }
}

/** Filesystem primitives that tests may replace (e.g. to simulate a cross-device rename). */
export interface FsOps {
  rename: (from: string, to: string) => Promise<void>;
  link: (existing: string, target: string) => Promise<void>;
}

const defaultOps: FsOps = { rename, link };

export interface TransferOptions {
  overwrite?: boolean;
  ops?: Partial<FsOps>;
}

async function sizeOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function errCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

async function verifiedCopy(src: string, dst: string, expected: number): Promise<void> {
  // Reflink where the filesystem supports it, a normal copy otherwise.
  await copyFile(src, dst, constants.COPYFILE_FICLONE);
  await verifySize(dst, expected);
}

async function verifySize(dst: string, expected: number): Promise<void> {
  const actual = await sizeOrNull(dst);
  if (actual !== expected) {
    await rm(dst, { force: true });
    throw new ImportFileError('VERIFY_FAILED', `Size mismatch after transfer to ${dst}: expected ${expected}, got ${actual ?? 'none'}`);
  }
}

/** Moves, copies or hard-links `src` to `dst`, creating parent folders and verifying the size. */
export async function transferFile(src: string, dst: string, mode: TransferMode, options: TransferOptions = {}): Promise<TransferResult> {
  const ops = { ...defaultOps, ...options.ops };
  const srcSize = await sizeOrNull(src);
  if (srcSize === null) throw new ImportFileError('SOURCE_NOT_FOUND', `Source file not found: ${src}`);
  const a = resolve(src);
  const b = resolve(dst);
  const caseOnly = a !== b && a.toLowerCase() === b.toLowerCase();
  if (a === b) throw new ImportFileError('SAME_FILE', `Source and destination are the same file: ${src}`);
  if (isUnder(b, a)) throw new ImportFileError('DESTINATION_INSIDE_SOURCE', `Destination ${dst} is inside ${src}`);

  if (!caseOnly && (await sizeOrNull(dst)) !== null) {
    if (!options.overwrite) throw new ImportFileError('DESTINATION_EXISTS', `Destination already exists: ${dst}`);
    await rm(dst, { force: true });
  }
  await mkdir(dirname(dst), { recursive: true });

  if (mode === 'move') {
    if (caseOnly) {
      // Case-insensitive filesystems: go through a temporary name.
      const tmp = `${dst}.mtmove-${process.pid}`;
      await ops.rename(src, tmp);
      await ops.rename(tmp, dst);
      return 'move';
    }
    try {
      await ops.rename(src, dst);
      await verifySize(dst, srcSize);
      return 'move';
    } catch (err) {
      if (err instanceof ImportFileError) throw err;
      const code = errCode(err);
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw err;
      // Cross-device (or a share that refuses rename): verified copy, then delete the source.
      await verifiedCopy(src, dst, srcSize);
      await unlink(src);
      return 'move';
    }
  }

  if (mode === 'hardlink' || mode === 'hardlinkOrCopy') {
    try {
      await ops.link(src, dst);
      return 'hardlink';
    } catch (err) {
      if (mode === 'hardlink') throw new ImportFileError('HARDLINK_FAILED', `Hard link failed for ${src}`, { cause: err });
    }
  }

  await verifiedCopy(src, dst, srcSize);
  return 'copy';
}

/** Mode bits from an octal string (`755`); files get the same bits without execute. */
export function parseMode(chmodFolder: string): { folder: number; file: number } {
  const folder = Number.parseInt(chmodFolder, 8);
  return { folder, file: folder & 0o666 };
}

/** Applies permissions (non-Windows only). Errors are swallowed: permissions are best effort. */
export async function setPermissions(path: string, chmodFolder: string, isFolder: boolean): Promise<void> {
  if (process.platform === 'win32') return;
  const { folder, file } = parseMode(chmodFolder);
  try {
    await chmod(path, isFolder ? folder : file);
  } catch {
    // Not owner, or the filesystem ignores modes.
  }
}

// ---------------------------------------------------------------------------------------
// Recycle bin (spec 10)
// ---------------------------------------------------------------------------------------

export class RecycleBin {
  constructor(
    private readonly binPath: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get enabled(): boolean {
    return !!this.binPath && this.binPath.trim() !== '';
  }

  /**
   * Moves a file into the bin under `subFolder` (path relative to its root folder), suffixing
   * `_2`, `_3` ... on a name clash, and stamps it with the current time so cleanup counts from
   * deletion. Without a bin the file is deleted. Returns the bin path, or null when deleted.
   * `name` files it under another name (a file set aside under a temporary name keeps its own).
   */
  async recycle(filePath: string, subFolder = '', name = basename(filePath)): Promise<string | null> {
    try {
      if (!this.enabled) {
        await rm(filePath, { force: true });
        return null;
      }
      const folder = join(this.binPath!, subFolder);
      await mkdir(folder, { recursive: true });
      const ext = extname(name);
      const stem = basename(name, ext);
      let target = join(folder, stem + ext);
      for (let i = 2; (await sizeOrNull(target)) !== null; i++) target = join(folder, `${stem}_${i}${ext}`);
      await transferFile(filePath, target, 'move');
      const now = this.now();
      await utimes(target, now, now);
      return target;
    } catch (err) {
      throw new ImportFileError('RECYCLE_BIN', `Unable to move ${filePath} to the recycle bin`, { cause: err });
    }
  }

  /** Deletes files older than `days` (0 disables), then empty folders. */
  async cleanup(days: number): Promise<{ deletedFiles: number; deletedFolders: number }> {
    if (!this.enabled || days <= 0) return { deletedFiles: 0, deletedFolders: 0 };
    const cutoff = this.now().getTime() - days * 24 * 60 * 60 * 1000;
    let deletedFiles = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const s = await stat(full).catch(() => null);
          if (s && s.mtimeMs < cutoff) {
            await rm(full, { force: true });
            deletedFiles++;
          }
        }
      }
    };
    await walk(this.binPath!);
    const deletedFolders = await deleteEmptyFolders(this.binPath!);
    return { deletedFiles, deletedFolders };
  }

  /** Deletes everything inside the bin. */
  async empty(): Promise<void> {
    if (!this.enabled) return;
    const entries = await readdir(this.binPath!).catch(() => [] as string[]);
    for (const e of entries) await rm(join(this.binPath!, e), { recursive: true, force: true });
  }
}

/** Removes empty sub-folders below `root` (never `root` itself). Returns how many were removed. */
export async function deleteEmptyFolders(root: string): Promise<number> {
  let removed = 0;
  const walk = async (dir: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const e of entries) {
      if (e.isDirectory()) {
        const childEmpty = await walk(join(dir, e.name));
        if (childEmpty) {
          await rmdir(join(dir, e.name)).then(
            () => removed++,
            () => (empty = false),
          );
        } else empty = false;
      } else empty = false;
    }
    return empty;
  };
  await walk(root);
  return removed;
}

// ---------------------------------------------------------------------------------------
// Extra files (spec 14)
// ---------------------------------------------------------------------------------------

export interface ExtraFilesOptions {
  /** Extensions without dots (`srt`, `nfo`). */
  extensions: readonly string[];
  /** Search sub-folders of the video's folder too (folder imports). */
  recursive: boolean;
  mode: TransferMode;
}

async function listFiles(dir: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (recursive) await walk(full);
      } else if (e.isFile()) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

function stemOf(path: string): string {
  const name = basename(path);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

const LANGUAGE_TAIL = /\.([a-z]{2,3}(?:\.(?:forced|sdh|cc|hi))?)$/i;

/**
 * Finds extras that belong to `videoSrc` and moves/copies them next to `videoDst`, renamed to
 * follow it (spec 14.4-14.6). Returns the destination paths.
 */
export async function importExtraFiles(videoSrc: string, videoDst: string, options: ExtraFilesOptions): Promise<string[]> {
  const wanted = new Set(options.extensions.map((e) => `.${e.replace(/^\./, '').toLowerCase()}`));
  if (wanted.size === 0) return [];
  const folder = dirname(videoSrc);
  const all = await listFiles(folder, options.recursive);
  const videoStem = stemOf(videoSrc).toLowerCase();
  const candidates = all.filter((f) => f !== videoSrc && wanted.has(extensionOf(f)) && !isMediaExtension(extensionOf(f)));

  let matched = candidates.filter((f) => basename(f).toLowerCase().startsWith(videoStem));
  if (matched.length === 0) {
    const videos = all.filter((f) => isMediaExtension(extensionOf(f)));
    const nonSample = videos.filter((v) => !isSampleByName(v));
    if (videos.length <= 2 && nonSample.length === 1) matched = candidates.filter((f) => SUBTITLE_EXTENSIONS.has(extensionOf(f)));
  }

  const dstStem = join(dirname(videoDst), stemOf(videoDst));
  const used = new Set<string>();
  let nfoDone = false;
  const results: string[] = [];
  for (const extra of matched) {
    const ext = extensionOf(extra);
    if (ext === '.nfo') {
      if (nfoDone) continue;
      nfoDone = true;
    }
    const name = basename(extra);
    // Keep whatever followed the video name ("…S01E01.en.forced.srt" → ".en.forced.srt").
    let suffix: string;
    if (name.toLowerCase().startsWith(videoStem)) suffix = name.slice(videoStem.length);
    else {
      const lang = LANGUAGE_TAIL.exec(stemOf(extra));
      suffix = (lang ? `.${lang[1]}` : '') + ext;
    }
    let target = dstStem + suffix;
    for (let i = 1; used.has(target.toLowerCase()); i++) {
      target = `${dstStem}${suffix.slice(0, -ext.length)}.${i}${ext}`;
    }
    used.add(target.toLowerCase());
    try {
      await transferFile(extra, target, options.mode, { overwrite: true });
      results.push(target);
    } catch {
      // An extra failing never fails the media import.
    }
  }
  return results;
}

/** Relative path from `root` with forward-or-native separators preserved. */
export function relativeTo(root: string, path: string): string {
  return relative(root, path);
}
