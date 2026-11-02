import { z } from 'zod';
import {
  ErrorResponse,
  JellyfinStatsAccess,
  JELLYFIN_USER_HEADER,
  LibraryGrowth,
  LibraryGrowthQuery,
  NewsletterPreview,
  NewsletterRun,
  PlaybackStats,
  PlaybackStatsQuery,
  Wrapped,
  WrappedQuery,
  WrappedShare,
  WrappedShareCreate,
  WatchStatsSettings,
} from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { mediaServerUsers } from '../../db/schema.js';
import { PluginError, type PluginUser } from '../jellyfin-plugin/index.js';
import { getSection, setSection, SettingsError } from '../settings/service.js';
import { normaliseExternalId } from '../watch-history/index.js';
import { wrappedPage, wrappedSvg } from './card.js';
import type { Newsletter } from './newsletter.js';
import { WatchStatsError, type WatchStatsService } from './service.js';
import type { WrappedShares } from './shares.js';

const portal = { access: { portal: true } } as const;
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const TokenParams = z.object({ token: z.string().min(1).max(128) });
const DaysQuery = z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) });
const YearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });
const YearBody = z.object({ year: z.number().int().min(2000).max(2100) }).nullish();
const SvgImage = z.object({ svg: z.string(), fileName: z.string() });
const NewsletterOverview = z.object({ preview: NewsletterPreview, runs: z.array(NewsletterRun) });
const errors = { 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 502: ErrorResponse };

const STATUS: Record<WatchStatsError['code'], number> = { NOT_FOUND: 404, FORBIDDEN: 403, DISABLED: 403, VALIDATION: 400 };

export interface WatchStatsRouteDeps {
  db: Db;
  service: WatchStatsService;
  shares: WrappedShares;
  newsletter: Newsletter;
  /** The Jellyfin plugin's caller (X-Arclight-Jellyfin-User), resolved by the jellyfin-plugin module. */
  pluginUser: (header: string | undefined) => Promise<PluginUser>;
  /** Leaving Soon is on for the plugin (collections module). */
  leavingSoonVisible: () => boolean;
}

function fileName(w: { name: string; year: number }): string {
  return `${w.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wrapped'}-${w.year}.svg`;
}

export function watchStatsRoutes(deps: WatchStatsRouteDeps): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const { db, service, shares, newsletter } = deps;
  const settings = () => getSection(db, 'watchStats');

  /** Whose stats a web caller may read: non-admins only their own; admins anyone (or the whole server). */
  const subject = (req: FastifyRequest, wanted: number | undefined): number | null => {
    const auth = req.auth!;
    if (auth.isAdmin) return wanted ?? null;
    const own = auth.user?.id;
    if (own === undefined) throw new WatchStatsError('FORBIDDEN', 'sign in to see your stats');
    if (wanted !== undefined && wanted !== own) throw new WatchStatsError('FORBIDDEN', "you can only see your own stats");
    return own;
  };
  /** Wrapped always belongs to one user: the caller unless an admin names another. */
  const wrappedUser = (req: FastifyRequest, wanted: number | undefined): number => {
    const id = subject(req, wanted) ?? req.auth!.user?.id;
    if (id === undefined || id === null) throw new WatchStatsError('VALIDATION', 'userId is required');
    return id;
  };

  const header = (req: FastifyRequest): string | undefined => {
    const v = req.headers[JELLYFIN_USER_HEADER];
    return Array.isArray(v) ? v[0] : v;
  };
  /** Arclight admins and Jellyfin administrators count as admins inside Jellyfin. */
  const pluginAccess = async (req: FastifyRequest): Promise<{ user: PluginUser; access: JellyfinStatsAccess }> => {
    const h = header(req);
    const user = await deps.pluginUser(h);
    const externalId = normaliseExternalId(h ?? '');
    const jellyfinAdmin = db
      .select({ isAdmin: mediaServerUsers.isAdmin })
      .from(mediaServerUsers)
      .where(sql`lower(replace(${mediaServerUsers.externalId}, '-', '')) = ${externalId}`)
      .all()
      .some((r) => r.isAdmin);
    const isAdmin = user.row.role === 'admin' || jellyfinAdmin;
    const s = settings();
    const audience = s.jellyfin.serverStats;
    return {
      user,
      access: {
        myStats: s.jellyfin.myStats,
        wrapped: s.jellyfin.wrapped,
        serverStats: audience === 'everyone' || (audience === 'admins' && isAdmin),
        shareLinks: s.jellyfin.wrapped && s.wrapped.shareLinks,
        leavingSoon: deps.leavingSoonVisible(),
        isAdmin,
      },
    };
  };
  const deny = (what: string) => new PluginError(403, 'disabled', `${what} is turned off in Arclight (Settings > Media servers > Jellyfin plugin)`);

  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof WatchStatsError) return reply.code(STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof PluginError) return reply.code(err.status).send({ error: err.message, code: err.code });
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof z.ZodError) return reply.code(400).send({ error: z.prettifyError(err), code: 'VALIDATION' });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled watch-stats error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // ------------------------------------------------------------ web app (signed in)

    app.get('/watchstats', { config: portal, schema: { querystring: PlaybackStatsQuery, response: { 200: PlaybackStats, ...errors } } }, async (req) => {
      const userId = subject(req, req.query.userId);
      return service.stats(req.query, userId, { withUsers: req.auth!.isAdmin });
    });

    app.get('/watchstats/growth', { schema: { querystring: LibraryGrowthQuery, response: { 200: LibraryGrowth } } }, async (req) => service.growth(req.query.days ?? 365));

    app.get('/watchstats/wrapped', { config: portal, schema: { querystring: WrappedQuery, response: { 200: Wrapped, ...errors } } }, async (req) =>
      service.wrapped(wrappedUser(req, req.query.userId), req.query.year),
    );

    app.get('/watchstats/wrapped/image.svg', { config: portal, schema: { querystring: WrappedQuery } }, async (req, reply) => {
      const w = service.wrapped(wrappedUser(req, req.query.userId), req.query.year);
      return reply
        .type('image/svg+xml; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${fileName(w)}"`)
        .send(wrappedSvg(w));
    });

    app.get('/watchstats/wrapped/shares', { config: portal, schema: { querystring: z.object({ userId: z.coerce.number().int().positive().optional() }), response: { 200: z.array(WrappedShare), ...errors } } }, async (req) =>
      shares.list(wrappedUser(req, req.query.userId)),
    );

    app.post('/watchstats/wrapped/shares', { config: portal, schema: { body: WrappedShareCreate, response: { 201: WrappedShare, ...errors } } }, async (req, reply) => {
      const s = settings();
      if (!s.wrapped.shareLinks) throw new WatchStatsError('DISABLED', 'share links are turned off');
      const userId = wrappedUser(req, req.body.userId);
      return reply.code(201).send(shares.create(userId, req.body.year, s.wrapped.shareLinkDays));
    });

    app.delete('/watchstats/wrapped/shares/:id', { config: portal, schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      const row = shares.get(req.params.id);
      if (!row) throw new WatchStatsError('NOT_FOUND', 'share link not found');
      if (!req.auth!.isAdmin && row.userId !== req.auth!.user?.id) throw new WatchStatsError('NOT_FOUND', 'share link not found');
      shares.revoke(row.id);
      return reply.code(204).send(null);
    });

    // ------------------------------------------------------------ settings + newsletter (admin)

    app.get('/settings/watchstats', { schema: { response: { 200: WatchStatsSettings } } }, async () => settings());
    app.put('/settings/watchstats', { schema: { body: WatchStatsSettings, response: { 200: WatchStatsSettings, ...errors } } }, async (req) => {
      setSection(db, 'watchStats', req.body);
      return settings();
    });

    app.get('/watchstats/newsletter', { schema: { response: { 200: NewsletterOverview } } }, async () => ({
      preview: newsletter.preview(settings().newsletter),
      runs: newsletter.runs(),
    }));

    app.post('/watchstats/newsletter/send', { schema: { response: { 200: NewsletterRun, ...errors } } }, async (_req, reply) => {
      try {
        return await newsletter.send(settings().newsletter, 'manual');
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : String(err), code: 'SEND_FAILED' });
      }
    });

    // ------------------------------------------------------------ public share links

    const shared = (token: string) => {
      const row = shares.resolve(token);
      if (!row) throw new WatchStatsError('NOT_FOUND', 'this link has expired or was revoked');
      if (!settings().wrapped.shareLinks) throw new WatchStatsError('NOT_FOUND', 'share links are turned off');
      return { row, wrapped: service.wrapped(row.userId, row.year) };
    };
    const open = { publicWhen: () => true } as const;

    app.get('/share/wrapped/:token', { config: open, schema: { params: TokenParams } }, async (req, reply) => {
      try {
        const { row, wrapped } = shared(req.params.token);
        return reply
          .type('text/html; charset=utf-8')
          .header('Cache-Control', 'no-store')
          .header('Content-Security-Policy', "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'")
          .send(wrappedPage(wrapped, { imagePath: `${req.params.token}/image.svg`, expiresAt: row.expiresAt }));
      } catch (err) {
        if (!(err instanceof WatchStatsError)) throw err;
        return reply.code(404).type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><title>Link expired</title><p>This link has expired or was revoked.</p>');
      }
    });

    app.get('/share/wrapped/:token/image.svg', { config: open, schema: { params: TokenParams } }, async (req, reply) => {
      const { wrapped } = shared(req.params.token);
      return reply.type('image/svg+xml; charset=utf-8').header('Cache-Control', 'no-store').send(wrappedSvg(wrapped));
    });

    // ------------------------------------------------------------ Jellyfin plugin (/jellyfin/*)

    app.get('/jellyfin/stats/access', { schema: { response: { 200: JellyfinStatsAccess, ...errors } } }, async (req) => (await pluginAccess(req)).access);

    app.get('/jellyfin/stats/me', { schema: { querystring: DaysQuery, response: { 200: PlaybackStats, ...errors } } }, async (req) => {
      const { user, access } = await pluginAccess(req);
      if (!access.myStats) throw deny('My stats');
      return service.stats({ days: req.query.days }, user.row.id, { withUsers: false });
    });

    app.get('/jellyfin/stats/server', { schema: { querystring: DaysQuery, response: { 200: PlaybackStats, ...errors } } }, async (req) => {
      const { access } = await pluginAccess(req);
      if (!access.serverStats) throw deny('Server stats');
      return service.stats({ days: req.query.days }, null, { withUsers: access.isAdmin || settings().jellyfin.showUserNames });
    });

    app.get('/jellyfin/wrapped', { schema: { querystring: YearQuery, response: { 200: Wrapped, ...errors } } }, async (req) => {
      const { user, access } = await pluginAccess(req);
      if (!access.wrapped) throw deny('Year in review');
      return service.wrapped(user.row.id, req.query.year);
    });

    app.get('/jellyfin/wrapped/image', { schema: { querystring: YearQuery, response: { 200: SvgImage, ...errors } } }, async (req) => {
      const { user, access } = await pluginAccess(req);
      if (!access.wrapped) throw deny('Year in review');
      const w = service.wrapped(user.row.id, req.query.year);
      return { svg: wrappedSvg(w), fileName: fileName(w) };
    });

    app.post('/jellyfin/wrapped/share', { schema: { body: YearBody, response: { 201: WrappedShare, ...errors } } }, async (req, reply) => {
      const { user, access } = await pluginAccess(req);
      if (!access.shareLinks) throw deny('Share links');
      const year = req.body?.year ?? service.clock().getFullYear();
      return reply.code(201).send(shares.create(user.row.id, year, settings().wrapped.shareLinkDays));
    });
  };
}

