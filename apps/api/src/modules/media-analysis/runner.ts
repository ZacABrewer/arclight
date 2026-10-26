import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaInfo } from '@arclight/shared';
import type { Probe, ProbeResult } from '../imports/index.js';
import { needsFrameProbe, parseFfprobeOutput } from './parse.js';

// Locating and running ffprobe. The process call is injectable (`exec`) so tests feed recorded
// JSON instead of spawning anything.

export class FfprobeError extends Error {
  constructor(
    readonly code: 'MISSING' | 'FAILED' | 'PARSE',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FfprobeError';
  }
}

export type ExecFn = (file: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<{ stdout: string }>;

export const nodeExec: ExecFn = (file, args, opts) =>
  new Promise((resolvePromise, reject) => {
    execFile(file, [...args], { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? '').trim().split(/\r?\n/).slice(-1)[0];
        reject(new FfprobeError('FAILED', detail || err.message, { cause: err }));
      } else resolvePromise({ stdout: String(stdout) });
    });
  });

export type FileExists = (path: string) => Promise<boolean>;

const executable: FileExists = async (path) => {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Find ffprobe: `ARCLIGHT_FFPROBE` when set (and present), else the first `ffprobe` (plus
 * `.exe` on Windows) on PATH. Null when neither exists.
 */
export async function locateFfprobe(
  env: NodeJS.ProcessEnv = process.env,
  exists: FileExists = executable,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const explicit = env['ARCLIGHT_FFPROBE']?.trim();
  if (explicit) return (await exists(explicit)) ? explicit : null;
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? ['ffprobe.exe', 'ffprobe'] : ['ffprobe'];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

export interface FfprobeRunnerOptions {
  /** Explicit binary; skips the lookup. */
  binary?: string;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  exists?: FileExists;
  timeoutMs?: number;
}

/** What the queue needs from a probe backend (tests can supply a plain object). */
export interface MediaProber {
  /** Resolved binary path; null when ffprobe is missing. */
  locate(): Promise<string | null>;
  analyze(path: string): Promise<MediaInfo>;
}

export class FfprobeRunner implements MediaProber {
  private readonly exec: ExecFn;
  private readonly timeoutMs: number;
  private located: Promise<string | null> | null = null;

  constructor(private readonly opts: FfprobeRunnerOptions = {}) {
    this.exec = opts.exec ?? nodeExec;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Cached lookup; call `relocate()` after installing ffprobe. */
  locate(): Promise<string | null> {
    if (this.opts.binary) return Promise.resolve(this.opts.binary);
    this.located ??= locateFfprobe(this.opts.env, this.opts.exists);
    return this.located;
  }

  relocate(): Promise<string | null> {
    this.located = null;
    return this.locate();
  }

  async available(): Promise<boolean> {
    return (await this.locate()) !== null;
  }

  private async binary(): Promise<string> {
    const bin = await this.locate();
    if (!bin) throw new FfprobeError('MISSING', 'ffprobe was not found (install ffmpeg or set ARCLIGHT_FFPROBE)');
    return bin;
  }

  /** Full analysis: streams + format, plus the first video frame's side data for PQ content. */
  async analyze(path: string): Promise<MediaInfo> {
    const bin = await this.binary();
    const { stdout } = await this.exec(
      bin,
      ['-v', 'error', '-hide_banner', '-print_format', 'json', '-show_format', '-show_streams', path],
      { timeoutMs: this.timeoutMs },
    );
    let frames: string | null = null;
    try {
      if (needsFrameProbe(stdout)) {
        frames = (
          await this.exec(
            bin,
            ['-v', 'error', '-print_format', 'json', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames', '-show_entries', 'frame=side_data_list', path],
            { timeoutMs: this.timeoutMs },
          )
        ).stdout;
      }
    } catch {
      frames = null; // HDR10+ detection is best effort
    }
    try {
      return parseFfprobeOutput(stdout, frames);
    } catch (err) {
      throw new FfprobeError('PARSE', err instanceof Error ? err.message : String(err), { cause: err });
    }
  }

  /** Duration in seconds (container), or null when unreadable. Cheap: format only. */
  async probeDuration(path: string): Promise<number | null> {
    try {
      const bin = await this.binary();
      const { stdout } = await this.exec(bin, ['-v', 'error', '-print_format', 'json', '-show_entries', 'format=duration', path], {
        timeoutMs: this.timeoutMs,
      });
      const d = Number((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration);
      return Number.isFinite(d) && d >= 0 ? d : null;
    } catch {
      return null;
    }
  }
}

/** MediaInfo -> the imports module's ProbeResult. */
export function toProbeResult(info: MediaInfo): ProbeResult {
  const result: ProbeResult = { runtimeSeconds: info.runtimeSeconds ?? null };
  if (info.audioStreamCount != null) result.audioStreams = info.audioStreamCount;
  if (info.width != null) result.width = info.width;
  if (info.height != null) result.height = info.height;
  if (info.videoFormat) result.videoCodec = info.videoFormat;
  if (info.audioFormat) result.audioCodec = info.audioFormat;
  if (info.audioStreams?.[0]?.channels != null) result.audioChannels = info.audioStreams[0].channels;
  return result;
}

/**
 * A probe for the imports decision (sample detection uses the real runtime). Resolves null when
 * the file cannot be read, which imports treat as SampleIndeterminate.
 */
export function createAnalysisProbe(runner: Pick<FfprobeRunner, 'analyze'>): Probe {
  return async (path) => {
    try {
      return toProbeResult(await runner.analyze(path));
    } catch {
      return null;
    }
  };
}
