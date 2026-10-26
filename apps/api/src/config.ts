import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Runtime configuration comes from the environment only. Everything the user can change
// in the UI lives in the settings table, not here.

export const DB_FILE_NAME = 'arclight.db';

export interface AppConfig {
  configDir: string;
  dbPath: string;
  logDir: string;
  port: number;
  host: string;
  logLevel: string;
  isDocker: boolean;
  /** Absolute path of the built web app to serve, or null in dev (Vite serves it). */
  webDist: string | null;
  /**
   * Boot-time torrent engine side effects (start the Session when `torrent.enabled`, auto-register
   * the "Built-in" client). loadConfig turns it on unless ARCLIGHT_TORRENT_ENGINE=0; configs built
   * by hand (tests) leave it undefined, which means off, so tests never open sockets by accident.
   */
  torrentEngine?: boolean;
}

/**
 * Env vars read outside this file (TMDB key, VPN control URL, migrate dirs). loadConfig copies
 * each MEDIATRON_<NAME> to ARCLIGHT_<NAME> when only the old one is set, so those readers only
 * ever look at the ARCLIGHT_ name.
 */
const PROMOTED_ENV = ['TMDB_API_KEY', 'VPN_CONTROL_URL', 'MIGRATE_DIRS'] as const;

/** ARCLIGHT_<name>, else the pre-rename MEDIATRON_<name>. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Deprecated fallback: MEDIATRON_* names from before the rename; removal tracked in docs/ROADMAP.md Phase 6.
  return env[`ARCLIGHT_${name}`] ?? env[`MEDIATRON_${name}`];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  for (const name of PROMOTED_ENV) {
    const value = readEnv(env, name);
    if (value !== undefined) env[`ARCLIGHT_${name}`] = value;
  }
  const isDocker = existsSync('/.dockerenv') || readEnv(env, 'DOCKER') === '1';
  const configDir = resolve(readEnv(env, 'CONFIG') ?? (isDocker ? '/config' : './config'));
  const logDir = join(configDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  const webDistEnv = readEnv(env, 'WEB_DIST');
  const webDist = webDistEnv ? resolve(webDistEnv) : null;

  return {
    configDir,
    dbPath: join(configDir, DB_FILE_NAME),
    logDir,
    port: Number(readEnv(env, 'PORT') ?? 7878),
    host: readEnv(env, 'HOST') ?? '0.0.0.0',
    logLevel: readEnv(env, 'LOG_LEVEL') ?? 'info',
    isDocker,
    webDist,
    torrentEngine: readEnv(env, 'TORRENT_ENGINE') !== '0',
  };
}
