import { execFile } from 'node:child_process';

// The one place the subtitles module starts processes (ffprobe, ffmpeg, ffsubsync, alass, the
// post-processing command). Never through a shell, always with a timeout. Tests inject a fake.

export interface RunOptions {
  timeoutMs: number;
  env?: Record<string, string> | undefined;
}

export interface RunResult {
  /** Exit code 0 and no spawn error. */
  ok: boolean;
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  /** Spawn failure (e.g. ENOENT) or kill reason. */
  error?: string | undefined;
}

export type ProcessRunner = (command: string, args: readonly string[], opts: RunOptions) => Promise<RunResult>;

const MAX_BUFFER = 64 * 1024 * 1024;

/** Default runner: `node:child_process` execFile, no shell, buffer output, kill on timeout. */
export const execFileRunner: ProcessRunner = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_BUFFER,
        encoding: 'buffer',
        windowsHide: true,
        shell: false,
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string }) | null;
        const timedOut = Boolean(e?.killed && e.signal === 'SIGKILL');
        const exitCode = e ? (typeof e.code === 'number' ? e.code : null) : 0;
        resolve({
          ok: !e,
          exitCode,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
          timedOut,
          ...(e ? { error: timedOut ? `timed out after ${opts.timeoutMs} ms` : e.message } : {}),
        });
      },
    );
  });
