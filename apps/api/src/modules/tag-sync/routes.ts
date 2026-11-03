import { z } from 'zod';
import { ErrorResponse, TagSyncPreview, TagSyncStatus } from '@arclight/shared';
import { MediaServerError } from '@arclight/media-servers';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { TagSyncError, type TagSyncService } from './service.js';

const IdParams = z.object({ id: z.string().min(1) });
const errors = { 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 502: ErrorResponse };

/** Admin-only: status, dry run, Sync now, and what to do with the tags when sync is turned off. */
export function tagSyncRoutes(service: TagSyncService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof TagSyncError) return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
      if (err instanceof MediaServerError) return reply.code(502).send({ error: err.message, code: 'SERVER_ERROR' });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled tag sync error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // Background runs log their own failures and record them in the status.
    const background = (p: Promise<void>) => void p.catch(() => undefined);

    app.get('/mediaserver/:id/tag-sync', { schema: { params: IdParams, response: { 200: TagSyncStatus, ...errors } } }, async (req) => service.status(req.params.id));

    app.post('/mediaserver/:id/tag-sync/preview', { schema: { params: IdParams, response: { 200: TagSyncPreview, ...errors } } }, async (req) => service.preview(req.params.id));

    app.post('/mediaserver/:id/tag-sync/run', { schema: { params: IdParams, response: { 202: z.null(), ...errors } } }, async (req, reply) => {
      background(service.runNow(req.params.id));
      return reply.code(202).send(null);
    });

    // Sync turned off, "Keep": the tags stay on the server, Arclight stops tracking them.
    app.post('/mediaserver/:id/tag-sync/forget', { schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      service.forget(req.params.id);
      return reply.code(204).send(null);
    });

    // Sync turned off, "Remove": take Arclight's tags off the server, then forget them.
    app.post('/mediaserver/:id/tag-sync/remove-all', { schema: { params: IdParams, response: { 202: z.null(), ...errors } } }, async (req, reply) => {
      background(service.removeAll(req.params.id));
      return reply.code(202).send(null);
    });
  };
}
