import { chmodSync, readdirSync, statSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Logger } from 'pino';

// File modes for Arclight's own files in the config directory: the database (and its -wal/-shm
// side files), logs, backups, the secret key file and restore leftovers hold credentials, so they
// are owner-only (0600 files, 0700 folders) no matter what the process umask is.
//
// There is deliberately no process-wide `umask(0o077)`: media files, imported/organised files and
// downloads must stay readable by the other containers sharing those folders through PUID/PGID
// (Jellyfin, Plex, other *arr apps). Media code creates its files without an explicit mode, so it
// keeps following the umask the container or service was started with. Only the files below get
// explicit modes.

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

/** chmod is a no-op worth skipping on Windows (only the read-only bit exists there). */
const POSIX = process.platform !== 'win32';

/** Sets `mode` when it differs; quiet when the file is gone or not ours (EPERM). */
export function ensureModeSync(path: string, mode: number): boolean {
  if (!POSIX) return false;
  try {
    const st = statSync(path);
    if ((st.mode & 0o777) === mode) return false;
    chmodSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

export async function ensureMode(path: string, mode: number): Promise<void> {
  if (!POSIX) return;
  await chmod(path, mode).catch(() => undefined);
}

export interface HardenOptions {
  configDir: string;
  logDir: string;
  dbPath: string;
  /** The default backup folder inside the config dir (a custom folder elsewhere is not touched here). */
  backupDir?: string;
  log?: Logger;
}

/**
 * Startup, idempotent: tighten the modes of the config directory, the database files, logs, the
 * key file, restore leftovers and backups in the default folder. Existing installs created these
 * as 0644/0755; this fixes them in place on the first 0.24 start.
 */
export function hardenConfigDir(opts: HardenOptions): number {
  if (!POSIX) return 0;
  let changed = 0;
  const dir = (p: string) => (ensureModeSync(p, PRIVATE_DIR_MODE) ? changed++ : 0);
  const file = (p: string) => (ensureModeSync(p, PRIVATE_FILE_MODE) ? changed++ : 0);
  dir(opts.configDir);
  const dbName = basename(opts.dbPath);
  for (const name of safeList(opts.configDir)) {
    if (
      name === dbName ||
      name.startsWith(`${dbName}-`) ||
      name.startsWith(`${dbName}.`) ||
      name.startsWith('secrets.key') ||
      name.startsWith('.snapshot-') ||
      name.startsWith('.upload-')
    ) {
      file(join(opts.configDir, name));
    }
  }
  dir(opts.logDir);
  for (const name of safeList(opts.logDir)) file(join(opts.logDir, name));
  if (opts.backupDir) {
    dir(opts.backupDir);
    for (const name of safeList(opts.backupDir)) file(join(opts.backupDir, name));
  }
  if (changed > 0) opts.log?.info({ files: changed }, 'tightened permissions of config files (owner only)');
  return changed;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
