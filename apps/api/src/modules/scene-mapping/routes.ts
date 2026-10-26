import { z } from 'zod';
import {
  SceneMapping,
  SceneMappingApplyResult,
  SceneMappingFeedStatus,
  SceneMappingInput,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { LibraryError } from '../library/index.js';
import type { SceneMappingFeed } from './feed.js';
import { SceneMappingError, type SceneMappingService } from './service.js';

const SeriesParams = z.object({ id: z.coerce.number().int().min(1) });
const MappingParams = SeriesParams.extend({ mappingId: z.coerce.number().int().min(1) });
const ErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
const errors = { 400: ErrorResponse, 404: ErrorResponse, 502: ErrorResponse };

const statusFor: Record<SceneMappingError['code'], number> = { NOT_FOUND: 404, VALIDATION: 400, UPSTREAM: 502 };

export function sceneMappingRoutes(
  service: SceneMappingService,
  feed: SceneMappingFeed | undefined,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof SceneMappingError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof LibraryError) return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error(err);
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get(
      '/series/:id/scenemapping',
      { schema: { params: SeriesParams, response: { 200: z.array(SceneMapping), ...errors } } },
      async (req) => service.list(req.params.id),
    );

    app.post(
      '/series/:id/scenemapping',
      { schema: { params: SeriesParams, body: SceneMappingInput, response: { 201: SceneMapping, ...errors } } },
      async (req, reply) => reply.code(201).send(service.create(req.params.id, req.body)),
    );

    app.put(
      '/series/:id/scenemapping/:mappingId',
      { schema: { params: MappingParams, body: SceneMappingInput, response: { 200: SceneMapping, ...errors } } },
      async (req) => service.update(req.params.id, req.params.mappingId, req.body),
    );

    app.delete(
      '/series/:id/scenemapping/:mappingId',
      { schema: { params: MappingParams, response: { 204: z.null(), ...errors } } },
      async (req, reply) => {
        service.delete(req.params.id, req.params.mappingId);
        return reply.code(204).send(null);
      },
    );

    app.post(
      '/series/:id/scenemapping/apply',
      { schema: { params: SeriesParams, response: { 200: SceneMappingApplyResult, ...errors } } },
      async (req) => service.applyToFiles(req.params.id),
    );

    if (feed) {
      app.get('/scenemapping/feed', { schema: { response: { 200: SceneMappingFeedStatus } } }, async () => feed.status());
      app.post(
        '/scenemapping/feed/sync',
        { schema: { response: { 200: SceneMappingFeedStatus, ...errors } } },
        async () => feed.sync(),
      );
    }
  };
}
