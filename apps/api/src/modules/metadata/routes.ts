import { z } from 'zod';
import { isMetadataError, type MetadataErrorCode } from '@arclight/metadata';
import {
  Job,
  MetadataCollection,
  MetadataErrorResponse,
  MetadataMovie,
  MetadataSearchQuery,
  MetadataSearchResult,
  MetadataSeries,
  RefreshCommand,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { RefreshTargetNotFound, type MetadataRefresher } from './commands.js';
import { MetadataNotConfiguredError, type MetadataService } from './service.js';

const TmdbIdParams = z.object({ tmdbId: z.coerce.number().int().positive() });

const statusFor: Record<MetadataErrorCode, number> = {
  'not-found': 404,
  'rate-limited': 429,
  unauthorized: 400,
  unreachable: 503,
  'bad-response': 502,
};

const errors = {
  400: MetadataErrorResponse,
  404: MetadataErrorResponse,
  429: MetadataErrorResponse,
  502: MetadataErrorResponse,
  503: MetadataErrorResponse,
};

export function metadataRoutes(
  service: MetadataService,
  refresher?: MetadataRefresher,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof MetadataNotConfiguredError) {
        return reply.code(400).send({ error: err.message, code: err.code });
      }
      if (err instanceof RefreshTargetNotFound) {
        return reply.code(404).send({ error: err.message, code: err.code });
      }
      if (isMetadataError(err)) {
        return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      }
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled metadata error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get(
      '/metadata/search',
      { schema: { querystring: MetadataSearchQuery, response: { 200: z.array(MetadataSearchResult), ...errors } } },
      async (req) => service.search(req.query.query, req.query.type),
    );

    app.get(
      '/metadata/series/:tmdbId',
      { schema: { params: TmdbIdParams, response: { 200: MetadataSeries, ...errors } } },
      async (req) => service.getSeries(req.params.tmdbId),
    );

    app.get(
      '/metadata/movie/:tmdbId',
      { schema: { params: TmdbIdParams, response: { 200: MetadataMovie, ...errors } } },
      async (req) => service.getMovie(req.params.tmdbId),
    );

    app.get(
      '/metadata/collection/:tmdbId',
      { config: { access: { areas: ['library'] } }, schema: { params: TmdbIdParams, response: { 200: MetadataCollection, ...errors } } },
      async (req) => service.getCollection(req.params.tmdbId),
    );

    // On-demand refresh of one item (or the library). Answers 202 with the started job; the
    // outcome arrives as a `job` event and in GET /jobs (see MetadataRefresher).
    if (refresher) {
      app.post(
        '/command/refresh',
        { schema: { body: RefreshCommand, response: { 202: Job, 400: MetadataErrorResponse, 404: MetadataErrorResponse } } },
        async (req, reply) => reply.code(202).send(refresher.start(req.body).job),
      );
    }
  };
}
