import { and, asc, eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import type { Logger } from 'pino';
import type {
  MediaManagementSettings,
  MigrateApp,
  MigrateApplyOptions,
  MigrateArea,
  MigrateConflictPolicy,
  MigrateSource,
  NamingConfig,
} from '@arclight/shared';
import type { MigrateDeps } from './deps.js';
import type { Db } from '../../db/index.js';
import * as t from '../../db/schema.js';
import { DownloadClientsService } from '../download-clients/service.js';
import { toDirectoryForm } from '../download-clients/remote-paths.js';
import { ImportListsService } from '../import-lists/service.js';
import { IndexersService } from '../indexers/service.js';
import { createTag, toCleanTitle, toSortTitle } from '../library/service.js';
import { NotificationsService } from '../notifications/service.js';
import { ProfilesService } from '../profiles/service.js';
import { getSection, setSection } from '../settings/service.js';
import { indexerServiceFor } from './api/prowlarr-definitions.js';
import { isInside, samePath } from './paths.js';
import { migrateImported } from './schema.js';
import type {
  AreaPayloads,
  BlocklistPayload,
  FilePayload,
  HistoryPayload,
  MoviePayload,
  SeriesPayload,
  SourceBundle,
  SourceItem,
} from './types.js';

// One handler per importable area: how to find the Arclight row an upstream item collides
// with, how to create it, and how to overwrite the collision. Handlers go through the owning
// module's service where it offers the operation; the library, root folders, remote path
// mappings, history and blocklist are written directly because their services have no
// "adopt with original path / date / ids" path (they compute paths from titles, require the
// folder to exist, or stamp the current time).

/** Thrown by a handler to skip one item with a reason (counted as skipped, not failed). */
export class SkipItem extends Error {}

export interface Existing {
  id: number | null;
  reason: string;
}

export interface AreaEnv {
  db: Db;
  app: MigrateApp;
  instance: string;
  bundle: SourceBundle;
  /** Conflict policy of the area being applied (per-area override or the run's default). */
  policy: MigrateConflictPolicy;
  now: string;
  log: Logger;
  /** `${area}:${sourceId}` → Arclight id, for this run. */
  idMap: Map<string, number>;
  warn(area: MigrateArea, message: string, sourceId?: string): void;
  services: Services;
  /** True for dry runs: sync handlers run in a rolled-back transaction; async handlers must not change anything. */
  dryRun: boolean;
  /** The source being imported (secrets included; never log it). */
  source: MigrateSource;
  options: MigrateApplyOptions;
  deps: MigrateDeps;
}

export interface Services {
  profiles: ProfilesService;
  indexers: IndexersService;
  downloadClients: DownloadClientsService;
  notifications: NotificationsService;
  importLists: ImportListsService;
}

export function createServices(db: Db, log: Logger): Services {
  return {
    profiles: new ProfilesService({ db, log }),
    indexers: new IndexersService({ db, log }),
    // Imported mappings/clients are validated by the importer; the service never probes the network here.
    downloadClients: new DownloadClientsService({ db, log }),
    notifications: new NotificationsService({ db, log }),
    importLists: new ImportListsService({
      db,
      log,
      metadata: {
        series: async () => null,
        movie: async () => null,
      },
    }),
  };
}

export interface AreaHandler<A extends MigrateArea> {
  find(env: AreaEnv, item: SourceItem<AreaPayloads[A]>): Existing | null;
  create(env: AreaEnv, item: SourceItem<AreaPayloads[A]>): number | null;
  overwrite?(env: AreaEnv, item: SourceItem<AreaPayloads[A]>, existing: Existing): number | null;
  /** Policy `merge`: keep the existing row's settings, add what it lacks. Absent: like skip. */
  merge?(env: AreaEnv, item: SourceItem<AreaPayloads[A]>, existing: Existing): number | null;
}

export interface AsyncOutcome {
  kind: 'created' | 'updated' | 'merged' | 'skipped';
  /** Arclight id recorded in migrate_imported (null when nothing has an id). */
  id: number | null;
  message?: string;
}

/**
 * Areas whose import needs I/O beyond the database (adopting torrents into the engine, calls to
 * the source app). Run outside any transaction, after the source's sync areas. With
 * `env.dryRun` the handler only checks what it would do and must not change anything (no
 * engine, no source app, no database writes). Throw SkipItem to skip with a reason.
 */
export interface AsyncAreaHandler<A extends MigrateArea> {
  find(env: AreaEnv, item: SourceItem<AreaPayloads[A]>): Existing | null;
  apply(env: AreaEnv, item: SourceItem<AreaPayloads[A]>, existing: Existing | null): Promise<AsyncOutcome>;
}

export type Handlers = { [A in MigrateArea]?: AreaHandler<A> };
export type AsyncHandlers = { [A in MigrateArea]?: AsyncAreaHandler<A> };

// ---- reference resolution ---------------------------------------------------------------

export function importedTarget(db: Db, instance: string, area: string, sourceId: string): { targetId: number | null } | undefined {
  return db
    .select({ targetId: migrateImported.targetId })
    .from(migrateImported)
    .where(and(eq(migrateImported.instance, instance), eq(migrateImported.area, area), eq(migrateImported.sourceId, sourceId)))
    .get();
}

/** Arclight id of an upstream row: this run, an earlier run, or the colliding existing row. */
export function resolveRef(env: AreaEnv, area: MigrateArea | 'episodes', sourceId: string | number | null): number | null {
  if (sourceId === null || sourceId === undefined) return null;
  const key = String(sourceId);
  const mapped = env.idMap.get(`${area}:${key}`);
  if (mapped !== undefined) return mapped;
  const prior = importedTarget(env.db, env.instance, area, key);
  if (prior?.targetId !== null && prior?.targetId !== undefined) return prior.targetId;
  if (area === 'episodes') return null;
  const bundleArea = env.bundle.areas[area];
  const item = bundleArea?.items.find((i) => i.sourceId === key);
  if (!item) return null;
  const handler = HANDLERS[area] as AreaHandler<MigrateArea> | undefined;
  const existing = handler?.find(env, item as SourceItem<AreaPayloads[MigrateArea]>);
  return existing?.id ?? null;
}

function resolveTags(env: AreaEnv, area: MigrateArea, sourceIds: number[], owner: string): number[] {
  const out: number[] = [];
  for (const sid of sourceIds) {
    const id = resolveRef(env, 'tags', sid);
    if (id === null) env.warn(area, `${owner}: tag ${sid} could not be mapped and was dropped`);
    else if (!out.includes(id)) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

function resolveQualityProfile(env: AreaEnv, area: MigrateArea, sourceId: number | null, owner: string): number {
  const mapped = resolveRef(env, 'qualityProfiles', sourceId);
  if (mapped !== null) return mapped;
  const first = env.db.select({ id: t.qualityProfiles.id }).from(t.qualityProfiles).orderBy(asc(t.qualityProfiles.id)).get();
  if (!first) throw new Error('no quality profile exists in Arclight; import quality profiles first');
  env.warn(area, `${owner}: quality profile ${sourceId ?? '?'} was not imported; using profile ${first.id}`);
  return first.id;
}

// ---- library writes ---------------------------------------------------------------------

function insertFile(env: AreaEnv, mediaType: 'series' | 'movie', parentId: number, f: FilePayload): number | null {
  if (env.db.select({ id: t.mediaFiles.id }).from(t.mediaFiles).where(eq(t.mediaFiles.path, f.path)).get()) {
    env.warn(mediaType === 'series' ? 'series' : 'movies', `file already tracked, skipped: ${f.path}`, f.sourceId);
    return null;
  }
  const row = env.db
    .insert(t.mediaFiles)
    .values({
      mediaType,
      seriesId: mediaType === 'series' ? parentId : null,
      movieId: mediaType === 'movie' ? parentId : null,
      seasonNumber: f.seasonNumber,
      relativePath: f.relativePath,
      path: f.path,
      sizeBytes: f.sizeBytes,
      dateAdded: f.dateAdded ?? env.now,
      quality: f.quality,
      languages: f.languages,
      releaseGroup: f.releaseGroup,
      sceneName: f.sceneName,
      edition: f.edition,
      mediaInfo: f.mediaInfo,
    })
    .returning({ id: t.mediaFiles.id })
    .get();
  return row.id;
}

function recordSub(env: AreaEnv, area: 'episodes' | 'mediaFiles', sourceId: string, targetId: number): void {
  env.idMap.set(`${area}:${sourceId}`, targetId);
  env.db
    .insert(migrateImported)
    .values({ instance: env.instance, sourceApp: env.app, area, sourceId, targetId, importedAt: env.now })
    .onConflictDoUpdate({ target: [migrateImported.instance, migrateImported.area, migrateImported.sourceId], set: { targetId } })
    .run();
}

/** Seasons, episodes and files of a series (new or existing). Existing episodes keep their row. */
function writeEpisodes(env: AreaEnv, seriesId: number, p: SeriesPayload, updateMonitoring: boolean): void {
  const seasonRows = new Map(env.db.select().from(t.seasons).where(eq(t.seasons.seriesId, seriesId)).all().map((s) => [s.seasonNumber, s]));
  const seasonNumbers = new Set<number>([...p.seasons.map((s) => s.seasonNumber), ...p.episodes.map((e) => e.seasonNumber)]);
  for (const n of [...seasonNumbers].sort((a, b) => a - b)) {
    const monitored = p.seasons.find((s) => s.seasonNumber === n)?.monitored ?? n > 0;
    const existing = seasonRows.get(n);
    if (!existing) env.db.insert(t.seasons).values({ seriesId, seasonNumber: n, monitored }).run();
    else if (updateMonitoring) env.db.update(t.seasons).set({ monitored }).where(eq(t.seasons.id, existing.id)).run();
  }

  const fileIds = new Map<string, number>();
  for (const f of p.files) {
    const id = insertFile(env, 'series', seriesId, f);
    if (id !== null) {
      fileIds.set(f.sourceId, id);
      recordSub(env, 'mediaFiles', f.sourceId, id);
    }
  }
  const existingEpisodes = new Map(
    env.db
      .select()
      .from(t.episodes)
      .where(eq(t.episodes.seriesId, seriesId))
      .all()
      .map((e) => [`${e.seasonNumber}:${e.episodeNumber}`, e]),
  );
  for (const e of p.episodes) {
    const fileId = e.sourceFileId ? (fileIds.get(e.sourceFileId) ?? null) : null;
    const current = existingEpisodes.get(`${e.seasonNumber}:${e.episodeNumber}`);
    if (current) {
      const set: Partial<typeof t.episodes.$inferInsert> = {};
      if (updateMonitoring) set.monitored = e.monitored;
      if (fileId !== null && current.episodeFileId === null) Object.assign(set, { hasFile: true, episodeFileId: fileId });
      if (Object.keys(set).length > 0) env.db.update(t.episodes).set(set).where(eq(t.episodes.id, current.id)).run();
      recordSub(env, 'episodes', e.sourceId, current.id);
      continue;
    }
    const row = env.db
      .insert(t.episodes)
      .values({
        seriesId,
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
        absoluteEpisodeNumber: e.absoluteEpisodeNumber,
        title: e.title?.trim() || 'TBA',
        overview: e.overview ?? '',
        airDate: e.airDate,
        airDateUtc: e.airDateUtc,
        runtimeMinutes: e.runtimeMinutes,
        monitored: e.monitored,
        hasFile: fileId !== null,
        episodeFileId: fileId,
      })
      .returning({ id: t.episodes.id })
      .get();
    recordSub(env, 'episodes', e.sourceId, row.id);
  }
}

function seriesSettings(env: AreaEnv, item: SourceItem<SeriesPayload>) {
  const p = item.payload;
  return {
    path: p.path,
    rootFolderPath: p.rootFolderPath,
    qualityProfileId: resolveQualityProfile(env, 'series', p.sourceQualityProfileId, item.name),
    monitored: p.monitored,
    monitorNewItems: p.monitorNewItems,
    seriesType: p.seriesType,
    seasonFolder: p.seasonFolder,
    useSceneNumbering: p.useSceneNumbering,
    tags: resolveTags(env, 'series', p.sourceTagIds, item.name),
  };
}

function movieSettings(env: AreaEnv, item: SourceItem<MoviePayload>) {
  const p = item.payload;
  return {
    path: p.path,
    rootFolderPath: p.rootFolderPath,
    qualityProfileId: resolveQualityProfile(env, 'movies', p.sourceQualityProfileId, item.name),
    minimumAvailability: p.minimumAvailability,
    monitored: p.monitored,
    tags: resolveTags(env, 'movies', p.sourceTagIds, item.name),
  };
}

function settingsRowExists(db: Db, key: string): boolean {
  return db.select({ key: t.settings.key }).from(t.settings).where(eq(t.settings.key, key)).get() !== undefined;
}

function historyParents(env: AreaEnv, p: HistoryPayload | BlocklistPayload): { seriesId: number | null; movieId: number | null } {
  if (p.mediaType === 'series') {
    const seriesId = resolveRef(env, 'series', p.sourceSeriesId);
    if (seriesId === null) throw new SkipItem('series not imported');
    return { seriesId, movieId: null };
  }
  const movieId = resolveRef(env, 'movies', p.sourceMovieId);
  if (movieId === null) throw new SkipItem('movie not imported');
  return { seriesId: null, movieId };
}

// ---- handlers ---------------------------------------------------------------------------

/**
 * Handlers for the Sonarr/Radarr/Prowlarr areas. Bazarr, Seerr, indexer proxies and torrents
 * live in their own `areas-*.ts` files; `handlers.ts` combines them all.
 */
export const HANDLERS: Handlers = {
  tags: {
    find: (env, item) => {
      const row = env.db.select({ id: t.tags.id }).from(t.tags).where(eq(t.tags.label, item.payload.label)).get();
      return row ? { id: row.id, reason: `tag "${item.payload.label}" exists` } : null;
    },
    create: (env, item) => createTag(env.db, item.payload.label).id,
    overwrite: (_env, _item, existing) => existing.id,
  },

  rootFolders: {
    find: (env, item) => {
      for (const r of env.db.select().from(t.rootFolders).all()) {
        if (samePath(r.path, item.payload.path)) return { id: r.id, reason: 'root folder exists' };
        if (isInside(r.path, item.payload.path) || isInside(item.payload.path, r.path)) return { id: r.id, reason: `overlaps root folder ${r.path}` };
      }
      return null;
    },
    create: (env, item) => {
      if (!existsSync(item.payload.path)) env.warn('rootFolders', `${item.payload.path} is not accessible from Arclight (check the path mappings)`, item.sourceId);
      return env.db.insert(t.rootFolders).values({ path: item.payload.path, mediaType: item.payload.mediaType }).returning({ id: t.rootFolders.id }).get().id;
    },
    overwrite: (_env, _item, existing) => existing.id,
  },

  customFormats: {
    find: (env, item) => {
      const row = env.db.select({ id: t.customFormats.id }).from(t.customFormats).where(eq(t.customFormats.name, item.payload.input.name)).get();
      return row ? { id: row.id, reason: `custom format "${item.payload.input.name}" exists` } : null;
    },
    create: (env, item) => env.services.profiles.createCustomFormat(item.payload.input).id,
    overwrite: (env, item, existing) => env.services.profiles.updateCustomFormat(existing.id!, item.payload.input).id,
  },

  qualityProfiles: {
    find: (env, item) => {
      const row = env.db.select({ id: t.qualityProfiles.id }).from(t.qualityProfiles).where(eq(t.qualityProfiles.name, item.payload.input.name)).get();
      return row ? { id: row.id, reason: `quality profile "${item.payload.input.name}" exists` } : null;
    },
    create: (env, item) => env.services.profiles.createQualityProfile(profileInput(env, item)).id,
    overwrite: (env, item, existing) => env.services.profiles.updateQualityProfile(existing.id!, profileInput(env, item)).id,
  },

  delayProfiles: {
    find: (env, item) => {
      // A tag that does not resolve yet cannot match anything (and must not match the default).
      const ids = item.payload.sourceTagIds.map((s) => resolveRef(env, 'tags', s));
      if (ids.some((x) => x === null)) return null;
      const tags = [...new Set(ids as number[])].sort((a, b) => a - b).join(',');
      const row = env.services.profiles.listDelayProfiles().find((d) => [...d.tags].sort((a, b) => a - b).join(',') === tags);
      return row ? { id: row.id, reason: tags === '' ? 'the default delay profile exists' : 'a delay profile with the same tags exists' } : null;
    },
    create: (env, item) =>
      env.services.profiles.createDelayProfile({ ...item.payload.input, tags: resolveTags(env, 'delayProfiles', item.payload.sourceTagIds, item.name) }).id,
    overwrite: (env, item, existing) =>
      env.services.profiles.updateDelayProfile(existing.id!, { ...item.payload.input, tags: resolveTags(env, 'delayProfiles', item.payload.sourceTagIds, item.name) }).id,
  },

  releaseProfiles: {
    find: (env, item) => {
      const row = env.db.select({ id: t.releaseProfiles.id }).from(t.releaseProfiles).where(eq(t.releaseProfiles.name, item.payload.name)).get();
      return row ? { id: row.id, reason: `release profile "${item.payload.name}" exists` } : null;
    },
    create: (env, item) => env.services.profiles.createReleaseProfile(releaseProfileInput(env, item)).id,
    overwrite: (env, item, existing) => env.services.profiles.updateReleaseProfile(existing.id!, releaseProfileInput(env, item)).id,
  },

  downloadClients: {
    find: (env, item) => {
      const row = env.db.select({ id: t.downloadClients.id }).from(t.downloadClients).where(eq(t.downloadClients.name, item.name)).get();
      return row ? { id: row.id, reason: `download client "${item.name}" exists` } : null;
    },
    create: (env, item) => {
      if (!item.payload.input) throw new SkipItem('not supported');
      return env.services.downloadClients.create({ ...item.payload.input, tags: resolveTags(env, 'downloadClients', item.payload.sourceTagIds, item.name) }).id;
    },
    overwrite: (env, item, existing) => {
      if (!item.payload.input) throw new SkipItem('not supported');
      return env.services.downloadClients.update(existing.id!, { ...item.payload.input, tags: resolveTags(env, 'downloadClients', item.payload.sourceTagIds, item.name) }).id;
    },
  },

  indexers: {
    find: (env, item) => {
      const row = env.db.select({ id: t.indexers.id }).from(t.indexers).where(eq(t.indexers.name, item.payload.create.name)).get();
      return row ? { id: row.id, reason: `indexer "${item.payload.create.name}" exists` } : null;
    },
    create: (env, item) => {
      const downloadClientId = resolveRef(env, 'downloadClients', item.payload.sourceDownloadClientId);
      return indexerServiceFor(env).create({ ...item.payload.create, tags: resolveTags(env, 'indexers', item.payload.sourceTagIds, item.name), downloadClientId }).id;
    },
    overwrite: (env, item, existing) => {
      const downloadClientId = resolveRef(env, 'downloadClients', item.payload.sourceDownloadClientId);
      const c = item.payload.create;
      return indexerServiceFor(env).update(existing.id!, {
        name: c.name,
        implementation: c.implementation,
        ...(c.enableRss !== undefined ? { enableRss: c.enableRss } : {}),
        ...(c.enableAutomaticSearch !== undefined ? { enableAutomaticSearch: c.enableAutomaticSearch } : {}),
        ...(c.enableInteractiveSearch !== undefined ? { enableInteractiveSearch: c.enableInteractiveSearch } : {}),
        ...(c.priority !== undefined ? { priority: c.priority } : {}),
        tags: resolveTags(env, 'indexers', item.payload.sourceTagIds, item.name),
        downloadClientId,
        settings: { ...c.settings, apiPath: c.settings.apiPath ?? '/api', categories: c.settings.categories ?? [], animeCategories: c.settings.animeCategories ?? [] },
      }).id;
    },
  },

  remotePathMappings: {
    find: (env, item) => {
      const remote = toDirectoryForm(item.payload.remotePath);
      const row = env.db
        .select()
        .from(t.remotePathMappings)
        .all()
        .find((m) => m.host.toLowerCase() === item.payload.host.toLowerCase() && m.remotePath === remote);
      return row ? { id: row.id, reason: `a mapping for ${row.host} ${row.remotePath} exists` } : null;
    },
    create: (env, item) =>
      env.db
        .insert(t.remotePathMappings)
        .values({ host: item.payload.host, remotePath: toDirectoryForm(item.payload.remotePath), localPath: toDirectoryForm(item.payload.localPath) })
        .returning({ id: t.remotePathMappings.id })
        .get().id,
    overwrite: (env, item, existing) => {
      env.db.update(t.remotePathMappings).set({ localPath: toDirectoryForm(item.payload.localPath) }).where(eq(t.remotePathMappings.id, existing.id!)).run();
      return existing.id;
    },
  },

  notifications: {
    find: (env, item) => {
      const row = env.db.select({ id: t.notifications.id }).from(t.notifications).where(eq(t.notifications.name, item.name)).get();
      return row ? { id: row.id, reason: `notification "${item.name}" exists` } : null;
    },
    create: (env, item) => env.services.notifications.create({ ...item.payload.input, tags: resolveTags(env, 'notifications', item.payload.sourceTagIds, item.name) }).id,
    overwrite: (env, item, existing) =>
      env.services.notifications.update(existing.id!, { ...item.payload.input, tags: resolveTags(env, 'notifications', item.payload.sourceTagIds, item.name) }).id,
  },

  importLists: {
    find: (env, item) => {
      const row = env.db.select({ id: t.importLists.id }).from(t.importLists).where(eq(t.importLists.name, item.name)).get();
      return row ? { id: row.id, reason: `import list "${item.name}" exists` } : null;
    },
    create: (env, item) => env.services.importLists.create(importListInput(env, item)).id,
    overwrite: (env, item, existing) => env.services.importLists.update(existing.id!, importListInput(env, item)).id,
  },

  naming: {
    find: (env) => (settingsRowExists(env.db, 'naming') ? { id: null, reason: 'naming is already configured' } : null),
    create: (env, item) => {
      setSection(env.db, 'naming', { ...getSection(env.db, 'naming'), ...item.payload.values } as NamingConfig, env.now);
      return null;
    },
    overwrite: (env, item) => {
      setSection(env.db, 'naming', { ...getSection(env.db, 'naming'), ...item.payload.values } as NamingConfig, env.now);
      return null;
    },
  },

  mediaManagement: {
    find: (env) => (settingsRowExists(env.db, 'mediaManagement') ? { id: null, reason: 'media management is already configured' } : null),
    create: (env, item) => {
      setSection(env.db, 'mediaManagement', { ...getSection(env.db, 'mediaManagement'), ...item.payload.values } as MediaManagementSettings, env.now);
      return null;
    },
    overwrite: (env, item) => {
      setSection(env.db, 'mediaManagement', { ...getSection(env.db, 'mediaManagement'), ...item.payload.values } as MediaManagementSettings, env.now);
      return null;
    },
  },

  series: {
    find: (env, item) => {
      const p = item.payload;
      if (p.tmdbId !== null) {
        const byTmdb = env.db.select({ id: t.series.id }).from(t.series).where(eq(t.series.tmdbId, p.tmdbId)).get();
        if (byTmdb) return { id: byTmdb.id, reason: `series with TMDB id ${p.tmdbId} exists` };
      }
      const byPath = env.db.select({ id: t.series.id }).from(t.series).where(eq(t.series.path, p.path)).get();
      return byPath ? { id: byPath.id, reason: `a series already uses ${p.path}` } : null;
    },
    create: (env, item) => {
      const p = item.payload;
      if (p.tmdbId === null) throw new SkipItem('no TMDB id');
      const row = env.db
        .insert(t.series)
        .values({
          tmdbId: p.tmdbId,
          tvdbId: p.tvdbId,
          imdbId: p.imdbId,
          title: p.title,
          sortTitle: toSortTitle(p.title),
          cleanTitle: toCleanTitle(p.title),
          year: p.year,
          overview: p.overview,
          status: p.status,
          network: p.network,
          runtimeMinutes: p.runtimeMinutes,
          genres: p.genres,
          images: p.images,
          ratings: p.ratings,
          certification: p.certification,
          originalLanguage: p.originalLanguage,
          ...seriesSettings(env, item),
          added: p.added ?? env.now,
          // Null so the metadata refresh job fills in TMDB data on its next pass.
          lastRefreshed: null,
        })
        .returning({ id: t.series.id })
        .get();
      writeEpisodes(env, row.id, p, true);
      return row.id;
    },
    overwrite: (env, item, existing) => {
      const id = existing.id!;
      const settings = seriesSettings(env, item);
      const clash = env.db.select({ id: t.series.id }).from(t.series).where(eq(t.series.path, settings.path)).get();
      const { path, ...rest } = settings;
      if (clash && clash.id !== id) {
        env.warn('series', `${item.name}: path ${path} belongs to another series; path not changed`, item.sourceId);
        env.db.update(t.series).set(rest).where(eq(t.series.id, id)).run();
      } else env.db.update(t.series).set(settings).where(eq(t.series.id, id)).run();
      writeEpisodes(env, id, item.payload, true);
      return id;
    },
    // Keep Arclight's settings and monitoring; add missing seasons, episodes and files.
    merge: (env, item, existing) => {
      writeEpisodes(env, existing.id!, item.payload, false);
      return existing.id;
    },
  },

  movies: {
    find: (env, item) => {
      const p = item.payload;
      if (p.tmdbId !== null) {
        const byTmdb = env.db.select({ id: t.movies.id }).from(t.movies).where(eq(t.movies.tmdbId, p.tmdbId)).get();
        if (byTmdb) return { id: byTmdb.id, reason: `movie with TMDB id ${p.tmdbId} exists` };
      }
      const byPath = env.db.select({ id: t.movies.id }).from(t.movies).where(eq(t.movies.path, p.path)).get();
      return byPath ? { id: byPath.id, reason: `a movie already uses ${p.path}` } : null;
    },
    create: (env, item) => {
      const p = item.payload;
      if (p.tmdbId === null) throw new SkipItem('no TMDB id');
      const row = env.db
        .insert(t.movies)
        .values({
          tmdbId: p.tmdbId,
          imdbId: p.imdbId,
          title: p.title,
          originalTitle: p.originalTitle,
          sortTitle: toSortTitle(p.title),
          cleanTitle: toCleanTitle(p.title),
          year: p.year,
          overview: p.overview,
          status: p.status,
          inCinemas: p.inCinemas,
          digitalRelease: p.digitalRelease,
          physicalRelease: p.physicalRelease,
          runtimeMinutes: p.runtimeMinutes,
          studio: p.studio,
          genres: p.genres,
          images: p.images,
          ratings: p.ratings,
          certification: p.certification,
          originalLanguage: p.originalLanguage,
          collection: p.collection,
          ...movieSettings(env, item),
          added: p.added ?? env.now,
          lastRefreshed: null,
          hasFile: false,
          movieFileId: null,
        })
        .returning({ id: t.movies.id })
        .get();
      attachMovieFile(env, row.id, p);
      return row.id;
    },
    overwrite: (env, item, existing) => {
      const id = existing.id!;
      const settings = movieSettings(env, item);
      const clash = env.db.select({ id: t.movies.id }).from(t.movies).where(eq(t.movies.path, settings.path)).get();
      const { path, ...rest } = settings;
      if (clash && clash.id !== id) {
        env.warn('movies', `${item.name}: path ${path} belongs to another movie; path not changed`, item.sourceId);
        env.db.update(t.movies).set(rest).where(eq(t.movies.id, id)).run();
      } else env.db.update(t.movies).set(settings).where(eq(t.movies.id, id)).run();
      const current = env.db.select({ movieFileId: t.movies.movieFileId }).from(t.movies).where(eq(t.movies.id, id)).get();
      if (!current?.movieFileId) attachMovieFile(env, id, item.payload);
      return id;
    },
    // Keep Arclight's settings; adopt the file when Arclight has none.
    merge: (env, item, existing) => {
      const id = existing.id!;
      const current = env.db.select({ movieFileId: t.movies.movieFileId }).from(t.movies).where(eq(t.movies.id, id)).get();
      if (!current?.movieFileId) attachMovieFile(env, id, item.payload);
      return id;
    },
  },

  history: {
    // Same event, same title, same moment, same episode: the row came over already (another run
    // reading the same app through the API instead of its files, or a second instance of the
    // source). The episode matters: Sonarr writes one row per episode of a season pack.
    find: (env, item) => {
      const p = item.payload;
      const episodeId = p.mediaType === 'series' ? resolveRef(env, 'episodes', p.sourceEpisodeId) : null;
      const row = env.db
        .select({ id: t.history.id, date: t.history.date, eventType: t.history.eventType, episodeId: t.history.episodeId })
        .from(t.history)
        .where(eq(t.history.sourceTitle, p.sourceTitle))
        .all()
        .find((r) => r.date === p.date && r.eventType === p.eventType && (p.mediaType !== 'series' || r.episodeId === episodeId));
      return row ? { id: row.id, reason: 'the same history event exists' } : null;
    },
    overwrite: (_env, _item, existing) => existing.id,
    create: (env, item) => {
      const p = item.payload;
      const { seriesId, movieId } = historyParents(env, p);
      const episodeId = p.mediaType === 'series' ? resolveRef(env, 'episodes', p.sourceEpisodeId) : null;
      if (p.mediaType === 'series' && episodeId === null) throw new SkipItem('episode not imported');
      return env.db
        .insert(t.history)
        .values({
          eventType: p.eventType,
          mediaType: p.mediaType,
          seriesId,
          episodeId,
          movieId,
          sourceTitle: p.sourceTitle,
          quality: p.quality,
          languages: p.languages,
          date: p.date,
          downloadId: p.downloadId,
          data: p.data,
        })
        .returning({ id: t.history.id })
        .get().id;
    },
  },

  blocklist: {
    find: (env, item) => {
      const p = item.payload;
      const row = env.db
        .select({ id: t.blocklist.id, date: t.blocklist.date })
        .from(t.blocklist)
        .where(eq(t.blocklist.sourceTitle, p.sourceTitle))
        .all()
        .find((r) => r.date === p.date);
      return row ? { id: row.id, reason: 'already blocklisted' } : null;
    },
    create: (env, item) => {
      const p = item.payload;
      const { seriesId, movieId } = historyParents(env, p);
      const episodeIds = p.sourceEpisodeIds.map((e) => resolveRef(env, 'episodes', e)).filter((e): e is number => e !== null);
      return env.db
        .insert(t.blocklist)
        .values({
          mediaType: p.mediaType,
          seriesId,
          episodeIds,
          movieId,
          sourceTitle: p.sourceTitle,
          quality: p.quality,
          languages: p.languages,
          date: p.date,
          publishedDate: p.publishedDate,
          size: p.size,
          protocol: p.protocol,
          indexer: p.indexer,
          indexerFlags: p.indexerFlags,
          message: p.message,
          torrentInfoHash: p.torrentInfoHash,
          releaseType: p.releaseType,
        })
        .returning({ id: t.blocklist.id })
        .get().id;
    },
    overwrite: (_env, _item, existing) => existing.id,
  },
};

function attachMovieFile(env: AreaEnv, movieId: number, p: MoviePayload): void {
  if (!p.file) return;
  const fileId = insertFile(env, 'movie', movieId, p.file);
  if (fileId === null) return;
  recordSub(env, 'mediaFiles', p.file.sourceId, fileId);
  env.db.update(t.movies).set({ hasFile: true, movieFileId: fileId }).where(eq(t.movies.id, movieId)).run();
}

function profileInput(env: AreaEnv, item: SourceItem<AreaPayloads['qualityProfiles']>) {
  const formatItems: Array<{ formatId: number; score: number }> = [];
  for (const f of item.payload.formatItems) {
    const formatId = resolveRef(env, 'customFormats', f.sourceFormatId);
    if (formatId === null) {
      env.warn('qualityProfiles', `"${item.name}": custom format ${f.sourceFormatId} was not imported; its score is dropped`, item.sourceId);
      continue;
    }
    if (!formatItems.some((x) => x.formatId === formatId)) formatItems.push({ formatId, score: f.score });
  }
  return { ...item.payload.input, formatItems };
}

function releaseProfileInput(env: AreaEnv, item: SourceItem<AreaPayloads['releaseProfiles']>) {
  const p = item.payload;
  const indexerId = resolveRef(env, 'indexers', p.sourceIndexerId);
  if (p.sourceIndexerId !== null && indexerId === null) env.warn('releaseProfiles', `"${p.name}": indexer ${p.sourceIndexerId} not imported; profile applies to all indexers`, item.sourceId);
  return {
    name: p.name,
    enabled: p.enabled,
    required: p.required,
    ignored: p.ignored,
    tags: resolveTags(env, 'releaseProfiles', p.sourceTagIds, p.name),
    ...(indexerId !== null ? { indexerId } : {}),
  };
}

function importListInput(env: AreaEnv, item: SourceItem<AreaPayloads['importLists']>) {
  return {
    ...item.payload.input,
    qualityProfileId: resolveQualityProfile(env, 'importLists', item.payload.sourceQualityProfileId, item.name),
    tags: resolveTags(env, 'importLists', item.payload.sourceTagIds, item.name),
  };
}
