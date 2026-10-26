import type { MigratePathMapping } from '@arclight/shared';
import { arrSchemaVersion, readTags, warn, type ReaderContext } from './arr-common.js';
import { parseArrConfigXml, readTextFile } from './config-files.js';
import { MigrateError } from './errors.js';
import { bool, field, ForeignDb, idList, int, jsonObject, str } from './foreign-db.js';
import { clampPriority, indexerImplementation, mapIndexerSettings, prowlarrBaseUrl, prowlarrProtocolGuess } from './mappers/indexers.js';
import type { IndexerPayload, SourceBundle, SourceItem } from './types.js';

// Prowlarr. Its Torznab/Newznab entries carry over directly. Every other indexer (Cardigann
// definitions and native implementations) is reached through Prowlarr's own per-indexer
// Torznab/Newznab endpoint (`<prowlarr>/<id>/api` with Prowlarr's API key), so Prowlarr can
// keep running as the indexer proxy; the definition and its settings are also staged under
// `indexers.cardigann` for a future native implementation. Proxies are staged, applications
// (the arr apps Prowlarr syncs to) are only reported.

export function readProwlarr(dbPath: string, configPath: string | undefined, mappings: readonly MigratePathMapping[]): SourceBundle {
  const db = ForeignDb.open(dbPath);
  try {
    if (!db.hasTable('Indexers') || !db.hasTable('Applications')) {
      throw new MigrateError('WRONG_APP', `${dbPath} does not look like a Prowlarr database (no Indexers/Applications tables)`);
    }
    // Prowlarr's tables use the arr layout; the language/quality ids are never consulted here.
    const ctx: ReaderContext = { db, app: 'sonarr', mappings, warnings: [] };
    const configText = readTextFile(configPath);
    const config = configText ? parseArrConfigXml(configText) : {};
    const apiKey = config['apikey'] ?? null;
    const baseUrl = prowlarrBaseUrl(config);
    if (!apiKey) warn(ctx, 'indexers', 'Prowlarr config.xml not found or has no ApiKey; proxied indexers are imported without a key (set it in Settings → Indexers)');
    else warn(ctx, 'indexers', `proxied indexers point at ${baseUrl}; change the host if Arclight reaches Prowlarr under another name`);

    const indexers: SourceItem<IndexerPayload>[] = [];
    const cardigann: SourceItem<unknown>[] = [];
    for (const r of db.rows('Indexers')) {
      const sourceId = String(int(r['id']));
      const name = str(r['name']) ?? `Indexer ${sourceId}`;
      const upstream = str(r['implementation']) ?? '';
      const settings = jsonObject(r['settings']);
      const enabled = bool(r['enable'], true);
      const direct = indexerImplementation(upstream);
      const definition = str(field(settings, 'definitionFile'));
      const common = {
        name,
        enableRss: enabled,
        enableAutomaticSearch: enabled,
        enableInteractiveSearch: enabled,
        priority: clampPriority(r['priority']),
      };
      if (direct) {
        const mapped = mapIndexerSettings(settings);
        const item: SourceItem<IndexerPayload> = {
          sourceId,
          name,
          payload: { create: { ...common, implementation: direct, settings: mapped }, sourceTagIds: idList(r['tags']), sourceDownloadClientId: null },
        };
        if (!mapped.baseUrl) item.unsupported = 'indexer has no base URL';
        indexers.push(item);
        continue;
      }
      const implementation = prowlarrProtocolGuess(upstream, definition);
      indexers.push({
        sourceId,
        name,
        payload: {
          create: {
            ...common,
            implementation,
            settings: {
              baseUrl: `${baseUrl}/${sourceId}`,
              apiPath: '/api',
              ...(apiKey ? { apiKey } : {}),
              // Prowlarr answers for every category it maps; ask for movies and TV.
              categories: [2000, 5000],
              animeCategories: [],
            },
          },
          sourceTagIds: idList(r['tags']),
          sourceDownloadClientId: null,
        },
      });
      cardigann.push({
        sourceId,
        name,
        stageArea: 'indexers.cardigann',
        payload: { implementation: upstream, definition, enabled, priority: int(r['priority']), settings, appProfileId: int(r['appprofileid']), tags: idList(r['tags']) },
      });
    }

    const proxies: SourceItem<unknown>[] = db.rows('IndexerProxies').map((r) => ({
      sourceId: String(int(r['id'])),
      name: str(r['name']) ?? 'Proxy',
      stageArea: 'indexers.proxies' as const,
      payload: { implementation: str(r['implementation']), settings: jsonObject(r['settings']), tags: idList(r['tags']) },
    }));
    const applications: SourceItem<unknown>[] = db.rows('Applications').map((r) => ({
      sourceId: String(int(r['id'])),
      name: `${str(r['name']) ?? 'Application'} (${str(r['implementation']) ?? '?'})`,
      payload: { implementation: str(r['implementation']), syncLevel: int(r['synclevel']) },
    }));

    return {
      app: 'prowlarr',
      schemaVersion: arrSchemaVersion(db),
      warnings: ctx.warnings,
      areas: {
        tags: readTags(ctx),
        indexers: { mode: 'import', items: indexers, details: { proxied: cardigann.length } },
        // Staged together: proxy settings and the definitions behind proxied indexers.
        ...(proxies.length + cardigann.length > 0 ? { indexerProxies: { mode: 'stage' as const, items: [...proxies, ...cardigann] } } : {}),
        applications: { mode: 'report', items: applications },
      },
    };
  } finally {
    db.close();
  }
}
