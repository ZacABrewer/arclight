import { z } from 'zod';
import {
  ImportList,
  ImportListCreate,
  ImportListExclusion,
  ImportListExclusionCreate,
  ImportListFoundItem,
  ImportListItem,
  ImportListItemsQuery,
  ImportListSchema,
  ImportListSettings,
  ImportListsErrorResponse,
  ImportListSyncResult,
  ImportListTestRequest,
  ImportListTestResult,
  ImportListUpdate,
  TraktDeviceRequest,
  TraktDeviceResponse,
  TraktPollRequest,
  TraktPollResponse,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ImportListFetchError, ImportListsError } from './errors.js';
import type { ImportListsService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const Empty = z.null();
const errors = {
  400: ImportListsErrorResponse,
  404: ImportListsErrorResponse,
  409: ImportListsErrorResponse,
  502: ImportListsErrorResponse,
};
const statusFor: Record<ImportListsError['code'], number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };

export function importListsRoutes(
  service: ImportListsService,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    // Typed errors map to HTTP here and nowhere else. Fetch errors (Trakt device flow, a
    // manual fetch) are upstream problems: 502.
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof ImportListsError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof ImportListFetchError) return reply.code(502).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled import list error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // ---- lists
    app.get('/importlist', { schema: { response: { 200: z.array(ImportList) } } }, async () => service.list());

    app.get('/importlist/schema', { schema: { response: { 200: z.array(ImportListSchema) } } }, async () => service.schemas());

    app.get(
      '/importlist/items',
      { schema: { querystring: ImportListItemsQuery, response: { 200: z.array(ImportListFoundItem) } } },
      async (req) => service.foundIn(req.query),
    );

    app.post(
      '/importlist/test',
      { schema: { body: ImportListTestRequest, response: { 200: ImportListTestResult, ...errors } } },
      async (req) => service.test(req.body),
    );

    app.post('/importlist/sync', { schema: { response: { 200: ImportListSyncResult, ...errors } } }, async () =>
      service.sync({ force: true }),
    );

    app.post(
      '/importlist/trakt/device',
      { schema: { body: TraktDeviceRequest, response: { 200: TraktDeviceResponse, ...errors } } },
      async (req) => service.traktDevice(req.body.clientId),
    );

    app.post(
      '/importlist/trakt/poll',
      { schema: { body: TraktPollRequest, response: { 200: TraktPollResponse, ...errors } } },
      async (req) => service.traktPoll(req.body),
    );

    app.get('/importlist/:id', { schema: { params: IdParams, response: { 200: ImportList, ...errors } } }, async (req) =>
      service.get(req.params.id),
    );

    app.get(
      '/importlist/:id/items',
      { schema: { params: IdParams, response: { 200: z.array(ImportListItem), ...errors } } },
      async (req) => service.items(req.params.id),
    );

    app.post(
      '/importlist',
      { schema: { body: ImportListCreate, response: { 201: ImportList, ...errors } } },
      async (req, reply) => reply.code(201).send(service.create(req.body)),
    );

    app.put(
      '/importlist/:id',
      { schema: { params: IdParams, body: ImportListUpdate, response: { 200: ImportList, ...errors } } },
      async (req) => service.update(req.params.id, req.body),
    );

    app.delete('/importlist/:id', { schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      service.delete(req.params.id);
      return reply.code(204).send(null);
    });

    // ---- exclusions (shared with the library's import exclusions)
    app.get('/importlistexclusion', { schema: { response: { 200: z.array(ImportListExclusion) } } }, async () =>
      service.listExclusions(),
    );

    app.get(
      '/importlistexclusion/:id',
      { schema: { params: IdParams, response: { 200: ImportListExclusion, ...errors } } },
      async (req) => service.getExclusion(req.params.id),
    );

    app.post(
      '/importlistexclusion',
      { schema: { body: ImportListExclusionCreate, response: { 201: ImportListExclusion, ...errors } } },
      async (req, reply) => reply.code(201).send(service.createExclusion(req.body)),
    );

    app.put(
      '/importlistexclusion/:id',
      { schema: { params: IdParams, body: ImportListExclusionCreate, response: { 200: ImportListExclusion, ...errors } } },
      async (req) => service.updateExclusion(req.params.id, req.body),
    );

    app.delete(
      '/importlistexclusion/:id',
      { schema: { params: IdParams, response: { 204: Empty, ...errors } } },
      async (req, reply) => {
        service.deleteExclusion(req.params.id);
        return reply.code(204).send(null);
      },
    );

    // ---- settings section
    app.get('/settings/importlists', { schema: { response: { 200: ImportListSettings } } }, async () => service.getSettings());

    app.put(
      '/settings/importlists',
      { schema: { body: ImportListSettings, response: { 200: ImportListSettings, ...errors } } },
      async (req) => service.updateSettings(req.body),
    );
  };
}
