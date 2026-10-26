import type { MigrateArea, MigratePathMapping, MigrationWarning, ReleaseProtocol } from '@arclight/shared';
import { normalizeData } from '../history/service.js';
import { bool, field, ForeignDb, idList, int, isoDate, json, jsonArray, jsonObject, str, type ForeignRow } from './foreign-db.js';
import { indexerFlagsFromBits, mapCustomFormat } from './mappers/custom-formats.js';
import { mapDownloadClient } from './mappers/download-clients.js';
import { importListCommon, mapImportListSettings } from './mappers/import-lists.js';
import { clampPriority, indexerImplementation, mapIndexerSettings } from './mappers/indexers.js';
import { mapLanguageId, mapLanguageList } from './mappers/languages.js';
import { mapMediaManagement } from './mappers/media-management.js';
import { mapNamingConfig } from './mappers/naming.js';
import { mapNotification } from './mappers/notifications.js';
import { mapProfileItems, mapQualityModel, type ArrApp } from './mappers/quality.js';
import { isInside, parentPath, remapPath } from './paths.js';
import type {
  AreaBundle,
  BlocklistPayload,
  CustomFormatPayload,
  DelayProfilePayload,
  DownloadClientPayload,
  HistoryPayload,
  ImportListPayload,
  IndexerPayload,
  NotificationPayload,
  QualityProfilePayload,
  ReleaseProfilePayload,
  RemotePathMappingPayload,
  RootFolderPayload,
  SettingsPayload,
  SourceAreas,
  SourceItem,
  TagPayload,
} from './types.js';
import type { MediaManagementSettings, NamingConfig } from '@arclight/shared';

// Tables Sonarr and Radarr share (same names, same columns modulo version drift): tags,
// root folders, profiles, custom formats, indexers, download clients, notifications, import
// lists, naming, config, history and blocklist. The per-app readers add the library.

export interface ReaderContext {
  db: ForeignDb;
  app: ArrApp;
  mappings: readonly MigratePathMapping[];
  warnings: MigrationWarning[];
}

export function warn(ctx: Pick<ReaderContext, 'warnings'>, area: MigrateArea, message: string, sourceId?: string): void {
  ctx.warnings.push(sourceId === undefined ? { area, message } : { area, message, sourceId });
}

const id = (row: ForeignRow) => String(int(row['id']) ?? '');

export function arrSchemaVersion(db: ForeignDb): string | null {
  const v = db.scalar('SELECT MAX("Version") FROM "VersionInfo"');
  return v === null ? null : String(v);
}

function importArea<P>(items: SourceItem<P>[], details?: Record<string, number>): AreaBundle<P> {
  return details ? { mode: 'import', items, details } : { mode: 'import', items };
}

export function readTags(ctx: ReaderContext): AreaBundle<TagPayload> {
  return importArea(
    ctx.db
      .rows('Tags')
      .map((r) => ({ label: (str(r['label']) ?? '').trim().toLowerCase(), sourceId: id(r) }))
      .filter((t) => t.label !== '')
      .map((t) => ({ sourceId: t.sourceId, name: t.label, payload: { label: t.label } })),
  );
}

/** Root folder paths after remapping, longest first (for matching media paths). */
export function remappedRootFolders(ctx: ReaderContext): string[] {
  return ctx.db
    .rows('RootFolders')
    .map((r) => str(r['path']))
    .filter((p): p is string => !!p)
    .map((p) => remapPath(p, ctx.mappings).path)
    .sort((a, b) => b.length - a.length);
}

export function readRootFolders(ctx: ReaderContext, mediaType: 'series' | 'movie'): AreaBundle<RootFolderPayload> {
  return importArea(
    ctx.db.rows('RootFolders').flatMap((r) => {
      const raw = str(r['path']);
      if (!raw) return [];
      const path = remapPath(raw, ctx.mappings).path.replace(/[\\/]+$/, '') || raw;
      return [{ sourceId: id(r), name: path, payload: { path, mediaType } }];
    }),
  );
}

/** The root folder that holds `path`, or its parent folder when none does. */
export function rootFolderFor(path: string, roots: readonly string[]): { root: string; matched: boolean } {
  const hit = roots.find((r) => isInside(r, path));
  return hit ? { root: hit.replace(/[\\/]+$/, '') || hit, matched: true } : { root: parentPath(path), matched: false };
}

export function readCustomFormats(ctx: ReaderContext): AreaBundle<CustomFormatPayload> {
  const items: SourceItem<CustomFormatPayload>[] = [];
  for (const r of ctx.db.rows('CustomFormats')) {
    const name = str(r['name']) ?? `Custom format ${id(r)}`;
    const { input, dropped } = mapCustomFormat(ctx.app, name, bool(r['includecustomformatwhenrenaming']), jsonArray(r['specifications']));
    for (const d of dropped) warn(ctx, 'customFormats', `"${name}": skipped specification ${d}`, id(r));
    const item: SourceItem<CustomFormatPayload> = { sourceId: id(r), name, payload: { input } };
    if (input.specifications.length === 0) item.unsupported = 'no specification could be translated';
    items.push(item);
  }
  return importArea(items);
}

export function readQualityProfiles(ctx: ReaderContext): AreaBundle<QualityProfilePayload> {
  const items: SourceItem<QualityProfilePayload>[] = [];
  for (const r of ctx.db.rows('QualityProfiles', 'Profiles')) {
    const name = str(r['name']) ?? `Profile ${id(r)}`;
    const { items: mapped, cutoff, dropped } = mapProfileItems(ctx.app, jsonArray(r['items']), int(r['cutoff']));
    if (dropped.length > 0) warn(ctx, 'qualityProfiles', `"${name}": qualities without an equivalent dropped (${[...new Set(dropped)].join(', ')})`, id(r));
    const formatItems = jsonArray(r['formatitems']).flatMap((f) => {
      if (!f || typeof f !== 'object') return [];
      const o = f as Record<string, unknown>;
      const fid = int(field(o, 'format', 'formatId'));
      const score = int(field(o, 'score')) ?? 0;
      return fid === null || score === 0 ? [] : [{ sourceFormatId: String(fid), score }];
    });
    const languages: string[] = [];
    if (r['language'] !== undefined && r['language'] !== null) {
      const raw = json<unknown>(r['language'], null);
      const lid = raw && typeof raw === 'object' ? int(field(raw as Record<string, unknown>, 'id')) : int(raw);
      const code = lid !== null ? mapLanguageId(ctx.app, lid) : undefined;
      if (code) languages.push(code);
    }
    const item: SourceItem<QualityProfilePayload> = {
      sourceId: id(r),
      name,
      payload: {
        input: {
          name,
          upgradeAllowed: bool(r['upgradeallowed'], true),
          cutoff: cutoff ?? 0,
          items: mapped,
          minFormatScore: int(r['minformatscore']) ?? 0,
          cutoffFormatScore: int(r['cutoffformatscore']) ?? 0,
          minUpgradeFormatScore: Math.max(1, int(r['minupgradeformatscore']) ?? 1),
          languages,
        },
        formatItems,
      },
    };
    if (cutoff === null) item.unsupported = 'no allowed quality could be translated';
    items.push(item);
  }
  return importArea(items);
}

export function readDelayProfiles(ctx: ReaderContext): AreaBundle<DelayProfilePayload> {
  const items: SourceItem<DelayProfilePayload>[] = [];
  for (const r of ctx.db.rows('DelayProfiles')) {
    const tags = idList(r['tags']);
    const enableUsenet = bool(r['enableusenet'], true);
    const enableTorrent = bool(r['enabletorrent'], true);
    // Upstream protocol enum: 1 usenet, 2 torrent.
    const preferred: ReleaseProtocol = int(r['preferredprotocol']) === 2 ? 'torrent' : 'usenet';
    if (!enableUsenet || !enableTorrent) {
      warn(ctx, 'delayProfiles', `delay profile ${id(r)} disables ${enableUsenet ? 'torrent' : 'usenet'}; Arclight delay profiles cannot disable a protocol (use indexer tags instead)`, id(r));
    }
    items.push({
      sourceId: id(r),
      name: tags.length === 0 ? 'Default delay profile' : `Delay profile (tags ${tags.join(', ')})`,
      payload: {
        input: {
          preferredProtocol: preferred,
          usenetDelayMinutes: Math.max(0, int(r['usenetdelay']) ?? 0),
          torrentDelayMinutes: Math.max(0, int(r['torrentdelay']) ?? 0),
          bypassIfHighestQuality: bool(r['bypassifhighestquality']),
          bypassIfAboveCustomFormatScore: bool(r['bypassifabovecustomformatscore']),
          minimumCustomFormatScore: int(r['minimumcustomformatscore']) ?? 0,
        },
        sourceTagIds: tags,
      },
    });
  }
  return importArea(items);
}

function termList(v: unknown): string[] {
  if (typeof v === 'string' && !v.trim().startsWith('[')) return v.split(',').map((t) => t.trim()).filter(Boolean);
  return jsonArray(v)
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean);
}

export function readReleaseProfiles(ctx: ReaderContext): AreaBundle<ReleaseProfilePayload> {
  const items: SourceItem<ReleaseProfilePayload>[] = [];
  for (const r of ctx.db.rows('ReleaseProfiles', 'Restrictions')) {
    const name = str(r['name']) || `Release profile ${id(r)}`;
    const required = termList(r['required']);
    const ignored = termList(r['ignored']);
    if (r['preferred'] !== undefined && jsonArray(r['preferred']).length > 0) {
      warn(ctx, 'releaseProfiles', `"${name}": preferred terms are not imported (use custom formats)`, id(r));
    }
    const indexerId = int(r['indexerid']);
    const item: SourceItem<ReleaseProfilePayload> = {
      sourceId: id(r),
      name,
      payload: { name, enabled: bool(r['enabled'], true), required, ignored, sourceIndexerId: indexerId && indexerId > 0 ? indexerId : null, sourceTagIds: idList(r['tags']) },
    };
    if (required.length === 0 && ignored.length === 0) item.unsupported = 'no required or ignored terms';
    items.push(item);
  }
  return importArea(items);
}

export function readIndexers(ctx: ReaderContext): AreaBundle<IndexerPayload> {
  const items: SourceItem<IndexerPayload>[] = [];
  for (const r of ctx.db.rows('Indexers')) {
    const name = str(r['name']) ?? `Indexer ${id(r)}`;
    const upstream = str(r['implementation']) ?? '';
    const impl = indexerImplementation(upstream);
    const settings = mapIndexerSettings(jsonObject(r['settings']));
    if ((settings.categories?.length ?? 0) + (settings.animeCategories?.length ?? 0) === 0) {
      settings.categories = ctx.app === 'sonarr' ? [5000] : [2000];
      warn(ctx, 'indexers', `"${name}": no categories configured; using ${ctx.app === 'sonarr' ? 'TV (5000)' : 'Movies (2000)'}`, id(r));
    }
    const downloadClientId = int(r['downloadclientid']);
    const item: SourceItem<IndexerPayload> = {
      sourceId: id(r),
      name,
      payload: {
        create: {
          name,
          implementation: impl ?? 'torznab',
          enableRss: bool(r['enablerss'], true),
          enableAutomaticSearch: bool(r['enableautomaticsearch'] ?? r['enablesearch'], true),
          enableInteractiveSearch: bool(r['enableinteractivesearch'] ?? r['enablesearch'], true),
          priority: clampPriority(r['priority']),
          settings,
        },
        sourceTagIds: idList(r['tags']),
        sourceDownloadClientId: downloadClientId && downloadClientId > 0 ? downloadClientId : null,
      },
    };
    if (!impl) item.unsupported = `${upstream || 'unknown'} indexers are not supported (only Torznab/Newznab; add it through Prowlarr)`;
    else if (!settings.baseUrl) item.unsupported = 'indexer has no base URL';
    items.push(item);
  }
  return importArea(items);
}

export function readDownloadClients(ctx: ReaderContext): AreaBundle<DownloadClientPayload> {
  const items: SourceItem<DownloadClientPayload>[] = [];
  for (const r of ctx.db.rows('DownloadClients')) {
    const name = str(r['name']) ?? `Download client ${id(r)}`;
    const upstream = str(r['implementation']) ?? '';
    const priority = Math.min(50, Math.max(1, int(r['priority']) ?? 1));
    const mapped = mapDownloadClient(
      ctx.app,
      upstream,
      {
        name,
        enable: bool(r['enable'], true),
        priority,
        removeCompletedDownloads: bool(r['removecompleteddownloads'], true),
        removeFailedDownloads: bool(r['removefaileddownloads'], true),
      },
      jsonObject(r['settings']),
    );
    const sourceTagIds = idList(r['tags']);
    if (mapped.kind === 'native') {
      items.push({ sourceId: id(r), name, payload: { input: mapped.input, staged: null, sourceTagIds } });
    } else {
      items.push({ sourceId: id(r), name, payload: { input: null, staged: mapped.staged, sourceTagIds }, unsupported: mapped.reason, stageArea: 'downloadClients.unsupported' });
    }
  }
  return importArea(items);
}

export function readRemotePathMappings(ctx: ReaderContext): AreaBundle<RemotePathMappingPayload> {
  return importArea(
    ctx.db.rows('RemotePathMappings').flatMap((r) => {
      const host = str(r['host']);
      const remotePath = str(r['remotepath']);
      const localRaw = str(r['localpath']);
      if (!host || !remotePath || !localRaw) return [];
      const localPath = remapPath(localRaw, ctx.mappings).path;
      return [{ sourceId: id(r), name: `${host}: ${remotePath} → ${localPath}`, payload: { host, remotePath, localPath } }];
    }),
  );
}

export function readNotifications(ctx: ReaderContext): AreaBundle<NotificationPayload> {
  const items: SourceItem<NotificationPayload>[] = [];
  for (const r of ctx.db.rows('Notifications')) {
    const name = str(r['name']) ?? `Notification ${id(r)}`;
    const mapped = mapNotification(r, jsonObject(r['settings']));
    for (const n of mapped.notes) warn(ctx, 'notifications', `"${name}": ${n}`, id(r));
    const item: SourceItem<NotificationPayload> = {
      sourceId: id(r),
      name,
      payload: {
        input: {
          name,
          implementation: mapped.implementation ?? 'webhook',
          enabled: true,
          ...mapped.triggers,
          includeHealthWarnings: mapped.includeHealthWarnings,
          settings: mapped.settings,
        },
        sourceTagIds: idList(r['tags']),
      },
    };
    if (mapped.unsupported) item.unsupported = mapped.unsupported;
    items.push(item);
  }
  return importArea(items);
}

export function readImportLists(ctx: ReaderContext): AreaBundle<ImportListPayload> {
  const items: SourceItem<ImportListPayload>[] = [];
  for (const r of ctx.db.rows('ImportLists', 'NetImport')) {
    const name = str(r['name']) ?? `Import list ${id(r)}`;
    const upstream = str(r['implementation']) ?? '';
    const mapped = mapImportListSettings(upstream, jsonObject(r['settings']));
    for (const n of mapped.notes) warn(ctx, 'importLists', `"${name}": ${n}`, id(r));
    const common = importListCommon(ctx.app, r);
    const rootFolderPath = common.rootFolderPath ? remapPath(common.rootFolderPath, ctx.mappings).path : '';
    const item: SourceItem<ImportListPayload> = {
      sourceId: id(r),
      name,
      payload: {
        input: {
          name,
          implementation: mapped.implementation ?? 'rss',
          enabled: common.enabled,
          enableAutomaticAdd: common.enableAutomaticAdd,
          searchOnAdd: common.searchOnAdd,
          monitorOption: common.monitorOption,
          seriesType: common.seriesType,
          seasonFolder: common.seasonFolder,
          rootFolderPath,
          minimumAvailability: common.minimumAvailability,
          mediaType: ctx.app === 'sonarr' ? 'series' : 'movie',
          settings: mapped.settings,
        },
        sourceQualityProfileId: common.sourceQualityProfileId,
        sourceTagIds: idList(r['tags']),
      },
    };
    if (mapped.unsupported) item.unsupported = mapped.unsupported;
    else if (!rootFolderPath) item.unsupported = 'import list has no root folder';
    items.push(item);
  }
  return importArea(items);
}

export function readNaming(ctx: ReaderContext): AreaBundle<SettingsPayload<NamingConfig>> {
  const row = ctx.db.rows('NamingConfig')[0];
  if (!row) return importArea([]);
  const { values, untranslatable } = mapNamingConfig(ctx.app, row);
  for (const u of untranslatable) warn(ctx, 'naming', `token not supported and removed: ${u}`);
  return importArea([{ sourceId: 'naming', name: 'Naming', payload: { values } }]);
}

export function readConfigTable(db: ForeignDb): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.rows('Config')) {
    const key = str(r['key']);
    const value = str(r['value']);
    if (key && value !== null) out[key.toLowerCase()] = value;
  }
  return out;
}

export function readMediaManagement(ctx: ReaderContext): AreaBundle<SettingsPayload<MediaManagementSettings>> {
  const config = readConfigTable(ctx.db);
  const values = mapMediaManagement(config, ctx.mappings);
  if (Object.keys(values).length === 0) return importArea([]);
  return importArea([{ sourceId: 'mediaManagement', name: 'Media management', payload: { values } }]);
}

/** History rows: only grabs and download-folder imports carry over. */
export function readHistory(ctx: ReaderContext): AreaBundle<HistoryPayload> {
  const items: SourceItem<HistoryPayload>[] = [];
  let ignored = 0;
  for (const r of ctx.db.rows('History')) {
    const type = int(r['eventtype']);
    const eventType = type === 1 ? 'grabbed' : type === 3 ? 'downloadFolderImported' : null;
    if (!eventType) {
      ignored++;
      continue;
    }
    const date = isoDate(r['date']);
    const title = str(r['sourcetitle']);
    if (!date || !title) continue;
    const parsedData = json<unknown>(r['data'], {});
    const rawData = parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData) ? (parsedData as Record<string, unknown>) : {};
    const data = normalizeData(Object.fromEntries(Object.entries(rawData).map(([k, v]) => [k, v === null || typeof v === 'object' ? undefined : (v as string | number | boolean)])));
    items.push({
      sourceId: id(r),
      name: title,
      payload: {
        mediaType: ctx.app === 'sonarr' ? 'series' : 'movie',
        sourceSeriesId: int(r['seriesid']),
        sourceEpisodeId: int(r['episodeid']),
        sourceMovieId: int(r['movieid']),
        eventType,
        sourceTitle: title,
        quality: mapQualityModel(ctx.app, json<unknown>(r['quality'], {})),
        languages: mapLanguageList(ctx.app, json<unknown>(r['languages'], [])),
        date,
        downloadId: str(r['downloadid']),
        data,
      },
    });
  }
  return importArea(items, ignored > 0 ? { otherEventsIgnored: ignored } : undefined);
}

const RELEASE_TYPE_NAMES: Record<number, string> = { 1: 'single', 2: 'multi', 3: 'seasonPack' };

export function readBlocklist(ctx: ReaderContext): AreaBundle<BlocklistPayload> {
  const items: SourceItem<BlocklistPayload>[] = [];
  for (const r of ctx.db.rows('Blocklist', 'Blacklist')) {
    const title = str(r['sourcetitle']);
    const date = isoDate(r['date']);
    if (!title || !date) continue;
    const hash = str(r['torrentinfohash']);
    const protocolId = int(r['protocol']);
    const protocol = protocolId === 1 ? 'usenet' : protocolId === 2 ? 'torrent' : hash ? 'torrent' : 'usenet';
    const releaseType = int(r['releasetype']);
    items.push({
      sourceId: id(r),
      name: title,
      payload: {
        mediaType: ctx.app === 'sonarr' ? 'series' : 'movie',
        sourceSeriesId: int(r['seriesid']),
        sourceEpisodeIds: idList(r['episodeids']),
        sourceMovieId: int(r['movieid']),
        sourceTitle: title,
        quality: mapQualityModel(ctx.app, json<unknown>(r['quality'], {})),
        languages: mapLanguageList(ctx.app, json<unknown>(r['languages'], [])),
        date,
        publishedDate: isoDate(r['publisheddate']),
        size: int(r['size']),
        protocol,
        indexer: str(r['indexer']),
        indexerFlags: indexerFlagsFromBits(ctx.app, int(r['indexerflags'])),
        message: str(r['message']),
        torrentInfoHash: hash ? hash.toLowerCase() : null,
        releaseType: releaseType !== null ? (RELEASE_TYPE_NAMES[releaseType] ?? null) : null,
      },
    });
  }
  return importArea(items);
}

/** Every infrastructure area Sonarr and Radarr have in common. */
export function readArrInfrastructure(ctx: ReaderContext, mediaType: 'series' | 'movie'): SourceAreas {
  return {
    tags: readTags(ctx),
    rootFolders: readRootFolders(ctx, mediaType),
    customFormats: readCustomFormats(ctx),
    qualityProfiles: readQualityProfiles(ctx),
    delayProfiles: readDelayProfiles(ctx),
    releaseProfiles: readReleaseProfiles(ctx),
    indexers: readIndexers(ctx),
    downloadClients: readDownloadClients(ctx),
    remotePathMappings: readRemotePathMappings(ctx),
    notifications: readNotifications(ctx),
    importLists: readImportLists(ctx),
    naming: readNaming(ctx),
    mediaManagement: readMediaManagement(ctx),
    history: readHistory(ctx),
    blocklist: readBlocklist(ctx),
  };
}
