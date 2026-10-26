import { MIGRATE_SECRET_MASK, type MigrateArea, type MigrateSource, type MigrationWarning } from '@arclight/shared';
import { ARR_VERSION_SQL } from '../arr-common.js';
import { MigrateError } from '../errors.js';
import { MemoryTables, type ForeignRow } from '../foreign-db.js';
import { fetchAllPages, type SourceHttp } from '../http.js';
import { readProwlarrTables } from '../prowlarr-reader.js';
import { readRadarrTables } from '../radarr-reader.js';
import type { ReadDeps } from '../readers.js';
import { readSonarrTables } from '../sonarr-reader.js';
import type { SourceBundle } from '../types.js';
import { definitionsReady } from './prowlarr-definitions.js';

// Sonarr / Radarr (API v3) and Prowlarr (API v1) read through their live API. The responses
// are turned into rows shaped like the apps' own database tables (MemoryTables), so the same
// readers and mappers serve both modes:
// - provider resources (indexers, download clients, notifications, import lists, proxies) carry
//   their settings as `fields: [{ name, value }]` with dotted names for nested settings; they are
//   folded back into one settings object;
// - enum names the API spells out become the numbers the database stores where a mapper
//   expects numbers (history event types, protocols, colon replacement, monitor-new-items...);
// - Sonarr's episodes and episode files are read per series; Radarr's movie file and collection
//   ride on the movie;
// - history and blocklist are paged.
// Recent versions return secrets (passwords, API keys) as `********`. Those are never imported
// as values: the item comes over without the secret and the plan says which field to re-enter.

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const asList = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** `[{name: 'seedCriteria.seedRatio', value: 1}]` → `{ seedCriteria: { seedRatio: 1 } }`; masked values skipped and reported. */
export function fieldsToSettings(fields: unknown, masked: string[]): Json {
  const out: Json = {};
  for (const f of asList(fields)) {
    const name = typeof f['name'] === 'string' ? f['name'] : null;
    if (!name) continue;
    const value = f['value'];
    if (value === MIGRATE_SECRET_MASK) {
      masked.push(name);
      continue;
    }
    if (value === undefined) continue;
    const parts = name.split('.');
    let target = out;
    for (const p of parts.slice(0, -1)) {
      if (!isObj(target[p])) target[p] = {};
      target = target[p] as Json;
    }
    target[parts[parts.length - 1]!] = value;
  }
  return out;
}

interface Collector {
  warnings: MigrationWarning[];
}

/** A provider resource as a table row: `settings` object instead of `fields`, masked secrets reported. */
function providerRow(res: Json, area: MigrateArea, c: Collector): ForeignRow {
  const masked: string[] = [];
  const { fields, ...rest } = res;
  const row: ForeignRow = { ...rest, settings: fieldsToSettings(fields, masked) };
  if (masked.length > 0) {
    const name = typeof res['name'] === 'string' ? res['name'] : `#${String(res['id'])}`;
    c.warnings.push({
      area,
      sourceId: String(res['id'] ?? ''),
      message: `"${name}": ${masked.join(', ')} hidden by the API (shown as ${MIGRATE_SECRET_MASK}); re-enter in Arclight after the import, or import this app from its files to carry secrets`,
    });
  }
  return row;
}

const PROTOCOL: Record<string, number> = { usenet: 1, torrent: 2 };
const protocolInt = (v: unknown) => (typeof v === 'string' ? (PROTOCOL[v.toLowerCase()] ?? 0) : v);

/** History event names → the numbers readHistory understands (1 grabbed, 3 imported, others ignored). */
const HISTORY_EVENTS: Record<string, number> = { grabbed: 1, seriesfolderimported: 2, moviefolderimported: 2, downloadfolderimported: 3, downloadfailed: 4 };
const historyEvent = (v: unknown) => (typeof v === 'string' ? (HISTORY_EVENTS[v.toLowerCase()] ?? 0) : v);

const COLON: Record<string, number> = { delete: 0, dash: 1, spacedash: 2, spacedashspace: 3, smart: 4, custom: 5 };
const MULTI_EPISODE: Record<string, number> = { extend: 0, duplicate: 1, repeat: 2, scene: 3, range: 4, prefixedrange: 5 };
const enumInt = (table: Record<string, number>, v: unknown) => (typeof v === 'string' && Number.isNaN(Number(v)) ? table[v.toLowerCase()] : v);

const languageId = (v: unknown) => (isObj(v) ? v['id'] : v);

function namingRow(naming: Json | null): ForeignRow[] {
  if (!naming) return [];
  return [{ ...naming, colonReplacementFormat: enumInt(COLON, naming['colonReplacementFormat']), multiEpisodeStyle: enumInt(MULTI_EPISODE, naming['multiEpisodeStyle']) }];
}

/** Settings resources (media management, download client handling) → Config key/value rows. */
function configRows(...resources: Array<Json | null>): ForeignRow[] {
  const rows: ForeignRow[] = [];
  for (const res of resources) {
    for (const [key, value] of Object.entries(res ?? {})) {
      if (key === 'id' || value === null || value === undefined || typeof value === 'object') continue;
      rows.push({ key: key.toLowerCase(), value: typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value) });
    }
  }
  return rows;
}

async function pages(http: SourceHttp, path: string, query: Record<string, string> = {}): Promise<Json[]> {
  try {
    return await fetchAllPages<Json>(http, path, { sortKey: 'date', sortDirection: 'ascending', ...query });
  } catch (err) {
    if (err instanceof MigrateError && err.code === 'SOURCE_UNREADABLE') return [];
    throw err;
  }
}

interface ArrCommon {
  version: string | null;
  tables: Record<string, ForeignRow[]>;
}

/** Everything Sonarr and Radarr share, as tables. */
async function readArrCommon(http: SourceHttp, app: 'sonarr' | 'radarr', c: Collector): Promise<ArrCommon> {
  const p = '/api/v3';
  const status = await http.json<Json>(`${p}/system/status`);
  const appName = String(status?.['appName'] ?? '').toLowerCase();
  if (appName && appName !== app) throw new MigrateError('WRONG_APP', `${http.baseUrl} is ${String(status['appName'])}, not ${app === 'sonarr' ? 'Sonarr' : 'Radarr'}`);
  const [tags, roots, formats, profiles, delays, releaseProfiles, indexers, clients, mappings, notifications, lists, naming, media, dlConfig] = await Promise.all([
    http.json<Json[]>(`${p}/tag`),
    http.json<Json[]>(`${p}/rootfolder`),
    http.optionalJson<Json[]>(`${p}/customformat`, []),
    http.json<Json[]>(`${p}/qualityprofile`),
    http.optionalJson<Json[]>(`${p}/delayprofile`, []),
    http.optionalJson<Json[] | null>(`${p}/releaseprofile`, null),
    http.optionalJson<Json[]>(`${p}/indexer`, []),
    http.optionalJson<Json[]>(`${p}/downloadclient`, []),
    http.optionalJson<Json[]>(`${p}/remotepathmapping`, []),
    http.optionalJson<Json[]>(`${p}/notification`, []),
    http.optionalJson<Json[]>(`${p}/importlist`, []),
    http.optionalJson<Json | null>(`${p}/config/naming`, null),
    http.optionalJson<Json | null>(`${p}/config/mediamanagement`, null),
    http.optionalJson<Json | null>(`${p}/config/downloadclient`, null),
  ]);
  // Radarr 4 and older Sonarr call release profiles "restrictions".
  const restrictions = releaseProfiles === null ? await http.optionalJson<Json[]>(`${p}/restriction`, []) : [];
  const history = await pages(http, `${p}/history`);
  let blocklist = await pages(http, `${p}/blocklist`);
  if (blocklist.length === 0) blocklist = await pages(http, `${p}/blacklist`);

  return {
    version: typeof status?.['version'] === 'string' ? status['version'] : null,
    tables: {
      Tags: asList(tags),
      RootFolders: asList(roots),
      CustomFormats: asList(formats),
      QualityProfiles: asList(profiles),
      DelayProfiles: asList(delays).map((d) => ({ ...d, preferredProtocol: protocolInt(d['preferredProtocol']) })),
      ReleaseProfiles: asList(releaseProfiles ?? restrictions),
      Indexers: asList(indexers).map((r) => providerRow(r, 'indexers', c)),
      DownloadClients: asList(clients).map((r) => providerRow(r, 'downloadClients', c)),
      RemotePathMappings: asList(mappings),
      Notifications: asList(notifications).map((r) => providerRow(r, 'notifications', c)),
      ImportLists: asList(lists).map((r) => providerRow(r, 'importLists', c)),
      NamingConfig: namingRow(isObj(naming) ? naming : null),
      Config: configRows(isObj(media) ? media : null, isObj(dlConfig) ? dlConfig : null),
      History: history.map((h) => ({ ...h, eventType: historyEvent(h['eventType']) })),
      Blocklist: blocklist.map((b) => ({ ...b, protocol: protocolInt(b['protocol']) })),
    },
  };
}

async function readSonarrApi(source: MigrateSource, http: SourceHttp): Promise<SourceBundle> {
  const c: Collector = { warnings: [] };
  const common = await readArrCommon(http, 'sonarr', c);
  const series = asList(await http.json<Json[]>('/api/v3/series'));
  const perSeries = await http.map(series, async (s) => {
    const id = s['id'] as number;
    const [episodes, files] = await Promise.all([http.json<Json[]>('/api/v3/episode', { query: { seriesId: id } }), http.json<Json[]>('/api/v3/episodefile', { query: { seriesId: id } })]);
    return { episodes: asList(episodes), files: asList(files) };
  });
  const tables: Record<string, ForeignRow[]> = {
    ...common.tables,
    Series: series.map((s) => ({
      ...s,
      originalLanguage: languageId(s['originalLanguage']),
      monitorNewItems: typeof s['monitorNewItems'] === 'string' ? (s['monitorNewItems'].toLowerCase() === 'none' ? 1 : 0) : s['monitorNewItems'],
    })),
    Episodes: perSeries.flatMap((x) => x.episodes),
    EpisodeFiles: perSeries.flatMap((x) => x.files),
  };
  const bundle = readSonarrTables(new MemoryTables(tables, { [ARR_VERSION_SQL]: common.version }), source.pathMappings, `${http.baseUrl} (API)`);
  bundle.warnings.push(...c.warnings);
  return bundle;
}

async function readRadarrApi(source: MigrateSource, http: SourceHttp): Promise<SourceBundle> {
  const c: Collector = { warnings: [] };
  const common = await readArrCommon(http, 'radarr', c);
  const [movies, collections] = await Promise.all([http.json<Json[]>('/api/v3/movie'), http.optionalJson<Json[]>('/api/v3/collection', [])]);
  const list = asList(movies);
  const tables: Record<string, ForeignRow[]> = {
    ...common.tables,
    Movies: list.map((m) => {
      const file = isObj(m['movieFile']) ? m['movieFile'] : null;
      const coll = isObj(m['collection']) ? m['collection'] : null;
      const { movieFile: _file, collection: _coll, ...rest } = m;
      return {
        ...rest,
        movieFileId: file?.['id'] ?? m['movieFileId'] ?? 0,
        originalLanguage: languageId(m['originalLanguage']),
        collectionTmdbId: coll?.['tmdbId'] ?? null,
        collectionTitle: coll?.['title'] ?? coll?.['name'] ?? null,
      };
    }),
    MovieFiles: list.flatMap((m) => (isObj(m['movieFile']) ? [{ ...m['movieFile'], movieId: m['id'] }] : [])),
    Collections: asList(collections),
  };
  const bundle = readRadarrTables(new MemoryTables(tables, { [ARR_VERSION_SQL]: common.version }), source.pathMappings, `${http.baseUrl} (API)`);
  bundle.warnings.push(...c.warnings);
  return bundle;
}

async function readProwlarrApi(source: MigrateSource, http: SourceHttp, deps: ReadDeps): Promise<SourceBundle> {
  const c: Collector = { warnings: [] };
  const p = '/api/v1';
  const status = await http.json<Json>(`${p}/system/status`);
  const appName = String(status?.['appName'] ?? '').toLowerCase();
  if (appName && appName !== 'prowlarr') throw new MigrateError('WRONG_APP', `${http.baseUrl} is ${String(status['appName'])}, not Prowlarr`);
  const [tags, indexers, proxies, applications] = await Promise.all([
    http.json<Json[]>(`${p}/tag`),
    http.json<Json[]>(`${p}/indexer`),
    http.optionalJson<Json[]>(`${p}/indexerproxy`, []),
    http.optionalJson<Json[]>(`${p}/applications`, []),
  ]);
  await definitionsReady(deps);
  const tables: Record<string, ForeignRow[]> = {
    Tags: asList(tags),
    Indexers: asList(indexers).map((r) => providerRow(r, 'indexers', c)),
    IndexerProxies: asList(proxies).map((r) => providerRow(r, 'indexerProxies', c)),
    Applications: asList(applications).map(({ fields: _f, ...rest }) => rest),
  };
  const bundle = readProwlarrTables(
    new MemoryTables(tables, { [ARR_VERSION_SQL]: typeof status?.['version'] === 'string' ? status['version'] : null }),
    source.pathMappings,
    { baseUrl: http.baseUrl, apiKey: source.apiKey ?? null, origin: 'api' },
    deps,
    `${http.baseUrl} (API)`,
  );
  bundle.warnings.push(...c.warnings);
  return bundle;
}

export async function readArrApi(source: MigrateSource, http: SourceHttp, deps: ReadDeps): Promise<SourceBundle> {
  switch (source.app) {
    case 'sonarr':
      return readSonarrApi(source, http);
    case 'radarr':
      return readRadarrApi(source, http);
    case 'prowlarr':
      return readProwlarrApi(source, http, deps);
    default:
      throw new MigrateError('VALIDATION', `${source.app} is not an arr app`);
  }
}
