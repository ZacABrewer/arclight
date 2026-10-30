import { describe, expect, it } from 'vitest';
import { Permission as P } from '@arclight/shared';
import { addUser, buildApp } from './test-support.js';

async function app() {
  const h = await buildApp();
  h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addSeries({ tmdbId: 1399, title: 'Thrones', year: 2011, seasons: [0, 2] });
  const admin = addUser(h.db, { role: 'admin', username: 'boss' });
  const user = addUser(h.db, { username: 'viewer', permissions: P.REQUEST | P.CREATE_ISSUES });
  return { ...h, admin, user, adminCookie: h.cookieFor(admin.id), userCookie: h.cookieFor(user.id) };
}

describe('requests routes', () => {
  it('refuses anonymous callers', async () => {
    const { app: server } = await app();
    expect((await server.inject({ method: 'GET', url: '/api/v1/request' })).statusCode).toBe(401);
  });

  it('lets role user create requests (allowUser) and answers 201 then 202', async () => {
    const h = await app();
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.userCookie }, payload: { mediaType: 'series', tmdbId: 1399, seasons: [1] } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'pending', requestedBy: { username: 'viewer' } });
    const again = await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.userCookie }, payload: { mediaType: 'series', tmdbId: 1399, seasons: [1] } });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ message: 'no seasons available to request' });
  });

  it('maps permission, duplicate, validation and not-found errors', async () => {
    const h = await app();
    const create = (payload: unknown, cookie = h.userCookie) => h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie }, payload: payload as object });
    expect((await create({ mediaType: 'movie', tmdbId: 603 })).statusCode).toBe(201);
    expect((await create({ mediaType: 'movie', tmdbId: 603 })).statusCode).toBe(409);
    expect((await create({ mediaType: 'movie', tmdbId: 9999 })).statusCode).toBe(404);
    expect((await create({ mediaType: 'film', tmdbId: 1 })).statusCode).toBe(400);
    const id = (await h.app.inject({ method: 'GET', url: '/api/v1/request', headers: { cookie: h.userCookie } })).json().results[0].id;
    const approve = await h.app.inject({ method: 'POST', url: `/api/v1/request/${id}/approve`, headers: { cookie: h.userCookie } });
    expect(approve.statusCode).toBe(403);
    expect(approve.json().code).toBe('FORBIDDEN');
  });

  it('admins approve and decline; the list is scoped for users', async () => {
    const h = await app();
    const other = addUser(h.db, { permissions: P.REQUEST });
    await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.userCookie }, payload: { mediaType: 'movie', tmdbId: 603 } });
    await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.cookieFor(other.id) }, payload: { mediaType: 'series', tmdbId: 1399, seasons: 'all' } });
    const all = (await h.app.inject({ method: 'GET', url: '/api/v1/request?filter=pending', headers: { cookie: h.adminCookie } })).json();
    expect(all.pageInfo.total).toBe(2);
    const mine = (await h.app.inject({ method: 'GET', url: '/api/v1/request', headers: { cookie: h.userCookie } })).json();
    expect(mine.results.map((r: { mediaTitle: string }) => r.mediaTitle)).toEqual(['The Matrix']);
    const searched = (await h.app.inject({ method: 'GET', url: '/api/v1/request?q=the.matrix', headers: { cookie: h.adminCookie } })).json();
    expect(searched.results.map((r: { mediaTitle: string }) => r.mediaTitle)).toEqual(['The Matrix']);
    expect(searched.pageInfo.total).toBe(1);
    const [series, movie] = all.results as { id: number }[];
    const approved = await h.app.inject({ method: 'POST', url: `/api/v1/request/${movie!.id}/approve`, headers: { cookie: h.adminCookie } });
    expect(approved.json()).toMatchObject({ status: 'approved' });
    const declined = await h.app.inject({ method: 'POST', url: `/api/v1/request/${series!.id}/decline`, headers: { cookie: h.adminCookie }, payload: { reason: 'no' } });
    expect(declined.json()).toMatchObject({ status: 'declined', declineReason: 'no' });
    const count = (await h.app.inject({ method: 'GET', url: '/api/v1/request/count', headers: { cookie: h.adminCookie } })).json();
    expect(count).toMatchObject({ total: 2, approved: 1, declined: 1 });
  });

  it('approve accepts override options over HTTP and validates them', async () => {
    const h = await app();
    await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.userCookie }, payload: { mediaType: 'series', tmdbId: 1399, seasons: [1] } });
    const id = (await h.app.inject({ method: 'GET', url: '/api/v1/request', headers: { cookie: h.adminCookie } })).json().results[0].id;
    const approve = (payload: unknown, cookie = h.adminCookie) =>
      h.app.inject({ method: 'POST', url: `/api/v1/request/${id}/approve`, headers: { cookie }, payload: payload as object });
    expect((await approve({ monitorOption: 'sometimes' })).statusCode).toBe(400);
    expect((await approve({ seasons: [] })).statusCode).toBe(400);
    expect((await approve({ monitorOption: 'all', seasons: [2] }, h.userCookie)).statusCode).toBe(403);
    const ok = await approve({ monitorOption: 'all', seasons: [1] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'approved', seasons: [{ seasonNumber: 1, status: 'approved' }] });
  });

  it('quota, permissions and personal settings follow self-or-manager rules', async () => {
    const h = await app();
    const other = addUser(h.db);
    const self = await h.app.inject({ method: 'GET', url: `/api/v1/user/${h.user.id}/quota`, headers: { cookie: h.userCookie } });
    expect(self.statusCode).toBe(200);
    expect(self.json()).toMatchObject({ exempt: false, status: { movie: { used: 0 } } });
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/user/${other.id}/quota`, headers: { cookie: h.userCookie } })).statusCode).toBe(403);
    const setQuota = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/user/${h.user.id}/quota`,
      headers: { cookie: h.adminCookie },
      payload: { movieLimit: 3, movieDays: 7, tvLimit: null, tvDays: null },
    });
    expect(setQuota.json().effective.movieLimit).toBe(3);
    expect((await h.app.inject({ method: 'PUT', url: `/api/v1/user/${h.user.id}/permissions`, headers: { cookie: h.userCookie }, payload: { permissions: P.MANAGE_REQUESTS } })).statusCode).toBe(403);
    const perms = await h.app.inject({ method: 'PUT', url: `/api/v1/user/${h.user.id}/permissions`, headers: { cookie: h.adminCookie }, payload: { permissions: P.REQUEST | P.ADMIN } });
    expect(perms.json()).toMatchObject({ permissions: P.REQUEST }); // ADMIN follows the role

    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/user/${h.user.id}/requestsettings`,
      headers: { cookie: h.userCookie },
      payload: { plexToken: 'plex-secret', watchlistSyncMovies: true, notifications: { discordEnabled: true, discordWebhookUrl: 'https://discord.test/x' } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().plexToken).toBe('********');
    const keep = await h.app.inject({ method: 'PUT', url: `/api/v1/user/${h.user.id}/requestsettings`, headers: { cookie: h.userCookie }, payload: { plexToken: '********' } });
    expect(keep.json().plexToken).toBe('********');
    const { users } = await import('../../db/schema.js');
    const row = h.db.select().from(users).all().find((u) => u.id === h.user.id)!;
    expect((row.settings as Record<string, unknown>)['plexToken']).toBe('plex-secret');
  });

  it('settings are readable by users but only writable with MANAGE_SETTINGS', async () => {
    const h = await app();
    const read = await h.app.inject({ method: 'GET', url: '/api/v1/settings/requests', headers: { cookie: h.userCookie } });
    expect(read.json()).toMatchObject({ partialRequestsEnabled: true });
    const body = { ...read.json(), hideAvailable: true };
    expect((await h.app.inject({ method: 'PUT', url: '/api/v1/settings/requests', headers: { cookie: h.userCookie }, payload: body })).statusCode).toBe(403);
    const saved = await h.app.inject({ method: 'PUT', url: '/api/v1/settings/requests', headers: { cookie: h.adminCookie }, payload: body });
    expect(saved.json().hideAvailable).toBe(true);
  });

  it('serves discover pages, title detail, sliders, issues and watchlist over HTTP', async () => {
    const h = await app();
    const movies = await h.app.inject({ method: 'GET', url: '/api/v1/discover/movies?page=1', headers: { cookie: h.userCookie } });
    expect(movies.json().results[0]).toMatchObject({ tmdbId: 603, mediaStatus: 'unknown' });
    const detail = await h.app.inject({ method: 'GET', url: '/api/v1/discover/tv/1399', headers: { cookie: h.userCookie } });
    expect(detail.json()).toMatchObject({ title: 'Thrones', canRequest: true });
    const sliders = await h.app.inject({ method: 'GET', url: '/api/v1/discoverslider', headers: { cookie: h.userCookie } });
    // Every built-in but Recently added (the user lacks View recently added).
    expect(sliders.json()).toHaveLength(16);
    const issue = await h.app.inject({ method: 'POST', url: '/api/v1/issue', headers: { cookie: h.userCookie }, payload: { type: 'video', mediaType: 'movie', tmdbId: 603, message: 'pixelated' } });
    expect(issue.statusCode).toBe(201);
    const comment = await h.app.inject({ method: 'POST', url: `/api/v1/issue/${issue.json().id}/comment`, headers: { cookie: h.adminCookie }, payload: { message: 'on it' } });
    expect(comment.json().comments).toHaveLength(2);
    const wl = await h.app.inject({ method: 'POST', url: '/api/v1/watchlist', headers: { cookie: h.userCookie }, payload: { mediaType: 'movie', tmdbId: 603 } });
    expect(wl.statusCode).toBe(201);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/watchlist/sync', headers: { cookie: h.userCookie } })).statusCode).toBe(403);
    const rule = await h.app.inject({ method: 'POST', url: '/api/v1/overriderule', headers: { cookie: h.adminCookie }, payload: { name: 'anime', mediaType: 'series', keywords: [210024] } });
    expect(rule.statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/overriderule', headers: { cookie: h.userCookie } })).statusCode).toBe(403);
  });
});
