import { z } from 'zod';
import {
  AudioAlbumDetail,
  AudioArtistDetail,
  AudioAuthorDetail,
  AudioBookDetail,
  AudioDetailQuery,
  AudioDiscoverHome,
  AudioDiscoverSearchQuery,
  AudioDiscoverSearchResult,
  AudioRequest,
  AudioRequestCount,
  AudioRequestDefaults,
  AudioRequestListQuery,
  AudioRequestPage,
  CreateAudioRequest,
  DeclineRequest,
  ErrorResponse,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AudioDiscoverService } from './audio-discover.js';
import type { AudioRequestsService } from './audio-requests.js';
import { AudioDisabledError, REQUESTS_ERROR_STATUS, RequestsError } from './errors.js';
import type { TokenBuckets } from './portal.js';
import { actorOf, portalRateLimit } from './routes.js';
import type { RequestsService } from './service.js';

// Music and audiobook requests and their Discover catalogue (docs/API.md "Music and audiobook
// requests"). Same conventions as routes.ts: discover routes are public while the portal allows
// anonymous discover (anonymous callers rate-limited), request routes are open to every signed-in
// user and the service checks the permission bits. MUSIC_DISABLED / AUDIOBOOKS_DISABLED are 404.

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const MbidParams = z.object({ mbid: z.string().trim().min(1).max(64) });
const AsinParams = z.object({ asin: z.string().trim().min(1).max(32) });
const Empty = z.null();
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 429: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse };
const user = { access: { portal: true } } as const;

export interface AudioRequestsRouteServices {
  requests: RequestsService;
  audio: AudioRequestsService;
  audioDiscover: AudioDiscoverService;
  portalLimiter?: TokenBuckets;
}

export function audioRequestsRoutes(s: AudioRequestsRouteServices): Plugin {
  const { audio, audioDiscover: discover } = s;
  const anonymousDiscover = () => {
    const p = s.requests.settings().publicPortal;
    return p.enabled && p.allowAnonymousDiscover;
  };
  const d = { config: { access: { portal: true }, publicWhen: anonymousDiscover }, preHandler: portalRateLimit(s.portalLimiter) } as const;
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof AudioDisabledError) return reply.code(404).send({ error: err.message, code: err.code });
      if (err instanceof RequestsError) return reply.code(REQUESTS_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof z.ZodError) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled audio requests error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // ------------------------------------------------------------------------- discover: music
    app.get('/discover/music', { ...d, schema: { response: { 200: AudioDiscoverHome, ...errors } } }, async () => discover.musicHome());
    app.get(
      '/discover/music/search',
      { ...d, schema: { querystring: AudioDiscoverSearchQuery, response: { 200: AudioDiscoverSearchResult, ...errors } } },
      async (req) => discover.musicSearch(req.query.query),
    );
    app.get('/discover/music/album/:mbid', { ...d, schema: { params: MbidParams, response: { 200: AudioAlbumDetail, ...errors } } }, async (req) =>
      discover.album(req.params.mbid),
    );
    app.get('/discover/music/artist/:mbid', { ...d, schema: { params: MbidParams, response: { 200: AudioArtistDetail, ...errors } } }, async (req) =>
      discover.artist(req.params.mbid),
    );

    // ------------------------------------------------------------------------- discover: audiobooks
    app.get('/discover/audiobooks', { ...d, schema: { querystring: AudioDetailQuery, response: { 200: AudioDiscoverHome, ...errors } } }, async (req) =>
      discover.audiobookHome(req.query.region),
    );
    app.get(
      '/discover/audiobooks/search',
      { ...d, schema: { querystring: AudioDiscoverSearchQuery, response: { 200: AudioDiscoverSearchResult, ...errors } } },
      async (req) => discover.audiobookSearch(req.query.query, req.query.region),
    );
    app.get(
      '/discover/audiobooks/book/:asin',
      { ...d, schema: { params: AsinParams, querystring: AudioDetailQuery, response: { 200: AudioBookDetail, ...errors } } },
      async (req) => discover.book(req.params.asin, req.query.region),
    );
    app.get(
      '/discover/audiobooks/author/:asin',
      { ...d, schema: { params: AsinParams, querystring: AudioDetailQuery, response: { 200: AudioAuthorDetail, ...errors } } },
      async (req) => discover.author(req.params.asin, req.query.region),
    );

    // ------------------------------------------------------------------------- requests
    app.get('/audiorequest', { config: user, schema: { querystring: AudioRequestListQuery, response: { 200: AudioRequestPage, ...errors } } }, async (req) =>
      audio.list(actorOf(req), req.query),
    );
    app.get('/audiorequest/count', { config: user, schema: { response: { 200: AudioRequestCount, ...errors } } }, async (req) => audio.count(actorOf(req)));
    app.get('/audiorequest/:id', { config: user, schema: { params: IdParams, response: { 200: AudioRequest, ...errors } } }, async (req) =>
      audio.get(actorOf(req), req.params.id),
    );
    app.post('/audiorequest', { config: user, schema: { body: CreateAudioRequest, response: { 201: AudioRequest, ...errors } } }, async (req, reply) =>
      reply.code(201).send(await audio.create(actorOf(req), req.body)),
    );
    app.post('/audiorequest/:id/approve', { config: user, schema: { params: IdParams, response: { 200: AudioRequest, ...errors } } }, async (req) =>
      audio.approve(actorOf(req), req.params.id),
    );
    app.post(
      '/audiorequest/:id/decline',
      { config: user, schema: { params: IdParams, body: DeclineRequest.nullish(), response: { 200: AudioRequest, ...errors } } },
      async (req) => audio.decline(actorOf(req), req.params.id, req.body?.reason),
    );
    app.post('/audiorequest/:id/retry', { config: user, schema: { params: IdParams, response: { 200: AudioRequest, ...errors } } }, async (req) =>
      audio.retry(actorOf(req), req.params.id),
    );
    app.delete('/audiorequest/:id', { config: user, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      audio.remove(actorOf(req), req.params.id);
      return reply.code(204).send(null);
    });

    // ------------------------------------------------------------------------- settings
    app.get('/settings/audiorequests', { config: user, schema: { response: { 200: AudioRequestDefaults, ...errors } } }, async (req) => audio.defaults(actorOf(req)));
    app.put(
      '/settings/audiorequests',
      { config: user, schema: { body: AudioRequestDefaults, response: { 200: AudioRequestDefaults, ...errors } } },
      async (req) => audio.setDefaults(actorOf(req), req.body),
    );
  };
}
