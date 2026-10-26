import type { MigrateApp, MigrateSource } from '@arclight/shared';
import { readArrApi } from './api/arr-api.js';
import { readBazarrApi } from './api/bazarr-api.js';
import { readSeerrApi } from './api/seerr-api.js';
import { readBazarr } from './bazarr-reader.js';
import { MigrateError } from './errors.js';
import type { MigrateDeps } from './deps.js';
import { SourceHttp } from './http.js';
import { readProwlarr } from './prowlarr-reader.js';
import { readQbittorrent } from './qbittorrent-reader.js';
import { readRadarr } from './radarr-reader.js';
import { readSeerr } from './seerr-reader.js';
import { readSonarr } from './sonarr-reader.js';
import type { SourceBundle } from './types.js';

// One entry point that turns a source (files or API) into the normalised SourceBundle the
// service plans and applies. File readers are synchronous SQLite reads; API readers fetch the
// same data over HTTP and map it through the same mappers.

/** What readers may use besides the source itself (HTTP for API mode, the indexer catalogue). */
export type ReadDeps = Pick<MigrateDeps, 'fetch' | 'findDefinition' | 'ctx'>;

export const APP_NAMES: Record<MigrateApp, string> = {
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  prowlarr: 'Prowlarr',
  bazarr: 'Bazarr',
  seerr: 'Overseerr / Jellyseerr',
  qbittorrent: 'qBittorrent',
};

/** API path prefix per app (the URL the user enters is the app root, with any URL base). */
export const API_PREFIX: Record<Exclude<MigrateApp, 'qbittorrent'>, string> = {
  sonarr: '/api/v3',
  radarr: '/api/v3',
  prowlarr: '/api/v1',
  bazarr: '/api',
  seerr: '/api/v1',
};

/** HTTP client for an API-mode source, with the app's auth header (qBittorrent logs in separately). */
export function httpFor(source: MigrateSource, deps: ReadDeps = {}, opts: { timeoutMs?: number; concurrency?: number } = {}): SourceHttp {
  if (!source.url) throw new MigrateError('VALIDATION', 'a URL is required when using the API');
  const headers: Record<string, string> = {};
  if (source.apiKey && source.app !== 'qbittorrent') headers[source.app === 'bazarr' ? 'X-API-KEY' : 'X-Api-Key'] = source.apiKey;
  return new SourceHttp({
    baseUrl: source.url,
    headers,
    appName: APP_NAMES[source.app],
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  });
}

function requireDbPath(source: MigrateSource): string {
  if (!source.dbPath) throw new MigrateError('VALIDATION', 'a database path is required when reading files');
  return source.dbPath;
}

export async function readSource(source: MigrateSource, deps: ReadDeps = {}): Promise<SourceBundle> {
  if (source.app === 'qbittorrent') return readQbittorrent(source, deps);
  if (source.mode === 'api') {
    const http = httpFor(source, deps);
    switch (source.app) {
      case 'sonarr':
      case 'radarr':
      case 'prowlarr':
        return readArrApi(source, http, deps);
      case 'bazarr':
        return readBazarrApi(source, http, deps);
      case 'seerr':
        return readSeerrApi(source, http, deps);
    }
  }
  const dbPath = requireDbPath(source);
  switch (source.app) {
    case 'sonarr':
      return readSonarr(dbPath, source.pathMappings);
    case 'radarr':
      return readRadarr(dbPath, source.pathMappings);
    case 'prowlarr':
      return readProwlarr(dbPath, source.configPath, source.pathMappings, deps);
    case 'bazarr':
      return readBazarr(dbPath, source.configPath, source.pathMappings);
    case 'seerr':
      return readSeerr(dbPath, source.configPath, source.pathMappings);
  }
}
