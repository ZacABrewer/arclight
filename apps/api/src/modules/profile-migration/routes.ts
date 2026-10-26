import { z } from 'zod';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  Job,
  ProfileItemStatus,
  ProfileMigrationApplyResult,
  ProfileMigrationErrorResponse,
  ProfileMigrationPreview,
  ProfileMigrationProfileUpdate,
  ProfileMigrationProgress,
  ProfileMigrationRequest,
  ProfileMigrationSearchResult,
  ProfileMigrationSettings,
  ProfileMismatchPage,
  ProfileMismatchQuery,
} from '@arclight/shared';
import { LibraryError } from '../library/index.js';
import { ProfileMigrationError, type ProfileMigrationService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const errors = { 400: ProfileMigrationErrorResponse, 404: ProfileMigrationErrorResponse };

/** Routes under /api/v1/profilemigration. Thin: validate -> service -> reply. */
export function profileMigrationRoutes(
  service: ProfileMigrationService,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof ProfileMigrationError) {
        return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
      }
      if (err instanceof LibraryError) {
        return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
      }
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled profile migration error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/profilemigration/settings', { schema: { response: { 200: ProfileMigrationSettings } } }, async () => service.getSettings());
    app.put(
      '/profilemigration/settings',
      { schema: { body: ProfileMigrationSettings.partial(), response: { 200: ProfileMigrationSettings, ...errors } } },
      async (req) => service.updateSettings(stripUndefined(req.body)),
    );

    app.get('/profilemigration/profiles', { schema: { response: { 200: z.array(ProfileMigrationProgress) } } }, async () => service.progressAll());
    app.get('/profilemigration/profiles/:id', { schema: { params: IdParams, response: { 200: ProfileMigrationProgress, ...errors } } }, async (req) =>
      service.progress(req.params.id),
    );
    app.put(
      '/profilemigration/profiles/:id',
      { schema: { params: IdParams, body: ProfileMigrationProfileUpdate, response: { 200: ProfileMigrationProgress, ...errors } } },
      async (req) => service.updateProfileSettings(req.params.id, req.body),
    );
    // Manual "search all now": 202 with the number of searches and the job running them.
    app.post(
      '/profilemigration/profiles/:id/search',
      { schema: { params: IdParams, response: { 202: ProfileMigrationSearchResult, ...errors } } },
      async (req, reply) => reply.code(202).send(service.searchAllNow(req.params.id)),
    );
    app.post(
      '/profilemigration/profiles/:id/retry',
      { schema: { params: IdParams, response: { 200: ProfileMigrationProgress, ...errors } } },
      async (req) => service.retryFailed(req.params.id),
    );

    app.post('/profilemigration/preview', { schema: { body: ProfileMigrationRequest, response: { 200: ProfileMigrationPreview, ...errors } } }, async (req) =>
      service.preview(req.body),
    );
    app.post(
      '/profilemigration/apply',
      { schema: { body: ProfileMigrationRequest, response: { 200: ProfileMigrationApplyResult, ...errors } } },
      async (req) => service.apply(req.body),
    );

    app.get('/profilemigration/mismatch', { config: { access: { areas: ['wanted'] } }, schema: { querystring: ProfileMismatchQuery, response: { 200: ProfileMismatchPage } } }, async (req) =>
      service.mismatchPage(req.query),
    );
    app.get('/profilemigration/items', { schema: { response: { 200: z.array(ProfileItemStatus) } } }, async () => service.itemStatuses());
    app.post('/profilemigration/reevaluate', { schema: { response: { 202: Job.nullable() } } }, async (_req, reply) =>
      reply.code(202).send(service.reevaluateAsJob()),
    );
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
