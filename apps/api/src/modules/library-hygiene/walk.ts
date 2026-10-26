import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extensionOf, isMediaExtension, isUnder } from '../imports/scan.js';

// Filesystem side of the orphan scan: walk a root folder, list video files and the topmost
// empty folders, hash file prefixes. No database.

export interface WalkedFile {
  path: string;
  sizeBytes: number;
  /** Device + inode; hard links of one file share it (0 when the platform reports none). */
  dev: number;
  ino: number;
  /** Inside an extras folder or named like an extra (`-trailer`, ...). */
  extra: boolean;
}

export interface WalkResult {
  videos: WalkedFile[];
  /** Topmost folders whose whole subtree holds no files (junk files ignored). Never the root. */
  emptyFolders: string[];
}

const SKIPPED_FOLDERS = new Set(['@eadir', '#recycle', '$recycle.bin', 'lost+found', '.@__thumb', 'plex versions', 'system volume information', '#snapshot']);
const JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const EXTRAS_FOLDERS = new Set([
  'extras', 'extrafanart', 'behind the scenes', 'deleted scenes', 'featurettes', 'interviews', 'other', 'scenes',
  'sample', 'samples', 'shorts', 'trailers', 'theme music', 'backdrops',
]);
const EXTRA_SUFFIXES = ['-trailer', '-other', '-behindthescenes', '-deleted', '-featurette', '-interview', '-scene', '-short', '-sample'];

function isJunk(name: string): boolean {
  const lower = name.toLowerCase();
  return JUNK_FILES.has(lower) || lower.startsWith('._');
}

function isExtraName(name: string): boolean {
  const ext = extensionOf(name);
  const stem = (ext ? name.slice(0, -ext.length) : name).toLowerCase();
  return EXTRA_SUFFIXES.some((s) => stem.endsWith(s));
}

export interface WalkOptions {
  /** Folders never entered (recycle bin, other root folders nested inside this one). */
  excluded?: readonly string[];
}

export async function walkRoot(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const result: WalkResult = { videos: [], emptyFolders: [] };
  const excluded = opts.excluded ?? [];

  /** Returns true when the folder's subtree holds no (non-junk) files. */
  const walk = async (dir: string, inExtras: boolean, isRoot: boolean): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false; // unreadable: never report as empty
    }
    let empty = true;
    const emptyChildren: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (lower.startsWith('.') || SKIPPED_FOLDERS.has(lower) || excluded.some((x) => isUnder(full, x))) {
          empty = false;
          continue;
        }
        const childEmpty = await walk(full, inExtras || EXTRAS_FOLDERS.has(lower), false);
        if (childEmpty) emptyChildren.push(full);
        else empty = false;
        continue;
      }
      if (!entry.isFile()) {
        empty = false;
        continue;
      }
      if (isJunk(entry.name)) continue;
      empty = false;
      if (!isMediaExtension(extensionOf(entry.name))) continue;
      const s = await stat(full).catch(() => null);
      if (!s) continue;
      result.videos.push({
        path: full,
        sizeBytes: s.size,
        dev: Number(s.dev),
        ino: Number(s.ino),
        extra: inExtras || isExtraName(entry.name),
      });
    }
    // Report the topmost empty folders only: when this folder is empty its children are
    // covered by it (unless this is the root, which is never reported).
    if (!empty || isRoot) result.emptyFolders.push(...emptyChildren);
    return empty;
  };

  await walk(root, false, true);
  result.videos.sort((a, b) => a.path.localeCompare(b.path));
  result.emptyFolders.sort();
  return result;
}

/** True when a folder (still) holds no non-junk files anywhere below it. */
export async function isFolderEmpty(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!(await isFolderEmpty(join(dir, e.name)))) return false;
    } else if (!isJunk(e.name)) return false;
  }
  return true;
}

export const HASH_PREFIX_BYTES = 1024 * 1024;

/** sha256 of the first `bytes` of a file (the whole file when smaller). */
export async function hashPrefix(path: string, bytes = HASH_PREFIX_BYTES): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
