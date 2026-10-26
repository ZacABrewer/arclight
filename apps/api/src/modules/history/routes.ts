import { z } from 'zod';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  HistoryErrorResponse,
  HistoryListQuery,
  HistoryMarkFailedRequest,
  HistoryMovieQuery,
  HistoryPage,
  HistoryRecord,
  HistorySeriesQuery,
  HistorySinceQuery,
  Job,
} from '@arclight/shared';
import { HistoryError, historyHttpStatus, type HistoryService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });

export const historyRoutes =
  (service: HistoryService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> =>
  async (app) => {
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof HistoryError) {
        return reply.code(historyHttpStatus(err.code)).send({ error: err.message, code: err.code });
      }
      throw err;
    });

    app.get('/history', { schema: { querystring: HistoryListQuery, response: { 200: HistoryPage } } }, async (req) =>
      service.list(req.query),
    );

    app.get(
      '/history/since',
      { schema: { querystring: HistorySinceQuery, response: { 200: z.array(HistoryRecord), 400: HistoryErrorResponse } } },
      async (req) => service.since(req.query.date, req.query.eventType, req.query),
    );

    app.get(
      '/history/series',
      { schema: { querystring: HistorySeriesQuery, response: { 200: z.array(HistoryRecord) } } },
      async (req) => {
        const { seriesId, seasonNumber, eventType, includeSeries, includeEpisode } = req.query;
        return service.forSeries(seriesId, {
          ...(seasonNumber === undefined ? {} : { seasonNumber }),
          ...(eventType === undefined ? {} : { eventType }),
          includeSeries,
          includeEpisode,
        });
      },
    );

    app.get(
      '/history/movie',
      { schema: { querystring: HistoryMovieQuery, response: { 200: z.array(HistoryRecord) } } },
      async (req) => {
        const { movieId, eventType, includeMovie } = req.query;
        return service.forMovie(movieId, { ...(eventType === undefined ? {} : { eventType }), includeMovie });
      },
    );

    app.post(
      '/history/failed/:id',
      {
        schema: {
          params: IdParams,
          body: HistoryMarkFailedRequest.nullish(),
          response: { 200: z.array(HistoryRecord), 400: HistoryErrorResponse, 404: HistoryErrorResponse },
        },
      },
      async (req) => {
        const body = req.body ?? { skipRedownload: false };
        return service.markFailed(req.params.id, {
          skipRedownload: body.skipRedownload,
          ...(body.message === undefined ? {} : { message: body.message }),
          source: 'api',
        });
      },
    );

    // Re-run the search for the record's episode(s) or movie; 202 with the started job.
    app.post(
      '/history/:id/redownload',
      { schema: { params: IdParams, response: { 202: Job, 400: HistoryErrorResponse, 404: HistoryErrorResponse, 503: HistoryErrorResponse } } },
      async (req, reply) => reply.code(202).send(service.redownload(req.params.id)),
    );
  };
