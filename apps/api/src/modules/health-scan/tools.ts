import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { posix } from 'node:path';
import { locateFfprobe, parseFfprobeOutput } from '../media-analysis/index.js';
import { locateFfmpeg } from '../transcode/runner.js';
import { decodeArgs, decodeSlices, withLowPriority, type DecodeOutcome, type FileKind, type PriorityTools, type ProbeOutcome } from './checks.js';
import type { HealthScanMode } from '@arclight/shared';

// The processes the health scan runs: ffprobe (container + streams) and ffmpeg (decode to
// null). Both go through `nice -n 19 ionice -c 3` when asked and when those exist (Linux; on
// other systems, or a container without them, the command runs as is). Tests replace the whole
// HealthTools object, or only the process call (`run`).

export interface RunResult {
  /** null when killed (signal, timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type ProcessFn = (file: string, args: readonly string[], opts: { signal?: AbortSignal | undefined; timeoutMs: number }) => Promise<RunResult>;

export interface ToolOptions {
  lowPriority: boolean;
  signal?: AbortSignal | undefined;
}

/** What the scan needs from the outside world besides the file system. */
export interface HealthTools {
  available(): Promise<{ ffprobe: boolean; ffmpeg: boolean }>;
  /** null when ffprobe is missing. */
  probe(path: string, opts: ToolOptions): Promise<ProbeOutcome>;
  /** null when ffmpeg is missing. */
  decode(path: string, kind: FileKind, mode: HealthScanMode, durationSeconds: number | null, opts: ToolOptions): Promise<DecodeOutcome>;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

export const spawnProcess: ProcessFn = (file, args, opts) =>
  new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(file, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise(r);
    };
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const onAbort = () => kill();
    const timer = setTimeout(kill, opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on('error', (err) => finish({ exitCode: -1, stdout, stderr: stderr || err.message }));
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr }));
  });

type Exists = (path: string) => Promise<boolean>;

const executable: Exists = async (path) => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `nice` / `ionice` on PATH. Linux only: elsewhere both are null. */
export async function locatePriorityTools(env: NodeJS.ProcessEnv = process.env, exists: Exists = executable, platform: NodeJS.Platform = process.platform): Promise<PriorityTools> {
  if (platform !== 'linux') return { nice: null, ionice: null };
  const find = async (name: string): Promise<string | null> => {
    for (const dir of (env['PATH'] ?? '').split(':')) {
      if (!dir) continue;
      const candidate = posix.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
    return null;
  };
  return { nice: await find('nice'), ionice: await find('ionice') };
}

/**
 * ffmpeg messages that do not mean the file is damaged: its own repeat summaries, HEVC
 * parameter-set changes (normal in Dolby Vision and some 4K remuxes), and missing references
 * right after a seek into an open GOP (quick mode starts mid-file). Real damage shows up as
 * other errors (invalid NAL units, corrupt frames, decode failures).
 */
const BENIGN = [/^Last message repeated \d+ times?$/i, /PPS changed between slices/i, /Could not find ref with POC/i];

/** Error lines of ffmpeg's stderr (`-v error`), blank and harmless lines dropped. */
export function errorLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !BENIGN.some((re) => re.test(l)));
}

export interface FfmpegHealthToolsOptions {
  run?: ProcessFn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: Exists;
  /** Overrides the lookups (tests). */
  binaries?: { ffprobe: string | null; ffmpeg: string | null; nice?: string | null; ionice?: string | null };
  probeTimeoutMs?: number;
  /** Per quick slice. Deep decodes get `deepTimeoutMs`. */
  sliceTimeoutMs?: number;
  deepTimeoutMs?: number;
}

export class FfmpegHealthTools implements HealthTools {
  private readonly run: ProcessFn;
  private located: Promise<{ ffprobe: string | null; ffmpeg: string | null } & PriorityTools> | null = null;

  constructor(private readonly opts: FfmpegHealthToolsOptions = {}) {
    this.run = opts.run ?? spawnProcess;
  }

  private locate() {
    this.located ??= (async () => {
      const b = this.opts.binaries;
      if (b) return { ffprobe: b.ffprobe, ffmpeg: b.ffmpeg, nice: b.nice ?? null, ionice: b.ionice ?? null };
      const [ffprobe, ffmpeg, priority] = await Promise.all([
        locateFfprobe(this.opts.env, this.opts.exists, this.opts.platform),
        locateFfmpeg(this.opts.env, this.opts.exists, this.opts.platform),
        locatePriorityTools(this.opts.env, this.opts.exists, this.opts.platform),
      ]);
      return { ffprobe, ffmpeg, ...priority };
    })();
    return this.located;
  }

  async available() {
    const l = await this.locate();
    return { ffprobe: l.ffprobe !== null, ffmpeg: l.ffmpeg !== null };
  }

  private command(binary: string, args: readonly string[], lowPriority: boolean, tools: PriorityTools) {
    return lowPriority ? withLowPriority(binary, args, tools) : { file: binary, args: [...args] };
  }

  async probe(path: string, opts: ToolOptions): Promise<ProbeOutcome> {
    const l = await this.locate();
    if (!l.ffprobe) return null;
    const cmd = this.command(l.ffprobe, ['-v', 'error', '-hide_banner', '-print_format', 'json', '-show_format', '-show_streams', path], opts.lowPriority, l);
    const r = await this.run(cmd.file, cmd.args, { signal: opts.signal, timeoutMs: this.opts.probeTimeoutMs ?? 60_000 });
    if (opts.signal?.aborted) throw new Error('aborted');
    if (r.exitCode !== 0) return { ok: false, message: errorLines(r.stderr).slice(-1)[0] ?? `ffprobe exited with ${r.exitCode ?? 'a signal'}` };
    try {
      const info = parseFfprobeOutput(r.stdout);
      return {
        ok: true,
        info: {
          durationSeconds: info.durationMs != null ? info.durationMs / 1000 : null,
          hasVideo: info.videoFormat != null,
          audioStreamCount: info.audioStreamCount ?? 0,
          audioLanguages: (info.audioStreams ?? []).map((a) => a.language).filter((x): x is string => !!x),
        },
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async decode(path: string, kind: FileKind, mode: HealthScanMode, durationSeconds: number | null, opts: ToolOptions): Promise<DecodeOutcome> {
    const l = await this.locate();
    if (!l.ffmpeg) return null;
    const errors: string[] = [];
    let exitCode: number | null = 0;
    for (const slice of decodeSlices(mode, durationSeconds)) {
      const cmd = this.command(l.ffmpeg, decodeArgs(path, slice, kind), opts.lowPriority, l);
      const timeoutMs = slice.length === null ? (this.opts.deepTimeoutMs ?? 6 * 3600_000) : (this.opts.sliceTimeoutMs ?? 10 * 60_000);
      const r = await this.run(cmd.file, cmd.args, { signal: opts.signal, timeoutMs });
      if (opts.signal?.aborted) throw new Error('aborted');
      errors.push(...errorLines(r.stderr));
      if (r.exitCode !== 0) {
        exitCode = r.exitCode;
        break;
      }
    }
    return { exitCode, errors };
  }
}
