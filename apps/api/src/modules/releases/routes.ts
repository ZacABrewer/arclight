import { z } from 'zod';
import {
  DecisionLogBatch,
  DecisionLogPage,
  DecisionLogQuery,
  ItemSearchStatus,
  PendingRelease,
  ReleaseGrabRequest,
  ReleaseGrabResponse,
  ReleasePushRequest,
  ReleasePushResponse,
  ReleasesErrorResponse,
  ReleaseSearchQuery,
  ReleaseSearchResponse,
  SearchCommandRequest,
  SearchCommandResponse,
  SearchStatusQuery,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { LibraryError } from '../library/index.js';
import { ReleasesError, type ReleasesService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const errors = { 400: ReleasesErrorResponse, 404: ReleasesErrorResponse, 502: ReleasesErrorResponse, 503: ReleasesErrorResponse };

const statusFor: Record<ReleasesError['code'], number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  UNAVAILABLE: 404,
  DOWNLOAD_FAILED: 502,
  CLIENT_UNAVAILABLE: 503,
};

export function releasesRoutes(service: ReleasesService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof ReleasesError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof LibraryError) {
        return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
      }
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get(
      '/release',
      { schema: { querystring: ReleaseSearchQuery, response: { 200: ReleaseSearchResponse, ...errors } } },
      async (req) => service.interactiveSearch(req.query),
    );

    app.post(
      '/release',
      { schema: { body: ReleaseGrabRequest, response: { 200: ReleaseGrabResponse, ...errors } } },
      async (req) => {
        const tracked = await service.grab(req.body);
        return {
          title: tracked.title,
          queueItemId: tracked.id,
          downloadId: tracked.downloadId,
          downloadClientId: tracked.downloadClientId,
        };
      },
    );

    app.post(
      '/release/push',
      { schema: { body: ReleasePushRequest, response: { 200: ReleasePushResponse, ...errors } } },
      async (req) => service.push(req.body),
    );

    app.get(
      '/release/decisions',
      { schema: { querystring: DecisionLogQuery, response: { 200: DecisionLogPage, ...errors } } },
      async (req) => service.listDecisionBatches(req.query),
    );

    app.get(
      '/release/decisions/:batchId',
      { schema: { params: z.object({ batchId: z.string().min(1).max(64) }), response: { 200: DecisionLogBatch, ...errors } } },
      async (req) => service.getDecisionBatch(req.params.batchId),
    );

    app.get(
      '/release/searchstatus',
      {
        config: { access: { areas: ['library', 'wanted'] } },
        schema: { querystring: SearchStatusQuery, response: { 200: z.array(ItemSearchStatus), ...errors } },
      },
      async (req) => service.searchStatus(req.query),
    );

    app.get('/release/pending',{ schema: { response: { 200: z.array(PendingRelease) } } }, async () => service.listPending());

    app.delete(
      '/release/pending/:id',
      { schema: { params: IdParams, response: { 204: z.null(), ...errors } } },
      async (req, reply) => {
        service.deletePending(req.params.id);
        return reply.code(204).send(null);
      },
    );

    app.post(
      '/command/search',
      { schema: { body: SearchCommandRequest, response: { 200: SearchCommandResponse, ...errors } } },
      async (req) => {
        const b = req.body;
        if (b.movieId !== undefined) return service.searchFor({ movieId: b.movieId }, { userInvoked: true });
        if (b.artistId !== undefined) {
          return service.searchFor({ artistId: b.artistId, ...(b.albumIds?.length ? { albumIds: b.albumIds } : {}) }, { userInvoked: true });
        }
        if (b.albumIds?.length && b.seriesId === undefined && !b.episodeIds?.length) {
          return service.searchFor({ albumIds: b.albumIds }, { userInvoked: true });
        }
        if (b.authorId !== undefined) {
          return service.searchFor({ authorId: b.authorId, ...(b.bookIds?.length ? { bookIds: b.bookIds } : {}) }, { userInvoked: true });
        }
        if (b.bookIds?.length && b.seriesId === undefined && !b.episodeIds?.length) {
          return service.searchFor({ bookIds: b.bookIds }, { userInvoked: true });
        }
        let seriesId = b.seriesId;
        if (seriesId === undefined) seriesId = service.seriesIdForEpisode(b.episodeIds![0]!);
        return service.searchFor(
          {
            seriesId,
            ...(b.seasonNumber !== undefined ? { seasonNumber: b.seasonNumber } : {}),
            ...(b.episodeIds?.length ? { episodeIds: b.episodeIds } : {}),
          },
          { userInvoked: true },
        );
      },
    );
  };
}
