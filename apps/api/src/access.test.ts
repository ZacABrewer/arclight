import type { RouteOptions } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { Permission, SecuritySettings, type AppArea, type ServerEvent } from '@arclight/shared';
import { buildApp, type AppContext } from './app.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { createTestDb, seedAdmin } from './db/test-utils.js';
import { authServiceFor, isPublicRoute, SESSION_COOKIE, type RouteAccess } from './modules/auth/index.js';
import { COMPAT_PUBLIC_ROUTES } from './modules/compat/index.js';
import { eventVisibleTo, type EventOwners, type EventViewer } from './modules/events/index.js';
import { setSection } from './modules/settings/service.js';

// Who besides admins can reach what. The route table below is the explicit allow-list of every
// route a non-admin (or an anonymous visitor) can reach; every other route is admin-only by
// default. A new route that opens itself (config.access, publicWhen, a public path) without
// being added here fails the first test, and a route listed here that disappears or changes
// its access fails it too. Then HTTP checks per category for a portal user, an app-access
// user and the first-run setup gate, and the live event feed filter.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

/**
 * Every route reachable without admin rights, as `METHOD url` → how. `portal`: any signed-in
 * user (the service scopes the work to the caller); `publicWhen`: also anonymous while the
 * public request portal allows it; `areas:`: read-only with that app access; `perms:`: read-only
 * with one of those permission bits; `public`: no credentials at all.
 */
const NON_ADMIN_ROUTES: Record<string, string> = {
  // ---- public (no credentials; each checks its own token or only signs in)
  'GET /api/v1/system/ping': 'public',
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/logout': 'public',
  'GET /api/v1/auth/status': 'public',
  'POST /api/v1/auth/plex/pin': 'public',
  'POST /api/v1/auth/plex/poll': 'public',
  'GET /api/v1/calendar/feed.ics': 'public',
  'GET /api/v1/theme': 'public',
  'GET /api/v1/theme/:id/theme.css': 'public',
  'GET /api/v1/theme/:id/fonts/:file': 'public',
  'GET /api/v1/setup/status': 'public',
  'POST /api/v1/setup/admin': 'public',
  'POST /api/v1/setup/rootfolder': 'public',
  'POST /api/v1/setup/complete': 'public',
  'GET /api': 'public',
  'GET /ping': 'public',
  'GET /initialize.json': 'public',
  'GET /initialize.js': 'public',
  'GET /metrics': 'public when metrics.allowAnonymous',

  // ---- own account, sessions, notifications
  'GET /api/v1/auth/me': 'portal',
  'GET /api/v1/auth/sessions': 'portal',
  'DELETE /api/v1/auth/sessions/:id': 'portal',
  'GET /api/v1/user/me': 'portal',
  'PUT /api/v1/user/me': 'portal',
  'PUT /api/v1/user/me/password': 'portal',
  'GET /api/v1/user/:id/permissions': 'portal',
  'GET /api/v1/user/:id/quota': 'portal',
  'GET /api/v1/user/:id/requestsettings': 'portal',
  'PUT /api/v1/user/:id/requestsettings': 'portal',
  'POST /api/v1/user/:id/requestsettings/test': 'portal',
  'POST /api/v1/user/:id/mediaserver/link': 'portal',
  'DELETE /api/v1/user/:id/mediaserver/link': 'portal',
  'POST /api/v1/user/me/mediaserver/plex/pin': 'portal',
  'POST /api/v1/user/me/mediaserver/plex/poll': 'portal',
  'POST /api/v1/user/me/discord/link-code': 'portal',
  'DELETE /api/v1/user/me/discord/link': 'portal',
  'GET /api/v1/push/vapid-public-key': 'portal',
  'GET /api/v1/push/subscription': 'portal',
  'POST /api/v1/push/subscription': 'portal',
  'DELETE /api/v1/push/subscription': 'portal',
  'GET /api/v1/push/preferences': 'portal',
  'PUT /api/v1/push/preferences': 'portal',
  'POST /api/v1/push/test': 'portal',
  'GET /api/v1/events': 'portal',

  // ---- discover (public portal: anonymous too while allowed)
  'GET /api/v1/public/portal': 'portal publicWhen',
  'GET /api/v1/discoverslider': 'portal publicWhen',
  'GET /api/v1/discover/movies': 'portal publicWhen',
  'GET /api/v1/discover/tv': 'portal publicWhen',
  'GET /api/v1/discover/trending': 'portal publicWhen',
  'GET /api/v1/discover/upcoming': 'portal publicWhen',
  'GET /api/v1/discover/search': 'portal publicWhen',
  'GET /api/v1/discover/search/people': 'portal publicWhen',
  'GET /api/v1/discover/genres': 'portal publicWhen',
  'GET /api/v1/discover/genres/tiles': 'portal publicWhen',
  'GET /api/v1/discover/genre/:id': 'portal publicWhen',
  'GET /api/v1/discover/keyword/:id': 'portal publicWhen',
  'GET /api/v1/discover/keywords': 'portal publicWhen',
  'GET /api/v1/discover/network/:id': 'portal publicWhen',
  'GET /api/v1/discover/studio/:id': 'portal publicWhen',
  'GET /api/v1/discover/companies': 'portal publicWhen',
  'GET /api/v1/discover/providers': 'portal publicWhen',
  'GET /api/v1/discover/person/:id': 'portal publicWhen',
  'GET /api/v1/discover/movie/:tmdbId': 'portal publicWhen',
  'GET /api/v1/discover/tv/:tmdbId': 'portal publicWhen',
  'GET /api/v1/discover/slider/:id': 'portal publicWhen',
  'GET /api/v1/discover/list/:list': 'portal publicWhen',
  'GET /api/v1/discover/info/:kind/:id': 'portal publicWhen',
  'GET /api/v1/discover/options': 'portal publicWhen',
  'GET /api/v1/discover/collection/:id': 'portal publicWhen',
  'POST /api/v1/discover/collection/:id/request': 'portal',

  // ---- requests (own; everyone's with Manage / View requests), request defaults
  'GET /api/v1/request': 'portal',
  'GET /api/v1/request/count': 'portal',
  'GET /api/v1/request/:id': 'portal',
  'GET /api/v1/request/:id/policy': 'portal',
  'POST /api/v1/request': 'portal',
  'PUT /api/v1/request/:id': 'portal',
  'DELETE /api/v1/request/:id': 'portal',
  'POST /api/v1/request/:id/approve': 'portal',
  'POST /api/v1/request/:id/decline': 'portal',
  'POST /api/v1/request/:id/retry': 'portal',
  'POST /api/v1/request/bulk/approve': 'portal',
  'POST /api/v1/request/bulk/decline': 'portal',
  'GET /api/v1/settings/requests': 'portal',

  // ---- issues and watchlist (own; others' with the matching permissions)
  'GET /api/v1/issue': 'portal',
  'GET /api/v1/issue/count': 'portal',
  'GET /api/v1/issue/:id': 'portal',
  'POST /api/v1/issue': 'portal',
  'POST /api/v1/issue/:id/comment': 'portal',
  'POST /api/v1/issue/:id/status': 'portal',
  'DELETE /api/v1/issue/:id': 'portal',
  'PUT /api/v1/issuecomment/:id': 'portal',
  'DELETE /api/v1/issuecomment/:id': 'portal',
  'GET /api/v1/watchlist': 'portal',
  'POST /api/v1/watchlist': 'portal',
  'DELETE /api/v1/watchlist/:id': 'portal',

  // ---- app access: Library (read-only)
  'GET /api/v1/series': 'areas:library',
  'GET /api/v1/series/:id': 'areas:library',
  'GET /api/v1/episode': 'areas:library',
  'GET /api/v1/episode/:id': 'areas:library',
  'GET /api/v1/movie': 'areas:library',
  'GET /api/v1/movie/:id': 'areas:library',
  'GET /api/v1/mediafile': 'areas:library',
  'GET /api/v1/mediafile/:id': 'areas:library',
  'GET /api/v1/library/statistics': 'areas:library',
  'GET /api/v1/metadata/collection/:tmdbId': 'areas:library',
  'GET /api/v1/rootfolder': 'areas:library perms:REQUEST_ADVANCED+MANAGE_REQUESTS',
  'GET /api/v1/rootfolder/:id': 'areas:library',
  'GET /api/v1/tag': 'areas:library perms:REQUEST_ADVANCED+MANAGE_REQUESTS',
  'GET /api/v1/tag/:id': 'areas:library',
  'GET /api/v1/qualityprofile': 'areas:library+wanted perms:REQUEST_ADVANCED+MANAGE_REQUESTS',
  'GET /api/v1/qualityprofile/:id': 'areas:library+wanted',
  'GET /api/v1/history/series': 'areas:library+activity',
  'GET /api/v1/history/movie': 'areas:library+activity',
  'GET /api/v1/queue/summary': 'areas:library+activity',
  'GET /api/v1/release/searchstatus': 'areas:library+wanted',

  // ---- app access: Calendar, Wanted, Activity (read-only)
  'GET /api/v1/calendar': 'areas:calendar',
  'GET /api/v1/wanted/missing/episodes': 'areas:wanted',
  'GET /api/v1/wanted/missing/movies': 'areas:wanted',
  'GET /api/v1/wanted/cutoff/episodes': 'areas:wanted',
  'GET /api/v1/wanted/cutoff/movies': 'areas:wanted',
  'GET /api/v1/profilemigration/mismatch': 'areas:wanted',
  'GET /api/v1/queue': 'areas:activity',
  'GET /api/v1/queue/status': 'areas:activity',
  'GET /api/v1/queue/:id': 'areas:activity',
  'GET /api/v1/queue/:id/timeline': 'areas:activity',
  'GET /api/v1/history': 'areas:activity',
  'GET /api/v1/history/since': 'areas:activity',
  'GET /api/v1/blocklist': 'areas:activity',
  'GET /api/v1/blocklist/series': 'areas:activity',
  'GET /api/v1/blocklist/movie': 'areas:activity',
};

const PERMISSION_NAMES = new Map<number, string>(Object.entries(Permission).map(([name, bit]) => [bit, name]));

/** How a registered route admits non-admins; null: admins only. */
function describeAccess(url: string, config: { access?: RouteAccess; publicWhen?: unknown } | undefined): string | null {
  if (url.startsWith('/api/v1/')) {
    if (isPublicRoute(url)) return 'public';
  } else if (COMPAT_PUBLIC_ROUTES.has(url)) {
    return 'public';
  } else if (url === '/metrics') {
    return 'public when metrics.allowAnonymous';
  }
  const parts: string[] = [];
  const access = config?.access;
  if (access?.portal) parts.push('portal');
  if (access?.areas?.length) parts.push(`areas:${access.areas.join('+')}`);
  if (access?.permissions?.length) parts.push(`perms:${access.permissions.map((p) => PERMISSION_NAMES.get(p) ?? String(p)).join('+')}`);
  if (config?.publicWhen) parts.push('publicWhen');
  return parts.length ? parts.join(' ') : null;
}

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
  routes: RouteOptions[];
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.app.close();
});

async function harness(opts: { admin?: boolean } = {}): Promise<Harness> {
  const db = await createTestDb();
  if (opts.admin ?? true) seedAdmin(db);
  const routes: RouteOptions[] = [];
  let ctx: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: process.env['ACCESS_LOG'] ?? 'silent' }), {
    probe: false,
    onContext: (c) => (ctx = c),
    onRoute: (r) => routes.push(r),
  });
  await app.ready();
  const h = { app, ctx: ctx!, db, routes };
  open.push(h);
  return h;
}

/** A signed-in non-admin; returns its session cookie and id. */
async function signedIn(h: Harness, opts: { appAccess?: AppArea[]; permissions?: number } = {}): Promise<{ cookie: string; id: number }> {
  const auth = authServiceFor(h.ctx);
  const user = await auth.createUser({
    username: `u${Math.random().toString(36).slice(2, 8)}`,
    password: 'password1',
    role: 'user',
    permissions: opts.permissions ?? Permission.REQUEST | Permission.CREATE_ISSUES,
    ...(opts.appAccess ? { appAccess: opts.appAccess } : {}),
  });
  return { cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}`, id: user.id };
}

describe('route table', () => {
  it('opens to non-admins exactly the routes on the allow-list; everything else is admin-only', async () => {
    const h = await harness();
    const actual: Record<string, string> = {};
    const getAccess = new Map<string, string | null>();
    for (const route of h.routes) {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        // CORS preflight answers OPTIONS for every path with headers only; it serves no data.
        if (method === 'OPTIONS' && route.url === '*') continue;
        const how = describeAccess(route.url, route.config as { access?: RouteAccess; publicWhen?: unknown } | undefined);
        if (method === 'HEAD') {
          // HEAD twins of GET routes must not be more open than their GET.
          getAccess.set(`HEAD ${route.url}`, how);
          continue;
        }
        if (method === 'GET') getAccess.set(`GET ${route.url}`, how);
        if (how !== null) actual[`${method} ${route.url}`] = how;
      }
    }
    expect(actual).toEqual(NON_ADMIN_ROUTES);
    for (const [key, how] of getAccess) {
      if (!key.startsWith('HEAD ')) continue;
      expect([how, key], 'HEAD route more open than its GET').toEqual([getAccess.get(`GET ${key.slice(5)}`) ?? null, key]);
    }
    // Sanity: the table really covers the app (hundreds of admin-only routes stay closed).
    expect(h.routes.length).toBeGreaterThan(500);
  });
});

describe('portal user over HTTP', () => {
  const ADMIN_ONLY_READS = [
    '/api/v1/series',
    '/api/v1/movie',
    '/api/v1/calendar',
    '/api/v1/queue',
    '/api/v1/history',
    '/api/v1/wanted/missing/episodes',
    '/api/v1/settings/security',
    '/api/v1/settings/mediamanagement',
    '/api/v1/settings/mediaserver',
    '/api/v1/settings/signin',
    '/api/v1/settings/compat',
    '/api/v1/system/status',
    '/api/v1/system/debug/snapshot',
    '/api/v1/system/backup',
    '/api/v1/system/update',
    '/api/v1/log',
    '/api/v1/log/file',
    '/api/v1/user',
    '/api/v1/user/1',
    '/api/v1/health',
    '/api/v1/jobs',
    '/api/v1/indexer',
    '/api/v1/downloadclient',
    '/api/v1/rootfolder',
    '/api/v1/qualityprofile',
    '/api/v1/overriderule',
    '/api/v1/audit',
    '/api/v1/config/export',
    '/api/v1/mediaserver',
    '/api/v1/user/import/mediaserver',
    '/api/v3/series',
    '/api/v3/system/status',
    '/metrics',
  ];

  it('gets 403 on every admin area, reads included', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h);
    for (const url of ADMIN_ONLY_READS) {
      for (const method of ['GET', 'HEAD'] as const) {
        const res = await h.app.inject({ method, url, headers: { cookie } });
        expect([url, method, res.statusCode]).toEqual([url, method, 403]);
      }
    }
  });

  it('cannot write to admin routes or other users', async () => {
    const h = await harness();
    const { cookie, id } = await signedIn(h);
    const other = await signedIn(h);
    const tries: Array<['POST' | 'PUT' | 'DELETE', string, object?]> = [
      ['POST', '/api/v1/series', {}],
      ['PUT', '/api/v1/settings/requests', {}],
      ['PUT', '/api/v1/settings/security', { method: 'none', requireForLocal: false, sessionDays: 30 }],
      ['POST', '/api/v1/user', { username: 'evil', password: 'password1', role: 'admin' }],
      ['PUT', `/api/v1/user/${id}`, { role: 'admin' }],
      ['PUT', `/api/v1/user/${id}/permissions`, { permissions: Permission.ADMIN }],
      ['PUT', `/api/v1/user/${id}/quota`, {}],
      ['POST', '/api/v1/discoverslider', {}],
      ['POST', '/api/v1/watchlist/sync'],
      ['POST', '/api/v1/request/digest'],
      ['POST', '/api/v1/settings/security/apikey'],
      ['POST', '/api/v1/system/debug/run', { input: 'help' }],
    ];
    for (const [method, url, payload] of tries) {
      const res = await h.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
      expect([method, url, res.statusCode]).toEqual([method, url, 403]);
    }
    // Portal routes under /user/:id act on the caller's own account only.
    for (const url of [`/api/v1/user/${other.id}/quota`, `/api/v1/user/${other.id}/requestsettings`, `/api/v1/user/${other.id}/permissions`]) {
      expect((await h.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(403);
    }
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/user/${id}/quota`, headers: { cookie } })).statusCode).toBe(200);
  });

  it('cannot open System → Debugging; admins (API key) can', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h);
    const key = authServiceFor(h.ctx).apiKey();
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/system/debug/snapshot', headers: { cookie } })).statusCode).toBe(403);
    const denied = await h.app.inject({ method: 'POST', url: '/api/v1/system/debug/run', headers: { cookie }, payload: { input: 'logs' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('log line');
    const snap = await h.app.inject({ method: 'GET', url: '/api/v1/system/debug/snapshot', headers: { 'x-api-key': key } });
    expect(snap.statusCode).toBe(200);
    expect(snap.json()).toMatchObject({ memory: { rss: expect.any(Number) }, handles: { available: true } });
    const run = await h.app.inject({ method: 'POST', url: '/api/v1/system/debug/run', headers: { 'x-api-key': key }, payload: { input: 'version\nengine' } });
    expect(run.statusCode).toBe(200);
    expect(run.json().results.map((r: { command: string; ok: boolean }) => [r.command, r.ok])).toEqual([
      ['version', true],
      ['engine', true],
    ]);
  });

  it('reaches its own account, requests, issues and the portal descriptor', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h);
    for (const url of ['/api/v1/auth/me', '/api/v1/user/me', '/api/v1/auth/sessions', '/api/v1/request', '/api/v1/request/count', '/api/v1/issue', '/api/v1/settings/requests', '/api/v1/public/portal', '/api/v1/watchlist']) {
      const res = await h.app.inject({ method: 'GET', url, headers: { cookie } });
      expect([url, res.statusCode]).toEqual([url, 200]);
    }
    const me = (await h.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).json();
    expect(me).toMatchObject({ isAdmin: false, user: { role: 'user', appAccess: [] } });
  });

  it('with app access reads only the granted areas, and never writes', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h, { appAccess: ['library'] });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/series', headers: { cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/movie', headers: { cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/qualityprofile', headers: { cookie } })).statusCode).toBe(200);
    for (const url of ['/api/v1/calendar', '/api/v1/queue', '/api/v1/history', '/api/v1/wanted/missing/movies', '/api/v1/system/status', '/api/v1/settings/mediamanagement']) {
      expect([url, (await h.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode]).toEqual([url, 403]);
    }
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/series', headers: { cookie }, payload: {} })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/movie/1', headers: { cookie } })).statusCode).toBe(403);
    const activity = await signedIn(h, { appAccess: ['activity', 'calendar'] });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/queue', headers: { cookie: activity.cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/calendar', headers: { cookie: activity.cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/series', headers: { cookie: activity.cookie } })).statusCode).toBe(403);
  });

  it('advanced requesters may read the root folder, profile and tag lists, nothing more', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h, { permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED });
    for (const url of ['/api/v1/rootfolder', '/api/v1/qualityprofile', '/api/v1/tag']) {
      expect([url, (await h.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode]).toEqual([url, 200]);
    }
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/series', headers: { cookie } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/rootfolder', headers: { cookie }, payload: { path: '/x' } })).statusCode).toBe(403);
  });

  it('admin promotion needs a local password, and ends the promoted user\'s sessions', async () => {
    const h = await harness();
    const auth = authServiceFor(h.ctx);
    const key = auth.apiKey();
    const { cookie, id } = await signedIn(h);
    // A media-server account has no local password.
    const { users } = await import('./db/schema.js');
    const { eq } = await import('drizzle-orm');
    h.db.update(users).set({ localPassword: false }).where(eq(users.id, id)).run();
    const refused = await h.app.inject({ method: 'PUT', url: `/api/v1/user/${id}`, headers: { 'x-api-key': key }, payload: { role: 'admin' } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('PASSWORD_REQUIRED');
    const promoted = await h.app.inject({ method: 'PUT', url: `/api/v1/user/${id}`, headers: { 'x-api-key': key }, payload: { role: 'admin', password: 'a-new-password' } });
    expect(promoted.json()).toMatchObject({ role: 'admin', localPassword: true, appAccess: [] });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('local sign-in can be turned off for users, never for admins', async () => {
    const h = await harness();
    const auth = authServiceFor(h.ctx);
    await auth.createUser({ username: 'boss', password: 'password1', role: 'admin' });
    await auth.createUser({ username: 'pat', password: 'password1', role: 'user' });
    auth.updateSignInSettings({ local: false, jellyfin: true, emby: true, plex: true, newUsers: 'automatic' });
    const pat = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'pat', password: 'password1' } });
    expect(pat.statusCode).toBe(403);
    const boss = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'boss', password: 'password1' } });
    expect(boss.statusCode).toBe(200);
  });
});

describe('first launch', () => {
  it('answers SETUP_REQUIRED everywhere but the setup bootstrap until the admin exists, API key included', async () => {
    const h = await harness({ admin: false });
    const key = authServiceFor(h.ctx).apiKey();
    for (const [method, url] of [
      ['GET', '/api/v1/series'],
      ['GET', '/api/v1/system/status'],
      ['GET', '/api/v1/settings/security'],
      ['GET', '/api/v1/user'],
      ['POST', '/api/v1/auth/login'],
      ['POST', '/api/v1/setup/rootfolder'],
      ['GET', '/api/v1/public/portal'],
      ['GET', '/api/v1/discover/trending'],
      ['GET', '/api/v3/series'],
      ['GET', '/api/v3/system/status'],
      ['GET', '/metrics'],
    ] as const) {
      for (const headers of [{}, { 'x-api-key': key }]) {
        const res = await h.app.inject({ method, url, headers, ...(method === 'POST' ? { payload: {} } : {}) });
        expect([method, url, res.statusCode, res.json().code]).toEqual([method, url, 403, 'SETUP_REQUIRED']);
      }
    }
    await expect(h.app.injectWS('/api/v1/events', { headers: { 'x-api-key': key } })).rejects.toThrow(/403/);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/system/ping' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/ping' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/setup/status' })).json()).toMatchObject({ needsSetup: true, steps: [{ id: 'admin', complete: false }, {}, {}, {}, {}] });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toMatchObject({ needsSetup: true, adminExists: false, authenticated: false });
  });

  it('creates exactly one admin when two first-launch requests race', async () => {
    const h = await harness({ admin: false });
    const create = (username: string) =>
      h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username, password: 'a-long-password-1' } });
    const codes = (await Promise.all([create('first'), create('second')])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
    const admins = authServiceFor(h.ctx).listUsers().filter((u) => u.role === 'admin');
    expect(admins).toHaveLength(1);
  });

  it('stays closed even if setup was marked complete without an admin (no default account, no skipping)', async () => {
    const h = await harness({ admin: false });
    setSection(h.db, 'security', SecuritySettings.parse({ setupComplete: true, method: 'none', requireForLocal: false }));
    // No local bypass without an admin either.
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/series', remoteAddress: '192.168.1.5' });
    expect(res.statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toMatchObject({ needsSetup: true, adminExists: false });
    // The admin step is still the way in, and only once.
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'owner', password: 'password1' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ isAdmin: true, user: { role: 'admin', localPassword: true } });
    const second = await h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'evil', password: 'password1' } });
    expect(second.statusCode).toBe(409);
    const headless = await h.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { username: 'evil2', password: 'password1' } });
    expect([401, 409]).toContain(headless.statusCode);
    expect(authServiceFor(h.ctx).listUsers().map((u) => u.username)).toEqual(['owner']);
  });

  it('refuses anonymous setup writes before the admin exists', async () => {
    const h = await harness({ admin: false });
    const folder = await h.app.inject({ method: 'POST', url: '/api/v1/setup/rootfolder', payload: { path: '/tmp/x', mediaType: 'series' } });
    expect(folder.statusCode).toBe(403);
    const noAdmin = await h.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { tmdbApiKey: 'k' } });
    expect(noAdmin.statusCode).toBe(400);
  });
});

describe('live event feed', () => {
  const owners: EventOwners = { requestOwner: (id) => (id === 1 ? 7 : 8), issueOwner: (id) => (id === 1 ? 7 : 8) };
  const portal: EventViewer = { isAdmin: false, userId: 7, appAccess: [], permissions: Permission.REQUEST };
  const job = { type: 'job', job: {} } as unknown as ServerEvent;

  it('shows a portal user only their own requests and issues', () => {
    expect(eventVisibleTo({ type: 'request', action: 'approved', id: 1 }, portal, owners)).toBe(true);
    expect(eventVisibleTo({ type: 'request', action: 'approved', id: 2 }, portal, owners)).toBe(false);
    expect(eventVisibleTo({ type: 'issue', action: 'updated', id: 1 }, portal, owners)).toBe(true);
    expect(eventVisibleTo({ type: 'issue', action: 'updated', id: 2 }, portal, owners)).toBe(false);
    expect(eventVisibleTo({ type: 'request', action: 'approved', id: 2 }, { ...portal, permissions: Permission.REQUEST_VIEW }, owners)).toBe(true);
    for (const event of [
      job,
      { type: 'settings', section: 'security' },
      { type: 'queue', action: 'changed' },
      { type: 'library', action: 'added', mediaType: 'series', id: 1 },
      { type: 'indexer', action: 'failed', id: 1, name: 'x' },
      { type: 'summary', action: 'generated', id: 1 },
    ] as ServerEvent[]) {
      expect([event.type, eventVisibleTo(event, portal, owners)]).toEqual([event.type, false]);
    }
  });

  it('adds library and activity events for granted areas; admins see everything', () => {
    const lib: EventViewer = { ...portal, appAccess: ['library'] };
    expect(eventVisibleTo({ type: 'library', action: 'added', mediaType: 'movie', id: 3 }, lib, owners)).toBe(true);
    expect(eventVisibleTo({ type: 'queue', action: 'changed' }, lib, owners)).toBe(false);
    expect(eventVisibleTo({ type: 'queue', action: 'changed' }, { ...portal, appAccess: ['activity'] }, owners)).toBe(true);
    expect(eventVisibleTo(job, { ...portal, appAccess: ['library', 'calendar', 'activity', 'wanted'] }, owners)).toBe(false);
    expect(eventVisibleTo(job, { isAdmin: true, userId: null, appAccess: [], permissions: 0 }, owners)).toBe(true);
  });

  it('filters the socket: a portal user receives nothing admin-only', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h, { permissions: Permission.REQUEST | Permission.REQUEST_VIEW });
    const ws = await h.app.injectWS('/api/v1/events', { headers: { cookie } });
    const received: ServerEvent[] = [];
    const done = new Promise<void>((resolve) =>
      ws.on('message', (data: Buffer) => {
        const event = JSON.parse(data.toString()) as ServerEvent;
        received.push(event);
        if (event.type === 'request') resolve();
      }),
    );
    h.ctx.bus.publish({ type: 'settings', section: 'security' });
    h.ctx.bus.publish({ type: 'queue', action: 'changed' });
    h.ctx.bus.publish({ type: 'library', action: 'added', mediaType: 'series', id: 1 });
    h.ctx.bus.publish({ type: 'indexer', action: 'failed', id: 1, name: 'x' });
    h.ctx.bus.publish({ type: 'request', action: 'created', id: 99 });
    await done;
    ws.terminate();
    expect(received.map((e) => e.type)).toEqual(['request']);
  });

  it('refuses the socket to anonymous callers', async () => {
    const h = await harness();
    await expect(h.app.injectWS('/api/v1/events')).rejects.toThrow(/401/);
  });
});
