import { execFile } from 'node:child_process';

// Spawning external programs (wireguard.exe, wg.exe, PowerShell, netsh) goes through this
// injectable runner so tests can replay recorded outputs. No shell is involved: arguments are
// passed as an array, never interpolated into a command line.

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (file: string, args: readonly string[], opts?: { timeoutMs?: number }) => Promise<ShellResult>;

export const nodeShellRunner: ShellRunner = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: opts.timeoutMs ?? 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
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

/** Quote a value for a single-quoted PowerShell string literal. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
