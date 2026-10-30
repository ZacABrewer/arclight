import { ErrorResponse, UniversalSearchQuery, UniversalSearchResponse } from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../../db/index.js';
import { searchScopeOf, universalSearch } from './service.js';

/** Every signed-in user; the service limits the kinds to what the caller may see. */
const portal = { access: { portal: true } } as const;

export function searchRoutes(db: Db): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled search error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get(
      '/search/universal',
      { config: portal, schema: { querystring: UniversalSearchQuery, response: { 200: UniversalSearchResponse, 400: ErrorResponse, 401: ErrorResponse } } },
      async (req, reply) => {
        // The auth hook already refused anonymous callers; fail closed if it did not run.
        if (!req.auth) return reply.code(401).send({ error: 'authentication required', code: 'UNAUTHORIZED' });
        return universalSearch(db, searchScopeOf(req.auth), req.query);
      },
    );
  };
}
