import { z, ZodError } from 'zod';
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AddPodcastRequest,
  applyPodcastSettingsUpdate,
  CreatePodcastSuggestion,
  DeclinePodcastSuggestion,
  DeletePodcastQuery,
  ErrorResponse,
  maskPodcastSettings,
  Podcast,
  PodcastEpisode,
  PodcastEpisodeBulkRequest,
  PodcastEpisodeBulkResult,
  PodcastEpisodePage,
  PodcastEpisodeQuery,
  PodcastListResponse,
  PodcastOpmlExportQuery,
  PodcastOpmlImportRequest,
  PodcastOpmlImportResult,
  PodcastPreview,
  PodcastPreviewRequest,
  PodcastSearchQuery,
  PodcastSearchResponse,
  PodcastSettingsResponse,
  PodcastSuggestion,
  PodcastSuggestionList,
  PodcastSuggestionListQuery,
  UpdatePodcastEpisodeRequest,
  UpdatePodcastRequest,
  type PodcastSettingsInput,
} from '@arclight/shared';
import type { AppContext } from '../../app.js';
import { RequestsError, REQUESTS_ERROR_STATUS } from '../requests/errors.js';
import { actorOf } from '../requests/routes.js';
import { getFeatureSettings, getSection, setSection } from '../settings/service.js';
import { PODCASTS_ERROR_STATUS, PodcastsError } from './service.js';
import type { PodcastsRuntime } from './index.js';

// Podcast routes under /api/v1 (docs/using/podcasts.md). Every /podcast route answers 404
// PODCASTS_DISABLED while `features.podcasts` is off. Library reads are open to users with the
// library area; the directory search and suggestions are open to every signed-in portal user;
// subscribing, downloads, OPML and settings are admin-only.

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const Empty = z.null();
const errors = { 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse };

export class PodcastsDisabled extends Error {
  readonly code = 'PODCASTS_DISABLED';
  constructor() {
    super('podcasts are not enabled (Settings → Features)');
  }
}

function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof PodcastsDisabled) return reply.code(404).send({ error: err.message, code: err.code });
  if (err instanceof PodcastsError) return reply.code(PODCASTS_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
  if (err instanceof RequestsError) return reply.code(REQUESTS_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
  if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'VALIDATION' });
  if ('validation' in err) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
  const status = (err as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: err.message, code: 'BAD_REQUEST' });
  req.log.error({ err }, 'unhandled podcast error');
  return reply.code(500).send({ error: 'internal error' });
}

export const podcastRoutes = (ctx: AppContext, rt: PodcastsRuntime): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> => {
  return async (app) => {
    app.setErrorHandler(errorHandler);
    app.addHook('onRequest', async () => {
      if (!getFeatureSettings(ctx.db).podcasts) throw new PodcastsDisabled();
    });

    const svc = () => rt.service();
    const library = { config: { access: { areas: ['library' as const] } } };
    const portal = { config: { access: { portal: true } } };

    // ------------------------------------------------------------------------- podcasts
    app.get('/podcast', { ...library, schema: { response: { 200: PodcastListResponse } } }, async () => svc().list());

    app.post('/podcast', { schema: { body: AddPodcastRequest, response: { 201: Podcast, ...errors } } }, async (req, reply) => {
      const p = await svc().add(req.body);
      return reply.code(201).send(p);
    });

    // Queue a poll of every monitored feed now.
    app.post('/podcast/refresh', { schema: { response: { 202: Empty } } }, async (_req, reply) => {
      rt.refreshAll();
      return reply.code(202).send(null);
    });

    // ----------------------------------------------------------------- directory, OPML
    app.get('/podcast/lookup', { schema: { querystring: PodcastSearchQuery, response: { 200: PodcastSearchResponse, ...errors } } }, async (req) =>
      svc().lookup(req.query.term, req.query.source),
    );

    app.post('/podcast/preview', { schema: { body: PodcastPreviewRequest, response: { 200: PodcastPreview, ...errors } } }, async (req) =>
      svc().preview(req.body.feedUrl),
    );

    app.post('/podcast/opml', { bodyLimit: 5 * 1024 * 1024, schema: { body: PodcastOpmlImportRequest, response: { 200: PodcastOpmlImportResult, ...errors } } }, async (req) =>
      svc().importOpml(req.body),
    );

    app.get('/podcast/opml', { schema: { querystring: PodcastOpmlExportQuery } }, async (req, reply) => {
      const xml = svc().exportOpml(req.query.includePrivate);
      reply.header('content-disposition', `attachment; filename="arclight-podcasts-${new Date().toISOString().slice(0, 10)}.opml"`);
      reply.header('cache-control', 'no-store');
      return reply.type('text/x-opml; charset=utf-8').send(xml);
    });

    // Request portal: directory search for any signed-in user (feed URLs are public).
    app.get('/podcast/search', { ...portal, schema: { querystring: PodcastSearchQuery, response: { 200: PodcastSearchResponse, ...errors } } }, async (req) => {
      rt.suggestions().assertMaySuggest(actorOf(req));
      return svc().lookup(req.query.term, req.query.source);
    });

    // ---------------------------------------------------------------------- suggestions
    app.get('/podcast/suggestion', { ...portal, schema: { querystring: PodcastSuggestionListQuery, response: { 200: PodcastSuggestionList } } }, async (req) =>
      rt.suggestions().list(actorOf(req), req.query),
    );

    app.post('/podcast/suggestion', { ...portal, schema: { body: CreatePodcastSuggestion, response: { 201: PodcastSuggestion, ...errors } } }, async (req, reply) => {
      const s = await rt.suggestions().create(actorOf(req), req.body);
      return reply.code(201).send(s);
    });

    app.post(
      '/podcast/suggestion/:id/approve',
      { ...portal, schema: { params: IdParams, response: { 200: PodcastSuggestion, ...errors } } },
      async (req) => rt.suggestions().approve(actorOf(req), req.params.id),
    );

    app.post(
      '/podcast/suggestion/:id/decline',
      { ...portal, schema: { params: IdParams, body: DeclinePodcastSuggestion.optional(), response: { 200: PodcastSuggestion, ...errors } } },
      async (req) => rt.suggestions().decline(actorOf(req), req.params.id, req.body?.reason),
    );

    app.delete('/podcast/suggestion/:id', { ...portal, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      rt.suggestions().remove(actorOf(req), req.params.id);
      return reply.code(204).send(null);
    });

    // ------------------------------------------------------------------------- episodes
    app.get('/podcast/episode', { ...library, schema: { querystring: PodcastEpisodeQuery, response: { 200: PodcastEpisodePage } } }, async (req) =>
      svc().episodes(req.query),
    );

    app.post('/podcast/episode/bulk', { schema: { body: PodcastEpisodeBulkRequest, response: { 200: PodcastEpisodeBulkResult, ...errors } } }, async (req) => ({
      updated: await svc().bulk(req.body.ids, req.body.action),
    }));

    // Played state is per library, like the media server's: library users may set it.
    app.put('/podcast/episode/:id', { ...library, schema: { params: IdParams, body: UpdatePodcastEpisodeRequest, response: { 200: PodcastEpisode, ...errors } } }, async (req) =>
      svc().setPlayed(req.params.id, req.body.played),
    );

    app.post('/podcast/episode/:id/download', { schema: { params: IdParams, response: { 200: PodcastEpisode, ...errors } } }, async (req) =>
      svc().queueDownload(req.params.id),
    );

    app.delete('/podcast/episode/:id/file', { schema: { params: IdParams, response: { 200: PodcastEpisode, ...errors } } }, async (req) =>
      svc().deleteFile(req.params.id),
    );

    // ---------------------------------------------------------------------- one podcast
    app.get('/podcast/:id', { ...library, schema: { params: IdParams, response: { 200: Podcast, ...errors } } }, async (req) => svc().get(req.params.id));

    app.put('/podcast/:id', { schema: { params: IdParams, body: UpdatePodcastRequest, response: { 200: Podcast, ...errors } } }, async (req) =>
      svc().update(req.params.id, req.body),
    );

    app.delete('/podcast/:id', { schema: { params: IdParams, querystring: DeletePodcastQuery, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      await svc().remove(req.params.id, req.query.deleteFiles);
      return reply.code(204).send(null);
    });

    app.post('/podcast/:id/refresh', { schema: { params: IdParams, response: { 200: Podcast, ...errors } } }, async (req) => {
      const s = svc();
      s.get(req.params.id); // 404 before polling
      await s.refresh(req.params.id);
      return s.get(req.params.id);
    });
  };
};

/** GET/PUT /settings/podcasts (admin). Not gated by the feature flag, so it can be set up first. */
export const podcastSettingsRoutes = (ctx: AppContext): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> => {
  return async (app) => {
    app.setErrorHandler(errorHandler);
    app.get('/settings/podcasts', { schema: { response: { 200: PodcastSettingsResponse } } }, async () => maskPodcastSettings(getSection(ctx.db, 'podcasts')));
    app.put(
      '/settings/podcasts',
      { schema: { body: z.record(z.string(), z.unknown()), response: { 200: PodcastSettingsResponse, 400: ErrorResponse } } },
      async (req) => {
        const next = applyPodcastSettingsUpdate(getSection(ctx.db, 'podcasts'), req.body as PodcastSettingsInput);
        const saved = setSection(ctx.db, 'podcasts', next);
        ctx.bus.publish({ type: 'settings', section: 'podcasts' });
        return maskPodcastSettings(saved);
      },
    );
  };
};
