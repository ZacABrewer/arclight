import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Keeps the player disk cache (WebVTT conversions and episode thumbnails, named
// `<key><size>-<mtime><ext>`) from growing without bound: a rebuilt entry removes the copies made
// for older versions of its source, and a periodic sweep drops the oldest entries over a size cap.
// Only the `subtitles` and `thumbs` folders are touched; trickplay manages its own folder.

/** The cache folders this module manages. */
export const MEDIA_CACHE_SUBDIRS = ['subtitles', 'thumbs'] as const;

/** Default size cap for the managed folders together. */
export const DEFAULT_MEDIA_CACHE_MAX_BYTES = 2 * 1024 ** 3;
/** Default time between sweeps (the first runs a few minutes after start). */
export const DEFAULT_MEDIA_CACHE_SWEEP_MS = 6 * 60 * 60_000;
const FIRST_SWEEP_MS = 5 * 60_000;
/** Temp files (a run killed mid-write) older than this are removed. */
const STALE_TEMP_MS = 60 * 60_000;

const ENTRY = /^(.+?-)\d+-\d+(\.[a-z0-9]+)$/i;

/** `{ key: 'f12-e0-', ext: '.vtt' }` for `f12-e0-1024-1700000000000.vtt`, or null for other names. */
export function cacheEntryKey(name: string): { key: string; ext: string } | null {
  const m = ENTRY.exec(name);
  return m ? { key: m[1]!, ext: m[2]! } : null;
}

/**
 * Removes the other versions of `name` in `dir`: same key and extension, different stamp. Best
 * effort; a file that cannot be removed now goes in a later sweep.
 */
export async function removeOtherStamps(dir: string, name: string): Promise<number> {
  const entry = cacheEntryKey(name);
  if (!entry) return 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const other of names) {
    if (other === name || !other.startsWith(entry.key)) continue;
    const o = cacheEntryKey(other);
    if (!o || o.key !== entry.key || o.ext.toLowerCase() !== entry.ext.toLowerCase()) continue;
    try {
      await rm(join(dir, other), { force: true });
      removed++;
    } catch {
      // next sweep
    }
  }
  return removed;
}

export interface SweepResult {
  removed: number;
  bytes: number;
}

/**
 * One sweep of `root` (configDir/cache/player): stale temp files go, then the oldest entries
 * (by modification time) until the managed folders hold at most `maxBytes`.
 */
export async function sweepMediaCache(root: string, maxBytes = DEFAULT_MEDIA_CACHE_MAX_BYTES, now = Date.now()): Promise<SweepResult> {
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  let removed = 0;
  for (const sub of MEDIA_CACHE_SUBDIRS) {
    const dir = join(root, sub);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      let s;
      try {
        s = await stat(path);
      } catch {
        continue;
      }
      if (!s.isFile()) continue;
      if (name.startsWith('.')) {
        if (now - s.mtimeMs > STALE_TEMP_MS) {
          await rm(path, { force: true }).catch(() => undefined);
          removed++;
        }
        continue;
      }
      files.push({ path, size: s.size, mtimeMs: s.mtimeMs });
    }
  }
  let bytes = files.reduce((n, f) => n + f.size, 0);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of files) {
    if (bytes <= maxBytes) break;
    try {
      await rm(f.path, { force: true });
      bytes -= f.size;
      removed++;
    } catch {
      // still in use; next sweep
    }
  }
  return { removed, bytes };
}

/** Runs `sweepMediaCache` periodically without holding the process open; returns a stop function. */
export function scheduleMediaCacheSweep(root: string, opts: { maxBytes?: number | undefined; intervalMs?: number | undefined } = {}): () => void {
  const interval = opts.intervalMs ?? DEFAULT_MEDIA_CACHE_SWEEP_MS;
  if (interval <= 0) return () => undefined;
  const run = () => void sweepMediaCache(root, opts.maxBytes).catch(() => undefined);
  let repeat: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    run();
    repeat = setInterval(run, interval);
    repeat.unref();
  }, Math.min(FIRST_SWEEP_MS, interval));
  first.unref();
  return () => {
    clearTimeout(first);
    if (repeat) clearInterval(repeat);
  };
}
