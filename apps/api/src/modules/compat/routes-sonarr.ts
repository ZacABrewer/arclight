import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AddSeriesRequest,
  CalendarQuery,
  MonitorOption,
  SeriesListQuery,
  type Episode,
  type MediaFile,
  type UpdateSeriesRequest,
} from '@arclight/shared';
import { CalendarService } from '../calendar/index.js';
import { libraryService as lib } from '../library/index.js';
import { compact, CompatError, parseOr400, qsBool, qsInt, qsIntList, type Json } from './common.js';
import { lookupSeries, tmdbIdForTvdb } from './lookup.js';
import { toV3Episode, toV3SeriesLookup } from './media.js';
import { envelope, PagingQuery } from './paging.js';
import { episodeFileJson, type CompatServices } from './services.js';

// Sonarr-shaped resources: series, episode, episodefile, calendar, wanted.

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const SeasonIn = z.object({ seasonNumber: z.coerce.number().int().min(0), monitored: z.boolean() });

const SeriesBody = z
  .object({
    id: z.coerce.number().int().optional(),
    tvdbId: z.coerce.number().int().optional(),
    tmdbId: z.coerce.number().int().optional(),
    title: z.string().optional(),
    qualityProfileId: z.coerce.number().int().optional(),
    rootFolderPath: z.string().optional(),
    path: z.string().optional(),
    monitored: z.boolean().optional(),
    monitorNewItems: z.enum(['all', 'none']).optional().catch(undefined),
    seasonFolder: z.boolean().optional(),
    seriesType: z.enum(['standard', 'daily', 'anime']).optional().catch(undefined),
    useSceneNumbering: z.boolean().optional(),
    tags: z.array(z.coerce.number().int()).optional(),
    seasons: z.array(SeasonIn).optional(),
    addOptions: z
      .object({
        monitor: z.string().optional(),
        searchForMissingEpisodes: z.boolean().optional(),
        searchForCutoffUnmetEpisodes: z.boolean().optional(),
        ignoreEpisodesWithFiles: z.boolean().optional(),
        ignoreEpisodesWithoutFiles: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Sonarr's addOptions.monitor -> our MonitorOption (`unknown` / absent: use the seasons list). */
function monitorOptionFrom(raw: string | undefined): MonitorOption | undefined {
  if (!raw) return undefined;
  const map: Record<string, MonitorOption> = {
    all: 'all',
    future: 'future',
    missing: 'missing',
    existing: 'existing',
    firstseason: 'firstSeason',
    latestseason: 'latestSeason',
    lastseason: 'latestSeason',
    pilot: 'pilot',
    none: 'none',
  };
  return map[raw.toLowerCase()];
}

export function sonarrRoutes(app: FastifyInstance, s: CompatServices): void {
  const db = s.db;

  // ---------------------------------------------------------------------------- series
  app.get('/series', async (req) => {
    const q = parseOr400(z.object({ tvdbId: qsInt, tmdbId: qsInt }).passthrough(), req.query);
    const list = lib.listSeries(db, SeriesListQuery.parse({ ...(q.tmdbId !== undefined ? { tmdbId: q.tmdbId } : {}) }));
    const extras = s.seriesExtras();
    return list.filter((x) => q.tvdbId === undefined || x.tvdbId === q.tvdbId).map((x) => s.seriesJson(x, extras));
  });

  app.get('/series/lookup', async (req) => {
    const { term } = parseOr400(z.object({ term: z.string().default('') }).passthrough(), req.query);
    const results = await lookupSeries(s.metadata, term);
    const extras = s.seriesExtras();
    return results.map((meta) => {
      const existing = lib.findSeriesByTmdbId(db, meta.tmdbId);
      return toV3SeriesLookup(meta, existing ? s.seriesJson(lib.getSeries(db, existing.id), extras) : null);
    });
  });

  app.get('/series/:id', async (req) => s.seriesJsonById(parseOr400(IdParam, req.params).id));

  app.post('/series', async (req, reply) => {
    const body = parseOr400(SeriesBody, req.body);
    let tmdbId = body.tmdbId && body.tmdbId > 0 ? body.tmdbId : null;
    if (!tmdbId && body.tvdbId && body.tvdbId > 0) tmdbId = await tmdbIdForTvdb(s.metadata, body.tvdbId);
    if (!tmdbId) throw CompatError.validation('TvdbId', 'Could not resolve the series: send a known tvdbId or tmdbId', body.tvdbId);
    if (lib.findSeriesByTmdbId(db, tmdbId)) throw CompatError.validation('TvdbId', 'This series has already been added', body.tvdbId ?? tmdbId);
    const rootFolderPath = body.rootFolderPath ?? (body.path ? dirname(body.path) : undefined);
    if (!rootFolderPath) throw CompatError.validation('RootFolderPath', "'Root Folder Path' must not be empty.");
    if (body.qualityProfileId === undefined) throw CompatError.validation('QualityProfileId', "'Quality Profile Id' must be greater than '0'.");

    const meta = await s.metadata.lookupSeries(tmdbId);
    if (!meta) throw CompatError.notFound(`Series with tmdbId ${tmdbId} not found`);

    const option = monitorOptionFrom(body.addOptions?.monitor);
    const req0 = AddSeriesRequest.parse({
      tmdbId,
      rootFolderPath,
      qualityProfileId: body.qualityProfileId,
      monitored: body.monitored ?? true,
      monitorOption: option ?? 'all',
      monitorNewItems: body.monitorNewItems ?? 'all',
      seriesType: body.seriesType ?? 'standard',
      seasonFolder: body.seasonFolder ?? true,
      tags: body.tags ?? [],
      searchOnAdd: false,
    });
    const added = lib.addSeries(db, meta, req0);
    // No explicit monitor option: the per-season flags in the body decide (upstream behaviour).
    if (!option && body.seasons?.length) {
      const known = new Set(added.seasons.map((x) => x.seasonNumber));
      for (const season of body.seasons) {
        if (known.has(season.seasonNumber)) lib.setSeasonMonitored(db, added.id, season.seasonNumber, season.monitored);
      }
    }
    s.announce('added', 'series', added.id);
    if (body.addOptions?.searchForMissingEpisodes) s.runner.start('SeriesSearch', { seriesId: added.id }, 'system');
    return reply.code(201).send(s.seriesJsonById(added.id));
  });

  const updateSeries = async (id: number, raw: unknown) => {
    const body = parseOr400(SeriesBody, raw);
    const current = lib.getSeries(db, id);
    const update: UpdateSeriesRequest = {
      ...(body.monitored !== undefined ? { monitored: body.monitored } : {}),
      ...(body.monitorNewItems ? { monitorNewItems: body.monitorNewItems } : {}),
      ...(body.qualityProfileId !== undefined ? { qualityProfileId: body.qualityProfileId } : {}),
      ...(body.seriesType ? { seriesType: body.seriesType } : {}),
      ...(body.seasonFolder !== undefined ? { seasonFolder: body.seasonFolder } : {}),
      ...(body.rootFolderPath && body.rootFolderPath !== current.rootFolderPath ? { rootFolderPath: body.rootFolderPath } : {}),
      ...(body.path && body.path !== current.path ? { path: body.path } : {}),
      ...(body.tags ? { tags: body.tags } : {}),
      ...(body.seasons ? { seasons: body.seasons } : {}),
    };
    const updated = lib.updateSeries(db, id, update);
    s.announce('updated', 'series', updated.id);
    return s.seriesJsonById(updated.id);
  };

  app.put('/series/:id', async (req, reply) => reply.code(202).send(await updateSeries(parseOr400(IdParam, req.params).id, req.body)));
  app.put('/series', async (req, reply) => {
    const { id } = parseOr400(z.object({ id: z.coerce.number().int().positive() }).passthrough(), req.body);
    return reply.code(202).send(await updateSeries(id, req.body));
  });

  app.delete('/series/:id', async (req) => {
    const { id } = parseOr400(IdParam, req.params);
    const q = parseOr400(z.object({ deleteFiles: qsBool, addImportListExclusion: qsBool, addImportExclusion: qsBool }).passthrough(), req.query);
    await lib.deleteSeries(db, id, { deleteFiles: q.deleteFiles ?? false, addExclusion: (q.addImportListExclusion ?? q.addImportExclusion) ?? false });
    s.announce('deleted', 'series', id);
    return {};
  });

  // ---------------------------------------------------------------------------- episodes
  const EpisodeQuery = z
    .object({
      seriesId: qsInt,
      seasonNumber: qsInt,
      episodeIds: qsIntList,
      episodeFileId: qsInt,
      includeEpisodeFile: qsBool,
      includeSeries: qsBool,
    })
    .passthrough();

  const episodeJson = (eps: Episode[], opts: { includeEpisodeFile?: boolean | undefined; includeSeries?: boolean | undefined }) => {
    const cutoff = opts.includeEpisodeFile ? s.cutoffChecker() : () => true;
    const seriesCache = new Map<number, Json>();
    const extras = opts.includeSeries ? s.seriesExtras() : new Map();
    return eps.map((e) => {
      let series: Json | undefined;
      if (opts.includeSeries) {
        series = seriesCache.get(e.seriesId) ?? s.seriesJson(lib.getSeries(db, e.seriesId), extras);
        seriesCache.set(e.seriesId, series);
      }
      let episodeFile: Json | undefined;
      if (opts.includeEpisodeFile && e.episodeFileId) {
        try {
          episodeFile = episodeFileJson(lib.getMediaFile(db, e.episodeFileId), cutoff);
        } catch {
          episodeFile = undefined;
        }
      }
      return toV3Episode(e, { episodeFile, series });
    });
  };

  app.get('/episode', async (req) => {
    const q = parseOr400(EpisodeQuery, req.query);
    let eps: Episode[];
    if (q.episodeIds?.length) eps = q.episodeIds.map((id) => lib.getEpisode(db, id));
    else if (q.episodeFileId !== undefined) eps = lib.getMediaFile(db, q.episodeFileId).episodeIds.map((id) => lib.getEpisode(db, id));
    else if (q.seriesId !== undefined) {
      eps = lib.listEpisodes(db, { seriesId: q.seriesId, ...(q.seasonNumber !== undefined ? { seasonNumber: q.seasonNumber } : {}) });
    } else throw CompatError.validation('seriesId', 'seriesId, episodeIds or episodeFileId must be provided');
    return episodeJson(eps, q);
  });

  app.get('/episode/:id', async (req) => {
    const { id } = parseOr400(IdParam, req.params);
    return episodeJson([lib.getEpisode(db, id)], { includeEpisodeFile: true, includeSeries: true })[0];
  });

  app.put('/episode/monitor', async (req, reply) => {
    const body = parseOr400(z.object({ episodeIds: z.array(z.coerce.number().int().positive()).min(1), monitored: z.boolean() }), req.body);
    const updated = lib.bulkSetEpisodesMonitored(db, body.episodeIds, body.monitored);
    for (const seriesId of new Set(updated.map((e) => e.seriesId))) s.announce('updated', 'series', seriesId);
    return reply.code(202).send(episodeJson(updated, {}));
  });

  app.put('/episode/:id', async (req, reply) => {
    const { id } = parseOr400(IdParam, req.params);
    const body = parseOr400(z.object({ monitored: z.boolean() }).passthrough(), req.body);
    const updated = lib.setEpisodeMonitored(db, id, body.monitored);
    s.announce('updated', 'series', updated.seriesId);
    return reply.code(202).send(episodeJson([updated], {})[0]);
  });

  // ---------------------------------------------------------------------------- episode files
  app.get('/episodefile', async (req) => {
    const q = parseOr400(z.object({ seriesId: qsInt, episodeFileIds: qsIntList }).passthrough(), req.query);
    const cutoff = s.cutoffChecker();
    let files: MediaFile[];
    if (q.episodeFileIds?.length) files = q.episodeFileIds.map((id) => lib.getMediaFile(db, id));
    else if (q.seriesId !== undefined) files = lib.listMediaFiles(db, { seriesId: q.seriesId });
    else throw CompatError.validation('seriesId', 'seriesId or episodeFileIds must be provided');
    return files.filter((f) => f.mediaType === 'series').map((f) => episodeFileJson(f, cutoff));
  });

  app.get('/episodefile/:id', async (req) => {
    const file = lib.getMediaFile(db, parseOr400(IdParam, req.params).id);
    if (file.mediaType !== 'series') throw CompatError.notFound();
    return episodeFileJson(file, s.cutoffChecker());
  });

  app.delete('/episodefile/:id', async (req) => {
    const { id } = parseOr400(IdParam, req.params);
    const file = lib.getMediaFile(db, id);
    if (file.mediaType !== 'series') throw CompatError.notFound();
    await lib.deleteMediaFile(db, id, { deleteFromDisk: true });
    if (file.seriesId) s.announce('fileDeleted', 'series', file.seriesId);
    return {};
  });

  // ---------------------------------------------------------------------------- calendar
  app.get('/calendar', async (req) => {
    const q = parseOr400(
      z
        .object({
          start: z.string().optional(),
          end: z.string().optional(),
          unmonitored: qsBool,
          includeSeries: qsBool,
          includeEpisodeFile: qsBool,
          tags: z.string().optional(),
        })
        .passthrough(),
      req.query,
    );
    const query = parseOr400(
      CalendarQuery,
      compact({
        start: q.start,
        end: q.end,
        unmonitored: q.unmonitored ? 'true' : 'false',
        includeEpisodeFile: q.includeEpisodeFile ? 'true' : 'false',
        tags: q.tags,
      }),
    );
    const items = new CalendarService(db).list(query);
    const eps: Episode[] = [];
    for (const item of items) if (item.type === 'episode') eps.push(item.episode);
    return episodeJson(eps, { includeSeries: q.includeSeries, includeEpisodeFile: q.includeEpisodeFile });
  });

  // ---------------------------------------------------------------------------- wanted
  const WantedQuery = PagingQuery.extend({ includeSeries: qsBool, monitored: qsBool });

  app.get('/wanted/missing', async (req) => {
    const q = parseOr400(WantedQuery, req.query);
    const page = lib.listMissingEpisodes(db, { page: q.page, pageSize: Math.min(q.pageSize, 500), includeSpecials: false });
    const records = episodeJson(page.records, { includeSeries: q.includeSeries });
    return envelope(q, 'episodes.airDateUtc', page.totalRecords, records, page.pageSize);
  });

  app.get('/wanted/cutoff', async (req) => {
    const q = parseOr400(WantedQuery, req.query);
    const page = lib.listCutoffUnmetEpisodes(db, { page: q.page, pageSize: Math.min(q.pageSize, 500), includeSpecials: false }, s.cutoffChecker());
    const records = episodeJson(page.records, { includeSeries: q.includeSeries, includeEpisodeFile: true });
    return envelope(q, 'episodes.airDateUtc', page.totalRecords, records, page.pageSize);
  });
}
