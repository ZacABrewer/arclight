import { ActivityStats, ActivityStatsQuery, ErrorResponse, IndexerStats, IndexerStatsQuery, LibraryStats, StorageStats, StorageStatsQuery } from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { StatsError, type StatsService } from './service.js';

export function statsRoutes(service: StatsService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof StatsError) return reply.code(503).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled stats error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get(
      '/stats/storage',
      { schema: { querystring: StorageStatsQuery, response: { 200: StorageStats, 400: ErrorResponse } } },
      async (req) => service.storage(req.query.top),
    );
    app.get('/stats/library', { schema: { response: { 200: LibraryStats } } }, async () => service.library());
    app.get(
      '/stats/activity',
      { schema: { querystring: ActivityStatsQuery, response: { 200: ActivityStats, 400: ErrorResponse } } },
      async (req) => service.activity(req.query.days),
    );
    app.get(
      '/stats/indexers',
      { schema: { querystring: IndexerStatsQuery, response: { 200: IndexerStats, 400: ErrorResponse, 503: ErrorResponse } } },
      async (req) => service.indexers(req.query.days),
    );
  };
}
