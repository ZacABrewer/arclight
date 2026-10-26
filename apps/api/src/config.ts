import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Runtime configuration comes from the environment only. Everything the user can change
// in the UI lives in the settings table, not here.
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
   * the "Built-in" client). loadConfig turns it on unless MEDIATRON_TORRENT_ENGINE=0; configs built
   * by hand (tests) leave it undefined, which means off, so tests never open sockets by accident.
   */
  torrentEngine?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isDocker = existsSync('/.dockerenv') || env['MEDIATRON_DOCKER'] === '1';
  const configDir = resolve(env['MEDIATRON_CONFIG'] ?? (isDocker ? '/config' : './config'));
  const logDir = join(configDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  const webDist = env['MEDIATRON_WEB_DIST'] ? resolve(env['MEDIATRON_WEB_DIST']) : null;

  return {
    configDir,
    dbPath: join(configDir, 'media-tron.db'),
    logDir,
    port: Number(env['MEDIATRON_PORT'] ?? 7878),
    host: env['MEDIATRON_HOST'] ?? '0.0.0.0',
    logLevel: env['MEDIATRON_LOG_LEVEL'] ?? 'info',
    isDocker,
    webDist,
    torrentEngine: env['MEDIATRON_TORRENT_ENGINE'] !== '0',
  };
}
