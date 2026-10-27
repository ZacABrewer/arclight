import { z } from 'zod';
import {
  DownloadClientImplementationSchema,
  DownloadClientInput,
  DownloadClientResource,
  DownloadClientsErrorResponse,
  DownloadClientTestAllResult,
  DownloadClientTestRequest,
  DownloadClientTestResult,
  DownloadTimeline,
  QueueBulkRemoveRequest,
  QueueForceStartRequest,
  QueueItem,
  QueueItemLimitsRequest,
  QueueMoveRequest,
  QueuePage,
  QueueQuery,
  QueueReannounceResult,
  QueueRemoveOptions,
  QueueRemoveResult,
  QueueReplaceRequest,
  QueueReplaceResult,
  QueueStatus,
  QueueSummaryItem,
  RemotePathMapping,
  RemotePathMappingInput,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { DownloadClientsError, type DownloadClientsErrorCode, type DownloadClientsService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const Empty = z.null();
const errors = {
  400: DownloadClientsErrorResponse,
  404: DownloadClientsErrorResponse,
  409: DownloadClientsErrorResponse,
  502: DownloadClientsErrorResponse,
};

const statusFor: Record<DownloadClientsErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  NO_CLIENT: 409,
  CLIENT_ERROR: 502,
};

export function downloadClientsRoutes(
  service: DownloadClientsService,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    // Typed errors from the service map to HTTP here and nowhere else.
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof DownloadClientsError) {
        return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      }
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    // ---- download clients --------------------------------------------------------------

    app.get('/downloadclient', { schema: { response: { 200: z.array(DownloadClientResource) } } }, async () =>
      service.list(),
    );

    app.get(
      '/downloadclient/schema',
      { schema: { response: { 200: z.array(DownloadClientImplementationSchema) } } },
      async () => service.schemas(),
    );

    app.get(
      '/downloadclient/:id',
      { schema: { params: IdParams, response: { 200: DownloadClientResource, ...errors } } },
      async (req) => service.get(req.params.id),
    );

    app.post(
      '/downloadclient',
      { schema: { body: DownloadClientInput, response: { 201: DownloadClientResource, ...errors } } },
      async (req, reply) => reply.code(201).send(service.create(req.body)),
    );

    app.put(
      '/downloadclient/:id',
      { schema: { params: IdParams, body: DownloadClientInput, response: { 200: DownloadClientResource, ...errors } } },
      async (req) => service.update(req.params.id, req.body),
    );

    app.delete(
      '/downloadclient/:id',
      { schema: { params: IdParams, response: { 204: Empty, ...errors } } },
      async (req, reply) => {
        service.delete(req.params.id);
        return reply.code(204).send(null);
      },
    );

    app.post(
      '/downloadclient/test',
      { schema: { body: DownloadClientTestRequest, response: { 200: DownloadClientTestResult, ...errors } } },
      async (req) => service.test(req.body),
    );

    app.post(
      '/downloadclient/testall',
      { schema: { response: { 200: DownloadClientTestAllResult } } },
      async () => service.testAll(),
    );

    // ---- remote path mappings ----------------------------------------------------------

    app.get('/remotepathmapping', { schema: { response: { 200: z.array(RemotePathMapping) } } }, async () =>
      service.listMappings(),
    );

    app.get(
      '/remotepathmapping/:id',
      { schema: { params: IdParams, response: { 200: RemotePathMapping, ...errors } } },
      async (req) => service.getMapping(req.params.id),
    );

    app.post(
      '/remotepathmapping',
      { schema: { body: RemotePathMappingInput, response: { 201: RemotePathMapping, ...errors } } },
      async (req, reply) => reply.code(201).send(await service.createMapping(req.body)),
    );

    app.put(
      '/remotepathmapping/:id',
      { schema: { params: IdParams, body: RemotePathMappingInput, response: { 200: RemotePathMapping, ...errors } } },
      async (req) => service.updateMapping(req.params.id, req.body),
    );

    app.delete(
      '/remotepathmapping/:id',
      { schema: { params: IdParams, response: { 204: Empty, ...errors } } },
      async (req, reply) => {
        service.deleteMapping(req.params.id);
        return reply.code(204).send(null);
      },
    );

    // ---- queue -------------------------------------------------------------------------

    app.get('/queue', { config: { access: { areas: ['activity'] } }, schema: { querystring: QueueQuery, response: { 200: QueuePage, ...errors } } }, async (req) =>
      service.listQueue(req.query),
    );

    app.get('/queue/status', { config: { access: { areas: ['activity'] } }, schema: { response: { 200: QueueStatus } } }, async () => service.queueStatus());

    // Compact per-item queue state for the library pages (no titles or paths).
    app.get('/queue/summary', { config: { access: { areas: ['library', 'activity'] } }, schema: { response: { 200: z.array(QueueSummaryItem) } } }, async () =>
      service.queueSummary(),
    );

    app.get(
      '/queue/:id/timeline',
      { config: { access: { areas: ['activity'] } }, schema: { params: IdParams, response: { 200: DownloadTimeline, ...errors } } },
      async (req) => service.getTimeline(req.params.id),
    );

    app.get('/queue/:id', { config: { access: { areas: ['activity'] } }, schema: { params: IdParams, response: { 200: QueueItem, ...errors } } }, async (req) =>
      service.getQueueItem(req.params.id),
    );

    app.delete(
      '/queue/bulk',
      { schema: { body: QueueBulkRemoveRequest, response: { 200: QueueRemoveResult, ...errors } } },
      async (req) => {
        const { ids, ...options } = req.body;
        return service.removeQueueItems(ids, options);
      },
    );

    app.delete(
      '/queue/:id',
      { schema: { params: IdParams, querystring: QueueRemoveOptions, response: { 200: QueueRemoveResult, ...errors } } },
      async (req) => {
        service.getQueueItem(req.params.id);
        return service.removeQueueItems([req.params.id], req.query);
      },
    );

    // Engine control: per-download limits, queue order and force start (clients that support them).
    app.post(
      '/queue/:id/limits',
      { schema: { params: IdParams, body: QueueItemLimitsRequest, response: { 200: QueueItem, ...errors } } },
      async (req) => service.setItemLimits(req.params.id, req.body),
    );

    app.post(
      '/queue/:id/move',
      { schema: { params: IdParams, body: QueueMoveRequest, response: { 200: QueueItem, ...errors } } },
      async (req) => service.moveInQueue(req.params.id, req.body.move),
    );

    app.post(
      '/queue/:id/forcestart',
      { schema: { params: IdParams, body: QueueForceStartRequest, response: { 200: QueueItem, ...errors } } },
      async (req) => service.setForceStart(req.params.id, req.body.enabled),
    );

    app.post(
      '/queue/grab/:id',
      { schema: { params: IdParams, response: { 200: QueueItem, ...errors } } },
      async (req) => {
        // "Send now": the user overrides a disk-space hold.
        const item = await service.retryPending(req.params.id, { force: true });
        return service.getQueueItem(item.id);
      },
    );

    // "Try another release": remove, (blocklist,) search again.
    app.post(
      '/queue/:id/replace',
      { schema: { params: IdParams, body: QueueReplaceRequest.default({ blocklist: true, removeData: true }), response: { 200: QueueReplaceResult, ...errors } } },
      async (req) => service.replace(req.params.id, req.body),
    );

    app.post(
      '/queue/:id/reannounce',
      { schema: { params: IdParams, response: { 200: QueueReannounceResult, ...errors } } },
      async (req) => service.reannounce(req.params.id),
    );
  };
}
