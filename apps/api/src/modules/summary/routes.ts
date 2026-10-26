import { z } from 'zod';
import {
  AlertSettings,
  AlertSettingsResponse,
  DailySummary,
  DailySummaryGenerateRequest,
  DailySummaryListQuery,
  ErrorResponse,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SettingsError } from '../settings/service.js';
import type { SummaryService } from './service.js';

export function summaryRoutes(service: SummaryService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled summary error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/settings/alerts', { schema: { response: { 200: AlertSettingsResponse } } }, async () => service.settings());

    app.put(
      '/settings/alerts',
      { schema: { body: AlertSettings, response: { 200: AlertSettingsResponse, 400: ErrorResponse } } },
      async (req) => service.saveSettings(req.body),
    );

    app.get('/summary/latest', { schema: { response: { 200: DailySummary.nullable() } } }, async () => service.latest());

    app.get(
      '/summary',
      { schema: { querystring: DailySummaryListQuery, response: { 200: z.array(DailySummary), 400: ErrorResponse } } },
      async (req) => service.list(req.query.limit),
    );

    app.post(
      '/summary',
      { schema: { body: DailySummaryGenerateRequest.optional(), response: { 200: DailySummary, 400: ErrorResponse } } },
      async (req) => service.generate({ notify: req.body?.notify ?? false }),
    );
  };
}
