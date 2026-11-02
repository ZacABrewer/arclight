import { z } from 'zod';
import {
  Issue,
  JELLYFIN_PLUGIN_FEATURES,
  JELLYFIN_PLUGIN_LATEST_VERSION,
  JELLYFIN_PLUGIN_MANIFEST_URL,
  JELLYFIN_USER_HEADER,
  JellyfinErrorResponse,
  JellyfinEventBatch,
  JellyfinEventsAccepted,
  JellyfinIssueInput,
  JellyfinLanguageRequestInput,
  JellyfinPing,
  JellyfinPluginInfo,
  JellyfinPluginKey,
  JellyfinPluginKeyCreate,
  JellyfinPluginKeyCreated,
  JellyfinPluginOverview,
  JellyfinRequestInput,
  JellyfinSearchPage,
  JellyfinSearchQuery,
  JellyfinStatusQuery,
  JellyfinStatusRequest,
  JellyfinStatusResponse,
  JellyfinTitle,
  JellyfinTitleParams,
  JellyfinWatchlistAdd,
  JellyfinWatchlist,
  JellyfinWatchlistDeleteQuery,
  JellyfinWatchlistItem,
  JellyfinDiscoverQuery,
  JellyfinGenreDiscoverParams,
  JellyfinGenreDiscoverQuery,
  JellyfinGenreParams,
  JellyfinGenres,
  JellyfinMyRequests,
  JellyfinProviders,
  JellyfinProvidersQuery,
  JellyfinRequestDeleteQuery,
  JellyfinRequestsQuery,
  JellyfinUpcoming,
  JellyfinUpcomingQuery,
  LanguageRequest,
  MediaRequest,
  RequestAccepted,
  isMediaBrowserKind,
} from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppContext } from '../../app.js';
import { VERSION } from '../../version.js';
import { AuthError, authServiceFor, type PluginKeyRow } from '../auth/index.js';
import type { MediaServersService } from '../media-servers/index.js';
import { REQUESTS_ERROR_STATUS, RequestsError } from '../requests/errors.js';
import { getSection } from '../settings/service.js';
import type { WatchHistory } from '../watch-history/index.js';
import { PluginError, type JellyfinPluginService } from './service.js';

const errors = {
  400: JellyfinErrorResponse,
  401: JellyfinErrorResponse,
  403: JellyfinErrorResponse,
  404: JellyfinErrorResponse,
  409: JellyfinErrorResponse,
  429: JellyfinErrorResponse,
  502: JellyfinErrorResponse,
  503: JellyfinErrorResponse,
};
const IdParams = z.object({ id: z.coerce.number().int().positive() });

function keyView(row: PluginKeyRow): JellyfinPluginKey {
  return { id: row.id, name: row.name, prefix: row.prefix, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, lastPingAt: row.lastPingAt };
}

/**
 * /api/v1/jellyfin/*: callable with a plugin key (the auth hook confines those keys here) or the
 * admin API key; no `config.access`, so signed-in portal users cannot act for other Jellyfin users.
 * /api/v1/settings/jellyfinplugin*: admin-only key management and the plugin card.
 */
export function jellyfinPluginRoutes(
  ctx: AppContext,
  service: JellyfinPluginService,
  wh: WatchHistory,
  servers: MediaServersService,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const header = (req: FastifyRequest): string | undefined => {
    const v = req.headers[JELLYFIN_USER_HEADER];
    return Array.isArray(v) ? v[0] : v;
  };
  const user = (req: FastifyRequest) => service.resolveUser(header(req));

  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof PluginError) return reply.code(err.status).send({ error: err.message, code: err.code });
      if (err instanceof RequestsError) return reply.code(REQUESTS_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof AuthError) return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
      if (err instanceof z.ZodError) return reply.code(400).send({ error: z.prettifyError(err), code: 'VALIDATION' });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled jellyfin plugin error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    // ---------------------------------------------------------------- server-level calls
    app.get('/jellyfin/ping', { schema: { response: { 200: JellyfinPing, ...errors } } }, async (req) => {
      if (req.auth?.pluginKeyId !== undefined) authServiceFor(ctx).markPluginPing(req.auth.pluginKeyId);
      return {
        version: VERSION,
        serverName: getSection(ctx.db, 'compat').instanceName,
        features: [...JELLYFIN_PLUGIN_FEATURES],
        linkedUsers: service.linkedCount(),
      };
    });

    app.get('/jellyfin/plugin', { schema: { response: { 200: JellyfinPluginInfo } } }, async () => ({
      latestVersion: JELLYFIN_PLUGIN_LATEST_VERSION,
      manifestUrl: JELLYFIN_PLUGIN_MANIFEST_URL,
    }));

    app.post(
      '/jellyfin/events',
      { bodyLimit: 4 * 1024 * 1024, schema: { body: JellyfinEventBatch, response: { 202: JellyfinEventsAccepted, ...errors } } },
      async (req, reply) => {
        const config = servers.byRemoteId(req.body.serverId);
        if (!config) {
          return reply.code(404).send({ error: `no Jellyfin/Emby server with id ${req.body.serverId} is configured (test the connection once so Arclight learns its id)`, code: 'UNKNOWN_SERVER' });
        }
        return reply.code(202).send({ accepted: wh.ingest.ingest(config, req.body.events) });
      },
    );

    // ---------------------------------------------------------------- per-user calls
    app.get('/jellyfin/status', { schema: { querystring: JellyfinStatusQuery, response: { 200: JellyfinStatusResponse, ...errors } } }, async (req) => ({
      items: await service.statusByIds(await user(req), req.query.items.split(',')),
    }));

    app.post('/jellyfin/status', { schema: { body: JellyfinStatusRequest, response: { 200: JellyfinStatusResponse, ...errors } } }, async (req) => ({
      items: await service.status(await user(req), req.body),
    }));

    app.get('/jellyfin/search', { schema: { querystring: JellyfinSearchQuery, response: { 200: JellyfinSearchPage, ...errors } } }, async (req) =>
      service.search(await user(req), req.query),
    );

    app.get('/jellyfin/discover', { schema: { querystring: JellyfinDiscoverQuery, response: { 200: JellyfinSearchPage, ...errors } } }, async (req) =>
      service.discover(await user(req), req.query),
    );

    app.get('/jellyfin/genres/:mediaType', { schema: { params: JellyfinGenreParams, response: { 200: JellyfinGenres, ...errors } } }, async (req) => {
      await user(req); // per-user like the other discover routes (linked, active account)
      return service.genres(req.params.mediaType);
    });

    app.get(
      '/jellyfin/discover/genre/:mediaType/:genreId',
      { schema: { params: JellyfinGenreDiscoverParams, querystring: JellyfinGenreDiscoverQuery, response: { 200: JellyfinSearchPage, ...errors } } },
      async (req) => service.genreDiscover(await user(req), req.params.mediaType, req.params.genreId, req.query),
    );

    app.get('/jellyfin/upcoming', { schema: { querystring: JellyfinUpcomingQuery, response: { 200: JellyfinUpcoming, ...errors } } }, async (req) =>
      service.upcoming(await user(req), req.query),
    );

    app.get(
      '/jellyfin/providers/:mediaType/:tmdbId',
      { schema: { params: JellyfinTitleParams, querystring: JellyfinProvidersQuery, response: { 200: JellyfinProviders, ...errors } } },
      async (req) => service.providers(await user(req), req.params.mediaType, req.params.tmdbId, req.query),
    );

    app.get('/jellyfin/requests', { schema: { querystring: JellyfinRequestsQuery, response: { 200: JellyfinMyRequests, ...errors } } }, async (req) =>
      service.myRequests(await user(req), req.query),
    );

    app.delete(
      '/jellyfin/requests/:id',
      { schema: { params: IdParams, querystring: JellyfinRequestDeleteQuery, response: { 204: z.null(), ...errors } } },
      async (req, reply) => {
        service.cancelRequest(await user(req), req.params.id, req.query);
        return reply.code(204).send(null);
      },
    );

    app.get('/jellyfin/title/:mediaType/:tmdbId', { schema: { params: JellyfinTitleParams, response: { 200: JellyfinTitle, ...errors } } }, async (req) =>
      service.title(await user(req), req.params.mediaType, req.params.tmdbId),
    );

    app.post('/jellyfin/request', { schema: { body: JellyfinRequestInput, response: { 201: MediaRequest, 202: RequestAccepted, ...errors } } }, async (req, reply) => {
      const outcome = await service.request(await user(req), req.body);
      if (outcome.kind === 'accepted') return reply.code(202).send({ message: outcome.message });
      return reply.code(201).send(outcome.request);
    });

    app.post('/jellyfin/language-request', { schema: { body: JellyfinLanguageRequestInput, response: { 201: LanguageRequest, ...errors } } }, async (req, reply) =>
      reply.code(201).send(await service.languageRequest(await user(req), req.body)),
    );

    app.post('/jellyfin/issue', { schema: { body: JellyfinIssueInput, response: { 201: Issue, ...errors } } }, async (req, reply) =>
      reply.code(201).send(await service.issue(await user(req), req.body)),
    );

    app.get('/jellyfin/watchlist', { schema: { response: { 200: JellyfinWatchlist, ...errors } } }, async (req) => service.watchlist(await user(req)));

    app.post('/jellyfin/watchlist', { schema: { body: JellyfinWatchlistAdd, response: { 201: JellyfinWatchlistItem, ...errors } } }, async (req, reply) =>
      reply.code(201).send(await service.addToWatchlist(await user(req), req.body)),
    );

    app.delete('/jellyfin/watchlist', { schema: { querystring: JellyfinWatchlistDeleteQuery, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      service.removeFromWatchlist(await user(req), req.query);
      return reply.code(204).send(null);
    });

    app.delete('/jellyfin/watchlist/:id', { schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      service.removeFromWatchlist(await user(req), { id: req.params.id });
      return reply.code(204).send(null);
    });

    // ---------------------------------------------------------------- admin: keys and status
    app.get('/settings/jellyfinplugin', { schema: { response: { 200: JellyfinPluginOverview } } }, async () => {
      const keys = authServiceFor(ctx).listPluginKeys();
      const lastEvents = wh.queries.lastEvents();
      const pings = keys.map((k) => k.lastPingAt).filter((p): p is string => p !== null).sort();
      return {
        manifestUrl: JELLYFIN_PLUGIN_MANIFEST_URL,
        latestVersion: JELLYFIN_PLUGIN_LATEST_VERSION,
        keys: keys.map(keyView),
        lastPingAt: pings[pings.length - 1] ?? null,
        servers: servers
          .stored()
          .filter((s) => isMediaBrowserKind(s.kind))
          .map((s) => ({ serverId: s.id, name: s.name, remoteId: s.remoteId ?? null, lastEventAt: lastEvents.get(s.id) ?? null })),
      };
    });

    app.post('/settings/jellyfinplugin/keys', { schema: { body: JellyfinPluginKeyCreate.nullish(), response: { 201: JellyfinPluginKeyCreated, ...errors } } }, async (req, reply) => {
      const { row, key } = authServiceFor(ctx).createPluginKey(JellyfinPluginKeyCreate.parse(req.body ?? {}).name);
      return reply.code(201).send({ ...keyView(row), key });
    });

    app.delete('/settings/jellyfinplugin/keys/:id', { schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      authServiceFor(ctx).deletePluginKey(req.params.id);
      return reply.code(204).send(null);
    });
  };
}
