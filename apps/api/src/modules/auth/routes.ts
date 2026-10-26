import { z } from 'zod';
import {
  ApiKeyResponse,
  AuthErrorResponse,
  AuthSettings,
  AuthStatus,
  LoginRequest,
  PasswordChange,
  RootFolder,
  SecuritySettingsResponse,
  Session,
  SessionRecord,
  SetupAdminRequest,
  SetupRequest,
  SetupRootFolderRequest,
  SetupStatus,
  User,
  UserCreate,
  UserSelfUpdate,
  UserUpdate,
} from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { clearSessionCookie, readCookie, SESSION_COOKIE, setSessionCookie } from './cookies.js';
import { requireAdmin } from './hook.js';
import { AUTH_ERROR_STATUS, AuthError, type AuthService, type RequestAuth } from './service.js';
import type { SetupService } from './setup.js';

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const Empty = z.null();
const errors = {
  400: AuthErrorResponse,
  401: AuthErrorResponse,
  403: AuthErrorResponse,
  404: AuthErrorResponse,
  409: AuthErrorResponse,
  429: AuthErrorResponse,
};

function sessionOf(auth: RequestAuth): Session {
  return {
    user: auth.user,
    via: auth.via,
    isAdmin: auth.isAdmin,
    ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}),
  };
}

/** The signed-in user of a request; API-key and bypass callers have none. */
function selfOf(req: FastifyRequest): { id: number; sessionId?: number } {
  const user = req.auth?.user;
  if (!user) throw new AuthError('VALIDATION', 'this request is not signed in as a user');
  return { id: user.id, ...(req.auth?.sessionId !== undefined ? { sessionId: req.auth.sessionId } : {}) };
}

function meta(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

export function authRoutes(auth: AuthService, setup: SetupService): Plugin {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof AuthError) return reply.code(AUTH_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled auth error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // ----------------------------------------------------------------------------- auth
    app.post('/auth/login', { schema: { body: LoginRequest, response: { 200: Session, ...errors } } }, async (req, reply) => {
      const result = await auth.login(req.body.username, req.body.password, { ...meta(req), rememberMe: req.body.rememberMe });
      setSessionCookie(req, reply, result.token, result.maxAgeSeconds);
      return { user: result.user, via: 'session' as const, isAdmin: result.user.role === 'admin', expiresAt: result.expiresAt };
    });

    app.post('/auth/logout', { schema: { response: { 204: Empty } } }, async (req, reply) => {
      auth.logout(readCookie(req.headers.cookie, SESSION_COOKIE));
      clearSessionCookie(req, reply);
      return reply.code(204).send(null);
    });

    app.get('/auth/me', { schema: { response: { 200: Session, 401: AuthErrorResponse } } }, async (req) => sessionOf(req.auth!));

    app.get('/auth/status', { schema: { response: { 200: AuthStatus } } }, async (req) => ({
      needsSetup: auth.needsSetup(),
      authMethod: auth.authSettings().method,
      authenticated: req.auth !== null,
      session: req.auth ? sessionOf(req.auth) : null,
    }));

    app.get('/auth/sessions', { schema: { response: { 200: z.array(SessionRecord) } } }, async (req) =>
      req.auth?.user ? auth.listSessions(req.auth.user.id, req.auth.sessionId) : [],
    );

    app.delete(
      '/auth/sessions/:id',
      { config: { allowUser: true }, schema: { params: IdParams, response: { 204: Empty, ...errors } } },
      async (req, reply) => {
        auth.revokeSession(selfOf(req).id, req.params.id);
        return reply.code(204).send(null);
      },
    );

    // ----------------------------------------------------------------------------- self
    app.get('/user/me', { schema: { response: { 200: User, ...errors } } }, async (req) => auth.getUser(selfOf(req).id));

    app.put(
      '/user/me',
      { config: { allowUser: true }, schema: { body: UserSelfUpdate, response: { 200: User, ...errors } } },
      async (req) => auth.updateSelf(selfOf(req).id, req.body),
    );

    app.put(
      '/user/me/password',
      { config: { allowUser: true }, schema: { body: PasswordChange, response: { 204: Empty, ...errors } } },
      async (req, reply) => {
        const self = selfOf(req);
        await auth.changePassword(self.id, req.body.currentPassword, req.body.newPassword, self.sessionId);
        return reply.code(204).send(null);
      },
    );

    // ----------------------------------------------------------------------------- users (admin)
    app.get('/user', { preHandler: requireAdmin, schema: { response: { 200: z.array(User), ...errors } } }, async () =>
      auth.listUsers(),
    );

    app.get('/user/:id', { preHandler: requireAdmin, schema: { params: IdParams, response: { 200: User, ...errors } } }, async (req) =>
      auth.getUser(req.params.id),
    );

    app.post('/user', { preHandler: requireAdmin, schema: { body: UserCreate, response: { 201: User, ...errors } } }, async (req, reply) =>
      reply.code(201).send(await auth.createUser(req.body)),
    );

    app.put(
      '/user/:id',
      { preHandler: requireAdmin, schema: { params: IdParams, body: UserUpdate, response: { 200: User, ...errors } } },
      async (req) => auth.updateUser(req.params.id, req.body),
    );

    app.delete(
      '/user/:id',
      { preHandler: requireAdmin, schema: { params: IdParams, response: { 204: Empty, ...errors } } },
      async (req, reply) => {
        auth.deleteUser(req.params.id, req.auth?.user?.id ?? null);
        return reply.code(204).send(null);
      },
    );

    // ----------------------------------------------------------------------------- security settings (admin)
    const securityResponse = () => ({ ...auth.authSettings(), apiKey: auth.apiKey() });

    app.get(
      '/settings/security',
      { preHandler: requireAdmin, schema: { response: { 200: SecuritySettingsResponse, ...errors } } },
      async () => securityResponse(),
    );

    app.put(
      '/settings/security',
      { preHandler: requireAdmin, schema: { body: AuthSettings, response: { 200: SecuritySettingsResponse, ...errors } } },
      async (req) => {
        auth.updateAuthSettings(req.body);
        return securityResponse();
      },
    );

    app.post(
      '/settings/security/apikey',
      { preHandler: requireAdmin, schema: { response: { 200: ApiKeyResponse, ...errors } } },
      async () => ({ apiKey: auth.regenerateApiKey() }),
    );

    // ----------------------------------------------------------------------------- setup (public; self-guarded)
    app.get('/setup/status', { schema: { response: { 200: SetupStatus } } }, async () => setup.status());

    app.post('/setup/admin', { schema: { body: SetupAdminRequest, response: { 201: Session, ...errors } } }, async (req, reply) => {
      const user = await setup.createAdmin(req.body);
      const session = auth.createSession(user.id, meta(req));
      setSessionCookie(req, reply, session.token, session.maxAgeSeconds);
      return reply.code(201).send({ user, via: 'session' as const, isAdmin: true, expiresAt: session.expiresAt });
    });

    app.post(
      '/setup/rootfolder',
      { schema: { body: SetupRootFolderRequest, response: { 201: RootFolder, ...errors } } },
      async (req, reply) => {
        setup.assertCanWrite(req.auth);
        return reply.code(201).send(await setup.addRootFolder(req.body));
      },
    );

    app.post('/setup/complete', { schema: { body: SetupRequest, response: { 200: SetupStatus, ...errors } } }, async (req) =>
      setup.complete(req.body, req.auth),
    );
  };
}
