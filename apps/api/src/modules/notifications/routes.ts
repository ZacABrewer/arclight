import { z } from 'zod';
import {
  NotificationConnection,
  NotificationDelivery,
  NotificationInput,
  NotificationPreview,
  NotificationPreviewRequest,
  NotificationTemplateMeta,
  NotificationSchema,
  NotificationsErrorResponse,
  NotificationTestAllResult,
  NotificationTestRequest,
  NotificationTestResult,
  PersonalDestination,
  PersonalDestinationInput,
  PersonalDestinationOptions,
  PersonalDestinationTestRequest,
} from '@arclight/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_REAUTH_MESSAGE, mayRunCommands, requireSelfOrAdmin } from '../auth/hook.js';
import type { PersonalNotifications } from './personal.js';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { NotificationsError, type NotificationsErrorCode, type NotificationsService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const DestinationParams = z.object({ id: z.coerce.number().int().min(1), destinationId: z.coerce.number().int().min(1) });
const portal = { access: { portal: true } } as const;

/** Whether the caller sees full error texts (admins and the API key) or only their category. */
function viewerIsAdmin(req: FastifyRequest): boolean {
  return req.auth?.isAdmin ?? false;
}
const errors = {
  400: NotificationsErrorResponse,
  401: NotificationsErrorResponse,
  403: NotificationsErrorResponse,
  404: NotificationsErrorResponse,
  409: NotificationsErrorResponse,
};
/**
 * A custom-script connection runs a program on the host: creating, changing or testing one needs a
 * browser session or an admin-scope key, never an app token or a narrower key (DATA-13).
 */
async function guardCustomScript(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = req.body as { implementation?: unknown } | undefined;
  if (body?.implementation === 'custom-script' && !mayRunCommands(req.auth)) {
    if (req.auth?.via === 'app') {
      await reply.code(403).send({ error: APP_REAUTH_MESSAGE, code: 'REAUTH_REQUIRED' });
      return;
    }
    await reply.code(403).send({ error: 'custom scripts can only be set up from a signed-in browser or an admin-scope key', code: 'FORBIDDEN' });
  }
}
const statusFor: Record<NotificationsErrorCode, number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };

export function notificationsRoutes(
  service: NotificationsService,
  personal?: PersonalNotifications,
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

    // Template editor helpers. Sample data only, so request-portal users (personal
    // destinations) may use them too.
    app.get(
      '/notification/templates',
      { config: { access: { portal: true } }, schema: { response: { 200: NotificationTemplateMeta } } },
      async () => service.templateMeta(),
    );

    app.post(
      '/notification/preview',
      { config: { access: { portal: true } }, schema: { body: NotificationPreviewRequest, response: { 200: NotificationPreview, ...errors } } },
      async (req) => service.preview(req.body),
    );

    app.get(
      '/notification/:id/deliveries',
      { schema: { params: IdParams, response: { 200: z.array(NotificationDelivery), ...errors } } },
      async (req) => service.deliveries(req.params.id),
    );

    app.get(
      '/notification/:id',
      { schema: { params: IdParams, response: { 200: NotificationConnection, ...errors } } },
      async (req) => service.get(req.params.id),
    );

    app.post(
      '/notification',
      { preHandler: guardCustomScript, schema: { body: NotificationInput, response: { 201: NotificationConnection, ...errors } } },
      async (req, reply) => reply.code(201).send(service.create(req.body)),
    );

    app.put(
      '/notification/:id',
      { preHandler: guardCustomScript, schema: { params: IdParams, body: NotificationInput, response: { 200: NotificationConnection, ...errors } } },
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
      { preHandler: guardCustomScript, schema: { body: NotificationTestRequest, response: { 200: NotificationTestResult, ...errors } } },
      async (req) => service.test(req.body),
    );

    app.post(
      '/notification/testall',
      { schema: { response: { 200: NotificationTestAllResult } } },
      async () => service.testAll(),
    );

    if (!personal) return;

    // ---- personal destinations: every user manages their own (admins anyone's) ----

    const own = { config: portal, preHandler: requireSelfOrAdmin } as const;

    app.get(
      '/user/:id/notification-destination/options',
      { ...own, schema: { params: IdParams, response: { 200: PersonalDestinationOptions.extend({ schemas: z.array(NotificationSchema) }), ...errors } } },
      async (req) => personal.options(req.params.id),
    );

    app.get(
      '/user/:id/notification-destination',
      { ...own, schema: { params: IdParams, response: { 200: z.array(PersonalDestination), ...errors } } },
      async (req) => personal.list(req.params.id, viewerIsAdmin(req)),
    );

    app.post(
      '/user/:id/notification-destination',
      { ...own, schema: { params: IdParams, body: PersonalDestinationInput, response: { 201: PersonalDestination, ...errors } } },
      async (req, reply) => reply.code(201).send(personal.create(req.params.id, req.body)),
    );

    app.post(
      '/user/:id/notification-destination/test',
      { ...own, schema: { params: IdParams, body: PersonalDestinationTestRequest, response: { 200: NotificationTestResult, ...errors } } },
      async (req) => personal.test(req.params.id, req.body, viewerIsAdmin(req)),
    );

    app.put(
      '/user/:id/notification-destination/:destinationId',
      { ...own, schema: { params: DestinationParams, body: PersonalDestinationInput, response: { 200: PersonalDestination, ...errors } } },
      async (req) => personal.update(req.params.id, req.params.destinationId, req.body),
    );

    app.delete(
      '/user/:id/notification-destination/:destinationId',
      { ...own, schema: { params: DestinationParams, response: { 204: z.null(), ...errors } } },
      async (req, reply) => {
        personal.delete(req.params.id, req.params.destinationId);
        return reply.code(204).send(null);
      },
    );

    app.get(
      '/user/:id/notification-destination/:destinationId/deliveries',
      { ...own, schema: { params: DestinationParams, response: { 200: z.array(NotificationDelivery), ...errors } } },
      async (req) => personal.deliveries(req.params.id, req.params.destinationId, viewerIsAdmin(req)),
    );
  };
}
