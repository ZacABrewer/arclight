import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  MigrateApplyRequest,
  MigrateDiscovery,
  MigrateErrorResponse,
  MigrateReport,
  MigrateSource,
  MigrateSourceCleanupRequest,
  MigrateSourceCleanupResult,
  MigrateSourcesResponse,
  MigrateStackApplyRequest,
  MigrateStackPreview,
  MigrateStackRequest,
  MigrateStackStatus,
  MigrateStatus,
  MigrateTestRequest,
  MigrateTestResult,
  MigrationPlan,
} from '@arclight/shared';
import { requireAdmin } from '../auth/hook.js';
import { discoverNetwork } from './discovery.js';
import { MigrateError, migrateHttpStatus } from './errors.js';
import type { MigrateService } from './service.js';
import type { MigrateStackRunner } from './stack.js';
import { testSource } from './test-connection.js';

const errors = {
  400: MigrateErrorResponse,
  401: MigrateErrorResponse,
  403: MigrateErrorResponse,
  404: MigrateErrorResponse,
  409: MigrateErrorResponse,
  502: MigrateErrorResponse,
};

/**
 * /migrate/*: admin only. Single source: plan is synchronous; apply starts the MigrateFromArr
 * job. Whole stack: test, discover, preview, then apply as the MigrateStack job.
 */
export const migrateRoutes =
  (service: MigrateService, stack: MigrateStackRunner): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> =>
  async (app) => {
    app.addHook('preHandler', requireAdmin);
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof MigrateError) return reply.code(migrateHttpStatus(err.code)).send({ error: err.message, code: err.code });
      throw err;
    });

    app.get('/migrate/sources', { schema: { response: { 200: MigrateSourcesResponse, ...errors } } }, async () => service.sources());

    app.get('/migrate/discover', { schema: { response: { 200: MigrateDiscovery, ...errors } } }, async () => ({
      files: service.sources(),
      network: await discoverNetwork(service.deps),
    }));

    app.post('/migrate/test', { schema: { body: MigrateTestRequest, response: { 200: MigrateTestResult, ...errors } } }, async (req) =>
      testSource(req.body, service.deps),
    );

    app.post('/migrate/plan', { schema: { body: MigrateSource, response: { 200: MigrationPlan, ...errors } } }, async (req) => service.plan(req.body));

    app.post('/migrate/apply', { schema: { body: MigrateApplyRequest, response: { 202: MigrateStatus, ...errors } } }, async (req, reply) =>
      reply.code(202).send(service.start(req.body)),
    );

    app.get('/migrate/status', { schema: { response: { 200: MigrateStatus, ...errors } } }, async () => service.status());

    // ---- whole stack ----------------------------------------------------------------------

    app.post('/migrate/stack/preview', { schema: { body: MigrateStackRequest, response: { 200: MigrateStackPreview, ...errors } } }, async (req) => stack.preview(req.body));

    app.post('/migrate/stack/apply', { schema: { body: MigrateStackApplyRequest, response: { 202: MigrateStackStatus, ...errors } } }, async (req, reply) =>
      reply.code(202).send(stack.start(req.body)),
    );

    app.post('/migrate/stack/resume', { schema: { response: { 202: MigrateStackStatus, ...errors } } }, async (_req, reply) => reply.code(202).send(stack.resume()));

    app.get('/migrate/stack/status', { schema: { response: { 200: MigrateStackStatus, ...errors } } }, async () => stack.status());

    app.get(
      '/migrate/stack/report',
      { schema: { querystring: z.object({ runId: z.coerce.number().int().optional(), download: z.coerce.boolean().optional() }), response: { 200: MigrateReport, ...errors } } },
      async (req, reply) => {
        const report = stack.report(req.query.runId);
        if (req.query.download) reply.header('Content-Disposition', `attachment; filename="arclight-import-report-${report.runId}.json"`);
        return report;
      },
    );

    app.post(
      '/migrate/stack/source-cleanup',
      { schema: { body: MigrateSourceCleanupRequest, response: { 200: MigrateSourceCleanupResult, ...errors } } },
      async (req) => stack.cleanup(req.body),
    );
  };
