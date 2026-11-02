import multipart from '@fastify/multipart';
import { z } from 'zod';
import { parsePlexWebhook } from '@arclight/media-servers';
import { PlexWebhookInfo, WatchHistoryErrorResponse } from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { MediaServersService } from '../media-servers/index.js';
import { API_PREFIX } from '../auth/hook.js';
import type { PlexLive } from './plex-live.js';

// Plex webhooks. Plex posts multipart/form-data with the event as JSON in the `payload` field
// (and, for some events, a `thumb` image, which is read and dropped). Plex sends no credentials,
// so the URL carries a per-connection secret: POST /api/v1/plex/webhook?token=... (a public
// route; the token picks the Plex connection). The admin routes show and rotate that URL.

const IdParams = z.object({ id: z.string().min(1) });
const WebhookQuery = z.object({ token: z.string().min(1).max(128) });
const WebhookResult = z.object({ status: z.enum(['stored', 'ignored']), reason: z.string().optional() });
const errors = { 400: WatchHistoryErrorResponse, 401: WatchHistoryErrorResponse, 404: WatchHistoryErrorResponse };
/** Payloads are small JSON; a thumbnail may ride along. */
const MAX_PART_BYTES = 2 * 1024 * 1024;

export const PLEX_WEBHOOK_PATH = '/plex/webhook';

/** The `payload` field of a multipart webhook, or a JSON body (proxies and tests). */
async function payloadOf(req: FastifyRequest): Promise<unknown> {
  if (!req.isMultipart()) {
    const body = req.body as Record<string, unknown> | undefined;
    return body && typeof body === 'object' && 'payload' in body ? body['payload'] : body;
  }
  let payload: unknown = null;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      part.file.resume(); // thumbnails are not kept
    } else if (part.fieldname === 'payload') {
      // A part sent as application/json may arrive already parsed.
      payload = part.value;
    }
  }
  return payload;
}

export function plexWebhookRoutes(servers: MediaServersService, live: PlexLive): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const info = (token: string) => ({ token, path: `${API_PREFIX}${PLEX_WEBHOOK_PATH}?token=${encodeURIComponent(token)}` });
  return async (app) => {
    if (!app.hasContentTypeParser('multipart/form-data')) {
      await app.register(multipart, { limits: { fileSize: MAX_PART_BYTES, files: 2, fields: 5, fieldSize: MAX_PART_BYTES } });
    }

    app.post(PLEX_WEBHOOK_PATH, { schema: { querystring: WebhookQuery, response: { 200: WebhookResult, ...errors } } }, async (req, reply) => {
      const config = servers.byWebhookToken(req.query.token);
      if (!config) return reply.code(401).send({ error: 'unknown webhook token', code: 'UNAUTHORIZED' });
      const event = parsePlexWebhook(await payloadOf(req));
      if (!event) return reply.code(400).send({ error: 'not a Plex webhook payload', code: 'VALIDATION' });
      if (!config.enabled) return { status: 'ignored' as const, reason: 'server disabled' };
      return live.webhook(config, event);
    });

    app.get('/mediaserver/:id/plexwebhook', { schema: { params: IdParams, response: { 200: PlexWebhookInfo, ...errors } } }, async (req, reply) => {
      const config = servers.stored().find((s) => s.id === req.params.id);
      if (!config) return reply.code(404).send({ error: `Media server ${req.params.id} not found`, code: 'NOT_FOUND' });
      if (config.kind !== 'plex') return reply.code(400).send({ error: 'webhooks are for Plex servers', code: 'VALIDATION' });
      return info(servers.webhookToken(config.id));
    });

    // Rotates the secret; the old webhook URL stops working at once.
    app.post('/mediaserver/:id/plexwebhook/regenerate', { schema: { params: IdParams, response: { 200: PlexWebhookInfo, ...errors } } }, async (req, reply) => {
      const config = servers.stored().find((s) => s.id === req.params.id);
      if (!config) return reply.code(404).send({ error: `Media server ${req.params.id} not found`, code: 'NOT_FOUND' });
      if (config.kind !== 'plex') return reply.code(400).send({ error: 'webhooks are for Plex servers', code: 'VALIDATION' });
      return info(servers.webhookToken(config.id, { regenerate: true }));
    });
  };
}
