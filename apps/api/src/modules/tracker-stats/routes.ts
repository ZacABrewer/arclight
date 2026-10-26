import {
  TrackerAccountSettings,
  TrackerErrorResponse,
  TrackerStatsResource,
  TrackerStatsSyncResult,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TrackerStatsError, type TrackerStatsErrorCode, type TrackerStatsService } from './service.js';

// /api/v1/tracker/* and /api/v1/indexer/:id/tracker. Thin: validate -> service -> reply.

const STATUS_FOR: Record<TrackerStatsErrorCode, number> = { NOT_FOUND: 404, VALIDATION: 400 };
const errors = { 400: TrackerErrorResponse, 404: TrackerErrorResponse };
const IdParams = z.object({ id: z.coerce.number().int() });

export function trackerStatsRoutes(service: TrackerStatsService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof TrackerStatsError) return reply.code(STATUS_FOR[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled tracker-stats error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get('/tracker/stats', { schema: { response: { 200: z.array(TrackerStatsResource) } } }, async () => service.list());

    app.post('/tracker/stats/sync', { schema: { response: { 200: TrackerStatsSyncResult } } }, async () => {
      const message = await service.sync();
      return { message, stats: service.list() };
    });

    app.get(
      '/indexer/:id/tracker',
      { schema: { params: IdParams, response: { 200: TrackerAccountSettings, ...errors } } },
      async (req) => service.getAccount(req.params.id),
    );

    app.put(
      '/indexer/:id/tracker',
      { schema: { params: IdParams, body: TrackerAccountSettings, response: { 200: TrackerAccountSettings, ...errors } } },
      async (req) => service.setAccount(req.params.id, req.body),
    );
  };
}
