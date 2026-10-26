import { z } from 'zod';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AddMovieRequest,
  AddRootFolderRequest,
  AddSeriesRequest,
  BulkEpisodeMonitorRequest,
  BulkMovieUpdateRequest,
  BulkSeriesUpdateRequest,
  DeleteMediaFileQuery,
  DeleteMediaQuery,
  Episode,
  EpisodeListQuery,
  EpisodeMonitorUpdate,
  ErrorResponse,
  ImportExclusion,
  LibraryStatistics,
  MediaFile,
  MediaFileListQuery,
  Movie,
  MovieListQuery,
  PageQuery,
  RootFolder,
  SeasonMonitorUpdate,
  Series,
  SeriesListQuery,
  Tag,
  TagRequest,
  UpdateMovieRequest,
  UpdateSeriesRequest,
  WantedEpisodesPage,
  WantedEpisodesQuery,
  WantedMoviesPage,
} from '@arclight/shared';
import type { AppContext } from '../../app.js';
import { httpStatusFor, LibraryError } from './errors.js';
import { createCutoffChecker, type CutoffProfiles } from './cutoff.js';
import * as svc from './service.js';
import { ProfilesService } from '../profiles/index.js';
import type { MovieMetadataInput, SeriesMetadataInput } from './service.js';

/**
 * Looks up metadata for a title being added. The metadata module registers the real
 * implementation; until it does, adding by tmdbId answers 503 so the rest of the library API
 * is usable on its own.
 */
export interface MetadataLookup {
  series(tmdbId: number): Promise<SeriesMetadataInput | null>;
  movie(tmdbId: number): Promise<MovieMetadataInput | null>;
}

/** Ids of the items a library command acts on. */
export interface LibraryCommandTarget {
  seriesIds?: number[];
  movieIds?: number[];
}

/**
 * Follow-up commands the bulk editor (and "search on add") can queue. Provided by wiring.ts
 * (metadata refresher and releases search); each starts a job and returns without waiting.
 */
export interface LibraryCommands {
  refresh(target: LibraryCommandTarget): void;
  search(target: LibraryCommandTarget): void;
}

export interface LibraryRoutesOptions {
  metadata?: MetadataLookup;
  commands?: LibraryCommands;
  /** Profiles for the cutoff-unmet queries; defaults to a ProfilesService on the same db. */
  profiles?: CutoffProfiles;
}

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const SeasonParams = IdParams.extend({ seasonNumber: z.coerce.number().int().min(0) });
const Empty = z.null();

export const libraryRoutes = (
  ctx: AppContext,
  opts: LibraryRoutesOptions = {},
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> => {
  return async (app) => {
    const db = ctx.db;
    // Library mutations are announced on the bus (live UI, history/blocklist cleanup on delete,
    // notifications). Published only after the service call succeeded.
    const announce = (action: 'added' | 'updated' | 'deleted' | 'fileDeleted', mediaType: 'series' | 'movie', id: number) =>
      ctx.bus.publish({ type: 'library', action, mediaType, id });

    // One place turns typed service errors into HTTP; everything else propagates to Fastify.
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof LibraryError) {
        return reply.code(httpStatusFor(err.code)).send({ error: err.message, code: err.code });
      }
      if (err instanceof Error && 'validation' in err) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled library error');
      return reply.code(500).send({ error: 'internal error' });
    });

    const profiles: CutoffProfiles = opts.profiles ?? new ProfilesService({ db });
    const commands = opts.commands;
    const queueSearch = (target: LibraryCommandTarget, legacyJob: string) => {
      if (commands) commands.search(target);
      else if (ctx.scheduler.has(legacyJob)) void ctx.scheduler.run(legacyJob, 'system');
    };
    type FollowUpFlags = { refresh?: boolean | undefined; search?: boolean | undefined };
    /** Checked before the update, so an unavailable command does not leave a half-applied request. */
    const assertCommands = (body: FollowUpFlags) => {
      if ((body.refresh || body.search) && !commands) throw new LibraryError('VALIDATION', 'refresh and search commands are not available');
    };
    /** Bulk `refresh` / `search` flags: queued after the update committed. */
    const followUps = (body: FollowUpFlags, target: LibraryCommandTarget) => {
      if (body.refresh) commands?.refresh(target);
      if (body.search) commands?.search(target);
    };

    const metadata: MetadataLookup = opts.metadata ?? {
      series: async () => {
        throw new MetadataUnavailable();
      },
      movie: async () => {
        throw new MetadataUnavailable();
      },
    };

    // ----------------------------------------------------------------------------- root folders
    app.get('/rootfolder', { schema: { response: { 200: z.array(RootFolder) } } }, async () => svc.listRootFolders(db));
    app.get('/rootfolder/:id', { schema: { params: IdParams, response: { 200: RootFolder, 404: ErrorResponse } } }, async (req) =>
      svc.getRootFolder(db, req.params.id),
    );
    app.post(
      '/rootfolder',
      { schema: { body: AddRootFolderRequest, response: { 201: RootFolder, 400: ErrorResponse, 409: ErrorResponse } } },
      async (req, reply) => reply.code(201).send(await svc.addRootFolder(db, req.body)),
    );
    app.delete('/rootfolder/:id', { schema: { params: IdParams, response: { 204: Empty, 404: ErrorResponse } } }, async (req, reply) => {
      svc.deleteRootFolder(db, req.params.id);
      return reply.code(204).send(null);
    });

    // ----------------------------------------------------------------------------- tags
    app.get('/tag', { schema: { response: { 200: z.array(Tag) } } }, async () => svc.listTags(db));
    app.get('/tag/:id', { schema: { params: IdParams, response: { 200: Tag, 404: ErrorResponse } } }, async (req) =>
      svc.getTag(db, req.params.id),
    );
    app.post('/tag', { schema: { body: TagRequest, response: { 201: Tag, 409: ErrorResponse } } }, async (req, reply) =>
      reply.code(201).send(svc.createTag(db, req.body.label)),
    );
    app.put(
      '/tag/:id',
      { schema: { params: IdParams, body: TagRequest, response: { 200: Tag, 404: ErrorResponse, 409: ErrorResponse } } },
      async (req) => svc.updateTag(db, req.params.id, req.body.label),
    );
    app.delete('/tag/:id', { schema: { params: IdParams, response: { 204: Empty, 404: ErrorResponse } } }, async (req, reply) => {
      svc.deleteTag(db, req.params.id);
      return reply.code(204).send(null);
    });

    // ----------------------------------------------------------------------------- series
    app.get('/series', { schema: { querystring: SeriesListQuery, response: { 200: z.array(Series) } } }, async (req) =>
      svc.listSeries(db, req.query),
    );
    app.get('/series/:id', { schema: { params: IdParams, response: { 200: Series, 404: ErrorResponse } } }, async (req) =>
      svc.getSeries(db, req.params.id),
    );
    app.post(
      '/series',
      { schema: { body: AddSeriesRequest, response: { 201: Series, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 503: ErrorResponse } } },
      async (req, reply) => {
        const meta = await metadata.series(req.body.tmdbId);
        if (!meta) throw LibraryError.notFound('series metadata for tmdbId', req.body.tmdbId);
        const series = svc.addSeries(db, meta, req.body);
        announce('added', 'series', series.id);
        if (req.body.searchOnAdd) queueSearch({ seriesIds: [series.id] }, 'series-search');
        return reply.code(201).send(series);
      },
    );
    app.put(
      '/series/bulk',
      { schema: { body: BulkSeriesUpdateRequest, response: { 200: z.array(Series), 400: ErrorResponse, 404: ErrorResponse } } },
      async (req) => {
        assertCommands(req.body);
        const updated = svc.bulkUpdateSeries(db, req.body);
        for (const s of updated) announce('updated', 'series', s.id);
        followUps(req.body, { seriesIds: req.body.ids });
        return updated;
      },
    );
    app.put(
      '/series/:id',
      { schema: { params: IdParams, body: UpdateSeriesRequest, response: { 200: Series, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse } } },
      async (req) => {
        const updated = svc.updateSeries(db, req.params.id, req.body);
        announce('updated', 'series', updated.id);
        return updated;
      },
    );
    app.put(
      '/series/:id/seasons/:seasonNumber/monitor',
      { schema: { params: SeasonParams, body: SeasonMonitorUpdate.pick({ monitored: true }), response: { 200: Series, 404: ErrorResponse } } },
      async (req) => {
        const updated = svc.setSeasonMonitored(db, req.params.id, req.params.seasonNumber, req.body.monitored);
        announce('updated', 'series', updated.id);
        return updated;
      },
    );
    app.delete(
      '/series/:id',
      { schema: { params: IdParams, querystring: DeleteMediaQuery, response: { 204: Empty, 400: ErrorResponse, 404: ErrorResponse } } },
      async (req, reply) => {
        await svc.deleteSeries(db, req.params.id, req.query);
        announce('deleted', 'series', req.params.id);
        return reply.code(204).send(null);
      },
    );

    // ----------------------------------------------------------------------------- episodes
    app.get('/episode', { schema: { querystring: EpisodeListQuery, response: { 200: z.array(Episode) } } }, async (req) =>
      svc.listEpisodes(db, req.query),
    );
    app.get('/episode/:id', { schema: { params: IdParams, response: { 200: Episode, 404: ErrorResponse } } }, async (req) =>
      svc.getEpisode(db, req.params.id),
    );
    app.put(
      '/episode/monitor',
      { schema: { body: BulkEpisodeMonitorRequest, response: { 200: z.array(Episode) } } },
      async (req) => {
        const updated = svc.bulkSetEpisodesMonitored(db, req.body.episodeIds, req.body.monitored);
        for (const seriesId of new Set(updated.map((e) => e.seriesId))) announce('updated', 'series', seriesId);
        return updated;
      },
    );
    app.put(
      '/episode/:id',
      { schema: { params: IdParams, body: EpisodeMonitorUpdate, response: { 200: Episode, 404: ErrorResponse } } },
      async (req) => {
        const updated = svc.setEpisodeMonitored(db, req.params.id, req.body.monitored);
        announce('updated', 'series', updated.seriesId);
        return updated;
      },
    );

    // ----------------------------------------------------------------------------- movies
    app.get('/movie', { schema: { querystring: MovieListQuery, response: { 200: z.array(Movie) } } }, async (req) =>
      svc.listMovies(db, req.query),
    );
    app.get('/movie/:id', { schema: { params: IdParams, response: { 200: Movie, 404: ErrorResponse } } }, async (req) =>
      svc.getMovie(db, req.params.id),
    );
    app.post(
      '/movie',
      { schema: { body: AddMovieRequest, response: { 201: Movie, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 503: ErrorResponse } } },
      async (req, reply) => {
        const meta = await metadata.movie(req.body.tmdbId);
        if (!meta) throw LibraryError.notFound('movie metadata for tmdbId', req.body.tmdbId);
        const movie = svc.addMovie(db, meta, req.body);
        announce('added', 'movie', movie.id);
        if (req.body.searchOnAdd) queueSearch({ movieIds: [movie.id] }, 'movie-search');
        return reply.code(201).send(movie);
      },
    );
    app.put(
      '/movie/bulk',
      { schema: { body: BulkMovieUpdateRequest, response: { 200: z.array(Movie), 400: ErrorResponse, 404: ErrorResponse } } },
      async (req) => {
        assertCommands(req.body);
        const updated = svc.bulkUpdateMovies(db, req.body);
        for (const m of updated) announce('updated', 'movie', m.id);
        followUps(req.body, { movieIds: req.body.ids });
        return updated;
      },
    );
    app.put(
      '/movie/:id',
      { schema: { params: IdParams, body: UpdateMovieRequest, response: { 200: Movie, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse } } },
      async (req) => {
        const updated = svc.updateMovie(db, req.params.id, req.body);
        announce('updated', 'movie', updated.id);
        return updated;
      },
    );
    app.delete(
      '/movie/:id',
      { schema: { params: IdParams, querystring: DeleteMediaQuery, response: { 204: Empty, 400: ErrorResponse, 404: ErrorResponse } } },
      async (req, reply) => {
        await svc.deleteMovie(db, req.params.id, req.query);
        announce('deleted', 'movie', req.params.id);
        return reply.code(204).send(null);
      },
    );

    // ----------------------------------------------------------------------------- media files
    app.get('/mediafile', { schema: { querystring: MediaFileListQuery, response: { 200: z.array(MediaFile) } } }, async (req) =>
      svc.listMediaFiles(db, req.query),
    );
    app.get('/mediafile/:id', { schema: { params: IdParams, response: { 200: MediaFile, 404: ErrorResponse } } }, async (req) =>
      svc.getMediaFile(db, req.params.id),
    );
    app.delete(
      '/mediafile/:id',
      { schema: { params: IdParams, querystring: DeleteMediaFileQuery, response: { 204: Empty, 404: ErrorResponse } } },
      async (req, reply) => {
        const file = svc.getMediaFile(db, req.params.id);
        await svc.deleteMediaFile(db, req.params.id, req.query);
        const parentId = file.mediaType === 'series' ? file.seriesId : file.movieId;
        if (parentId !== null && parentId !== undefined) announce('fileDeleted', file.mediaType, parentId);
        return reply.code(204).send(null);
      },
    );

    // ----------------------------------------------------------------------------- wanted
    app.get('/wanted/missing/episodes', { schema: { querystring: WantedEpisodesQuery, response: { 200: WantedEpisodesPage } } }, async (req) =>
      svc.listMissingEpisodes(db, req.query),
    );
    app.get('/wanted/missing/movies', { schema: { querystring: PageQuery, response: { 200: WantedMoviesPage } } }, async (req) =>
      svc.listMissingMovies(db, req.query),
    );
    // Cutoff unmet: monitored items with a file below their profile's quality or format-score
    // cutoff. Same checker as the CutoffUnmetSearch job (releases.isFileCutoffMet).
    app.get('/wanted/cutoff/episodes', { schema: { querystring: WantedEpisodesQuery, response: { 200: WantedEpisodesPage } } }, async (req) =>
      svc.listCutoffUnmetEpisodes(db, req.query, createCutoffChecker(db, profiles)),
    );
    app.get('/wanted/cutoff/movies', { schema: { querystring: PageQuery, response: { 200: WantedMoviesPage } } }, async (req) =>
      svc.listCutoffUnmetMovies(db, req.query, createCutoffChecker(db, profiles)),
    );

    // ----------------------------------------------------------------------------- exclusions + stats
    app.get('/library/exclusions', { schema: { response: { 200: z.array(ImportExclusion) } } }, async () =>
      svc.listImportExclusions(db),
    );
    app.delete('/library/exclusions/:id', { schema: { params: IdParams, response: { 204: Empty, 404: ErrorResponse } } }, async (req, reply) => {
      svc.deleteImportExclusion(db, req.params.id);
      return reply.code(204).send(null);
    });
    app.get('/library/statistics', { schema: { response: { 200: LibraryStatistics } } }, async () => svc.getLibraryStatistics(db));
  };
};

class MetadataUnavailable extends LibraryError {
  constructor() {
    super('VALIDATION', 'metadata lookup is not available; the metadata module is not registered');
    this.name = 'MetadataUnavailable';
  }
}
