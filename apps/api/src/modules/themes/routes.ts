import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { ThemeCatalog, ThemeSettings, ThemeStatus, ThemeSyncResult } from '@arclight/shared';
import type { FastifyPluginAsync, FastifyReply, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SettingsError } from '../settings/service.js';
import type { ThemesService } from './service.js';
import { imageType } from './store.js';

const ErrorBody = z.object({ error: z.string(), code: z.string().optional() });

export interface ThemesRouteHooks {
  /** Called after PUT /settings/themes saved (reschedules the sync). */
  onSettingsChanged?: (settings: ThemeSettings) => void;
}

export function themesRoutes(service: ThemesService, hooks: ThemesRouteHooks = {}): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error(err);
      return reply.code(500).send({ error: 'internal error' });
    });

    // Public (auth/hook.ts PUBLIC_ROUTES): the sign-in page and the request portal load these too.
    app.get('/theme', { schema: { response: { 200: ThemeCatalog } } }, async (_req, reply) => {
      reply.header('cache-control', 'no-cache');
      return service.catalog();
    });

    const sendFile = (id: string, file: string, type: string, cacheControl: string, reply: FastifyReply) => {
      const path = service.filePath(id, file);
      if (!path) return reply.code(404).send({ error: 'theme file not found' });
      reply.header('cache-control', cacheControl);
      reply.header('x-content-type-options', 'nosniff');
      return reply.type(type).send(createReadStream(path));
    };

    app.get(
      '/theme/:id/theme.css',
      { schema: { params: z.object({ id: z.string() }), querystring: z.object({ v: z.string().optional() }) } },
      // `?v=<current version>` never changes content; anything else is rechecked.
      async (req, reply) =>
        sendFile(req.params.id, 'theme.css', 'text/css; charset=utf-8', req.query.v !== undefined && req.query.v === service.version(req.params.id) ? 'public, max-age=31536000, immutable' : 'no-cache', reply),
    );

    // Font URLs come from relative url()s in the stylesheet, so they carry no version: cached a day.
    app.get('/theme/:id/fonts/:file', { schema: { params: z.object({ id: z.string(), file: z.string() }) } }, async (req, reply) =>
      sendFile(req.params.id, `fonts/${req.params.file}`, 'font/woff2', 'public, max-age=86400', reply),
    );

    // Background images: relative url()s like fonts, cached a day.
    app.get('/theme/:id/images/:file', { schema: { params: z.object({ id: z.string(), file: z.string() }) } }, async (req, reply) =>
      sendFile(req.params.id, `images/${req.params.file}`, imageType(req.params.file), 'public, max-age=86400', reply),
    );

    // Admin only.
    app.get('/theme/status', { schema: { response: { 200: ThemeStatus } } }, async () => service.status());

    app.post('/theme/sync', { schema: { response: { 200: ThemeSyncResult, 400: ErrorBody } } }, async () => service.sync());

    app.get('/settings/themes', { schema: { response: { 200: ThemeSettings } } }, async () => service.settings());

    app.put('/settings/themes', { schema: { body: ThemeSettings, response: { 200: ThemeSettings, 400: ErrorBody } } }, async (req) => {
      const saved = service.updateSettings(req.body);
      hooks.onSettingsChanged?.(saved);
      return saved;
    });
  };
}
