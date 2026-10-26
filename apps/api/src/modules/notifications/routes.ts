import { z } from 'zod';
import {
  NotificationConnection,
  NotificationInput,
  NotificationSchema,
  NotificationsErrorResponse,
  NotificationTestAllResult,
  NotificationTestRequest,
  NotificationTestResult,
} from '@media-tron/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { NotificationsError, type NotificationsErrorCode, type NotificationsService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const errors = { 400: NotificationsErrorResponse, 404: NotificationsErrorResponse, 409: NotificationsErrorResponse };
const statusFor: Record<NotificationsErrorCode, number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };

export function notificationsRoutes(
  service: NotificationsService,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof NotificationsError) {
        return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      }
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get('/notification', { schema: { response: { 200: z.array(NotificationConnection) } } }, async () =>
      service.list(),
    );

    app.get('/notification/schema', { schema: { response: { 200: z.array(NotificationSchema) } } }, async () =>
      service.schemas(),
    );

    app.get(
      '/notification/:id',
      { schema: { params: IdParams, response: { 200: NotificationConnection, ...errors } } },
      async (req) => service.get(req.params.id),
    );

    app.post(
      '/notification',
      { schema: { body: NotificationInput, response: { 201: NotificationConnection, ...errors } } },
      async (req, reply) => reply.code(201).send(service.create(req.body)),
    );

    app.put(
      '/notification/:id',
      { schema: { params: IdParams, body: NotificationInput, response: { 200: NotificationConnection, ...errors } } },
      async (req) => service.update(req.params.id, req.body),
    );

    app.delete(
      '/notification/:id',
      { schema: { params: IdParams, response: { 204: z.null(), ...errors } } },
      async (req, reply) => {
        service.delete(req.params.id);
        return reply.code(204).send(null);
      },
    );

    app.post(
      '/notification/test',
      { schema: { body: NotificationTestRequest, response: { 200: NotificationTestResult, ...errors } } },
      async (req) => service.test(req.body),
    );

    app.post(
      '/notification/testall',
      { schema: { response: { 200: NotificationTestAllResult } } },
      async () => service.testAll(),
    );
  };
}
