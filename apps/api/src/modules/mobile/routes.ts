import { MobileDeviceInput, MobileDeviceListQuery, MobileDeviceResource, MobilePairingInfo, MobileTestResult } from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MobileError, type MobileService } from './service.js';

// /api/v1/mobile/*: the Arclight Admin app's devices. Every route is open to signed-in users
// (portal) and scoped to the caller's own devices; admins may list (`?all=true`), remove and
// test anyone's. Registering needs a signed-in user (API-key callers get 400 NO_USER). No
// response ever carries the relay secret.

const user = { access: { portal: true } } as const;
const ErrorBody = z.object({ error: z.string(), code: z.string() });
const errors = { 400: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody, 429: ErrorBody };
const IdParams = z.object({ id: z.coerce.number().int().positive() });

function userIdOf(req: FastifyRequest): number {
  const id = req.auth?.user?.id;
  if (id === undefined) throw new MobileError('NO_USER', 'mobile devices belong to a signed-in user');
  return id;
}

const isAdmin = (req: FastifyRequest) => req.auth?.isAdmin === true;
const callerId = (req: FastifyRequest) => req.auth?.user?.id ?? null;

const STATUS: Record<MobileError['code'], number> = { NO_USER: 400, NOT_FOUND: 404, FORBIDDEN: 403, RATE_LIMITED: 429, CONFLICT: 409 };

export function mobileRoutes(service: MobileService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof MobileError) return reply.code(STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled mobile error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get('/mobile/pairing', { config: user, schema: { response: { 200: MobilePairingInfo } } }, async () => ({
      serverUrl: service.serverUrl() ?? null,
      pushEnabled: service.enabled,
    }));

    app.get('/mobile/devices', { config: user, schema: { querystring: MobileDeviceListQuery, response: { 200: z.array(MobileDeviceResource), ...errors } } }, async (req) => {
      if (req.query.all) {
        if (!isAdmin(req)) throw new MobileError('FORBIDDEN', 'only admins can list every device');
        return service.listAll();
      }
      return service.list(userIdOf(req));
    });

    app.post('/mobile/devices', { config: user, schema: { body: MobileDeviceInput, response: { 201: MobileDeviceResource, ...errors } } }, async (req, reply) =>
      reply.code(201).send(service.register(userIdOf(req), req.body, { isAdmin: isAdmin(req) })),
    );

    app.delete('/mobile/devices/:id', { config: user, schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      service.remove(callerId(req), isAdmin(req), req.params.id);
      return reply.code(204).send(null);
    });

    app.post('/mobile/devices/:id/test', { config: user, schema: { params: IdParams, response: { 200: MobileTestResult, ...errors } } }, async (req) =>
      service.test(callerId(req), isAdmin(req), req.params.id),
    );
  };
}
