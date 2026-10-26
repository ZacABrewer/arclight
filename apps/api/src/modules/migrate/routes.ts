import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  MigrateApplyRequest,
  MigrateErrorResponse,
  MigrateSource,
  MigrateSourcesResponse,
  MigrateStatus,
  MigrationPlan,
} from '@arclight/shared';
import { requireAdmin } from '../auth/hook.js';
import { MigrateError, migrateHttpStatus } from './errors.js';
import type { MigrateService } from './service.js';

const errors = { 400: MigrateErrorResponse, 401: MigrateErrorResponse, 403: MigrateErrorResponse, 404: MigrateErrorResponse, 409: MigrateErrorResponse };

/** /migrate/*: admin only. Plan is synchronous; apply starts the MigrateFromArr job. */
export const migrateRoutes =
  (service: MigrateService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> =>
  async (app) => {
    app.addHook('preHandler', requireAdmin);
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof MigrateError) return reply.code(migrateHttpStatus(err.code)).send({ error: err.message, code: err.code });
      throw err;
    });

    app.get('/migrate/sources', { schema: { response: { 200: MigrateSourcesResponse, ...errors } } }, async () => service.sources());

    app.post('/migrate/plan', { schema: { body: MigrateSource, response: { 200: MigrationPlan, ...errors } } }, async (req) => service.plan(req.body));

    app.post('/migrate/apply', { schema: { body: MigrateApplyRequest, response: { 202: MigrateStatus, ...errors } } }, async (req, reply) =>
      reply.code(202).send(service.start(req.body)),
    );

    app.get('/migrate/status', { schema: { response: { 200: MigrateStatus, ...errors } } }, async () => service.status());
  };
