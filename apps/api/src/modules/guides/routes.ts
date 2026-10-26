import { z } from 'zod';
import {
  GuideProfileInfo,
  GuidesApplyRequest,
  GuidesApplyResult,
  GuidesDiff,
  GuidesErrorResponse,
  GuidesSettings,
  GuidesStatus,
  GuidesSyncResult,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SettingsError } from '../settings/service.js';
import { GuidesError, type GuidesService } from './service.js';

const errors = { 400: GuidesErrorResponse, 502: GuidesErrorResponse };
const statusFor: Record<GuidesError['code'], number> = { NOT_FOUND: 404, VALIDATION: 400, UPSTREAM: 502 };

export interface GuidesRouteHooks {
  /** Called after PUT /settings/guides saved (reschedules the job). */
  onSettingsChanged?: (settings: GuidesSettings) => void;
}

export function guidesRoutes(
  service: GuidesService,
  hooks: GuidesRouteHooks = {},
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof GuidesError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/guides/status', { schema: { response: { 200: GuidesStatus } } }, async () => service.status());

    app.get('/guides/diff', { schema: { response: { 200: GuidesDiff } } }, async () => service.pendingDiff());

    app.post('/guides/sync', { schema: { response: { 200: GuidesSyncResult, ...errors } } }, async () => service.sync());

    app.post(
      '/guides/apply',
      { schema: { body: GuidesApplyRequest.optional(), response: { 200: GuidesApplyResult, ...errors } } },
      async (req) => service.apply(req.body?.ids),
    );

    app.get(
      '/guides/profiles',
      {
        schema: {
          querystring: z.object({ refresh: z.enum(['true', 'false']).optional() }),
          response: { 200: z.array(GuideProfileInfo), ...errors },
        },
      },
      async (req) => service.profiles({ refresh: req.query.refresh === 'true' }),
    );

    app.get('/settings/guides', { schema: { response: { 200: GuidesSettings } } }, async () => service.settings());

    app.put('/settings/guides', { schema: { body: GuidesSettings, response: { 200: GuidesSettings, ...errors } } }, async (req) => {
      const saved = service.updateSettings(req.body);
      hooks.onSettingsChanged?.(saved);
      return saved;
    });
  };
}
