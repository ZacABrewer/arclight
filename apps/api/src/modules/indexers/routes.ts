import { z } from 'zod';
import {
  Indexer,
  IndexerCapabilitiesResource,
  IndexerCategory,
  IndexerCreate,
  IndexersErrorResponse,
  IndexerStatus,
  IndexerTemplate,
  IndexerTestAllItem,
  IndexerTestResult,
  IndexerUpdate,
  ManualSearchRequest,
  ReleaseResource,
} from '@media-tron/shared';
import { IndexerError } from '@media-tron/indexers';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { IndexersError, type IndexersService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const CapsQuery = z.object({ refresh: z.stringbool().optional() });
const Empty = z.null();

const errors = {
  400: IndexersErrorResponse,
  404: IndexersErrorResponse,
  409: IndexersErrorResponse,
  502: IndexersErrorResponse,
};

const statusFor: Record<IndexersError['code'], number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };

export function indexersRoutes(
  service: IndexersService,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    // Typed errors map to HTTP here and nowhere else. Indexer protocol errors (only
    // reachable from the caps route) are an upstream problem: 502.
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof IndexersError) {
        return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      }
      if (err instanceof IndexerError) {
        return reply.code(502).send({ error: err.message, code: err.code });
      }
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/indexer', { schema: { response: { 200: z.array(Indexer) } } }, async () => service.list());

    app.get('/indexer/schema', { schema: { response: { 200: z.array(IndexerTemplate) } } }, async () =>
      service.templates(),
    );

    app.get('/indexer/categories', { schema: { response: { 200: z.array(IndexerCategory) } } }, async () =>
      service.categories(),
    );

    app.get('/indexer/status', { schema: { response: { 200: z.array(IndexerStatus) } } }, async () =>
      service.statuses(),
    );

    app.post(
      '/indexer/test',
      { schema: { body: IndexerCreate, response: { 200: IndexerTestResult, ...errors } } },
      async (req) => service.test(req.body),
    );

    app.post('/indexer/testall', { schema: { response: { 200: z.array(IndexerTestAllItem) } } }, async () =>
      service.testAll(),
    );

    app.get('/indexer/:id', { schema: { params: IdParams, response: { 200: Indexer, ...errors } } }, async (req) =>
      service.get(req.params.id),
    );

    app.get(
      '/indexer/:id/caps',
      { schema: { params: IdParams, querystring: CapsQuery, response: { 200: IndexerCapabilitiesResource, ...errors } } },
      async (req) => service.getCaps(req.params.id, { refresh: req.query.refresh ?? false }),
    );

    app.post(
      '/indexer',
      { schema: { body: IndexerCreate, response: { 201: Indexer, ...errors } } },
      async (req, reply) => reply.code(201).send(service.create(req.body)),
    );

    app.put(
      '/indexer/:id',
      { schema: { params: IdParams, body: IndexerUpdate, response: { 200: Indexer, ...errors } } },
      async (req) => service.update(req.params.id, req.body),
    );

    app.delete('/indexer/:id', { schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      service.delete(req.params.id);
      return reply.code(204).send(null);
    });

    app.get(
      '/search',
      { schema: { querystring: ManualSearchRequest, response: { 200: z.array(ReleaseResource), ...errors } } },
      async (req) => service.manualSearch(req.query),
    );
  };
}
