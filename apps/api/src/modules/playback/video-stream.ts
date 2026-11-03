import { execFile } from 'node:child_process';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { TranscodeHwaccel } from '@arclight/shared';
import { FfmpegRunner, parseHwaccels } from '../transcode/runner.js';
import { testBackends } from '../transcode/hwaccel.js';
import { buildSubtitleArgs, buildThumbnailArgs } from './video-info.js';

// The machinery behind live video: which encoder backend to use (the transcode module's
// capability test, run once on first use), the WebVTT and thumbnail disk caches, and a helper
// that waits for ffmpeg's first output so a failing hardware encoder can be retried in software.

/** Hardware backends tried for live video, in order; software is the fallback. */
export const LIVE_HW_ORDER: readonly TranscodeHwaccel[] = ['qsv', 'vaapi', 'nvenc', 'videotoolbox'];

export interface EncoderChoice {
  hwaccel: TranscodeHwaccel;
  /** ffmpeg has zscale (software HDR tone-mapping). */
  zscale: boolean;
}

export type Exec = (bin: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

export const nodeExec: Exec = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(bin, [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

export interface EncoderDetectorOptions {
  /** Test seam: the available backends without running ffmpeg. */
  detect?: (bin: string) => Promise<EncoderChoice>;
}

/**
 * Picks the live encoder once per process: the first hardware backend whose capability test
 * passes (the transcode module's one-frame encode), else software. A backend that fails on a
 * real stream is dropped for the rest of the process (markBroken).
 */
export class EncoderDetector {
  private choice: Promise<EncoderChoice> | undefined;
  private readonly broken = new Set<TranscodeHwaccel>();

  constructor(private readonly opts: EncoderDetectorOptions = {}) {}

  async pick(bin: string): Promise<EncoderChoice> {
    this.choice ??= (this.opts.detect ?? detectEncoders)(bin).catch(() => ({ hwaccel: 'none' as const, zscale: false }));
    const c = await this.choice;
    return this.broken.has(c.hwaccel) ? { ...c, hwaccel: 'none' } : c;
  }

  markBroken(hw: TranscodeHwaccel): void {
    if (hw !== 'none') this.broken.add(hw);
  }
}

async function detectEncoders(bin: string): Promise<EncoderChoice> {
  const runner = new FfmpegRunner({ binary: bin });
  let methods: string[] = [];
  let filters = '';
  try {
    methods = parseHwaccels(await runner.exec(bin, ['-hide_banner', '-hwaccels']));
    filters = await runner.exec(bin, ['-hide_banner', '-filters']);
  } catch {
    // No hwaccel list: software only.
  }
  const zscale = /\szscale\s/.test(filters);
  const status = methods.length > 0 ? await testBackends(runner, bin, methods, { timeoutMs: 15_000 }) : [];
  const ok = new Set(status.filter((s) => s.available).map((s) => s.backend));
  const hwaccel = LIVE_HW_ORDER.find((b) => ok.has(b)) ?? 'none';
  return { hwaccel, zscale };
}

/**
 * Resolves with ffmpeg's first chunk (put back on the stream before returning), or null when the
 * stream ended without any output: ffmpeg failed before writing anything.
 */
export function firstOutput(stream: Readable): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onEnd);
      resolve(ok);
    };
    const onReadable = () => {
      const chunk = stream.read() as Buffer | null;
      if (chunk === null) return;
      stream.unshift(chunk);
      done(true);
    };
    const onEnd = () => done(false);
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.once('error', onEnd);
  });
}

// ---- disk caches --------------------------------------------------------------------------------

/** A file's identity for cache keys: size and mtime, so a replaced file gets a new entry. */
export async function fileStamp(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    return `${s.size}-${Math.round(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** True when `buf` is valid UTF-8 (external subtitles in another charset get a hint for ffmpeg). */
export function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

async function readHead(path: string, bytes = 256 * 1024): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export interface MediaCacheOptions {
  /** configDir/cache/player */
  dir: string;
  locate: () => Promise<string | null>;
  exec?: Exec;
}

export class MediaCacheError extends Error {
  constructor(
    readonly code: 'FFMPEG_MISSING' | 'CONVERT_FAILED' | 'SOURCE_MISSING',
    message: string,
  ) {
    super(message);
  }
}

/**
 * WebVTT conversions and episode thumbnails, made by ffmpeg once and kept on disk. Concurrent
 * requests for the same entry share one ffmpeg run. Writes go to a temp file renamed into place,
 * so a killed run never leaves half a file behind.
 */
export class MediaCache {
  private readonly exec: Exec;
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly opts: MediaCacheOptions) {
    this.exec = opts.exec ?? nodeExec;
  }

  private async make(sub: string, name: string, build: (bin: string, tmp: string) => Promise<readonly string[]>, timeoutMs: number): Promise<string> {
    const dir = join(this.opts.dir, sub);
    const target = join(dir, name);
    try {
      await stat(target);
      return target;
    } catch {
      // not cached yet
    }
    const running = this.pending.get(target);
    if (running) return running;
    const job = (async () => {
      const bin = await this.opts.locate();
      if (!bin) throw new MediaCacheError('FFMPEG_MISSING', 'ffmpeg was not found (set ARCLIGHT_FFMPEG or put ffmpeg on PATH)');
      await mkdir(dir, { recursive: true });
      const ext = name.slice(name.lastIndexOf('.'));
      const tmp = join(dir, `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
      const res = await this.exec(bin, await build(bin, tmp), timeoutMs);
      let size = 0;
      try {
        size = (await stat(tmp)).size;
      } catch {
        size = 0;
      }
      if (res.code !== 0 || size === 0) {
        await rm(tmp, { force: true });
        throw new MediaCacheError('CONVERT_FAILED', 'ffmpeg could not convert this file');
      }
      await rename(tmp, target);
      return target;
    })().finally(() => this.pending.delete(target));
    this.pending.set(target, job);
    return job;
  }

  /**
   * The WebVTT file of a subtitle: an embedded text stream (ordinal) of `video`, or an external
   * file. Embedded streams need the whole container read once, hence the long timeout.
   */
  async subtitle(source: { kind: 'embedded'; mediaFileId: number; path: string; ordinal: number } | { kind: 'external'; subtitleId: number; path: string }): Promise<string> {
    const stamp = await fileStamp(source.path);
    if (!stamp) throw new MediaCacheError('SOURCE_MISSING', 'the subtitle source is missing on disk');
    const name = source.kind === 'embedded' ? `f${source.mediaFileId}-e${source.ordinal}-${stamp}.vtt` : `x${source.subtitleId}-${stamp}.vtt`;
    return this.make(
      'subtitles',
      name,
      async (_bin, tmp) => {
        if (source.kind === 'embedded') return buildSubtitleArgs(source.path, source.ordinal, tmp);
        // ffmpeg reads text subtitles as UTF-8; older .srt files are often Windows-1252.
        const charset = isUtf8(await readHead(source.path)) ? undefined : 'CP1252';
        return buildSubtitleArgs(source.path, null, tmp, charset);
      },
      15 * 60_000,
    );
  }

  /** A JPEG frame of `path` at ~15 % of `durationMs`, 480 px wide. */
  async thumbnail(mediaFileId: number, path: string, durationMs: number): Promise<string> {
    const stamp = await fileStamp(path);
    if (!stamp) throw new MediaCacheError('SOURCE_MISSING', 'the video file is missing on disk');
    const at = durationMs > 0 ? Math.round(durationMs * 0.15) : 60_000;
    return this.make('thumbs', `f${mediaFileId}-${stamp}.jpg`, async (_bin, tmp) => buildThumbnailArgs(path, at, tmp), 60_000);
  }
}
