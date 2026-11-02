import { z } from 'zod';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ErrorResponse,
  SoulseekAutoResult,
  SoulseekDownload,
  SoulseekGrabRequest,
  SoulseekSearchRequest,
  SoulseekSearchResult,
  SoulseekSettingsResponse,
  SoulseekSettingsUpdate,
  SoulseekTestRequest,
  SoulseekTestResult,
} from '@arclight/shared';
import type { AppContext } from '../../../app.js';
import { LibraryError } from '../../library/index.js';
import { httpStatusFor } from '../../library/errors.js';
import { musicEnabled } from '../service.js';
import { registerSoulseekJobs } from './jobs.js';
import { SoulseekError } from './service.js';
import { soulseekServiceFor } from './index.js';

// Soulseek (slskd) routes under /api/v1. Admin-only (no access config) and gated by
// `features.music` like the rest of music; the source itself is off until enabled in its
// settings section.

const IdParams = z.object({ id: z.coerce.number().int().positive() });

class MusicDisabled extends Error {
  readonly code = 'MUSIC_DISABLED';
}

export const soulseekRoutes = (ctx: AppContext): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> => {
  return async (app) => {
    const service = () => soulseekServiceFor(ctx);
    registerSoulseekJobs(ctx.scheduler, service());

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof MusicDisabled) return reply.code(404).send({ error: err.message, code: err.code });
      if (err instanceof SoulseekError) return reply.code(err.status).send({ error: err.message, code: err.code });
      if (err instanceof LibraryError) return reply.code(httpStatusFor(err.code)).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      const status = (err as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return reply.code(status).send({ error: err instanceof Error ? err.message : 'bad request', code: 'BAD_REQUEST' });
      }
      req.log.error({ err }, 'unhandled soulseek error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.addHook('onRequest', async () => {
      if (!musicEnabled(ctx.db)) throw new MusicDisabled('music is not enabled (Settings → Features)');
    });

    const errors = { 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 502: ErrorResponse };

    app.get('/settings/soulseek', { schema: { response: { 200: SoulseekSettingsResponse } } }, async () => service().getSettings());

    app.put('/settings/soulseek', { schema: { body: SoulseekSettingsUpdate, response: { 200: SoulseekSettingsResponse, 400: ErrorResponse } } }, async (req) =>
      service().updateSettings(req.body),
    );

    app.post('/soulseek/test', { schema: { body: SoulseekTestRequest.optional(), response: { 200: SoulseekTestResult } } }, async (req) =>
      service().test(req.body ?? {}),
    );

    app.post('/soulseek/search', { schema: { body: SoulseekSearchRequest, response: { 200: SoulseekSearchResult, ...errors } } }, async (req) =>
      service().searchAlbum(req.body.albumId, req.body.query),
    );

    app.post('/soulseek/grab', { schema: { body: SoulseekGrabRequest, response: { 201: SoulseekDownload, ...errors } } }, async (req, reply) =>
      reply.code(201).send(await service().grab(req.body)),
    );

    app.post('/soulseek/album/:id/auto', { schema: { params: IdParams, response: { 200: SoulseekAutoResult, ...errors } } }, async (req) =>
      service().autoAlbum(req.params.id),
    );

    app.get('/soulseek/downloads', { schema: { response: { 200: z.array(SoulseekDownload) } } }, async () => service().listDownloads());

    app.delete('/soulseek/downloads/:id', { schema: { params: IdParams, response: { 204: z.null(), 404: ErrorResponse } } }, async (req, reply) => {
      await service().removeDownload(req.params.id);
      return reply.code(204).send(null);
    });
  };
};
