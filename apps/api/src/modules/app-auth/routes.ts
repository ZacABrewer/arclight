import { AppDevice, AppDeviceListQuery, AppPairCode, AppPairRequest, AppSignInRequest, AppSignInResponse } from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AUTH_ERROR_STATUS, AuthError } from '../auth/service.js';
import { AppAuthError, APP_AUTH_ERROR_STATUS, type AppAuthService } from './service.js';

// /api/v1/app/*: the Arclight player app's sign-in, QR pairing and devices.
//   POST /app/sign-in, POST /app/pair  public (rate-limited per address with the web sign-in)
//   POST /app/pair-codes               signed-in browser session only (hook.ts SESSION_ONLY_PREFIXES)
//   GET /app/devices, DELETE /app/devices/:id, POST /app/sign-out   any signed-in user (own devices;
//   admins list with ?all=true or ?userId= and remove anyone's)
// Sign-in bodies carry passwords and codes: these routes keep out of the request audit (the
// service records login.success / login.failed itself).

const portal = { access: { portal: true } } as const;
const ErrorBody = z.object({ error: z.string(), code: z.string() });
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 410: ErrorBody, 429: ErrorBody };
const IdParams = z.object({ id: z.coerce.number().int().positive() });

function userOf(req: FastifyRequest) {
  const user = req.auth?.user;
  if (!user) throw new AppAuthError('NO_USER', 'app devices belong to a signed-in user');
  return user;
}

export function appAuthRoutes(service: AppAuthService, opts: { basePath: string }): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof AppAuthError) return reply.code(APP_AUTH_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof AuthError) return reply.code(AUTH_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message, code: 'BAD_REQUEST' });
      req.log.error({ err }, 'unhandled app-auth error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.post('/app/sign-in', { config: { audit: false }, schema: { body: AppSignInRequest, response: { 200: AppSignInResponse, ...errors } } }, async (req) =>
      service.signIn(req.body, req.ip),
    );

    app.post('/app/pair', { config: { audit: false }, schema: { body: AppPairRequest, response: { 200: AppSignInResponse, ...errors } } }, async (req) =>
      service.pair(req.body, req.ip),
    );

    app.post('/app/pair-codes', { config: { ...portal, audit: false }, schema: { response: { 201: AppPairCode, ...errors } } }, async (req, reply) =>
      reply.code(201).send(service.createPairCode(userOf(req), `${req.protocol}://${req.host}${opts.basePath}`)),
    );

    app.get('/app/devices', { config: portal, schema: { querystring: AppDeviceListQuery, response: { 200: z.array(AppDevice), ...errors } } }, async (req) => {
      const current = req.auth?.appDeviceId;
      if (req.query.all || req.query.userId !== undefined) {
        if (!req.auth?.isAdmin) throw new AppAuthError('FORBIDDEN', "only admins can list other users' devices");
        return service.listAll(current, req.query.userId);
      }
      return service.list(userOf(req).id, current);
    });

    app.delete('/app/devices/:id', { config: portal, schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      service.remove(req.auth?.user?.id ?? null, req.auth?.isAdmin === true, req.params.id);
      return reply.code(204).send(null);
    });

    app.post('/app/sign-out', { config: portal, schema: { response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      const user = userOf(req);
      if (req.auth?.via !== 'app' || req.auth.appDeviceId === undefined) throw new AppAuthError('NOT_APP', 'sign-out here is for the Arclight app; sign out of the web with POST /auth/logout');
      service.signOut(user.id, req.auth.appDeviceId);
      return reply.code(204).send(null);
    });
  };
}
