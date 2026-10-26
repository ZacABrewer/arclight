import type { IndexerProxyType, MigratePathMapping } from '@arclight/shared';
import { definitionsReady, matchDefinition, translateFields } from './api/prowlarr-definitions.js';
import { arrSchemaVersion, readTags, warn, type ReaderContext } from './arr-common.js';
import { parseArrConfigXml, readTextFile } from './config-files.js';
import type { MigrateDeps } from './deps.js';
import { MigrateError } from './errors.js';
import { bool, field, ForeignDb, idList, int, jsonObject, num, str, type TableSource } from './foreign-db.js';
import { clampPriority, indexerImplementation, mapIndexerSettings, prowlarrBaseUrl, prowlarrProtocolGuess } from './mappers/indexers.js';
import type { IndexerPayload, IndexerProxyPayload, SourceBundle, SourceItem } from './types.js';

// Prowlarr. Each indexer becomes, in order of preference:
//   1. an Arclight definition indexer, when Arclight's catalogue (built-in, feed, custom or
//      community definitions) has the same definition: Cardigann `definitionFile`, the API's
//      `definitionName`, or a native implementation's name. Setting values (credentials, cookies,
//      options) are translated to the definition's setting names; Prowlarr is no longer needed.
//   2. a direct Torznab/Newznab indexer, for Prowlarr's own generic Torznab/Newznab entries.
//   3. a Torznab/Newznab indexer pointing at Prowlarr's per-indexer endpoint
//      (`<prowlarr>/<id>/api` with Prowlarr's API key): Prowlarr keeps serving it, so it has to
//      keep running. Used when Arclight has no definition for the site.
// Indexer proxies (FlareSolverr, HTTP, SOCKS5) are imported; applications (the arr apps
// Prowlarr syncs to) are only reported, since Arclight is the app.

export interface ProwlarrEndpoint {
  /** Prowlarr root as Arclight reaches it, for the proxied fallback. */
  baseUrl: string;
  apiKey: string | null;
  /** Where baseUrl came from, for the warning (config.xml guesses `localhost`). */
  origin: 'config' | 'api';
}

const MINUTE = 60_000;

/** Prowlarr's torrent seed settings and minimum seeders → Arclight indexer settings. */
function seedSettings(settings: Record<string, unknown>): Pick<IndexerPayload['create']['settings'], 'seedRatio' | 'seedTime' | 'seasonPackSeedTime' | 'minimumSeeders'> {
  const tb = field(settings, 'torrentBaseSettings');
  const t = tb && typeof tb === 'object' ? (tb as Record<string, unknown>) : {};
  const out: Pick<IndexerPayload['create']['settings'], 'seedRatio' | 'seedTime' | 'seasonPackSeedTime' | 'minimumSeeders'> = {};
  const ratio = num(field(t, 'seedRatio'));
  if (ratio !== null && ratio >= 0) out.seedRatio = ratio;
  const seedTime = num(field(t, 'seedTime'));
  if (seedTime !== null && seedTime >= 0) out.seedTime = Math.round(seedTime * MINUTE);
  const pack = num(field(t, 'packSeedTime'));
  if (pack !== null && pack >= 0) out.seasonPackSeedTime = Math.round(pack * MINUTE);
  const seeders = int(field(t, 'appMinimumSeeders'));
  if (seeders !== null && seeders >= 0) out.minimumSeeders = seeders;
  return out;
}

const PROXY_TYPES: Record<string, IndexerProxyType> = { flaresolverr: 'flaresolverr', http: 'http', socks5: 'socks5' };

/** One IndexerProxies row → proxy payload (FlareSolverr keeps its URL's scheme in `host`). */
export function mapIndexerProxy(implementation: string, settings: Record<string, unknown>): { create: Omit<IndexerProxyPayload['create'], 'name'> } | { unsupported: string } {
  const type = PROXY_TYPES[implementation.toLowerCase()];
  if (!type) return { unsupported: `${implementation || 'unknown'} proxies are not supported (Arclight has FlareSolverr, HTTP and SOCKS5)` };
  const rawHost = (str(field(settings, 'host')) ?? '').trim();
  if (!rawHost) return { unsupported: 'proxy has no host' };
  let host = rawHost;
  let port = int(field(settings, 'port'));
  if (/^https?:\/\//i.test(rawHost)) {
    try {
      const u = new URL(rawHost);
      host = type === 'flaresolverr' ? `${u.protocol}//${u.hostname}` : u.hostname;
      port = port ?? (u.port ? Number(u.port) : null);
    } catch {
      return { unsupported: `proxy host "${rawHost}" is not a valid URL` };
    }
  }
  port ??= type === 'flaresolverr' ? 8191 : type === 'socks5' ? 1080 : 8080;
  const timeout = int(field(settings, 'requestTimeout'));
  const username = str(field(settings, 'username'));
  const password = str(field(settings, 'password'));
  return {
    create: {
      type,
      host,
      port,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(timeout !== null && timeout >= 1 && timeout <= 600 ? { requestTimeout: timeout } : {}),
    },
  };
}

/** A Prowlarr source as tables (its database, or rows built from its API). */
export function readProwlarrTables(db: TableSource, mappings: readonly MigratePathMapping[], endpoint: ProwlarrEndpoint, deps: Pick<MigrateDeps, 'ctx' | 'findDefinition'>, where: string): SourceBundle {
  if (!db.hasTable('Indexers') || !db.hasTable('Applications')) {
    throw new MigrateError('WRONG_APP', `${where} does not look like Prowlarr (no indexers/applications)`);
  }
  // Prowlarr's tables use the arr layout; the language/quality ids are never consulted here.
  const ctx: ReaderContext = { db, app: 'sonarr', mappings, warnings: [] };

  const indexers: SourceItem<IndexerPayload>[] = [];
  let matched = 0;
  let proxied = 0;
  for (const r of db.rows('Indexers')) {
    const sourceId = String(int(r['id']));
    const name = str(r['name']) ?? `Indexer ${sourceId}`;
    const upstream = str(r['implementation']) ?? '';
    const settings = jsonObject(r['settings']);
    const enabled = bool(r['enable'], true);
    const tags = idList(r['tags']);
    const common = {
      name,
      enableRss: enabled,
      enableAutomaticSearch: enabled,
      enableInteractiveSearch: enabled,
      priority: clampPriority(r['priority']),
    };

    const direct = indexerImplementation(upstream);
    if (direct) {
      const mapped = mapIndexerSettings(settings);
      const item: SourceItem<IndexerPayload> = { sourceId, name, payload: { create: { ...common, implementation: direct, settings: mapped }, sourceTagIds: tags, sourceDownloadClientId: null } };
      if (!mapped.baseUrl) item.unsupported = 'indexer has no base URL';
      indexers.push(item);
      continue;
    }

    const definitionFile = str(field(settings, 'definitionFile'));
    const definitionName = str(r['definitionname']);
    const match = matchDefinition(deps, [definitionFile, definitionName, upstream.toLowerCase() === 'cardigann' ? null : upstream]);
    if (match) {
      matched++;
      const { fields, dropped } = translateFields(match, settings);
      if (dropped.length > 0) warn(ctx, 'indexers', `"${name}": setting(s) ${dropped.join(', ')} could not be carried over; check them in Settings > Indexers`, sourceId);
      const baseUrl = (str(field(settings, 'baseUrl')) ?? '').trim();
      indexers.push({
        sourceId,
        name,
        payload: {
          create: {
            ...common,
            implementation: 'definition',
            settings: {
              baseUrl: /^https?:\/\//i.test(baseUrl) ? baseUrl : '',
              apiPath: '',
              categories: [],
              animeCategories: [],
              definitionId: match.ref.id,
              fields,
              ...seedSettings(settings),
            },
          },
          sourceTagIds: tags,
          sourceDownloadClientId: null,
        },
      });
      continue;
    }

    proxied++;
    const implementation = prowlarrProtocolGuess(upstream, definitionFile ?? definitionName);
    indexers.push({
      sourceId,
      name,
      payload: {
        create: {
          ...common,
          implementation,
          settings: {
            baseUrl: `${endpoint.baseUrl}/${sourceId}`,
            apiPath: '/api',
            ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
            // Prowlarr answers for every category it maps; ask for movies and TV.
            categories: [2000, 5000],
            animeCategories: [],
            ...seedSettings(settings),
          },
        },
        sourceTagIds: tags,
        sourceDownloadClientId: null,
      },
    });
    warn(ctx, 'indexers', `"${name}": Arclight has no definition "${definitionFile ?? definitionName ?? upstream}"; it is reached through Prowlarr, which must keep running`, sourceId);
  }
  if (proxied > 0) {
    if (!endpoint.apiKey) warn(ctx, 'indexers', 'Prowlarr API key unknown (config.xml not found or has no ApiKey); proxied indexers are imported without a key (set it in Settings > Indexers)');
    else if (endpoint.origin === 'config') warn(ctx, 'indexers', `proxied indexers point at ${endpoint.baseUrl}; change the host if Arclight reaches Prowlarr under another name`);
  }

  const proxies: SourceItem<IndexerProxyPayload>[] = db.rows('IndexerProxies').map((r) => {
    const sourceId = String(int(r['id']));
    const name = str(r['name']) ?? `Proxy ${sourceId}`;
    const implementation = str(r['implementation']) ?? '';
    const mapped = mapIndexerProxy(implementation, jsonObject(r['settings']));
    const sourceTagIds = idList(r['tags']);
    if ('unsupported' in mapped) {
      return { sourceId, name, payload: { create: { name, type: 'http', host: '', port: 1 }, sourceTagIds }, unsupported: mapped.unsupported };
    }
    return { sourceId, name, payload: { create: { name, ...mapped.create }, sourceTagIds } };
  });
  const applications: SourceItem<unknown>[] = db.rows('Applications').map((r) => ({
    sourceId: String(int(r['id'])),
    name: `${str(r['name']) ?? 'Application'} (${str(r['implementation']) ?? '?'})`,
    payload: { implementation: str(r['implementation']), syncLevel: r['synclevel'] ?? null },
  }));

  return {
    app: 'prowlarr',
    schemaVersion: arrSchemaVersion(db),
    warnings: ctx.warnings,
    areas: {
      tags: readTags(ctx),
      indexers: { mode: 'import', items: indexers, details: { definitions: matched, proxied } },
      ...(proxies.length > 0 ? { indexerProxies: { mode: 'import' as const, items: proxies } } : {}),
      applications: { mode: 'report', items: applications },
    },
  };
}

export async function readProwlarr(dbPath: string, configPath: string | undefined, mappings: readonly MigratePathMapping[], deps: Pick<MigrateDeps, 'ctx' | 'findDefinition'> = {}): Promise<SourceBundle> {
  await definitionsReady(deps);
  const db = ForeignDb.open(dbPath);
  try {
    const configText = readTextFile(configPath);
    const config = configText ? parseArrConfigXml(configText) : {};
    return readProwlarrTables(db, mappings, { baseUrl: prowlarrBaseUrl(config), apiKey: config['apikey'] ?? null, origin: 'config' }, deps, `${dbPath} (database)`);
  } finally {
    db.close();
  }
}
