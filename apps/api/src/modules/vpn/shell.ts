import { execFile } from 'node:child_process';

// Spawning external programs (wireguard.exe, wg.exe, PowerShell, netsh) goes through this
// injectable runner so tests can replay recorded outputs. No shell is involved: arguments are
// passed as an array, never interpolated into a command line.

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ShellOptions {
  timeoutMs?: number;
  /** Extra environment variables on top of the server's own. A value passed this way is never parsed as code. */
  env?: Record<string, string>;
}

export type ShellRunner = (file: string, args: readonly string[], opts?: ShellOptions) => Promise<ShellResult>;

export const nodeShellRunner: ShellRunner = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: opts.timeoutMs ?? 15_000, windowsHide: true, maxBuffer: 1024 * 1024, ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
          // ENOENT, EACCES, ...: the program could not be started at all.
          reject(err);
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/**
 * Quote a value for a single-quoted PowerShell string literal. PowerShell also treats the
 * "smart" single quotes U+2018 to U+201B as quote characters, so those are doubled too. Prefer
 * passing values through `ShellOptions.env` (`$env:NAME` in the script), which needs no quoting.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/['‘-‛]/g, (q) => q + q)}'`;
}
