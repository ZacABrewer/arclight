import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import type { MediaInfo, PlayerSettings, TrickplayManifest } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { mediaFiles } from '../library/schema.js';
import { dynamicRangeOf, durationOf, TONEMAP_ZSCALE } from './video-info.js';
import { fileStamp, type Limiter } from './video-stream.js';
import { fileInput } from '../transcode/input-protocols.js';

// Scrub thumbnails ("trickplay"): JPEG sprite sheets of a video file, one 320 px tile every 10 s,
// 10x10 tiles per sheet, made by one low-priority background ffmpeg at a time and kept per file
// stamp under configDir/cache/player/trickplay/<mediaFileId>/<stamp>/. The queue holds file ids
// only (deduplicated); each job re-checks the file and the setting when it starts and waits while
// every live video slot is in use, so scrub thumbnails never slow down someone watching.

export const TRICKPLAY_INTERVAL_MS = 10_000;
export const TRICKPLAY_TILE_WIDTH = 320;
export const TRICKPLAY_COLUMNS = 10;
export const TRICKPLAY_ROWS = 10;

/** The manifest as stored next to the sheets: no URLs, plus the sheet count. */
export type StoredManifest = Omit<TrickplayManifest, 'sheets' | 'status'> & { sheetCount: number; stamp: string };

/** ffmpeg arguments that write `<outDir>/0.jpg ... N.jpg`. `tonemap`: insert the software HDR->SDR chain. */
export function buildTrickplayArgs(input: string, outDir: string, opts: { tonemap: boolean }): string[] {
  const filters = [`fps=1/${TRICKPLAY_INTERVAL_MS / 1000}`, `scale=${TRICKPLAY_TILE_WIDTH}:-2:flags=fast_bilinear`];
  if (opts.tonemap) filters.push(TONEMAP_ZSCALE);
  filters.push(`tile=${TRICKPLAY_COLUMNS}x${TRICKPLAY_ROWS}`);
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-threads',
    '2',
    '-skip_frame',
    'nokey',
    ...fileInput(input),
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    filters.join(','),
    '-q:v',
    '6',
    '-start_number',
    '0',
    '-f',
    'image2',
    join(outDir, '%d.jpg'),
  ];
}

/** Width and height from a JPEG's start-of-frame marker, or null. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Tiles of a file of `durationMs` held in `sheetCount` sheets. */
export function tileCountOf(durationMs: number, sheetCount: number): number {
  const per = TRICKPLAY_COLUMNS * TRICKPLAY_ROWS;
  const max = sheetCount * per;
  if (sheetCount === 0) return 0;
  const byDuration = durationMs > 0 ? Math.ceil(durationMs / TRICKPLAY_INTERVAL_MS) : max;
  return Math.max((sheetCount - 1) * per + 1, Math.min(max, byDuration));
}

/** Runs ffmpeg at a lower priority; resolves with the exit code. */
export type TrickplayRunner = (bin: string, args: readonly string[], timeoutMs: number) => Promise<number>;

export const lowPriorityRun: TrickplayRunner = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, 10);
      } catch {
        // not permitted or not supported here: normal priority
      }
    }
    child.stderr?.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });

export interface TrickplayOptions {
  db: Db;
  /** configDir/cache/player/trickplay */
  dir: string;
  locate: () => Promise<string | null>;
  /** zscale available in this ffmpeg (the live encoder detection). */
  zscale: (bin: string) => Promise<boolean>;
  settings: () => PlayerSettings;
  /** True while every live video slot is in use. */
  liveBusy: () => boolean;
  limiter: Limiter;
  run?: TrickplayRunner;
  /** Busy-wait poll interval (default 5 s). */
  pollMs?: number;
  log?: { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };
}

type FileRow = { id: number; path: string; mediaInfo: MediaInfo | null };

export class TrickplayService {
  private readonly queued = new Set<number>();
  private readonly order: number[] = [];
  private pumping: Promise<void> | null = null;
  private stopped = false;
  /** Files that failed (or have no video) at this stamp: not retried until the file changes. */
  private readonly failed = new Map<number, string>();
  /** The file being generated now and its temporary folder (clear() leaves that folder alone). */
  private active: { id: number; tmp: string } | null = null;
  private readonly run: TrickplayRunner;

  constructor(private readonly opts: TrickplayOptions) {
    this.run = opts.run ?? lowPriorityRun;
  }

  get pending(): number {
    return this.queued.size;
  }

  private fileRow(id: number): FileRow | null {
    const row = this.opts.db.select({ id: mediaFiles.id, path: mediaFiles.path, mediaInfo: mediaFiles.mediaInfo }).from(mediaFiles).where(eq(mediaFiles.id, id)).get();
    return row ? { id: row.id, path: row.path, mediaInfo: row.mediaInfo ?? null } : null;
  }

  /** The stored manifest for the file's current stamp, or null. */
  async ready(id: number, stamp: string): Promise<StoredManifest | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.opts.dir, String(id), stamp, 'manifest.json'), 'utf8')) as StoredManifest;
      return raw.stamp === stamp ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * What a client gets for a file now: ready (with the stored manifest), pending (queued or
   * generating; queued now when `enqueue`), or unavailable (setting off, failed, missing file).
   */
  async status(id: number, opts: { enqueue: boolean }): Promise<{ status: 'ready'; manifest: StoredManifest } | { status: 'pending' | 'unavailable' }> {
    if (this.opts.settings().trickplay === 'off') return { status: 'unavailable' };
    const row = this.fileRow(id);
    if (!row) return { status: 'unavailable' };
    const stamp = await fileStamp(row.path);
    if (!stamp) return { status: 'unavailable' };
    const manifest = await this.ready(id, stamp);
    if (manifest) return { status: 'ready', manifest };
    if (this.failed.get(id) === stamp) return { status: 'unavailable' };
    if (opts.enqueue) this.enqueue(id);
    return this.queued.has(id) ? { status: 'pending' } : { status: 'unavailable' };
  }

  /** Queues a file (once). Generation starts in the background. */
  enqueue(id: number): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.order.push(id);
    this.pumping ??= this.pump().finally(() => {
      this.pumping = null;
    });
  }

  /** Resolves when the queue is empty (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  /** Stops after the current file (shutdown). */
  stop(): void {
    this.stopped = true;
    this.order.length = 0;
  }

  private async pump(): Promise<void> {
    for (;;) {
      const id = this.order.shift();
      if (id === undefined || this.stopped) return;
      try {
        while (this.opts.liveBusy() && !this.stopped) await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 5000));
        if (this.stopped) return;
        await this.opts.limiter.run(() => this.generate(id));
      } catch (err) {
        if (this.stopped) return;
        this.opts.log?.warn({ err, mediaFileId: id }, 'scrub thumbnails could not be made');
      } finally {
        this.queued.delete(id);
      }
    }
  }

  /** One job: re-checks the file and the setting, then makes the sheets for the current stamp. */
  private async generate(id: number): Promise<void> {
    if (this.opts.settings().trickplay === 'off') return;
    const row = this.fileRow(id);
    if (!row) return;
    const stamp = await fileStamp(row.path);
    if (!stamp || (await this.ready(id, stamp))) return;
    const info = row.mediaInfo;
    if (info && !info.videoFormat && !(info.width && info.height)) {
      this.failed.set(id, stamp);
      return;
    }
    const bin = await this.opts.locate();
    if (!bin) throw new Error('ffmpeg was not found');
    const fileDir = join(this.opts.dir, String(id));
    const tmp = join(fileDir, `${stamp}.tmp`);
    const final = join(fileDir, stamp);
    this.active = { id, tmp };
    try {
      await this.generateInto(id, row, info, bin, stamp, fileDir, tmp, final);
    } finally {
      this.active = null;
    }
  }

  private async generateInto(id: number, row: FileRow, info: MediaInfo | null, bin: string, stamp: string, fileDir: string, tmp: string, final: string): Promise<void> {
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    const hdr = dynamicRangeOf(info) !== 'sdr';
    const tonemap = hdr && (await this.opts.zscale(bin));
    const durationMs = durationOf(info, null);
    // Keyframe-only decoding is fast; allow ~1 min per 10 min of film, at least 10 min.
    const timeoutMs = Math.max(10 * 60_000, durationMs / 10);
    const code = await this.run(bin, buildTrickplayArgs(row.path, tmp, { tonemap }), timeoutMs);
    const sheets = (await readdir(tmp).catch(() => [] as string[])).filter((f) => /^\d+\.jpg$/.test(f)).length;
    const first = sheets > 0 ? jpegSize(await readFile(join(tmp, '0.jpg'))) : null;
    if (code !== 0 || sheets === 0 || !first) {
      await rm(tmp, { recursive: true, force: true });
      this.failed.set(id, stamp);
      throw new Error(`ffmpeg exited with ${code} and ${sheets} sheets`);
    }
    const manifest: StoredManifest = {
      mediaFileId: id,
      stamp,
      intervalMs: TRICKPLAY_INTERVAL_MS,
      tileWidth: Math.round(first.width / TRICKPLAY_COLUMNS),
      tileHeight: Math.round(first.height / TRICKPLAY_ROWS),
      columns: TRICKPLAY_COLUMNS,
      rows: TRICKPLAY_ROWS,
      tileCount: tileCountOf(durationMs, sheets),
      sheetCount: sheets,
    };
    await writeFile(join(tmp, 'manifest.json'), JSON.stringify(manifest));
    await rm(final, { recursive: true, force: true });
    await rename(tmp, final);
    // Older stamps of this file are stale now.
    for (const entry of await readdir(fileDir).catch(() => [] as string[])) {
      if (entry !== stamp) await rm(join(fileDir, entry), { recursive: true, force: true });
    }
    this.failed.delete(id);
  }

  /** The JPEG of sheet `n` at `stamp`, or null when it is not (or no longer) there. */
  async sheetPath(id: number, n: number, stamp: string): Promise<string | null> {
    if (!/^[0-9]+-[0-9]+$/.test(stamp)) return null;
    const p = join(this.opts.dir, String(id), stamp, `${n}.jpg`);
    try {
      await stat(join(this.opts.dir, String(id), stamp, 'manifest.json'));
      await stat(p);
      return p;
    } catch {
      return null;
    }
  }

  /** Size of the whole trickplay cache. */
  async cacheSize(): Promise<{ bytes: number; files: number }> {
    let bytes = 0;
    let files = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) {
          files++;
          bytes += (await stat(p).catch(() => ({ size: 0 }))).size;
        }
      }
    };
    await walk(this.opts.dir);
    return { bytes, files };
  }

  /**
   * Deletes every sheet (they are made again on demand), forgets failures and drops queued files
   * that have not started. The file being generated right now keeps its temporary folder and
   * finishes normally.
   */
  async clear(): Promise<void> {
    this.failed.clear();
    for (const id of this.order.splice(0)) this.queued.delete(id);
    for (const e of await readdir(this.opts.dir).catch(() => [] as string[])) {
      const active = this.active;
      if (active && e === String(active.id)) {
        const fileDir = join(this.opts.dir, e);
        for (const sub of await readdir(fileDir).catch(() => [] as string[])) {
          if (join(fileDir, sub) !== active.tmp) await rm(join(fileDir, sub), { recursive: true, force: true });
        }
        continue;
      }
      await rm(join(this.opts.dir, e), { recursive: true, force: true });
    }
  }

  /**
   * The nightly job: drops folders of media files that no longer exist, then (with the setting on
   * `library`) queues every video file without current sheets, newest first. Returns a summary.
   */
  async nightly(): Promise<string> {
    const ids = new Set(
      this.opts.db
        .select({ id: mediaFiles.id })
        .from(mediaFiles)
        .all()
        .map((r) => r.id),
    );
    let removed = 0;
    for (const e of await readdir(this.opts.dir).catch(() => [] as string[])) {
      if (!/^\d+$/.test(e) || !ids.has(Number(e))) {
        await rm(join(this.opts.dir, e), { recursive: true, force: true });
        removed++;
      }
    }
    if (this.opts.settings().trickplay !== 'library') return `removed ${removed} stale folders`;
    const rows = this.opts.db
      .select({ id: mediaFiles.id, path: mediaFiles.path })
      .from(mediaFiles)
      .orderBy(desc(mediaFiles.dateAdded), desc(mediaFiles.id))
      .all();
    let queued = 0;
    for (const r of rows) {
      const stamp = await fileStamp(r.path);
      if (!stamp || this.failed.get(r.id) === stamp || (await this.ready(r.id, stamp))) continue;
      this.enqueue(r.id);
      queued++;
    }
    return `queued ${queued} files, removed ${removed} stale folders`;
  }
}
