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
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppContext } from '../../app.js';
import { AuthError, authServiceFor, requireSelfOrAdmin, setSessionCookie } from '../auth/index.js';
import { isHttps, readCookie } from '../auth/cookies.js';
import type { MediaServerAccounts } from './accounts.js';
import { REQUESTS_ERROR_STATUS, RequestsError } from './errors.js';
import { canManageRequests } from './permissions.js';
import { PLEX_PIN_COOKIE, PLEX_PIN_TTL_MS, PlexPinGuard, PlexPinRateLimited, plexPinCookie } from './plex-pins.js';
import { actorOf } from './routes.js';
import type { RequestsService } from './service.js';

// Media-server routes: Settings > Media server, per-user account links, importing server
// users, the Plex PIN sign-in, and the on-demand admin digest. Plex PINs are bound to the
// browser and account that created them (plex-pins.ts).

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const PlexLinkPoll = z.object({ id: z.number().int().positive() });
const Empty = z.null();
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 429: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse };
/** The signed-in user's own media-server link (the services refuse other users unless MANAGE_USERS). */
const user = { access: { portal: true } } as const;

export function mediaServerRoutes(ctx: AppContext, accounts: MediaServerAccounts, requests: RequestsService): Plugin {
  return async (app) => {
    const pins = new PlexPinGuard();

    /** Creates a plex.tv PIN bound to this browser (and to `userId` when linking). */
    const createPin = async (req: FastifyRequest, reply: FastifyReply, userId: number | null) => {
      pins.throttleCreate(req.ip);
      const pin = await accounts.plexPin();
      reply.header('set-cookie', plexPinCookie(pins.bind(pin.id, userId), PLEX_PIN_TTL_MS / 1000, isHttps(req)));
      return pin;
    };
    /**
     * Polls a bound PIN: 403 unless this browser (and user) created it; null while plex.tv waits
     * or another poll of the same PIN is in flight. A PIN finishes once, then its cookie is cleared.
     */
    const pollPin = async <T>(req: FastifyRequest, reply: FastifyReply, pinId: number, userId: number | null, run: () => Promise<T | null>): Promise<T | null> => {
      pins.throttlePoll(req.ip, pinId);
      const check = pins.claim(pinId, readCookie(req.headers.cookie, PLEX_PIN_COOKIE), userId);
      if (check === 'forbidden') throw new RequestsError('FORBIDDEN', 'this Plex sign-in was started in another browser or has expired; start again');
      if (check === 'busy') return null;
      let out: T | null;
      try {
        out = await run();
      } catch (err) {
        pins.release(pinId);
        throw err;
      }
      if (out === null) {
        pins.release(pinId);
        return null;
      }
      pins.finish(pinId);
      reply.header('set-cookie', plexPinCookie('', 0, isHttps(req)));
      return out;
    };

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof PlexPinRateLimited) return reply.code(429).header('retry-after', String(err.retryAfter)).send({ error: err.message, code: 'RATE_LIMITED' });
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
      async (req, reply) => {
        const actor = actorOf(req);
        const body = req.body;
        if (!('pinId' in body)) return accounts.link(actor, req.params.id, body);
        // A PIN links only for the caller who created it (here or at /user/me/mediaserver/plex/pin).
        const out = await pollPin(req, reply, body.pinId, actor.userId, async () => accounts.link(actor, req.params.id, body));
        if (out === null) throw new RequestsError('VALIDATION', 'the Plex PIN has not been authorised yet');
        return out;
      },
    );
    app.delete(
      '/user/:id/mediaserver/link',
      { config: user, preHandler: requireSelfOrAdmin, schema: { params: IdParams, response: { 200: UserRequestSettings, ...errors } } },
      async (req) => accounts.unlink(actorOf(req), req.params.id),
    );

    // ------------------------------------------------------------------------- Plex PIN link for the signed-in user
    app.post('/user/me/mediaserver/plex/pin', { config: user, schema: { body: Empty.optional(), response: { 200: PlexPin, ...errors } } }, async (req, reply) => {
      const actor = actorOf(req);
      if (actor.userId === null) throw new RequestsError('VALIDATION', 'this request is not signed in as a user');
      return createPin(req, reply, actor.userId);
    });
    app.post(
      '/user/me/mediaserver/plex/poll',
      { config: user, schema: { body: PlexLinkPoll, response: { 200: UserRequestSettings, 202: PlexPollPending, ...errors } } },
      async (req, reply) => {
        const actor = actorOf(req);
        const settings = await pollPin(req, reply, req.body.id, actor.userId, () => accounts.plexLinkPoll(actor, req.body.id));
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
    app.post('/auth/plex/pin', { schema: { response: { 200: PlexPin, ...errors } } }, async (req, reply) => createPin(req, reply, null));
    app.post(
      '/auth/plex/poll',
      { schema: { body: PlexPollRequest, response: { 200: Session, 202: PlexPollPending, ...errors } } },
      async (req, reply) => {
        const userId = await pollPin(req, reply, req.body.id, null, () => accounts.plexSignIn(req.body.id));
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
