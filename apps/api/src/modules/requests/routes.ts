import { z } from 'zod';
import {
  ApproveRequest,
  BulkRequestAction,
  CollectionDetail,
  CollectionRequestInput,
  CollectionRequestResult,
  DiscoverEntity,
  DiscoverEntityKind,
  DiscoverFilterOptions,
  DiscoverListName,
  DiscoverListQuery,
  DiscoverTextQuery,
  DiscoverTile,
  DiscoverTileQuery,
  KeywordPage,
  PersonPage,
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
  PublicPortal,
  RequestAccepted,
  RequestPolicyExplanation,
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
} from '@arclight/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireSelfOrAdmin } from '../auth/hook.js';
import type { DiscoverService } from './discover.js';
import { REQUESTS_ERROR_STATUS, RequestsError } from './errors.js';
import type { IssuesService } from './issues.js';
import { ANONYMOUS_ACTOR, SYSTEM_ACTOR, canManageUsers, type Actor } from './permissions.js';
import { publicPortal, type MediaServerLoginOption, type TokenBuckets } from './portal.js';
import type { RequestsService } from './service.js';
import type { WatchlistService } from './watchlist.js';

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const TmdbParams = z.object({ tmdbId: z.coerce.number().int().positive() });
const PageQuery = z.object({ page: z.coerce.number().int().min(1).max(500).default(1) });
const GenresQuery = z.object({ mediaType: z.enum(['movie', 'tv']).default('movie') });
const SliderQuery = PageQuery.extend({ timeWindow: z.enum(['day', 'week']).default('day') });
const ListParams = z.object({ list: DiscoverListName });
const EntityParams = z.object({ kind: DiscoverEntityKind, id: z.coerce.number().int().positive() });
const Empty = z.null();
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 429: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse };
/**
 * Portal routes: every signed-in user may call them (the auth hook); the services scope the work
 * to the caller (own requests, issues, watchlist, account) or check the permission bits.
 * Routes without a config are admin-only (sliders, override rules, settings writes, user
 * permissions and quotas, watchlist sync).
 */
const user = { access: { portal: true } } as const;

export interface RequestsRouteServices {
  requests: RequestsService;
  issues: IssuesService;
  discover: DiscoverService;
  watchlist: WatchlistService;
  /** Runs the WatchlistSync job now. */
  runWatchlistSync: () => Promise<WatchlistSyncResult>;
  /** Per-IP limit for anonymous discover (public portal). */
  portalLimiter?: TokenBuckets;
  /** Media-server sign-in offered on the login page. */
  mediaServerLogin?: () => MediaServerLoginOption;
  /** Feature flags shown to anonymous portal visitors. */
  features?: () => PublicPortal['features'];
}

/** Who is calling, in permission terms. API-key and bypass callers act as admin. */
export function actorOf(req: FastifyRequest): Actor {
  const auth = req.auth;
  if (!auth) throw new RequestsError('FORBIDDEN', 'authentication required');
  if (!auth.user) return SYSTEM_ACTOR;
  const bits = auth.isAdmin ? auth.user.permissions | Permission.ADMIN : auth.user.permissions & ~Permission.ADMIN;
  return { userId: auth.user.id, permissions: bits };
}

/** Discover callers: signed-in users act as themselves, portal visitors as ANONYMOUS_ACTOR. */
export function discoverActorOf(req: FastifyRequest): Actor {
  return req.auth ? actorOf(req) : ANONYMOUS_ACTOR;
}

/** preHandler: anonymous portal visitors are rate-limited per IP; signed-in callers are not. */
export function portalRateLimit(limiter: TokenBuckets | undefined) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth || !limiter) return;
    if (!limiter.take(req.ip)) {
      reply.header('retry-after', String(Math.max(1, limiter.retryAfter(req.ip))));
      return reply.code(429).send({ error: 'too many requests; sign in or slow down', code: 'RATE_LIMITED' });
    }
  };
}

export function requestsRoutes(s: RequestsRouteServices): Plugin {
  const { requests, issues, discover, watchlist } = s;
  const guard = requests.certifications;
  const portalOn = () => requests.settings().publicPortal.enabled;
  const anonymousDiscover = () => {
    const p = requests.settings().publicPortal;
    return p.enabled && p.allowAnonymousDiscover;
  };
  /** Discover routes: public while the portal allows anonymous discover; anonymous callers are rate-limited. */
  const pub = { access: { portal: true }, publicWhen: anonymousDiscover } as const;
  const limit = portalRateLimit(s.portalLimiter);
  const page = async (req: FastifyRequest, p: DiscoverPage): Promise<DiscoverPage> => ({ ...p, results: await guard.filter(discoverActorOf(req), p.results) });
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
    app.get('/request/:id/policy', { config: user, schema: { params: IdParams, response: { 200: RequestPolicyExplanation, ...errors } } }, async (req) =>
      requests.explainPolicy(actorOf(req), req.params.id),
    );
    app.post('/request/:id/retry', { config: user, schema: { params: IdParams, response: { 200: MediaRequest, ...errors } } }, async (req) =>
      requests.retry(actorOf(req), req.params.id),
    );

    // ------------------------------------------------------------------------- discover
    // Public while publicPortal.enabled && allowAnonymousDiscover; results honour content caps.
    const d = { config: pub, preHandler: limit } as const;
    app.get('/discover/movies', { ...d, schema: { querystring: DiscoverQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      page(req, await discover.movies(req.query)),
    );
    app.get('/discover/tv', { ...d, schema: { querystring: DiscoverQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      page(req, await discover.tv(req.query)),
    );
    app.get('/discover/trending', { ...d, schema: { querystring: TrendingQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      page(req, await discover.trending(req.query)),
    );
    app.get('/discover/upcoming', { ...d, schema: { querystring: DiscoverKindQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      page(req, await discover.upcoming(req.query)),
    );
    app.get('/discover/search', { ...d, schema: { querystring: DiscoverSearchQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      page(req, await discover.search(req.query)),
    );
    app.get('/discover/genres', { ...d, schema: { querystring: GenresQuery, response: { 200: z.array(DiscoverGenre), ...errors } } }, async (req) =>
      discover.genres(req.query.mediaType),
    );
    app.get(
      '/discover/genre/:id',
      { ...d, schema: { params: IdParams, querystring: DiscoverKindQuery, response: { 200: DiscoverPage, ...errors } } },
      async (req) => page(req, await discover.genre(req.params.id, req.query)),
    );
    app.get(
      '/discover/keyword/:id',
      { ...d, schema: { params: IdParams, querystring: DiscoverKindQuery, response: { 200: DiscoverPage, ...errors } } },
      async (req) => page(req, await discover.keyword(req.params.id, req.query)),
    );
    app.get('/discover/network/:id', { ...d, schema: { params: IdParams, querystring: PageQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      page(req, await discover.network(req.params.id, req.query.page)),
    );
    app.get('/discover/studio/:id', { ...d, schema: { params: IdParams, querystring: PageQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      page(req, await discover.studio(req.params.id, req.query.page)),
    );
    app.get('/discover/person/:id', { ...d, schema: { params: IdParams, response: { 200: PersonDetail, ...errors } } }, async (req) => {
      const actor = discoverActorOf(req);
      const person = await discover.person(req.params.id);
      return { ...person, cast: await guard.filter(actor, person.cast), crew: await guard.filter(actor, person.crew) };
    });
    const title = async (req: FastifyRequest, type: 'movie' | 'series', tmdbId: number) => {
      const actor = discoverActorOf(req);
      await guard.assertAllowed(actor, type, tmdbId);
      const detail = await discover.title(actor, type, tmdbId);
      return { ...detail, similar: await guard.filter(actor, detail.similar), recommendations: await guard.filter(actor, detail.recommendations) };
    };
    app.get('/discover/movie/:tmdbId', { ...d, schema: { params: TmdbParams, response: { 200: TitleDetail, ...errors } } }, async (req) =>
      title(req, 'movie', req.params.tmdbId),
    );
    app.get('/discover/tv/:tmdbId', { ...d, schema: { params: TmdbParams, response: { 200: TitleDetail, ...errors } } }, async (req) =>
      title(req, 'series', req.params.tmdbId),
    );
    app.get('/discover/slider/:id', { ...d, schema: { params: IdParams, querystring: SliderQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      page(req, await discover.sliderItems(discoverActorOf(req), req.params.id, req.query.page, req.query.timeWindow)),
    );
    // Full catalogue: ready-made lists, people, tiles for the home page, filter vocabularies, collections.
    app.get('/discover/list/:list', { ...d, schema: { params: ListParams, querystring: DiscoverListQuery, response: { 200: DiscoverPage, ...errors } } }, async (req) =>
      page(req, await discover.list(req.params.list, req.query)),
    );
    app.get('/discover/search/people', { ...d, schema: { querystring: DiscoverTextQuery, response: { 200: PersonPage, ...errors } } }, async (req) =>
      discover.searchPeople(req.query),
    );
    app.get('/discover/keywords', { ...d, schema: { querystring: DiscoverTextQuery, response: { 200: KeywordPage, ...errors } } }, async (req) =>
      discover.keywords(req.query),
    );
    app.get('/discover/genres/tiles', { ...d, schema: { querystring: DiscoverTileQuery, response: { 200: z.array(DiscoverTile), ...errors } } }, async (req) =>
      discover.genreTiles(req.query.mediaType),
    );
    app.get('/discover/companies', { ...d, schema: { querystring: DiscoverTileQuery, response: { 200: z.array(DiscoverTile), ...errors } } }, async (req) =>
      discover.companies(req.query.mediaType),
    );
    app.get('/discover/providers', { ...d, schema: { querystring: DiscoverTileQuery, response: { 200: z.array(DiscoverTile), ...errors } } }, async (req) =>
      discover.providers(req.query.mediaType, req.query.region),
    );
    app.get('/discover/info/:kind/:id', { ...d, schema: { params: EntityParams, response: { 200: DiscoverEntity, ...errors } } }, async (req) =>
      discover.entity(req.params.kind, req.params.id),
    );
    app.get('/discover/options', { ...d, schema: { response: { 200: DiscoverFilterOptions, ...errors } } }, async () => discover.filterOptions());
    app.get('/discover/collection/:id', { ...d, schema: { params: IdParams, response: { 200: CollectionDetail, ...errors } } }, async (req) => {
      const actor = discoverActorOf(req);
      const detail = await discover.collection(actor, req.params.id);
      const parts = await guard.filter(actor, detail.parts);
      return { ...detail, parts, missing: parts.filter((p) => p.mediaStatus === 'unknown').length };
    });
    app.post(
      '/discover/collection/:id/request',
      { config: user, schema: { params: IdParams, body: CollectionRequestInput.nullish(), response: { 200: CollectionRequestResult, ...errors } } },
      async (req) => discover.requestCollection(actorOf(req), req.params.id, req.body ?? {}),
    );

    // ------------------------------------------------------------------------- public portal
    app.get(
      '/public/portal',
      { config: { access: { portal: true }, publicWhen: portalOn }, preHandler: limit, schema: { response: { 200: PublicPortal, ...errors } } },
      async () => publicPortal(requests, s.mediaServerLogin ?? (() => null), s.features),
    );

    // ------------------------------------------------------------------------- sliders
    app.get('/discoverslider', { config: pub, preHandler: limit, schema: { response: { 200: z.array(DiscoverSlider), ...errors } } }, async (req) =>
      discover.sliders(discoverActorOf(req)),
    );
    app.post('/discoverslider', { schema: { body: DiscoverSliderInput, response: { 201: DiscoverSlider, ...errors } } }, async (req, reply) =>
      reply.code(201).send(discover.createSlider(actorOf(req), req.body)),
    );
    app.put('/discoverslider/order', { schema: { body: DiscoverSliderOrder, response: { 200: z.array(DiscoverSlider), ...errors } } }, async (req) =>
      discover.orderSliders(actorOf(req), req.body),
    );
    app.post('/discoverslider/reset', { schema: { response: { 200: z.array(DiscoverSlider), ...errors } } }, async (req) =>
      discover.resetSliders(actorOf(req)),
    );
    app.put(
      '/discoverslider/:id',
      { schema: { params: IdParams, body: DiscoverSliderUpdate, response: { 200: DiscoverSlider, ...errors } } },
      async (req) => discover.updateSlider(actorOf(req), req.params.id, req.body),
    );
    app.delete('/discoverslider/:id', { schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
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
    app.get('/overriderule', { schema: { response: { 200: z.array(OverrideRule), ...errors } } }, async (req) => requests.listRules(actorOf(req)));
    app.post('/overriderule', { schema: { body: OverrideRuleInput, response: { 201: OverrideRule, ...errors } } }, async (req, reply) =>
      reply.code(201).send(requests.createRule(actorOf(req), req.body)),
    );
    app.put(
      '/overriderule/:id',
      { schema: { params: IdParams, body: OverrideRuleInput, response: { 200: OverrideRule, ...errors } } },
      async (req) => requests.updateRule(actorOf(req), req.params.id, req.body),
    );
    app.delete('/overriderule/:id', { schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
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
    app.post('/watchlist/sync', { schema: { response: { 200: WatchlistSyncResult, ...errors } } }, async (req) => {
      if (!canManageUsers(actorOf(req).permissions)) throw RequestsError.forbidden();
      return s.runWatchlistSync();
    });
    app.delete('/watchlist/:id', { config: user, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      watchlist.remove(actorOf(req), req.params.id);
      return reply.code(204).send(null);
    });

    // ------------------------------------------------------------------------- users
    app.get('/user/:id/permissions', { config: user, preHandler: requireSelfOrAdmin, schema: { params: IdParams, response: { 200: UserPermissions, ...errors } } }, async (req) =>
      requests.permissions(actorOf(req), req.params.id),
    );
    app.put(
      '/user/:id/permissions',
      { schema: { params: IdParams, body: UserPermissions, response: { 200: UserPermissions, ...errors } } },
      async (req) => requests.setPermissions(actorOf(req), req.params.id, req.body),
    );
    app.get('/user/:id/quota', { config: user, preHandler: requireSelfOrAdmin, schema: { params: IdParams, response: { 200: UserQuotaResponse, ...errors } } }, async (req) =>
      requests.quota(actorOf(req), req.params.id),
    );
    app.put('/user/:id/quota', { schema: { params: IdParams, body: UserQuota, response: { 200: UserQuotaResponse, ...errors } } }, async (req) =>
      requests.setQuota(actorOf(req), req.params.id, req.body),
    );
    app.get('/user/:id/requestsettings', { config: user, preHandler: requireSelfOrAdmin, schema: { params: IdParams, response: { 200: UserRequestSettings, ...errors } } }, async (req) =>
      requests.requestSettings(actorOf(req), req.params.id),
    );
    app.put(
      '/user/:id/requestsettings',
      { config: user, preHandler: requireSelfOrAdmin, schema: { params: IdParams, body: UserRequestSettings, response: { 200: UserRequestSettings, ...errors } } },
      async (req) => requests.setRequestSettings(actorOf(req), req.params.id, req.body),
    );
    app.post(
      '/user/:id/requestsettings/test',
      { config: user, preHandler: requireSelfOrAdmin, schema: { params: IdParams, response: { 200: UserNotificationTestResult, ...errors } } },
      async (req) => requests.testNotifications(actorOf(req), req.params.id),
    );

    // ------------------------------------------------------------------------- settings
    app.get('/settings/requests', { config: user, schema: { response: { 200: RequestsSettings, ...errors } } }, async () => requests.settings());
    app.put('/settings/requests', { schema: { body: RequestsSettings, response: { 200: RequestsSettings, ...errors } } }, async (req) =>
      requests.updateSettings(actorOf(req), req.body),
    );
  };
}
