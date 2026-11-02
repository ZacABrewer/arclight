import { createReadStream, readFileSync } from 'node:fs';
import { z } from 'zod';
import { BASE_THEME_ID, JELLYFIN_USER_HEADER, JellyfinErrorResponse, JellyfinThemes, JellyfinUserConfig, type ThemeInfo } from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { canRequest, canViewAllRequests, requestTypeAllowed } from '../requests/permissions.js';
import type { ThemesService } from '../themes/index.js';
import { PluginError, type JellyfinPluginService, type PluginUser } from './service.js';
import { generateJellyfinCss, themeCssEtag } from './theme-css.js';

// Arclight themes inside Jellyfin (docs/THEMES.md "Using themes in Jellyfin"):
//   GET /jellyfin/themes                         installed packs + server default
//   GET /jellyfin/theme/:themeId.css             Jellyfin Web stylesheet generated from the pack's tokens
//   GET /jellyfin/theme-fonts/:themeId/:file     font files the pack ships (the stylesheet links them relatively)
//   GET /jellyfin/userconfig                     per user: the account's theme and request rights
// Same access as the other /jellyfin routes: plugin keys and the admin API key / admin sessions.

const errors = { 400: JellyfinErrorResponse, 403: JellyfinErrorResponse, 404: JellyfinErrorResponse };
const CSS_FILE = /^([a-z0-9][a-z0-9-]{0,31})\.css$/;
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FONT_FILE = /^[A-Za-z0-9._-]{1,80}\.woff2$/;
const CACHE_MAX = 64;

/** Installed packs (Tron, the built-in look, has no tokens to map and is left out). */
function packs(themes: ThemesService): ThemeInfo[] {
  return themes.themes().filter((t) => t.id !== BASE_THEME_ID && t.source !== 'builtin');
}

/** The theme a linked account uses in Arclight: its own pick when allowed and installed, else the server default; null = Tron. */
export function accountTheme(themes: ThemesService, user: Pick<PluginUser, 'row'>): string | null {
  const catalog = themes.catalog();
  const installed = new Set(packs(themes).map((t) => t.id));
  const raw = ((user.row.settings ?? {}) as Record<string, unknown>)['theme'];
  const pick = typeof raw === 'string' && raw !== 'default' ? raw : null;
  const own = pick !== null && (catalog.allowUserChoice || user.row.role === 'admin') ? pick : null;
  const chosen = own ?? catalog.defaultTheme;
  if (chosen === BASE_THEME_ID) return null;
  if (installed.has(chosen)) return chosen;
  return installed.has(catalog.defaultTheme) ? catalog.defaultTheme : null;
}

export function jellyfinThemeRoutes(service: JellyfinPluginService, themes: ThemesService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const cache = new Map<string, string>();
  const header = (req: FastifyRequest): string | undefined => {
    const v = req.headers[JELLYFIN_USER_HEADER];
    return Array.isArray(v) ? v[0] : v;
  };

  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof PluginError) return reply.code(err.status).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled jellyfin theme error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get('/jellyfin/themes', { schema: { response: { 200: JellyfinThemes } } }, async () => {
      const catalog = themes.catalog();
      const list = packs(themes);
      return {
        defaultTheme: list.some((t) => t.id === catalog.defaultTheme) ? catalog.defaultTheme : null,
        themes: list.map((t) => ({ id: t.id, name: t.name, version: t.version, dark: t.colorScheme === 'dark' })),
      };
    });

    app.get('/jellyfin/theme/:file', { schema: { params: z.object({ file: z.string().max(64) }) } }, async (req, reply) => {
      const id = CSS_FILE.exec(req.params.file)?.[1];
      const info = id ? packs(themes).find((t) => t.id === id) : undefined;
      const cssPath = info ? themes.filePath(info.id, 'theme.css') : null;
      if (!info || !cssPath) return reply.code(404).send({ error: 'no installed theme pack with that id', code: 'NOT_FOUND' });
      const etag = themeCssEtag({ id: info.id, version: info.version, source: info.source });
      reply.header('etag', etag);
      reply.header('cache-control', 'public, max-age=3600');
      reply.header('x-content-type-options', 'nosniff');
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string' && inm.split(',').map((s) => s.trim()).includes(etag)) return reply.code(304).send();
      let css = cache.get(etag);
      if (css === undefined) {
        css = generateJellyfinCss({
          id: info.id,
          name: info.name,
          version: info.version,
          colorScheme: info.colorScheme,
          source: info.source,
          css: readFileSync(cssPath, 'utf8'),
          hasFont: (file) => themes.filePath(info.id, `fonts/${file}`) !== null,
        });
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(etag, css);
      }
      return reply.type('text/css; charset=utf-8').send(css);
    });

    app.get(
      '/jellyfin/theme-fonts/:themeId/:file',
      { schema: { params: z.object({ themeId: z.string().max(32), file: z.string().max(96) }) } },
      async (req, reply) => {
        const { themeId, file } = req.params;
        const path = THEME_ID.test(themeId) && FONT_FILE.test(file) ? themes.filePath(themeId, `fonts/${file}`) : null;
        if (!path) return reply.code(404).send({ error: 'font not found', code: 'NOT_FOUND' });
        reply.header('cache-control', 'public, max-age=604800');
        reply.header('x-content-type-options', 'nosniff');
        return reply.type('font/woff2').send(createReadStream(path));
      },
    );

    app.get('/jellyfin/userconfig', { schema: { response: { 200: JellyfinUserConfig, ...errors } } }, async (req) => {
      const user = await service.resolveUser(header(req));
      const held = user.actor.permissions;
      const typeOk = (t: 'movie' | 'series') => requestTypeAllowed({ permissions: held, settings: user.row.settings }, t);
      return {
        theme: accountTheme(themes, user),
        canRequestMovies: canRequest(held, 'movie', false) && typeOk('movie'),
        canRequestSeries: canRequest(held, 'series', false) && typeOk('series'),
        canRequest4k: (canRequest(held, 'movie', true) && typeOk('movie')) || (canRequest(held, 'series', true) && typeOk('series')),
        canViewAllRequests: canViewAllRequests(held),
      };
    });
  };
}
