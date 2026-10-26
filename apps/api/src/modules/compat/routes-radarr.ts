import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AddMovieRequest, MovieListQuery, type MediaFile, type Movie, type UpdateMovieRequest } from '@media-tron/shared';
import { libraryService as lib } from '../library/index.js';
import { CompatError, parseOr400, qsBool, qsInt, qsIntList, type Json } from './common.js';
import { lookupMovies, tmdbIdForImdb } from './lookup.js';
import { toV3MovieFile, toV3MovieLookup } from './media.js';
import type { CompatServices } from './services.js';

// Radarr-shaped resources: movie, moviefile, collection.

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const MovieBody = z
  .object({
    id: z.coerce.number().int().optional(),
    tmdbId: z.coerce.number().int().optional(),
    imdbId: z.string().optional(),
    title: z.string().optional(),
    qualityProfileId: z.coerce.number().int().optional(),
    rootFolderPath: z.string().optional(),
    path: z.string().optional(),
    monitored: z.boolean().optional(),
    minimumAvailability: z.enum(['announced', 'inCinemas', 'released']).optional().catch(undefined),
    tags: z.array(z.coerce.number().int()).optional(),
    addOptions: z
      .object({ searchForMovie: z.boolean().optional(), monitor: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function radarrRoutes(app: FastifyInstance, s: CompatServices): void {
  const db = s.db;

  // ---------------------------------------------------------------------------- movies
  app.get('/movie', async (req) => {
    const q = parseOr400(z.object({ tmdbId: qsInt }).passthrough(), req.query);
    const cutoff = s.cutoffChecker();
    return lib.listMovies(db, MovieListQuery.parse(q.tmdbId !== undefined ? { tmdbId: q.tmdbId } : {})).map((m) => s.movieJson(m, cutoff));
  });

  const existingFor = (tmdbId: number): Json | null => {
    const found = lib.findMovieByTmdbId(db, tmdbId);
    return found ? s.movieJson(found) : null;
  };

  app.get('/movie/lookup', async (req) => {
    const { term } = parseOr400(z.object({ term: z.string().default('') }).passthrough(), req.query);
    const results = await lookupMovies(s.metadata, term);
    return results.map((meta) => toV3MovieLookup(meta, existingFor(meta.tmdbId)));
  });

  app.get('/movie/lookup/tmdb', async (req) => {
    const { tmdbId } = parseOr400(z.object({ tmdbId: z.coerce.number().int().positive() }).passthrough(), req.query);
    const [meta] = await lookupMovies(s.metadata, `tmdb:${tmdbId}`);
    if (!meta) throw CompatError.notFound(`Movie with tmdbId ${tmdbId} not found`);
    return toV3MovieLookup(meta, existingFor(meta.tmdbId));
  });

  app.get('/movie/lookup/imdb', async (req) => {
    const { imdbId } = parseOr400(z.object({ imdbId: z.string().min(1) }).passthrough(), req.query);
    const [meta] = await lookupMovies(s.metadata, `imdb:${imdbId}`);
    if (!meta) throw CompatError.notFound(`Movie with imdbId ${imdbId} not found`);
    return toV3MovieLookup(meta, existingFor(meta.tmdbId));
  });

  app.get('/movie/:id', async (req) => s.movieJson(lib.getMovie(db, parseOr400(IdParam, req.params).id)));

  app.post('/movie', async (req, reply) => {
    const body = parseOr400(MovieBody, req.body);
    let tmdbId = body.tmdbId && body.tmdbId > 0 ? body.tmdbId : null;
    if (!tmdbId && body.imdbId) tmdbId = await tmdbIdForImdb(s.metadata, body.imdbId, 'movie');
    if (!tmdbId) throw CompatError.validation('TmdbId', "'Tmdb Id' must be greater than '0'.", body.tmdbId);
    if (lib.findMovieByTmdbId(db, tmdbId)) throw CompatError.validation('TmdbId', 'This movie has already been added', tmdbId);
    const rootFolderPath = body.rootFolderPath ?? (body.path ? dirname(body.path) : undefined);
    if (!rootFolderPath) throw CompatError.validation('RootFolderPath', "'Root Folder Path' must not be empty.");
    if (body.qualityProfileId === undefined) throw CompatError.validation('QualityProfileId', "'Quality Profile Id' must be greater than '0'.");

    const meta = await s.metadata.lookupMovie(tmdbId);
    if (!meta) throw CompatError.notFound(`Movie with tmdbId ${tmdbId} not found`);
    const monitor = body.addOptions?.monitor?.toLowerCase();
    const added = lib.addMovie(
      db,
      meta,
      AddMovieRequest.parse({
        tmdbId,
        rootFolderPath,
        qualityProfileId: body.qualityProfileId,
        monitored: monitor === 'none' ? false : (body.monitored ?? true),
        minimumAvailability: body.minimumAvailability ?? 'released',
        tags: body.tags ?? [],
        searchOnAdd: false,
      }),
    );
    s.announce('added', 'movie', added.id);
    if (body.addOptions?.searchForMovie) s.runner.start('MoviesSearch', { movieIds: [added.id] }, 'system');
    return reply.code(201).send(s.movieJson(lib.getMovie(db, added.id)));
  });

  const updateMovie = (id: number, raw: unknown): Json => {
    const body = parseOr400(MovieBody, raw);
    const current = lib.getMovie(db, id);
    const update: UpdateMovieRequest = {
      ...(body.monitored !== undefined ? { monitored: body.monitored } : {}),
      ...(body.qualityProfileId !== undefined ? { qualityProfileId: body.qualityProfileId } : {}),
      ...(body.minimumAvailability ? { minimumAvailability: body.minimumAvailability } : {}),
      ...(body.rootFolderPath && body.rootFolderPath !== current.rootFolderPath ? { rootFolderPath: body.rootFolderPath } : {}),
      ...(body.path && body.path !== current.path ? { path: body.path } : {}),
      ...(body.tags ? { tags: body.tags } : {}),
    };
    const updated = lib.updateMovie(db, id, update);
    s.announce('updated', 'movie', updated.id);
    return s.movieJson(updated);
  };

  app.put('/movie/:id', async (req, reply) => reply.code(202).send(updateMovie(parseOr400(IdParam, req.params).id, req.body)));
  app.put('/movie', async (req, reply) => {
    const { id } = parseOr400(z.object({ id: z.coerce.number().int().positive() }).passthrough(), req.body);
    return reply.code(202).send(updateMovie(id, req.body));
  });

  app.delete('/movie/:id', async (req) => {
    const { id } = parseOr400(IdParam, req.params);
    const q = parseOr400(z.object({ deleteFiles: qsBool, addImportExclusion: qsBool, addImportListExclusion: qsBool }).passthrough(), req.query);
    await lib.deleteMovie(db, id, { deleteFiles: q.deleteFiles ?? false, addExclusion: (q.addImportExclusion ?? q.addImportListExclusion) ?? false });
    s.announce('deleted', 'movie', id);
    return {};
  });

  // ---------------------------------------------------------------------------- movie files
  app.get('/moviefile', async (req) => {
    const q = parseOr400(z.object({ movieId: qsIntList, movieFileIds: qsIntList }).passthrough(), req.query);
    const cutoff = s.cutoffChecker();
    let files: MediaFile[];
    if (q.movieFileIds?.length) files = q.movieFileIds.map((id) => lib.getMediaFile(db, id));
    else if (q.movieId?.length) files = q.movieId.flatMap((movieId) => lib.listMediaFiles(db, { movieId }));
    else throw CompatError.validation('movieId', 'movieId or movieFileIds must be provided');
    return files.filter((f) => f.mediaType === 'movie').map((f) => toV3MovieFile(f, !cutoff(f)));
  });

  app.get('/moviefile/:id', async (req) => {
    const file = lib.getMediaFile(db, parseOr400(IdParam, req.params).id);
    if (file.mediaType !== 'movie') throw CompatError.notFound();
    return toV3MovieFile(file, !s.cutoffChecker()(file));
  });

  app.delete('/moviefile/:id', async (req) => {
    const { id } = parseOr400(IdParam, req.params);
    const file = lib.getMediaFile(db, id);
    if (file.mediaType !== 'movie') throw CompatError.notFound();
    await lib.deleteMediaFile(db, id, { deleteFromDisk: true });
    if (file.movieId) s.announce('fileDeleted', 'movie', file.movieId);
    return {};
  });

  // ---------------------------------------------------------------------------- collections
  app.get('/collection', async (req) => {
    const q = parseOr400(z.object({ tmdbId: qsInt }).passthrough(), req.query);
    const groups = new Map<number, { title: string; movies: Movie[] }>();
    for (const m of lib.listMovies(db, MovieListQuery.parse({}))) {
      if (!m.collection) continue;
      const g = groups.get(m.collection.tmdbId) ?? { title: m.collection.title, movies: [] };
      g.movies.push(m);
      groups.set(m.collection.tmdbId, g);
    }
    return [...groups.entries()]
      .filter(([tmdbId]) => q.tmdbId === undefined || tmdbId === q.tmdbId)
      .map(([tmdbId, g]) => {
        const first = g.movies[0]!;
        return {
          id: tmdbId,
          title: g.title,
          sortTitle: g.title.toLowerCase(),
          tmdbId,
          monitored: false,
          qualityProfileId: first.qualityProfileId,
          rootFolderPath: first.rootFolderPath,
          searchOnAdd: false,
          minimumAvailability: first.minimumAvailability,
          images: [],
          overview: '',
          missingMovies: 0,
          tags: [],
          movies: g.movies.map((m) => ({
            tmdbId: m.tmdbId,
            imdbId: m.imdbId ?? undefined,
            title: m.title,
            cleanTitle: m.cleanTitle,
            sortTitle: m.sortTitle,
            status: m.status,
            overview: m.overview,
            runtime: m.runtimeMinutes ?? 0,
            images: m.images,
            year: m.year,
            ratings: m.ratings,
            genres: m.genres,
            folder: m.path,
            isExisting: true,
            isExcluded: false,
          })),
        };
      });
  });
}
