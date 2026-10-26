import { z } from 'zod';
import {
  ErrorResponse,
  MediaServerImportRequest,
  MediaServerImportResult,
  MediaServerLinkRequest,
  MediaServerSettings,
  MediaServerTestResult,
  MediaServerUser,
  PlexPin,
  PlexPollPending,
  PlexPollRequest,
  RequestsDigestResult,
  Session,
  UserRequestSettings,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppContext } from '../../app.js';
import { AuthError, authServiceFor, requireSelfOrAdmin, setSessionCookie } from '../auth/index.js';
import type { MediaServerAccounts } from './accounts.js';
import { REQUESTS_ERROR_STATUS, RequestsError } from './errors.js';
import { canManageRequests } from './permissions.js';
import { actorOf } from './routes.js';
import type { RequestsService } from './service.js';

// Media-server routes: Settings > Media server, per-user account links, importing server
// users, the Plex PIN sign-in, and the on-demand admin digest.

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const PlexLinkPoll = z.object({ id: z.number().int().positive() });
const Empty = z.null();
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse };
/** The signed-in user's own media-server link (the services refuse other users unless MANAGE_USERS). */
const user = { access: { portal: true } } as const;

export function mediaServerRoutes(ctx: AppContext, accounts: MediaServerAccounts, requests: RequestsService): Plugin {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof RequestsError) return reply.code(REQUESTS_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof AuthError) return reply.code(err.code === 'FORBIDDEN' ? 403 : 400).send({ error: err.message, code: err.code });
      if (err instanceof z.ZodError) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled media server error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // ------------------------------------------------------------------------- settings
    app.get('/settings/mediaserver', { schema: { response: { 200: MediaServerSettings, ...errors } } }, async (req) =>
      accounts.settings(actorOf(req)),
    );
    app.put('/settings/mediaserver', { schema: { body: MediaServerSettings, response: { 200: MediaServerSettings, ...errors } } }, async (req) =>
      accounts.updateSettings(actorOf(req), req.body),
    );
    app.post(
      '/settings/mediaserver/test',
      { schema: { body: MediaServerSettings.optional().nullable(), response: { 200: MediaServerTestResult, ...errors } } },
      async (req) => accounts.test(actorOf(req), req.body ?? undefined),
    );

    // ------------------------------------------------------------------------- links
    app.post(
      '/user/:id/mediaserver/link',
      { config: user, preHandler: requireSelfOrAdmin, schema: { params: IdParams, body: MediaServerLinkRequest, response: { 200: UserRequestSettings, ...errors } } },
      async (req) => accounts.link(actorOf(req), req.params.id, req.body),
    );
    app.delete(
      '/user/:id/mediaserver/link',
      { config: user, preHandler: requireSelfOrAdmin, schema: { params: IdParams, response: { 200: UserRequestSettings, ...errors } } },
      async (req) => accounts.unlink(actorOf(req), req.params.id),
    );

    // ------------------------------------------------------------------------- Plex PIN link for the signed-in user
    app.post('/user/me/mediaserver/plex/pin', { config: user, schema: { body: Empty.optional(), response: { 200: PlexPin, ...errors } } }, async (req) => {
      const actor = actorOf(req);
      if (actor.userId === null) throw new RequestsError('VALIDATION', 'this request is not signed in as a user');
      return accounts.plexPin();
    });
    app.post(
      '/user/me/mediaserver/plex/poll',
      { config: user, schema: { body: PlexLinkPoll, response: { 200: UserRequestSettings, 202: PlexPollPending, ...errors } } },
      async (req, reply) => {
        const settings = await accounts.plexLinkPoll(actorOf(req), req.body.id);
        if (settings === null) return reply.code(202).send({ pending: true as const });
        return settings;
      },
    );

    // ------------------------------------------------------------------------- import
    app.get('/user/import/mediaserver', { schema: { response: { 200: z.array(MediaServerUser), ...errors } } }, async (req) =>
      accounts.listServerUsers(actorOf(req)),
    );
    app.post(
      '/user/import/mediaserver',
      { schema: { body: MediaServerImportRequest.optional().nullable(), response: { 200: MediaServerImportResult, ...errors } } },
      async (req) => accounts.importUsers(actorOf(req), req.body ?? {}),
    );

    // ------------------------------------------------------------------------- Plex PIN sign-in (public)
    app.post('/auth/plex/pin', { schema: { response: { 200: PlexPin, ...errors } } }, async () => accounts.plexPin());
    app.post(
      '/auth/plex/poll',
      { schema: { body: PlexPollRequest, response: { 200: Session, 202: PlexPollPending, ...errors } } },
      async (req, reply) => {
        const userId = await accounts.plexSignIn(req.body.id);
        if (userId === null) return reply.code(202).send({ pending: true as const });
        const auth = authServiceFor(ctx);
        const result = auth.loginExternal(userId, { ip: req.ip, userAgent: req.headers['user-agent'], rememberMe: req.body.rememberMe });
        setSessionCookie(req, reply, result.token, result.maxAgeSeconds);
        return { user: result.user, via: 'session' as const, isAdmin: result.user.role === 'admin', expiresAt: result.expiresAt };
      },
    );

    // ------------------------------------------------------------------------- digest
    app.post('/request/digest', { schema: { body: Empty.optional(), response: { 200: RequestsDigestResult, ...errors } } }, async (req) => {
      if (!canManageRequests(actorOf(req).permissions)) throw RequestsError.forbidden();
      return requests.digest();
    });
  };
}
