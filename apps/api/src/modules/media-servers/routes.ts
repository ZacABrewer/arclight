import { z } from 'zod';
import {
  MediaServerAccountResource,
  MediaServerInput,
  MediaServerProbeResult,
  MediaServerResource,
  MediaServersErrorResponse,
  MediaServerTestRequest,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { MediaServersError, type MediaServersErrorCode, type MediaServersService } from './service.js';

const IdParams = z.object({ id: z.string().min(1) });
const errors = { 400: MediaServersErrorResponse, 404: MediaServersErrorResponse, 409: MediaServersErrorResponse, 502: MediaServersErrorResponse };

const statusFor: Record<MediaServersErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  SERVER_ERROR: 502,
};

export function mediaServersRoutes(service: MediaServersService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof MediaServersError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled media-servers error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get('/mediaserver', { schema: { response: { 200: z.array(MediaServerResource) } } }, async () => service.list());

    app.post(
      '/mediaserver/test',
      { schema: { body: MediaServerTestRequest, response: { 200: MediaServerProbeResult, ...errors } } },
      async (req) => service.testCandidate(req.body),
    );

    app.get('/mediaserver/:id', { schema: { params: IdParams, response: { 200: MediaServerResource, ...errors } } }, async (req) =>
      service.get(req.params.id),
    );

    app.post('/mediaserver', { schema: { body: MediaServerInput, response: { 201: MediaServerResource, ...errors } } }, async (req, reply) =>
      reply.code(201).send(service.create(req.body)),
    );

    app.put(
      '/mediaserver/:id',
      { schema: { params: IdParams, body: MediaServerInput, response: { 200: MediaServerResource, ...errors } } },
      async (req) => service.update(req.params.id, req.body),
    );

    app.delete('/mediaserver/:id', { schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      service.delete(req.params.id);
      return reply.code(204).send(null);
    });

    app.post('/mediaserver/:id/test', { schema: { params: IdParams, response: { 200: MediaServerProbeResult, ...errors } } }, async (req) =>
      service.test(req.params.id),
    );

    app.get(
      '/mediaserver/:id/users',
      { schema: { params: IdParams, response: { 200: z.array(MediaServerAccountResource), ...errors } } },
      async (req) => service.users(req.params.id),
    );
  };
}
