import { existsSync, statSync } from 'node:fs';
import { MigrateSource, type MigrateApp, type MigrateSourceInput, type MigrateTestResult } from '@arclight/shared';
import { arrSchemaVersion } from './arr-common.js';
import { MigrateError } from './errors.js';
import { ForeignDb } from './foreign-db.js';
import { testQbittorrent } from './qbittorrent-reader.js';
import { API_PREFIX, APP_NAMES, httpFor, type ReadDeps } from './readers.js';

// "Test" on the connect step: is the source there, is it the app the user picked, and does it
// accept the key? Reads only (status endpoints, or the database's table list).

const ARR_APP_NAMES: Record<string, MigrateApp> = { sonarr: 'sonarr', radarr: 'radarr', prowlarr: 'prowlarr' };

function fail(app: MigrateApp, message: string, detected: MigrateApp | null = null, version: string | null = null): MigrateTestResult {
  return { ok: false, app, version, detected, message };
}

/** Which app a SQLite database belongs to, from its tables. */
export function detectDatabaseApp(db: ForeignDb): MigrateApp | null {
  if (db.hasTable('Series') && db.hasTable('Episodes')) return 'sonarr';
  if (db.hasTable('Indexers') && db.hasTable('Applications')) return 'prowlarr';
  if (db.hasTable('Movies')) return 'radarr';
  if (db.hasTable('table_languages_profiles') || db.hasTable('table_history')) return 'bazarr';
  if (db.hasTable('media_request') && db.hasTable('user')) return 'seerr';
  return null;
}

function testFiles(source: MigrateSource): MigrateTestResult {
  const path = source.dbPath ?? '';
  if (!existsSync(path)) return fail(source.app, `${path} was not found inside the Arclight container (is the folder mounted?)`);
  if (statSync(path).isDirectory()) return fail(source.app, `${path} is a folder; pick the database file inside it`);
  let db: ForeignDb;
  try {
    db = ForeignDb.open(path);
  } catch (err) {
    return fail(source.app, err instanceof Error ? err.message : String(err));
  }
  try {
    const detected = detectDatabaseApp(db);
    const version = detected === 'bazarr' ? String(db.scalar('SELECT version_num FROM alembic_version') ?? '') || null : detected === 'seerr' ? null : arrSchemaVersion(db);
    if (detected !== source.app) {
      return fail(source.app, detected ? `this is a ${APP_NAMES[detected]} database, not ${APP_NAMES[source.app]}` : `this does not look like a ${APP_NAMES[source.app]} database`, detected, version);
    }
    if (source.configPath && !existsSync(source.configPath)) return { ok: true, app: source.app, version, detected: null, message: `the config file ${source.configPath} was not found; some details (API keys, providers) will be missing` };
    return { ok: true, app: source.app, version, detected: null, message: null };
  } finally {
    db.close();
  }
}

async function testApi(source: MigrateSource, deps: ReadDeps): Promise<MigrateTestResult> {
  const app = source.app;
  const http = httpFor(source, deps, { timeoutMs: 10_000 });
  try {
    switch (app) {
      case 'sonarr':
      case 'radarr':
      case 'prowlarr': {
        const status = await http.json<{ appName?: string; version?: string }>(`${API_PREFIX[app]}/system/status`);
        const name = (status?.appName ?? '').toLowerCase();
        const detected = ARR_APP_NAMES[name] ?? null;
        const version = status?.version ?? null;
        if (detected && detected !== app) return fail(app, `this is ${APP_NAMES[detected]}, not ${APP_NAMES[app]}`, detected, version);
        if (!status || typeof status !== 'object' || !version) return fail(app, `the answer does not look like ${APP_NAMES[app]}`);
        return { ok: true, app, version, detected: null, message: null };
      }
      case 'bazarr': {
        const status = await http.json<{ data?: { bazarr_version?: string } }>(`${API_PREFIX.bazarr}/system/status`);
        const version = status?.data?.bazarr_version ?? null;
        if (!version) return fail(app, 'the answer does not look like Bazarr');
        return { ok: true, app, version, detected: null, message: null };
      }
      case 'seerr': {
        const status = await http.json<{ version?: string }>(`${API_PREFIX.seerr}/status`);
        if (!status?.version) return fail(app, 'the answer does not look like Overseerr or Jellyseerr');
        // The status endpoint is public; this one checks the API key.
        await http.json(`${API_PREFIX.seerr}/settings/main`);
        return { ok: true, app, version: status.version, detected: null, message: null };
      }
      case 'qbittorrent':
        return testQbittorrent(source, deps);
    }
  } catch (err) {
    if (err instanceof MigrateError) return fail(app, err.message);
    throw err;
  }
}

export async function testSource(input: MigrateSourceInput, deps: ReadDeps = {}): Promise<MigrateTestResult> {
  const source = MigrateSource.parse(input);
  if (source.app === 'qbittorrent') return testQbittorrent(source, deps);
  return source.mode === 'api' ? testApi(source, deps) : testFiles(source);
}
