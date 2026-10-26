import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Permission as P, RequestsSettings, type PublicPortalSettings } from '@arclight/shared';
import { users } from '../../db/schema.js';
import { authModule, authServiceFor, installAuth, SESSION_COOKIE } from '../auth/index.js';
import { requestsModuleWith } from './index.js';
import { configureServer, FakeMediaServers } from './media-server-fakes.js';
import { TokenBuckets, type RateLimitOptions } from './portal.js';
import { addUser, setup } from './test-support.js';

/** Auth hook + auth routes + requests module (the public-route rules live in the hook). */
async function app(opts: { rateLimit?: RateLimitOptions } = {}) {
  const servers = new FakeMediaServers();
  const h = await setup({ extra: { fetch: servers.fetch, plexTvUrl: 'http://plextv.test', ...(opts.rateLimit ? { portalRateLimit: opts.rateLimit } : {}) } });
  h.tmdb
    .addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999, certification: 'R' })
    .addMovie({ tmdbId: 700, title: 'Adults Only', year: 2001, certification: 'NC-17' })
    .addSeries({ tmdbId: 1399, title: 'Thrones', year: 2011, seasons: [0, 2], certification: 'TV-MA' });
  const server = Fastify().withTypeProvider<ZodTypeProvider>();
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  await server.register(
    async (api) => {
      installAuth(api, h.ctx);
      await api.register(requestsModuleWith({})(h.ctx));
      await api.register(authModule(h.ctx));
    },
    { prefix: '/api/v1' },
  );
  await server.ready();
  const admin = addUser(h.db, { role: 'admin' });
  const auth = authServiceFor(h.ctx);
  const cookieFor = (id: number) => `${SESSION_COOKIE}=${auth.createSession(id).token}`;
  const portal = (p: Partial<PublicPortalSettings>) =>
    h.services.requests.updateSettings(admin.actor, RequestsSettings.parse({ ...h.services.requests.settings(), publicPortal: { ...h.services.requests.settings().publicPortal, ...p } }));
  const get = (url: string, cookie?: string) => server.inject({ method: 'GET', url: `/api/v1${url}`, ...(cookie ? { headers: { cookie } } : {}) });
  return { ...h, servers, server, admin, cookieFor, portal, get };
}

describe('public request portal', () => {
  it('while disabled, discover and the portal descriptor need sign-in', async () => {
    const h = await app();
    expect((await h.get('/discover/movies')).statusCode).toBe(401);
    expect((await h.get('/public/portal')).statusCode).toBe(401);
    const signedIn = await h.get('/public/portal', h.cookieFor(h.admin.id));
    expect(signedIn.json()).toMatchObject({ enabled: false, allowAnonymousDiscover: false });
  });

  it('enabled: GET /public/portal is public with branding, message and login methods; discover stays private without allowAnonymousDiscover', async () => {
    const h = await app();
    h.portal({ enabled: true, message: 'Ask for anything family friendly' });
    const res = await h.get('/public/portal');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: true,
      title: 'Arclight',
      applicationUrl: '',
      message: 'Ask for anything family friendly',
      allowAnonymousDiscover: false,
      loginMethods: { local: true, mediaServer: null, plex: false },
    });
    expect((await h.get('/discover/movies')).statusCode).toBe(401);
    configureServer(h.db, h.servers, 'plex');
    expect((await h.get('/public/portal')).json().loginMethods).toMatchObject({ mediaServer: { kind: 'plex' }, plex: true });
  });

  it('with anonymous discover, visitors browse discover, sliders and title pages but cannot request', async () => {
    const h = await app();
    h.portal({ enabled: true, allowAnonymousDiscover: true });
    const movies = await h.get('/discover/movies');
    expect(movies.statusCode).toBe(200);
    expect(movies.json().results.map((r: { tmdbId: number }) => r.tmdbId)).toEqual([603]); // NC-17 hidden for visitors
    expect((await h.get('/discoverslider')).statusCode).toBe(200);
    const detail = await h.get('/discover/movie/603');
    expect(detail.json()).toMatchObject({ title: 'The Matrix', canRequest: false, requests: [] });
    expect((await h.get('/discover/movie/700')).statusCode).toBe(403);
    const request = await h.server.inject({ method: 'POST', url: '/api/v1/request', payload: { mediaType: 'movie', tmdbId: 603 } });
    expect(request.statusCode).toBe(401);
    expect((await h.get('/request')).statusCode).toBe(401);
  });

  it('signed-in users keep their own view (no visitor filtering) while the portal is on', async () => {
    const h = await app();
    h.portal({ enabled: true, allowAnonymousDiscover: true });
    const user = addUser(h.db, { permissions: P.REQUEST });
    const movies = await h.get('/discover/movies', h.cookieFor(user.id));
    expect(movies.json().results).toHaveLength(2);
    expect((await h.get('/discover/movie/603', h.cookieFor(user.id))).json().canRequest).toBe(true);
  });

  it('rate-limits anonymous discover per IP with 429 and Retry-After; signed-in users are not limited', async () => {
    const h = await app({ rateLimit: { capacity: 2, refillPerSecond: 0.01 } });
    h.portal({ enabled: true, allowAnonymousDiscover: true });
    expect((await h.get('/discover/genres')).statusCode).toBe(200);
    expect((await h.get('/discover/genres')).statusCode).toBe(200);
    const limited = await h.get('/discover/genres');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const other = await h.server.inject({ method: 'GET', url: '/api/v1/discover/genres', remoteAddress: '10.9.9.9' });
    expect(other.statusCode).toBe(200);
    for (let i = 0; i < 3; i++) expect((await h.get('/discover/genres', h.cookieFor(h.admin.id))).statusCode).toBe(200);
  });

  it('the token bucket refills over time', () => {
    let now = 0;
    const buckets = new TokenBuckets({ capacity: 2, refillPerSecond: 1 }, () => now);
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    expect(buckets.retryAfter('a')).toBe(1);
    now = 1500;
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    expect(buckets.take('b')).toBe(true);
  });
});

describe('login page: media-server sign-in and Plex linking', () => {
  it('GET /auth/status reports the first enabled server with sign-in enabled', async () => {
    const h = await app();
    expect((await h.get('/auth/status')).json().mediaServerLogin).toBeNull();
    configureServer(h.db, h.servers, 'jellyfin', { name: 'Den' });
    expect((await h.get('/auth/status')).json().mediaServerLogin).toEqual({ kind: 'jellyfin', name: 'Den' });
    configureServer(h.db, h.servers, 'jellyfin', { name: 'Den', loginEnabled: false });
    expect((await h.get('/auth/status')).json().mediaServerLogin).toBeNull();
  });

  it('POST /user/me/mediaserver/plex/pin + poll link the signed-in user without a new session', async () => {
    const h = await app();
    const user = addUser(h.db, { permissions: P.REQUEST });
    const cookie = h.cookieFor(user.id);
    expect((await h.server.inject({ method: 'POST', url: '/api/v1/user/me/mediaserver/plex/pin' })).statusCode).toBe(401);
    const pin = await h.server.inject({ method: 'POST', url: '/api/v1/user/me/mediaserver/plex/pin', headers: { cookie } });
    expect(pin.statusCode).toBe(200);
    const { id } = pin.json() as { id: number };
    const poll = () => h.server.inject({ method: 'POST', url: '/api/v1/user/me/mediaserver/plex/poll', headers: { cookie }, payload: { id } });
    expect((await poll()).statusCode).toBe(202);
    h.servers.plex.approve(id, 'linked-token', { id: 42, username: 'heidi' });
    const done = await poll();
    expect(done.statusCode).toBe(200);
    expect(done.headers['set-cookie']).toBeUndefined();
    expect(done.json()).toMatchObject({ plexToken: '********', mediaServerLink: { kind: 'plex', externalId: '42', username: 'heidi' } });
    const row = h.db.select().from(users).where(eq(users.id, user.id)).get()!;
    expect(row.settings).toMatchObject({ plexToken: 'linked-token' });

    // The same Plex account cannot be linked to a second user.
    const other = addUser(h.db, { permissions: P.REQUEST });
    const otherCookie = h.cookieFor(other.id);
    const pin2 = (await h.server.inject({ method: 'POST', url: '/api/v1/user/me/mediaserver/plex/pin', headers: { cookie: otherCookie } })).json() as { id: number };
    h.servers.plex.approve(pin2.id, 'other-token', { id: 42, username: 'heidi' });
    const conflict = await h.server.inject({ method: 'POST', url: '/api/v1/user/me/mediaserver/plex/poll', headers: { cookie: otherCookie }, payload: { id: pin2.id } });
    expect(conflict.statusCode).toBe(409);
  });
});
