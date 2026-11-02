import { z } from 'zod';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  CreateMusicPlaylist,
  ErrorResponse,
  MusicPlaylist,
  MusicPlaylistEntry,
  MusicPlaylistPreview,
  MusicPlaylistPreviewRequest,
  MusicPlaylistsSettingsResponse,
  MusicPlaylistsSettingsUpdate,
  MusicPlaylistSyncStarted,
  SimilarArtistsResponse,
  UpdateMusicPlaylist,
} from '@arclight/shared';
import type { AppContext } from '../../../app.js';
import { LibraryError } from '../../library/index.js';
import { httpStatusFor } from '../../library/errors.js';
import { musicEnabled } from '../service.js';
import { registerPlaylistJobs } from './jobs.js';
import { PlaylistError } from './providers.js';
import { playlistServiceFor } from './index.js';

// Music playlists (import from Spotify / Deezer / ListenBrainz / Last.fm, m3u + media-server
// pushes) and similar artists, under /api/v1. Writes are admin-only (no access config); the
// similar-artist read is open to library users. Gated by `features.music`.

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() });

class MusicDisabled extends Error {
  readonly code = 'MUSIC_DISABLED';
}

export const playlistRoutes = (ctx: AppContext): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> => {
  return async (app) => {
    const service = () => playlistServiceFor(ctx);
    registerPlaylistJobs(ctx.scheduler, service);

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof MusicDisabled) return reply.code(404).send({ error: err.message, code: err.code });
      if (err instanceof PlaylistError) return reply.code(err.status).send({ error: err.message, code: err.code });
      if (err instanceof LibraryError) return reply.code(httpStatusFor(err.code)).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      const status = (err as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return reply.code(status).send({ error: err instanceof Error ? err.message : 'bad request', code: 'BAD_REQUEST' });
      }
      req.log.error({ err }, 'unhandled music playlist error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.addHook('onRequest', async () => {
      if (!musicEnabled(ctx.db)) throw new MusicDisabled('music is not enabled (Settings → Features)');
    });

    const errors = { 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse };
    const library = { access: { areas: ['library' as const] } };

    app.get('/settings/musicplaylists', { schema: { response: { 200: MusicPlaylistsSettingsResponse } } }, async () => service().getSettings());

    app.put('/settings/musicplaylists', { schema: { body: MusicPlaylistsSettingsUpdate, response: { 200: MusicPlaylistsSettingsResponse, 400: ErrorResponse } } }, async (req) =>
      service().updateSettings(req.body),
    );

    app.get('/music/playlist', { schema: { response: { 200: z.array(MusicPlaylist) } } }, async () => service().list());

    app.post('/music/playlist/preview', { schema: { body: MusicPlaylistPreviewRequest, response: { 200: MusicPlaylistPreview, ...errors } } }, async (req) =>
      service().preview(req.body.source),
    );

    app.post('/music/playlist', { schema: { body: CreateMusicPlaylist, response: { 201: MusicPlaylist, ...errors } } }, async (req, reply) =>
      reply.code(201).send(service().create(req.body)),
    );

    app.get('/music/playlist/:id', { schema: { params: IdParams, response: { 200: MusicPlaylist, 404: ErrorResponse } } }, async (req) => service().get(req.params.id));

    app.put('/music/playlist/:id', { schema: { params: IdParams, body: UpdateMusicPlaylist, response: { 200: MusicPlaylist, ...errors } } }, async (req) =>
      service().update(req.params.id, req.body),
    );

    app.delete('/music/playlist/:id', { schema: { params: IdParams, response: { 204: z.null(), 404: ErrorResponse } } }, async (req, reply) => {
      service().delete(req.params.id);
      return reply.code(204).send(null);
    });

    app.get('/music/playlist/:id/entries', { schema: { params: IdParams, response: { 200: z.array(MusicPlaylistEntry), 404: ErrorResponse } } }, async (req) =>
      service().entries(req.params.id),
    );

    app.post('/music/playlist/:id/sync', { schema: { params: IdParams, response: { 202: MusicPlaylistSyncStarted, 404: ErrorResponse } } }, async (req, reply) => {
      const { jobId, status } = service().startSync(req.params.id, 'manual');
      return reply.code(202).send({ jobId, status });
    });

    app.get('/artist/:id/similar', { config: library, schema: { params: IdParams, querystring: LimitQuery, response: { 200: SimilarArtistsResponse, ...errors } } }, async (req) => ({
      items: await service().similarForArtist(req.params.id, req.query.limit),
    }));
  };
};
