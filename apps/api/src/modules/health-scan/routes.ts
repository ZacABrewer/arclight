import {
  ErrorResponse,
  HealthActionRequest,
  HealthActionResult,
  HealthListQuery,
  HealthListResponse,
  HealthScanRequest,
  HealthScanSettings,
  Job,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { setSection } from '../settings/service.js';
import { HealthScanError, type HealthScanErrorCode, type HealthScanService } from './service.js';

const statusFor: Record<HealthScanErrorCode, number> = { NOT_FOUND: 404, VALIDATION: 400 };
const errors = { 400: ErrorResponse, 404: ErrorResponse };

export interface HealthScanRoutesOptions {
  /** Starts a HealthScan / HealthCheck job and answers its initial row. */
  startScan(req: HealthScanRequest): Job;
  /** Called after the settings changed (reschedules the job). */
  onSettingsChanged(): void;
}

export function healthScanRoutes(
  service: HealthScanService,
  opts: HealthScanRoutesOptions,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof HealthScanError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled health-scan error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/library/health', { schema: { querystring: HealthListQuery, response: { 200: HealthListResponse, ...errors } } }, async (req) => service.list(req.query));

    app.post('/library/health/scan', { schema: { body: HealthScanRequest, response: { 202: Job, ...errors } } }, async (req, reply) =>
      reply.code(202).send(opts.startScan(req.body)),
    );

    app.post('/library/health/action', { schema: { body: HealthActionRequest, response: { 200: HealthActionResult, ...errors } } }, async (req) =>
      service.act(req.body.action, req.body.ids, (target) =>
        opts.startScan({ files: target.files, albumIds: target.albumIds, bookIds: target.bookIds }).id,
      ),
    );

    app.get('/settings/healthscan', { schema: { response: { 200: HealthScanSettings } } }, async () => service.settings());

    app.put('/settings/healthscan', { schema: { body: HealthScanSettings, response: { 200: HealthScanSettings, ...errors } } }, async (req) => {
      setSection(service.db, 'healthScan', req.body);
      opts.onSettingsChanged();
      return service.settings();
    });
  };
}
