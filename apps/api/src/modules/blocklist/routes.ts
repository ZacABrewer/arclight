import { z } from 'zod';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  BlocklistAddRequest,
  BlocklistBulkDeleteRequest,
  BlocklistDeleteResult,
  BlocklistListQuery,
  BlocklistMovieQuery,
  BlocklistPage,
  BlocklistRecord,
  BlocklistSeriesQuery,
  HistoryErrorResponse,
} from '@arclight/shared';
import { BlocklistError, blocklistHttpStatus, type BlocklistService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });

export const blocklistRoutes =
  (service: BlocklistService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> =>
  async (app) => {
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof BlocklistError) {
        return reply.code(blocklistHttpStatus(err.code)).send({ error: err.message, code: err.code });
      }
      throw err;
    });

    app.get('/blocklist', { schema: { querystring: BlocklistListQuery, response: { 200: BlocklistPage } } }, async (req) =>
      service.list(req.query),
    );

    app.get(
      '/blocklist/series',
      { schema: { querystring: BlocklistSeriesQuery, response: { 200: z.array(BlocklistRecord) } } },
      async (req) => service.forSeries(req.query.seriesId),
    );

    app.get(
      '/blocklist/movie',
      { schema: { querystring: BlocklistMovieQuery, response: { 200: z.array(BlocklistRecord) } } },
      async (req) => service.forMovie(req.query.movieId),
    );

    app.post(
      '/blocklist',
      { schema: { body: BlocklistAddRequest, response: { 201: BlocklistRecord, 400: HistoryErrorResponse } } },
      async (req, reply) => reply.code(201).send(service.add(req.body)),
    );

    app.post('/blocklist/clear', { schema: { response: { 200: BlocklistDeleteResult } } }, async () => ({
      deleted: service.clear(),
    }));

    // Static path; registered alongside `/:id` but matched first by the router.
    app.delete(
      '/blocklist/bulk',
      { schema: { body: BlocklistBulkDeleteRequest, response: { 200: BlocklistDeleteResult } } },
      async (req) => ({ deleted: service.bulkRemove(req.body.ids) }),
    );

    app.delete(
      '/blocklist/:id',
      { schema: { params: IdParams, response: { 204: z.null(), 404: HistoryErrorResponse } } },
      async (req, reply) => {
        service.remove(req.params.id);
        return reply.code(204).send(null);
      },
    );
  };
