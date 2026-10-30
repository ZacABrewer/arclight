import { execFile, spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { TranscodeHwaccel } from '@arclight/shared';

// Locating and running ffmpeg. Modeled on the media-analysis ffprobe runner: the process layer
// is an interface so tests drive jobs with a fake (no ffmpeg needed).

export class FfmpegError extends Error {
  constructor(
    readonly code: 'MISSING' | 'FAILED',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FfmpegError';
  }
}

export interface ProcessResult {
  /** Exit code; null when killed by a signal. */
  exitCode: number | null;
  /** Last lines of stderr (for the job message). */
  stderrTail: string;
  /** The last 8 KB of stderr (hardware-failure detection looks past the tail). */
  stderr?: string;
}

export interface RunningProcess {
  done: Promise<ProcessResult>;
  /** Terminates the process (SIGTERM, then SIGKILL after a grace period). */
  kill(): void;
}

/** What the transcode service needs from an ffmpeg backend (tests supply a fake). */
export interface TranscodeRunner {
  /** Resolved binary path; null when ffmpeg is missing. */
  locate(): Promise<string | null>;
  /** Starts ffmpeg; `onStdout` receives the `-progress pipe:1` stream. */
  start(binary: string, args: readonly string[], onStdout: (chunk: string) => void): RunningProcess;
  /** Runs ffmpeg to completion and returns stdout (short commands such as `-hwaccels`). */
  exec(binary: string, args: readonly string[]): Promise<string>;
}

export type ExecFn = (file: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<{ stdout: string }>;

const nodeExec: ExecFn = (file, args, opts) =>
  new Promise((resolvePromise, reject) => {
    execFile(file, [...args], { timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? '').trim().split(/\r?\n/).slice(-1)[0];
        reject(new FfmpegError('FAILED', detail || err.message, { cause: err }));
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
 * Find ffmpeg: `ARCLIGHT_FFMPEG` when set; else the `ffmpeg` next to `ARCLIGHT_FFPROBE` when
 * that is set (same name with `ffprobe` replaced); else the first `ffmpeg` on PATH.
 */
export async function locateFfmpeg(
  env: NodeJS.ProcessEnv = process.env,
  exists: FileExists = executable,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const explicit = env['ARCLIGHT_FFMPEG']?.trim();
  if (explicit) return (await exists(explicit)) ? explicit : null;
  const probe = env['ARCLIGHT_FFPROBE']?.trim();
  if (probe) {
    const name = basename(probe).replace(/ffprobe/i, 'ffmpeg');
    const sibling = join(dirname(probe), name === basename(probe) ? (platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : name);
    if (await exists(sibling)) return sibling;
  }
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const n of names) {
      const candidate = join(dir.replace(/^"|"$/g, ''), n);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

/** `ffmpeg -hide_banner -hwaccels` output -> method names. */
export function parseHwaccels(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim());
  const start = lines.findIndex((l) => /^hardware acceleration methods:?$/i.test(l));
  return [...new Set(lines.slice(start + 1).filter((l) => /^[a-z0-9_]+$/i.test(l)))];
}

/** ffmpeg hwaccel methods -> the rule backends they enable. */
export function backendsFor(methods: readonly string[]): TranscodeHwaccel[] {
  const set = new Set(methods.map((m) => m.toLowerCase()));
  const out: TranscodeHwaccel[] = ['none'];
  if (set.has('vaapi')) out.push('vaapi');
  if (set.has('qsv')) out.push('qsv');
  if (set.has('cuda') || set.has('nvdec')) out.push('nvenc');
  if (set.has('videotoolbox')) out.push('videotoolbox');
  return out;
}

export interface FfmpegRunnerOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  exists?: FileExists;
  exec?: ExecFn;
  /** Grace period between SIGTERM and SIGKILL on cancel. Default 5 s. */
  killGraceMs?: number;
}

export class FfmpegRunner implements TranscodeRunner {
  private located: Promise<string | null> | null = null;
  private readonly execFn: ExecFn;

  constructor(private readonly opts: FfmpegRunnerOptions = {}) {
    this.execFn = opts.exec ?? nodeExec;
  }

  locate(): Promise<string | null> {
    if (this.opts.binary) return Promise.resolve(this.opts.binary);
    this.located ??= locateFfmpeg(this.opts.env, this.opts.exists);
    return this.located;
  }

  relocate(): Promise<string | null> {
    this.located = null;
    return this.locate();
  }

  start(binary: string, args: readonly string[], onStdout: (chunk: string) => void): RunningProcess {
    const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    const done = new Promise<ProcessResult>((resolvePromise) => {
      child.on('error', (err) => resolvePromise({ exitCode: -1, stderrTail: err.message }));
      child.on('close', (code) => resolvePromise({ exitCode: code, stderrTail: tail(stderr), stderr }));
    });
    const grace = this.opts.killGraceMs ?? 5000;
    return {
      done,
      kill: () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, grace);
        timer.unref();
      },
    };
  }

  async exec(binary: string, args: readonly string[]): Promise<string> {
    return (await this.execFn(binary, args, { timeoutMs: 15_000 })).stdout;
  }
}

function tail(text: string, lines = 5): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}
