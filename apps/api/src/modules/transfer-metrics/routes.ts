import { DownloadMetrics, EngineMetrics, ErrorResponse, MetricsRangeQuery, VpnMetrics } from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TransferMetricsError, type TransferMetricsService } from './service.js';

const QueueIdParams = z.object({ queueId: z.coerce.number().int().positive() });

export function transferMetricsRoutes(
  service: TransferMetricsService,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof TransferMetricsError) return reply.code(404).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled transfer metrics error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get(
      '/metrics/downloads/:queueId',
      { schema: { params: QueueIdParams, querystring: MetricsRangeQuery, response: { 200: DownloadMetrics, 400: ErrorResponse, 404: ErrorResponse } } },
      async (req) => service.downloadMetrics(req.params.queueId, req.query.range),
    );
    app.get(
      '/metrics/engine',
      { schema: { querystring: MetricsRangeQuery, response: { 200: EngineMetrics, 400: ErrorResponse } } },
      async (req) => service.engineMetrics(req.query.range),
    );
    app.get(
      '/metrics/vpn',
      { schema: { querystring: MetricsRangeQuery, response: { 200: VpnMetrics, 400: ErrorResponse } } },
      async (req) => service.vpnMetrics(req.query.range),
    );
  };
}
