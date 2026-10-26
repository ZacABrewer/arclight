import { z } from 'zod';
import {
  ApproveRequest,
  BulkRequestAction,
  BulkRequestResult,
  CreateIssue,
  CreateRequest,
  DeclineRequest,
  DiscoverGenre,
  DiscoverKindQuery,
  DiscoverPage,
  DiscoverQuery,
  DiscoverSearchQuery,
  DiscoverSlider,
  DiscoverSliderInput,
  DiscoverSliderOrder,
  DiscoverSliderUpdate,
  ErrorResponse,
  Issue,
  IssueCommentInput,
  IssueCount,
  IssueListQuery,
  IssuePage,
  IssueStatusUpdate,
  MediaRequest,
  OverrideRule,
  OverrideRuleInput,
  Permission,
  PersonDetail,
  RequestAccepted,
  RequestCount,
  RequestListQuery,
  RequestPage,
  RequestsSettings,
  TitleDetail,
  TrendingQuery,
  UpdateRequest,
  UserNotificationTestResult,
  UserPermissions,
  UserQuota,
  UserQuotaResponse,
  UserRequestSettings,
  WatchlistCreate,
  WatchlistItem,
  WatchlistQuery,
  WatchlistSyncResult,
} from '@media-tron/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { DiscoverService } from './discover.js';
import { REQUESTS_ERROR_STATUS, RequestsError } from './errors.js';
import type { IssuesService } from './issues.js';
import { SYSTEM_ACTOR, canManageUsers, type Actor } from './permissions.js';
import type { RequestsService } from './service.js';
import type { WatchlistService } from './watchlist.js';

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const TmdbParams = z.object({ tmdbId: z.coerce.number().int().positive() });
const PageQuery = z.object({ page: z.coerce.number().int().min(1).max(500).default(1) });
const GenresQuery = z.object({ mediaType: z.enum(['movie', 'tv']).default('movie') });
const Empty = z.null();
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse };
/** Users with role `user` may call every route; the services check the permission bits. */
const user = { allowUser: true } as const;

export interface RequestsRouteServices {
  requests: RequestsService;
  issues: IssuesService;
  discover: DiscoverService;
  watchlist: WatchlistService;
  /** Runs the WatchlistSync job now. */
  runWatchlistSync: () => Promise<WatchlistSyncResult>;
}

/** Who is calling, in permission terms. API-key and bypass callers act as admin. */
export function actorOf(req: FastifyRequest): Actor {
  const auth = req.auth;
  if (!auth) throw new RequestsError('FORBIDDEN', 'authentication required');
  if (!auth.user) return SYSTEM_ACTOR;
  const bits = auth.isAdmin ? auth.user.permissions | Permission.ADMIN : auth.user.permissions & ~Permission.ADMIN;
  return { userId: auth.user.id, permissions: bits };
}

export function requestsRoutes(s: RequestsRouteServices): Plugin {
  const { requests, issues, discover, watchlist } = s;
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof RequestsError) return reply.code(REQUESTS_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof z.ZodError) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled requests error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // ------------------------------------------------------------------------- requests
    app.get('/request', { config: user, schema: { querystring: RequestListQuery, response: { 200: RequestPage, ...errors } } }, async (req) =>
      requests.list(actorOf(req), req.query),
    );
    app.get('/request/count', { config: user, schema: { response: { 200: RequestCount, ...errors } } }, async (req) => requests.count(actorOf(req)));
    app.get('/request/:id', { config: user, schema: { params: IdParams, response: { 200: MediaRequest, ...errors } } }, async (req) =>
      requests.get(actorOf(req), req.params.id),
    );
    app.post(
      '/request',
      { config: user, schema: { body: CreateRequest, response: { 201: MediaRequest, 202: RequestAccepted, ...errors } } },
      async (req, reply) => {
        const outcome = await requests.create(actorOf(req), req.body);
        if (outcome.kind === 'accepted') return reply.code(202).send({ message: outcome.message });
        return reply.code(201).send(outcome.request);
      },
    );
    app.post('/request/bulk/approve', { config: user, schema: { body: BulkRequestAction, response: { 200: BulkRequestResult, ...errors } } }, async (req) =>
      requests.bulk(actorOf(req), req.body.ids, 'approve'),
    );
    app.post('/request/bulk/decline', { config: user, schema: { body: BulkRequestAction, response: { 200: BulkRequestResult, ...errors } } }, async (req) =>
      requests.bulk(actorOf(req), req.body.ids, 'decline'),
    );
    app.put('/request/:id', { config: user, schema: { params: IdParams, body: UpdateRequest, response: { 200: MediaRequest, ...errors } } }, async (req) =>
      requests.update(actorOf(req), req.params.id, req.body),
    );
    app.delete('/request/:id', { config: user, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      requests.remove(actorOf(req), req.params.id);
      return reply.code(204).send(null);
    });
    app.post(
      '/request/:id/approve',
      { config: user, schema: { params: IdParams, body: ApproveRequest.nullish(), response: { 200: MediaRequest, ...errors } } },
      async (req) => requests.approve(actorOf(req), req.params.id, req.body ?? {}),
    );
    app.post(
      '/request/:id/decline',
      { config: user, schema: { params: IdParams, body: DeclineRequest.nullish(), response: { 200: MediaRequest, ...errors } } },
      async (req) => requests.decline(actorOf(req), req.params.id, req.body?.reason),
    );
    app.post('/request/:id/retry', { config: user, schema: { params: IdParams, response: { 200: MediaRequest, ...errors } } }, async (req) =>
      requests.retry(actorOf(req), req.params.id),
    );

    // ------------------------------------------------------------------------- discover
    app.get('/discover/movies', { config: user, schema: { querystring: DiscoverQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      discover.movies(req.query),
    );
    app.get('/discover/tv', { config: user, schema: { querystring: DiscoverQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      discover.tv(req.query),
    );
    app.get('/discover/trending', { config: user, schema: { querystring: TrendingQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      discover.trending(req.query),
    );
    app.get('/discover/upcoming', { config: user, schema: { querystring: DiscoverKindQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      discover.upcoming(req.query),
    );
    app.get('/discover/search', { config: user, schema: { querystring: DiscoverSearchQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      discover.search(req.query),
    );
    app.get('/discover/genres', { config: user, schema: { querystring: GenresQuery, response: { 200: z.array(DiscoverGenre), ...errors } } }, async (req) =>
      discover.genres(req.query.mediaType),
    );
    app.get(
      '/discover/genre/:id',
      { config: user, schema: { params: IdParams, querystring: DiscoverKindQuery, response: { 200: DiscoverPage, ...errors } } },
      async (req) => discover.genre(req.params.id, req.query),
    );
    app.get(
      '/discover/keyword/:id',
      { config: user, schema: { params: IdParams, querystring: DiscoverKindQuery, response: { 200: DiscoverPage, ...errors } } },
      async (req) => discover.keyword(req.params.id, req.query),
    );
    app.get('/discover/network/:id', { config: user, schema: { params: IdParams, querystring: PageQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      discover.network(req.params.id, req.query.page),
    );
    app.get('/discover/studio/:id', { config: user, schema: { params: IdParams, querystring: PageQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      discover.studio(req.params.id, req.query.page),
    );
    app.get('/discover/person/:id', { config: user, schema: { params: IdParams, response: { 200: PersonDetail, ...errors } } }, async (req) =>
      discover.person(req.params.id),
    );
    app.get('/discover/movie/:tmdbId', { config: user, schema: { params: TmdbParams, response: { 200: TitleDetail, ...errors } } }, async (req) =>
      discover.title(actorOf(req), 'movie', req.params.tmdbId),
    );
    app.get('/discover/tv/:tmdbId', { config: user, schema: { params: TmdbParams, response: { 200: TitleDetail, ...errors } } }, async (req) =>
      discover.title(actorOf(req), 'series', req.params.tmdbId),
    );
    app.get('/discover/slider/:id', { config: user, schema: { params: IdParams, querystring: PageQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      discover.sliderItems(actorOf(req), req.params.id, req.query.page),
    );

    // ------------------------------------------------------------------------- sliders
    app.get('/discoverslider', { config: user, schema: { response: { 200: z.array(DiscoverSlider), ...errors } } }, async (req) => discover.sliders(actorOf(req)));
    app.post('/discoverslider', { config: user, schema: { body: DiscoverSliderInput, response: { 201: DiscoverSlider, ...errors } } }, async (req, reply) =>
      reply.code(201).send(discover.createSlider(actorOf(req), req.body)),
    );
    app.put('/discoverslider/order', { config: user, schema: { body: DiscoverSliderOrder, response: { 200: z.array(DiscoverSlider), ...errors } } }, async (req) =>
      discover.orderSliders(actorOf(req), req.body),
    );
    app.post('/discoverslider/reset', { config: user, schema: { response: { 200: z.array(DiscoverSlider), ...errors } } }, async (req) =>
      discover.resetSliders(actorOf(req)),
    );
    app.put(
      '/discoverslider/:id',
      { config: user, schema: { params: IdParams, body: DiscoverSliderUpdate, response: { 200: DiscoverSlider, ...errors } } },
      async (req) => discover.updateSlider(actorOf(req), req.params.id, req.body),
    );
    app.delete('/discoverslider/:id', { config: user, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      discover.deleteSlider(actorOf(req), req.params.id);
      return reply.code(204).send(null);
    });

    // ------------------------------------------------------------------------- issues
    app.get('/issue', { config: user, schema: { querystring: IssueListQuery, response: { 200: IssuePage, ...errors } } }, async (req) =>
      issues.list(actorOf(req), req.query),
    );
    app.get('/issue/count', { config: user, schema: { response: { 200: IssueCount, ...errors } } }, async (req) => issues.count(actorOf(req)));
    app.get('/issue/:id', { config: user, schema: { params: IdParams, response: { 200: Issue, ...errors } } }, async (req) => issues.get(actorOf(req), req.params.id));
    app.post('/issue', { config: user, schema: { body: CreateIssue, response: { 201: Issue, ...errors } } }, async (req, reply) =>
      reply.code(201).send(await issues.create(actorOf(req), req.body)),
    );
    app.post(
      '/issue/:id/comment',
      { config: user, schema: { params: IdParams, body: IssueCommentInput, response: { 201: Issue, ...errors } } },
      async (req, reply) => reply.code(201).send(await issues.comment(actorOf(req), req.params.id, req.body.message)),
    );
    app.post(
      '/issue/:id/status',
      { config: user, schema: { params: IdParams, body: IssueStatusUpdate, response: { 200: Issue, ...errors } } },
      async (req) => issues.setStatus(actorOf(req), req.params.id, req.body.status),
    );
    app.delete('/issue/:id', { config: user, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      issues.remove(actorOf(req), req.params.id);
      return reply.code(204).send(null);
    });
    app.put(
      '/issuecomment/:id',
      { config: user, schema: { params: IdParams, body: IssueCommentInput, response: { 200: Issue, ...errors } } },
      async (req) => issues.editComment(actorOf(req), req.params.id, req.body.message),
    );
    app.delete('/issuecomment/:id', { config: user, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      issues.deleteComment(actorOf(req), req.params.id);
      return reply.code(204).send(null);
    });

    // ------------------------------------------------------------------------- override rules
    app.get('/overriderule', { config: user, schema: { response: { 200: z.array(OverrideRule), ...errors } } }, async (req) => requests.listRules(actorOf(req)));
    app.post('/overriderule', { config: user, schema: { body: OverrideRuleInput, response: { 201: OverrideRule, ...errors } } }, async (req, reply) =>
      reply.code(201).send(requests.createRule(actorOf(req), req.body)),
    );
    app.put(
      '/overriderule/:id',
      { config: user, schema: { params: IdParams, body: OverrideRuleInput, response: { 200: OverrideRule, ...errors } } },
      async (req) => requests.updateRule(actorOf(req), req.params.id, req.body),
    );
    app.delete('/overriderule/:id', { config: user, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      requests.deleteRule(actorOf(req), req.params.id);
      return reply.code(204).send(null);
    });

    // ------------------------------------------------------------------------- watchlist
    app.get('/watchlist', { config: user, schema: { querystring: WatchlistQuery, response: { 200: z.array(WatchlistItem), ...errors } } }, async (req) =>
      watchlist.list(actorOf(req), req.query.userId),
    );
    app.post('/watchlist', { config: user, schema: { body: WatchlistCreate, response: { 201: WatchlistItem, ...errors } } }, async (req, reply) =>
      reply.code(201).send(await watchlist.add(actorOf(req), req.body)),
    );
    app.post('/watchlist/sync', { config: user, schema: { response: { 200: WatchlistSyncResult, ...errors } } }, async (req) => {
      if (!canManageUsers(actorOf(req).permissions)) throw RequestsError.forbidden();
      return s.runWatchlistSync();
    });
    app.delete('/watchlist/:id', { config: user, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      watchlist.remove(actorOf(req), req.params.id);
      return reply.code(204).send(null);
    });

    // ------------------------------------------------------------------------- users
    app.get('/user/:id/permissions', { config: user, schema: { params: IdParams, response: { 200: UserPermissions, ...errors } } }, async (req) =>
      requests.permissions(actorOf(req), req.params.id),
    );
    app.put(
      '/user/:id/permissions',
      { config: user, schema: { params: IdParams, body: UserPermissions, response: { 200: UserPermissions, ...errors } } },
      async (req) => requests.setPermissions(actorOf(req), req.params.id, req.body.permissions),
    );
    app.get('/user/:id/quota', { config: user, schema: { params: IdParams, response: { 200: UserQuotaResponse, ...errors } } }, async (req) =>
      requests.quota(actorOf(req), req.params.id),
    );
    app.put('/user/:id/quota', { config: user, schema: { params: IdParams, body: UserQuota, response: { 200: UserQuotaResponse, ...errors } } }, async (req) =>
      requests.setQuota(actorOf(req), req.params.id, req.body),
    );
    app.get('/user/:id/requestsettings', { config: user, schema: { params: IdParams, response: { 200: UserRequestSettings, ...errors } } }, async (req) =>
      requests.requestSettings(actorOf(req), req.params.id),
    );
    app.put(
      '/user/:id/requestsettings',
      { config: user, schema: { params: IdParams, body: UserRequestSettings, response: { 200: UserRequestSettings, ...errors } } },
      async (req) => requests.setRequestSettings(actorOf(req), req.params.id, req.body),
    );
    app.post(
      '/user/:id/requestsettings/test',
      { config: user, schema: { params: IdParams, response: { 200: UserNotificationTestResult, ...errors } } },
      async (req) => requests.testNotifications(actorOf(req), req.params.id),
    );

    // ------------------------------------------------------------------------- settings
    app.get('/settings/requests', { config: user, schema: { response: { 200: RequestsSettings, ...errors } } }, async () => requests.settings());
    app.put('/settings/requests', { config: user, schema: { body: RequestsSettings, response: { 200: RequestsSettings, ...errors } } }, async (req) =>
      requests.updateSettings(actorOf(req), req.body),
    );
  };
}
