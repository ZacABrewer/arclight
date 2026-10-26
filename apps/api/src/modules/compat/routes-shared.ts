import { statfs } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AddRootFolderRequest,
  BlocklistListQuery,
  FileSystemQuery,
  HistoryListQuery,
  ReleasePushRequest,
  TagRequest,
  type HistoryRecord,
  type HistorySortKey,
  type QueueItem,
  type QueueSortKey,
} from '@arclight/shared';
import { blocklistServiceFor } from '../blocklist/index.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { historyServiceFor } from '../history/index.js';
import { importListsServiceFor } from '../import-lists/index.js';
import { getImportsService } from '../imports/index.js';
import { indexersServiceFor } from '../indexers/index.js';
import { libraryService as lib } from '../library/index.js';
import { notificationsServiceFor } from '../notifications/index.js';
import { releasesServiceFor } from '../releases/index.js';
import {
  parseHistoryEventType,
  toV3Blocklist,
  toV3History,
  toV3QueueRecords,
  toV3Release,
  trackedIdFromQueueId,
} from './activity.js';
import { compact, CompatError, parseOr400, qsBool, qsInt, qsIntList, type Json } from './common.js';
import {
  fromV3IndexerCreate,
  fromV3IndexerUpdate,
  fromV3QualityProfile,
  indexerSchemas,
  toV3CustomFormat,
  toV3DelayProfile,
  toV3DownloadClient,
  toV3ImportList,
  toV3Indexer,
  toV3Notification,
  toV3QualityDefinition,
  toV3QualityProfile,
  toV3ReleaseProfile,
  toV3RootFolder,
  toV3Tag,
  type V3ProviderBody,
  type V3QualityProfileIn,
} from './config.js';
import { toV3Episode } from './media.js';
import { envelope, pageOf, PagingQuery, sortOrder } from './paging.js';
import { languageList, v3Language } from './quality.js';
import type { CompatServices } from './services.js';

// Resources both apps have, served in the Sonarr shape (plus harmless Radarr-only fields).

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const ProviderBody = z
  .object({
    id: z.coerce.number().int().optional(),
    name: z.string().optional(),
    implementation: z.string().optional(),
    configContract: z.string().optional(),
    fields: z.array(z.object({ name: z.string(), value: z.unknown().optional() }).passthrough()).optional(),
    enableRss: z.boolean().optional(),
    enableAutomaticSearch: z.boolean().optional(),
    enableInteractiveSearch: z.boolean().optional(),
    priority: z.coerce.number().optional(),
    tags: z.array(z.coerce.number().int()).optional(),
    downloadClientId: z.coerce.number().int().nullish(),
  })
  .passthrough();

const QualityProfileBody: z.ZodType<V3QualityProfileIn> = z
  .object({
    name: z.string().min(1),
    upgradeAllowed: z.boolean().optional(),
    cutoff: z.coerce.number().int(),
    items: z.array(z.any()),
    minFormatScore: z.coerce.number().int().optional(),
    cutoffFormatScore: z.coerce.number().int().optional(),
    minUpgradeFormatScore: z.coerce.number().int().optional(),
    formatItems: z.array(z.object({ format: z.coerce.number().int(), score: z.coerce.number().int() }).passthrough()).optional(),
    language: z.object({ id: z.coerce.number().int() }).passthrough().optional(),
  })
  .passthrough() as unknown as z.ZodType<V3QualityProfileIn>;

export function sharedRoutes(app: FastifyInstance, s: CompatServices): void {
  const db = s.db;
  const ctx = s.ctx;

  // ---------------------------------------------------------------------------- root folders
  const rootFolderJson = async (r: Awaited<ReturnType<typeof lib.listRootFolders>>[number]) => {
    let total: number | null = null;
    try {
      const info = await statfs(r.path);
      total = Number(info.blocks) * Number(info.bsize);
    } catch {
      total = null;
    }
    return toV3RootFolder(r, total);
  };

  app.get('/rootfolder', async () => Promise.all((await lib.listRootFolders(db)).map(rootFolderJson)));
  app.get('/rootfolder/:id', async (req) => rootFolderJson(await lib.getRootFolder(db, parseOr400(IdParam, req.params).id)));
  app.post('/rootfolder', async (req, reply) => {
    const body = parseOr400(z.object({ path: z.string().min(1), mediaType: z.enum(['series', 'movie']).optional() }).passthrough(), req.body);
    // Sonarr/Radarr do not send a media type; guess from the folder name, default series.
    const mediaType = body.mediaType ?? (/movie|film/i.test(body.path) ? 'movie' : 'series');
    const added = await lib.addRootFolder(db, AddRootFolderRequest.parse({ path: body.path, mediaType }));
    return reply.code(201).send(await rootFolderJson(added));
  });
  app.delete('/rootfolder/:id', async (req) => {
    lib.deleteRootFolder(db, parseOr400(IdParam, req.params).id);
    return {};
  });

  // ---------------------------------------------------------------------------- tags
  app.get('/tag', async () => lib.listTags(db).map(toV3Tag));
  app.get('/tag/:id', async (req) => toV3Tag(lib.getTag(db, parseOr400(IdParam, req.params).id)));
  app.post('/tag', async (req, reply) => {
    const { label } = parseOr400(TagRequest, req.body);
    const existing = lib.listTags(db).find((t) => t.label.toLowerCase() === label.toLowerCase());
    return reply.code(201).send(toV3Tag(existing ?? lib.createTag(db, label)));
  });
  app.put('/tag/:id', async (req, reply) => {
    const { label } = parseOr400(TagRequest, req.body);
    return reply.code(202).send(toV3Tag(lib.updateTag(db, parseOr400(IdParam, req.params).id, label)));
  });
  app.delete('/tag/:id', async (req) => {
    lib.deleteTag(db, parseOr400(IdParam, req.params).id);
    return {};
  });

  // ---------------------------------------------------------------------------- languages
  app.get('/language', async () => languageList());
  app.get('/language/:id', async (req) => {
    const { id } = parseOr400(z.object({ id: z.coerce.number().int() }), req.params);
    const found = languageList().find((l) => l['id'] === id);
    if (!found) throw CompatError.notFound();
    return found;
  });
  // Sonarr v3 clients (Overseerr in v3 mode, LunaSea) still ask for language profiles.
  const languageProfile = {
    id: 1,
    name: 'Any',
    upgradeAllowed: false,
    cutoff: v3Language('en'),
    languages: languageList().map((l) => ({ language: { id: l['id'], name: l['name'] }, allowed: true })),
  };
  app.get('/languageprofile', async () => [languageProfile]);
  app.get('/languageprofile/:id', async () => languageProfile);

  // ---------------------------------------------------------------------------- profiles
  app.get('/qualityprofile', async () => {
    const formats = s.profiles.listCustomFormats();
    return s.profiles.listQualityProfiles().map((p) => toV3QualityProfile(p, formats));
  });
  app.get('/qualityprofile/:id', async (req) =>
    toV3QualityProfile(s.profiles.getQualityProfile(parseOr400(IdParam, req.params).id), s.profiles.listCustomFormats()),
  );
  app.post('/qualityprofile', async (req, reply) => {
    const created = s.profiles.createQualityProfile(fromV3QualityProfile(parseOr400(QualityProfileBody, req.body)));
    return reply.code(201).send(toV3QualityProfile(created, s.profiles.listCustomFormats()));
  });
  app.put('/qualityprofile/:id', async (req, reply) => {
    const { id } = parseOr400(IdParam, req.params);
    const existing = s.profiles.getQualityProfile(id);
    const updated = s.profiles.updateQualityProfile(id, fromV3QualityProfile(parseOr400(QualityProfileBody, req.body), existing));
    return reply.code(202).send(toV3QualityProfile(updated, s.profiles.listCustomFormats()));
  });

  app.get('/qualitydefinition', async () => s.profiles.listQualityDefinitions().map(toV3QualityDefinition));
  app.get('/qualitydefinition/:id', async (req) => {
    const { id } = parseOr400(z.object({ id: z.coerce.number().int().min(0) }), req.params);
    const found = s.profiles.listQualityDefinitions().find((d) => d.qualityId === id);
    if (!found) throw CompatError.notFound();
    return toV3QualityDefinition(found);
  });
  const DefinitionBody = z
    .object({
      id: z.coerce.number().int().min(0).optional(),
      quality: z.object({ id: z.coerce.number().int().min(0) }).passthrough().optional(),
      minSize: z.coerce.number().min(0).nullish(),
      maxSize: z.coerce.number().min(0).nullish(),
      preferredSize: z.coerce.number().min(0).nullish(),
    })
    .passthrough();
  const updateDefinition = (raw: z.infer<typeof DefinitionBody>, fallbackId?: number) => {
    const qualityId = raw.quality?.id ?? raw.id ?? fallbackId;
    if (qualityId === undefined) throw CompatError.validation('quality', 'quality.id is required');
    return toV3QualityDefinition(
      s.profiles.updateQualityDefinition(qualityId, {
        minSize: raw.minSize ?? null,
        maxSize: raw.maxSize ?? null,
        preferredSize: raw.preferredSize ?? null,
      }),
    );
  };
  app.put('/qualitydefinition/update', async (req, reply) => {
    const list = parseOr400(z.array(DefinitionBody), req.body);
    return reply.code(202).send(list.map((d) => updateDefinition(d)));
  });
  app.put('/qualitydefinition/:id', async (req, reply) => {
    const { id } = parseOr400(z.object({ id: z.coerce.number().int().min(0) }), req.params);
    return reply.code(202).send(updateDefinition(parseOr400(DefinitionBody, req.body), id));
  });

  app.get('/customformat', async () => s.profiles.listCustomFormats().map(toV3CustomFormat));
  app.get('/customformat/:id', async (req) => toV3CustomFormat(s.profiles.getCustomFormat(parseOr400(IdParam, req.params).id)));
  app.get('/delayprofile', async () => s.profiles.listDelayProfiles().map(toV3DelayProfile));
  app.get('/delayprofile/:id', async (req) => toV3DelayProfile(s.profiles.getDelayProfile(parseOr400(IdParam, req.params).id)));
  app.get('/releaseprofile', async () => s.profiles.listReleaseProfiles().map(toV3ReleaseProfile));
  app.get('/releaseprofile/:id', async (req) => toV3ReleaseProfile(s.profiles.getReleaseProfile(parseOr400(IdParam, req.params).id)));

  // ---------------------------------------------------------------------------- indexers
  const indexers = () => indexersServiceFor(ctx);
  app.get('/indexer', async () => indexers().list().map(toV3Indexer));
  app.get('/indexer/schema', async () => indexerSchemas());
  app.get('/indexer/:id', async (req) => toV3Indexer(indexers().get(parseOr400(IdParam, req.params).id)));
  app.post('/indexer', async (req, reply) => {
    const body = parseOr400(ProviderBody, req.body) as V3ProviderBody;
    return reply.code(201).send(toV3Indexer(indexers().create(fromV3IndexerCreate(body))));
  });
  app.put('/indexer/:id', async (req, reply) => {
    const { id } = parseOr400(IdParam, req.params);
    const body = parseOr400(ProviderBody, req.body) as V3ProviderBody;
    return reply.code(202).send(toV3Indexer(indexers().update(id, fromV3IndexerUpdate(body))));
  });
  app.delete('/indexer/:id', async (req) => {
    indexers().delete(parseOr400(IdParam, req.params).id);
    return {};
  });
  // Prowlarr's connection test: validate the body's shape only (the test indexer it sends
  // points at a placeholder), then answer 200 with the advertised version header.
  app.post('/indexer/test', async (req) => {
    fromV3IndexerCreate(parseOr400(ProviderBody, req.body) as V3ProviderBody);
    return {};
  });
  app.post('/indexer/testall', async () =>
    indexers()
      .list()
      .map((i) => ({ id: i.id, isValid: true, validationFailures: [] })),
  );

  // ---------------------------------------------------------------------------- read-only providers
  app.get('/downloadclient', async () => getDownloadClientsService(ctx).list().map(toV3DownloadClient));
  app.get('/downloadclient/:id', async (req) => toV3DownloadClient(getDownloadClientsService(ctx).get(parseOr400(IdParam, req.params).id)));
  app.get('/notification', async () => notificationsServiceFor(ctx).list().map(toV3Notification));
  app.get('/importlist', async () => importListsServiceFor(ctx).list().map(toV3ImportList));

  // ---------------------------------------------------------------------------- history
  const historyService = () => historyServiceFor(ctx);
  const embedHistory = (records: HistoryRecord[], include: { series?: boolean | undefined; episode?: boolean | undefined; movie?: boolean | undefined }) => {
    const seriesCache = new Map<number, Json>();
    const movieCache = new Map<number, Json>();
    const extras = include.series ? s.seriesExtras() : new Map();
    const safe = <T>(fn: () => T): T | undefined => {
      try {
        return fn();
      } catch {
        return undefined;
      }
    };
    return records.map((r) => {
      let series: Json | undefined;
      let episode: Json | undefined;
      let movie: Json | undefined;
      if (include.series && r.seriesId) {
        const id = r.seriesId;
        series = seriesCache.get(id) ?? safe(() => s.seriesJson(lib.getSeries(db, id), extras));
        if (series) seriesCache.set(id, series);
      }
      if (include.episode && r.episodeId) {
        const id = r.episodeId;
        const e = safe(() => lib.getEpisode(db, id));
        episode = e ? toV3Episode(e) : undefined;
      }
      if (include.movie && r.movieId) {
        const id = r.movieId;
        movie = movieCache.get(id) ?? safe(() => s.movieJson(lib.getMovie(db, id)));
        if (movie) movieCache.set(id, movie);
      }
      return toV3History(r, { series, episode, movie });
    });
  };

  const HISTORY_SORT: Record<string, HistorySortKey> = {
    date: 'date',
    sourcetitle: 'sourceTitle',
    'series.sorttitle': 'title',
    'series.title': 'title',
    'movies.sorttitle': 'title',
    'movie.sorttitle': 'title',
    title: 'title',
    quality: 'quality',
    eventtype: 'eventType',
  };

  app.get('/history', async (req) => {
    const q = parseOr400(
      PagingQuery.extend({
        eventType: z.unknown().optional(),
        episodeId: qsInt,
        downloadId: z.string().optional(),
        seriesId: qsIntList,
        seriesIds: qsIntList,
        movieId: qsIntList,
        movieIds: qsIntList,
        includeSeries: qsBool,
        includeEpisode: qsBool,
        includeMovie: qsBool,
      }),
      req.query,
    );
    const eventType = parseHistoryEventType(q.eventType);
    const seriesIds = [...(q.seriesId ?? []), ...(q.seriesIds ?? [])];
    const movieIds = [...(q.movieId ?? []), ...(q.movieIds ?? [])];
    const page = historyService().list(
      HistoryListQuery.parse({
        page: q.page,
        pageSize: q.pageSize,
        sortKey: HISTORY_SORT[(q.sortKey ?? 'date').toLowerCase()] ?? 'date',
        sortDirection: sortOrder(q, 'desc'),
        ...(eventType ? { eventType: [eventType] } : {}),
        ...(q.episodeId !== undefined ? { episodeId: q.episodeId } : {}),
        ...(q.downloadId ? { downloadId: q.downloadId } : {}),
        ...(seriesIds.length ? { seriesId: seriesIds } : {}),
        ...(movieIds.length ? { movieId: movieIds } : {}),
      }),
    );
    const records = embedHistory(page.records, { series: q.includeSeries, episode: q.includeEpisode, movie: q.includeMovie });
    return envelope(q, 'date', page.totalRecords, records, page.pageSize);
  });

  app.get('/history/since', async (req) => {
    const q = parseOr400(
      z.object({ date: z.string().min(1), eventType: z.unknown().optional(), includeSeries: qsBool, includeEpisode: qsBool, includeMovie: qsBool }).passthrough(),
      req.query,
    );
    const date = new Date(q.date);
    if (Number.isNaN(date.getTime())) throw CompatError.validation('date', 'date must be an ISO-8601 timestamp', q.date);
    const records = historyService().since(date.toISOString(), parseHistoryEventType(q.eventType));
    return embedHistory(records, { series: q.includeSeries, episode: q.includeEpisode, movie: q.includeMovie });
  });

  app.get('/history/series', async (req) => {
    const q = parseOr400(
      z.object({ seriesId: z.coerce.number().int().positive(), seasonNumber: qsInt, eventType: z.unknown().optional(), includeSeries: qsBool, includeEpisode: qsBool }).passthrough(),
      req.query,
    );
    const eventType = parseHistoryEventType(q.eventType);
    const records = historyService().forSeries(q.seriesId, {
      ...(q.seasonNumber !== undefined ? { seasonNumber: q.seasonNumber } : {}),
      ...(eventType ? { eventType } : {}),
    });
    return embedHistory(records, { series: q.includeSeries, episode: q.includeEpisode });
  });

  app.get('/history/movie', async (req) => {
    const q = parseOr400(z.object({ movieId: z.coerce.number().int().positive(), eventType: z.unknown().optional(), includeMovie: qsBool }).passthrough(), req.query);
    const eventType = parseHistoryEventType(q.eventType);
    const records = historyService().forMovie(q.movieId, eventType ? { eventType } : {});
    return embedHistory(records, { movie: q.includeMovie });
  });

  // ---------------------------------------------------------------------------- blocklist
  app.get('/blocklist', async (req) => {
    const q = parseOr400(PagingQuery.extend({ seriesIds: qsIntList, movieIds: qsIntList, protocols: z.string().optional() }), req.query);
    const sortKey = (q.sortKey ?? 'date').toLowerCase();
    const page = blocklistServiceFor(ctx).list(
      BlocklistListQuery.parse({
        page: q.page,
        pageSize: q.pageSize,
        sortKey: sortKey.includes('title') ? (sortKey === 'sourcetitle' ? 'sourceTitle' : 'title') : sortKey === 'indexer' ? 'indexer' : sortKey === 'quality' ? 'quality' : 'date',
        sortDirection: sortOrder(q, 'desc'),
        ...(q.seriesIds?.length ? { seriesId: q.seriesIds } : {}),
        ...(q.movieIds?.length ? { movieId: q.movieIds } : {}),
      }),
    );
    return envelope(q, 'date', page.totalRecords, page.records.map((b) => toV3Blocklist(b)), page.pageSize);
  });
  app.delete('/blocklist/bulk', async (req) => {
    const { ids } = parseOr400(z.object({ ids: z.array(z.coerce.number().int().positive()).min(1) }).passthrough(), req.body);
    blocklistServiceFor(ctx).bulkRemove(ids);
    return {};
  });
  app.delete('/blocklist/:id', async (req) => {
    blocklistServiceFor(ctx).remove(parseOr400(IdParam, req.params).id);
    return {};
  });

  // ---------------------------------------------------------------------------- queue
  const QUEUE_SORT: Record<string, QueueSortKey> = {
    added: 'added',
    title: 'title',
    progress: 'progress',
    size: 'sizeBytes',
    sizeleft: 'sizeLeftBytes',
    status: 'status',
    timeleft: 'eta',
    estimatedcompletiontime: 'eta',
    downloadclient: 'downloadClientName',
    protocol: 'protocol',
  };

  const QueueQueryIn = PagingQuery.extend({
    includeUnknownSeriesItems: qsBool,
    includeUnknownMovieItems: qsBool,
    includeSeries: qsBool,
    includeEpisode: qsBool,
    includeMovie: qsBool,
    seriesIds: qsIntList,
    movieIds: qsIntList,
    episodeIds: qsIntList,
    seriesId: qsInt,
    protocol: z.enum(['usenet', 'torrent']).optional().catch(undefined),
  });

  const queueRecords = (q: z.infer<typeof QueueQueryIn>): Json[] => {
    const service = getDownloadClientsService(ctx);
    const sortKey = QUEUE_SORT[(q.sortKey ?? 'timeleft').toLowerCase()] ?? 'eta';
    const items: QueueItem[] = service.listQueue({
      page: 1,
      pageSize: 1000,
      sortKey,
      sortDirection: sortOrder(q, 'asc'),
      includeUnknownMediaItems: (q.includeUnknownSeriesItems ?? false) || (q.includeUnknownMovieItems ?? false),
      ...(q.protocol ? { protocol: q.protocol } : {}),
    }).records;
    const seriesFilter = new Set([...(q.seriesIds ?? []), ...(q.seriesId !== undefined ? [q.seriesId] : [])]);
    const movieFilter = new Set(q.movieIds ?? []);
    const episodeFilter = new Set(q.episodeIds ?? []);
    const history = historyService();
    const seriesCache = new Map<number, Json>();
    const extras = q.includeSeries ? s.seriesExtras() : new Map();
    const out: Json[] = [];
    for (const item of items) {
      if (seriesFilter.size && (item.seriesId === undefined || !seriesFilter.has(item.seriesId))) continue;
      if (movieFilter.size && (item.movieId === undefined || !movieFilter.has(item.movieId))) continue;
      const grabbed = item.downloadId.startsWith('pending:') ? null : history.mostRecentForDownloadId(item.downloadId, 'grabbed');
      let series: Json | undefined;
      if (q.includeSeries && item.seriesId !== undefined) {
        const id = item.seriesId;
        try {
          series = seriesCache.get(id) ?? s.seriesJson(lib.getSeries(db, id), extras);
          seriesCache.set(id, series);
        } catch {
          series = undefined;
        }
      }
      let movie: Json | undefined;
      if (q.includeMovie && item.movieId !== undefined) {
        try {
          movie = s.movieJson(lib.getMovie(db, item.movieId));
        } catch {
          movie = undefined;
        }
      }
      // Episode resources feed seasonNumber/episodeHasFile even when not embedded.
      const episodes = new Map<number, Json>();
      for (const episodeId of item.episodeIds ?? []) {
        try {
          episodes.set(episodeId, toV3Episode(lib.getEpisode(db, episodeId)));
        } catch {
          // deleted since the grab
        }
      }
      let records = toV3QueueRecords(item, { grabbed, series, movie, episodes });
      if (!q.includeEpisode) records = records.map(({ episode: _episode, ...rest }) => rest);
      if (episodeFilter.size) records = records.filter((r) => typeof r['episodeId'] === 'number' && episodeFilter.has(r['episodeId']));
      out.push(...records);
    }
    return out;
  };

  app.get('/queue', async (req) => {
    const q = parseOr400(QueueQueryIn, req.query);
    const all = queueRecords(q);
    return envelope(q, 'timeleft', all.length, pageOf(all, q.page, q.pageSize), q.pageSize, 'asc');
  });

  app.get('/queue/details', async (req) => queueRecords(parseOr400(QueueQueryIn, req.query)));

  app.get('/queue/status', async () => {
    const st = getDownloadClientsService(ctx).queueStatus();
    return {
      id: 1,
      totalCount: st.totalCount,
      count: st.totalCount,
      unknownCount: st.unknownCount,
      errors: st.errors > 0,
      warnings: st.warnings > 0,
      unknownErrors: false,
      unknownWarnings: false,
    };
  });

  const RemoveQuery = z
    .object({ removeFromClient: qsBool, blocklist: qsBool, skipRedownload: qsBool, blacklist: qsBool })
    .passthrough();

  app.delete('/queue/bulk', async (req) => {
    const q = parseOr400(RemoveQuery, req.query);
    const { ids } = parseOr400(z.object({ ids: z.array(z.coerce.number().int().positive()).min(1) }).passthrough(), req.body);
    const tracked = [...new Set(ids.map(trackedIdFromQueueId))];
    await getDownloadClientsService(ctx).removeQueueItems(tracked, {
      removeFromClient: q.removeFromClient ?? true,
      blocklist: (q.blocklist ?? q.blacklist) ?? false,
      skipRedownload: q.skipRedownload ?? false,
    });
    return {};
  });

  app.delete('/queue/:id', async (req) => {
    const { id } = parseOr400(IdParam, req.params);
    const q = parseOr400(RemoveQuery, req.query);
    const service = getDownloadClientsService(ctx);
    const trackedId = trackedIdFromQueueId(id);
    service.getQueueItem(trackedId);
    const result = await service.removeQueueItems([trackedId], {
      removeFromClient: q.removeFromClient ?? true,
      blocklist: (q.blocklist ?? q.blacklist) ?? false,
      skipRedownload: q.skipRedownload ?? false,
    });
    if (result.failed.length) throw new CompatError(502, result.failed[0]!.error);
    return {};
  });

  // ---------------------------------------------------------------------------- commands
  app.post('/command', async (req, reply) => {
    const body = parseOr400(z.object({ name: z.string().min(1) }).passthrough(), req.body);
    const { name, ...rest } = body;
    return reply.code(201).send(s.runner.start(name, rest as Json));
  });
  app.get('/command', async () => s.runner.list());
  app.get('/command/:id', async (req) => {
    const found = s.runner.get(parseOr400(IdParam, req.params).id);
    if (!found) throw CompatError.notFound();
    return found;
  });
  app.delete('/command/:id', async (req) => {
    s.runner.cancel(parseOr400(IdParam, req.params).id);
    return {};
  });

  // ---------------------------------------------------------------------------- releases
  app.get('/release', async (req) => {
    const q = parseOr400(z.object({ seriesId: qsInt, seasonNumber: qsInt, episodeId: qsInt, movieId: qsInt }).passthrough(), req.query);
    if (q.seriesId === undefined && q.episodeId === undefined && q.movieId === undefined) {
      throw CompatError.validation('seriesId', 'seriesId, episodeId or movieId is required');
    }
    const decisions = await releasesServiceFor(ctx).interactiveSearch(q);
    return decisions.map(toV3Release);
  });

  app.post('/release', async (req) => {
    const body = parseOr400(
      z
        .object({
          guid: z.string().min(1),
          indexerId: z.coerce.number().int(),
          seriesId: z.coerce.number().int().positive().optional(),
          episodeId: z.coerce.number().int().positive().optional(),
          episodeIds: z.array(z.coerce.number().int().positive()).optional(),
          movieId: z.coerce.number().int().positive().optional(),
          downloadClientId: z.coerce.number().int().positive().optional(),
        })
        .passthrough(),
      req.body,
    );
    const episodeIds = body.episodeIds ?? (body.episodeId ? [body.episodeId] : undefined);
    const tracked = await releasesServiceFor(ctx).grab({
      guid: body.guid,
      indexerId: body.indexerId,
      ...(body.seriesId !== undefined ? { seriesId: body.seriesId } : {}),
      ...(episodeIds ? { episodeIds } : {}),
      ...(body.movieId !== undefined ? { movieId: body.movieId } : {}),
      ...(body.downloadClientId !== undefined ? { downloadClientId: body.downloadClientId } : {}),
    });
    return compact({
      guid: body.guid,
      indexerId: body.indexerId,
      title: tracked.title,
      approved: true,
      downloadAllowed: true,
      downloadId: tracked.downloadId,
      downloadClientId: tracked.downloadClientId ?? undefined,
      queueId: tracked.id,
    });
  });

  // Prowlarr / autobrr push. Upstream answers with the decision list for the pushed release.
  app.post('/release/push', async (req) => {
    const body = parseOr400(
      z
        .object({
          title: z.string().min(1),
          downloadUrl: z.string().optional(),
          magnetUrl: z.string().optional(),
          protocol: z.union([z.string(), z.number()]).optional(),
          publishDate: z.string().optional(),
          size: z.coerce.number().optional(),
          guid: z.string().optional(),
          infoUrl: z.string().optional(),
          infoHash: z.string().optional(),
          indexer: z.string().optional(),
          indexerId: z.coerce.number().int().optional(),
          seeders: z.coerce.number().int().optional(),
          leechers: z.coerce.number().int().optional(),
          tvdbId: z.coerce.number().int().optional(),
          tmdbId: z.coerce.number().int().optional(),
          imdbId: z.string().optional(),
          downloadClientId: z.coerce.number().int().optional(),
        })
        .passthrough(),
      req.body,
    );
    const url = body.downloadUrl ?? body.magnetUrl ?? '';
    const proto = String(body.protocol ?? '').toLowerCase();
    const protocol =
      proto === 'usenet' || proto === '1' ? 'usenet' : proto === 'torrent' || proto === '2' ? 'torrent' : url.startsWith('magnet:') || /\.torrent(\?|$)/i.test(url) ? 'torrent' : 'usenet';
    const result = await releasesServiceFor(ctx).push(
      ReleasePushRequest.parse(
        compact({
          title: body.title,
          downloadUrl: body.downloadUrl || undefined,
          magnetUrl: body.magnetUrl || undefined,
          protocol,
          publishDate: body.publishDate ?? new Date().toISOString(),
          size: body.size !== undefined ? Math.max(0, Math.round(body.size)) : 0,
          guid: body.guid,
          infoUrl: body.infoUrl,
          infoHash: body.infoHash,
          indexer: body.indexer,
          indexerId: body.indexerId && body.indexerId > 0 ? body.indexerId : undefined,
          seeders: body.seeders,
          leechers: body.leechers,
          tvdbId: body.tvdbId && body.tvdbId > 0 ? body.tvdbId : undefined,
          tmdbId: body.tmdbId && body.tmdbId > 0 ? body.tmdbId : undefined,
          imdbId: body.imdbId || undefined,
          downloadClientId: body.downloadClientId && body.downloadClientId > 0 ? body.downloadClientId : undefined,
        }),
      ),
    );
    return result.decision ? [toV3Release(result.decision)] : [];
  });

  // ---------------------------------------------------------------------------- disk, filesystem
  app.get('/diskspace', async () => {
    const seen = new Set<string>();
    const out: Json[] = [];
    for (const root of await lib.listRootFolders(db)) {
      try {
        const info = await statfs(root.path);
        const key = `${info.type}:${info.blocks}:${info.bsize}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: root.path, label: root.path, freeSpace: Number(info.bavail) * Number(info.bsize), totalSpace: Number(info.blocks) * Number(info.bsize) });
      } catch {
        // inaccessible root folders are reported by the health check instead
      }
    }
    return out;
  });

  app.get('/filesystem', async (req) => {
    const q = parseOr400(z.object({ path: z.string().optional(), includeFiles: z.string().optional(), allowFoldersWithoutTrailingSlashes: z.string().optional() }).passthrough(), req.query);
    const listing = await getImportsService(ctx).listFileSystem(
      FileSystemQuery.parse(compact({ path: q.path, includeFiles: q.includeFiles ?? 'false', allowFoldersWithoutTrailingSlashes: q.allowFoldersWithoutTrailingSlashes })),
    );
    const entry = (e: (typeof listing.directories)[number]) =>
      compact({ type: e.type === 'directory' ? 'folder' : e.type, name: e.name, path: e.path, size: e.sizeBytes, lastModified: e.lastModified });
    return compact({ parent: listing.parent ?? undefined, directories: listing.directories.map(entry), files: listing.files.map(entry) });
  });
}
