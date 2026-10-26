import { ContainerUpdateRun, ContainerUpdatesInfo, UpdateInfo, UpdateSettings, UpdateSettingsUpdate } from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ContainerUpdateError, type ContainerUpdater } from './containers.js';
import { UpdatesError, type UpdatesService } from './service.js';

// /api/v1/system/update*, /api/v1/system/update/containers* and /api/v1/settings/updates.
// State-changing routes are admin-only through the global auth hook (no `config.access`).

const ErrorBody = z.object({ error: z.string(), code: z.string() });
const errors = { 400: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const statusFor = { UNAVAILABLE: 409, NOT_FOUND: 404, NOTHING_TO_DO: 409 } as const;

export function updatesRoutes(service: UpdatesService, containers: ContainerUpdater): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof UpdatesError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof ContainerUpdateError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled updates error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get('/system/update', { schema: { response: { 200: UpdateInfo } } }, async () => service.info());

    app.post('/system/update/check', { schema: { response: { 200: UpdateInfo } } }, async () => service.check());

    app.get('/system/update/containers', { schema: { response: { 200: ContainerUpdatesInfo } } }, async () => containers.info(service.settings().mode));

    app.post('/system/update/containers/check', { schema: { response: { 200: ContainerUpdatesInfo, ...errors } } }, async () => {
      await containers.check();
      return containers.info(service.settings().mode);
    });

    /** Update every container that has an update (and their network dependents). */
    app.post('/system/update/containers/update', { schema: { response: { 200: ContainerUpdateRun, ...errors } } }, async () => containers.update());

    app.post(
      '/system/update/containers/:name/update',
      { schema: { params: z.object({ name: z.string().min(1) }), response: { 200: ContainerUpdateRun, ...errors } } },
      async (req) => containers.update([req.params.name]),
    );

    app.get('/settings/updates', { schema: { response: { 200: UpdateSettings } } }, async () => service.settings());

    app.put('/settings/updates', { schema: { body: UpdateSettingsUpdate, response: { 200: UpdateSettings, 400: ErrorBody } } }, async (req) =>
      service.updateSettings(req.body),
    );
  };
}
