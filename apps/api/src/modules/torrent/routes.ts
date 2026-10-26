import {
  TorrentActionResult,
  TorrentDetail,
  TorrentErrorResponse,
  TorrentListQuery,
  TorrentMoveRequest,
  TorrentPriorityRequest,
  TorrentSessionStatus,
  TorrentSettingsResponse,
  TorrentSettingsUpdate,
} from '@media-tron/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SettingsError } from '../settings/service.js';
import { TorrentModuleError, type TorrentModuleErrorCode, type TorrentService } from './service.js';

// /api/v1/torrent/* and /api/v1/settings/torrent. Thin: validate -> service -> reply.

const STATUS_FOR: Record<TorrentModuleErrorCode, number> = {
  NOT_FOUND: 404,
  NOT_RUNNING: 409,
  CONFLICT: 409,
  VALIDATION: 400,
};

const errors = { 400: TorrentErrorResponse, 404: TorrentErrorResponse, 409: TorrentErrorResponse };
const IdParams = z.object({ id: z.string().regex(/^[0-9a-fA-F]{40}$/, 'expected a 40-character info-hash') });
const OK = { ok: true } as const;

export function torrentRoutes(service: TorrentService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof TorrentModuleError) return reply.code(STATUS_FOR[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled torrent error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get('/torrent/status', { schema: { response: { 200: TorrentSessionStatus } } }, async () => service.status());

    app.get('/torrent/torrents', { schema: { querystring: TorrentListQuery, response: { 200: z.array(TorrentDetail) } } }, async (req) =>
      service.listTorrents(req.query),
    );

    const action = (name: 'recheck' | 'pause' | 'resume', run: (id: string) => Promise<void>) =>
      app.post(`/torrent/:id/${name}`, { schema: { params: IdParams, response: { 200: TorrentActionResult, ...errors } } }, async (req) => {
        await run(req.params.id);
        return OK;
      });
    action('recheck', (id) => service.recheck(id));
    action('pause', (id) => service.pause(id));
    action('resume', (id) => service.resume(id));

    app.post(
      '/torrent/:id/move',
      { schema: { params: IdParams, body: TorrentMoveRequest, response: { 200: TorrentActionResult, ...errors } } },
      async (req) => {
        await service.move(req.params.id, req.body.savePath);
        return OK;
      },
    );

    app.post(
      '/torrent/:id/priority',
      { schema: { params: IdParams, body: TorrentPriorityRequest, response: { 200: TorrentActionResult, ...errors } } },
      async (req) => {
        await service.setPriority(req.params.id, req.body);
        return OK;
      },
    );

    app.get('/settings/torrent', { schema: { response: { 200: TorrentSettingsResponse } } }, async () => service.settingsResponse());

    app.put(
      '/settings/torrent',
      { schema: { body: TorrentSettingsUpdate, response: { 200: TorrentSettingsResponse, 400: TorrentErrorResponse } } },
      async (req) => service.updateSettings(req.body),
    );
  };
}
