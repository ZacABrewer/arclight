import {
  CrossSeedErrorResponse,
  CrossSeedListQuery,
  CrossSeedResource,
  CrossSeedSearchRequest,
  CrossSeedSearchResult,
  CrossSeedSettings,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CrossSeedError, type CrossSeedErrorCode, type CrossSeedService } from './service.js';

// /api/v1/crossseed and /api/v1/settings/crossseed. Thin: validate -> service -> reply.

const STATUS_FOR: Record<CrossSeedErrorCode, number> = { NOT_FOUND: 404, VALIDATION: 400 };
const errors = { 400: CrossSeedErrorResponse, 404: CrossSeedErrorResponse };

export function crossSeedRoutes(
  service: CrossSeedService,
  hooks: { settingsChanged?: (s: CrossSeedSettings) => void } = {},
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof CrossSeedError) return reply.code(STATUS_FOR[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled cross-seed error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get('/crossseed', { schema: { querystring: CrossSeedListQuery, response: { 200: z.array(CrossSeedResource) } } }, async (req) =>
      service.list(req.query),
    );

    app.post(
      '/crossseed/search',
      { schema: { body: CrossSeedSearchRequest, response: { 200: CrossSeedSearchResult, ...errors } } },
      async (req) => service.search(req.body),
    );

    app.get('/settings/crossseed', { schema: { response: { 200: CrossSeedSettings } } }, async () => service.settings());

    app.put('/settings/crossseed', { schema: { body: CrossSeedSettings, response: { 200: CrossSeedSettings, ...errors } } }, async (req) => {
      const saved = service.updateSettings(req.body);
      hooks.settingsChanged?.(saved);
      return saved;
    });
  };
}
