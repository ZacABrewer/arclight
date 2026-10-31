import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NotificationEvent } from '@arclight/notifications';
import { ALL_REQUEST_TYPES, Permission as P, RequestsSettings } from '@arclight/shared';
import { users } from '../../db/schema.js';
import { authServiceFor } from '../auth/index.js';
import { setSection } from '../settings/service.js';
import { FakeAudioLibrary, OK_COMPUTER, PHM, fakeAudioSources, fixtureFetch, seedAudioLibrary } from './audio-test-support.js';
import { MOVIE, languageHarness } from './language-test-support.js';
import { configureServer, FakeMediaServers } from './media-server-fakes.js';
import { mediaRequests } from './schema.js';
import { requestTypeAllowed } from './permissions.js';
import { addUser, buildApp, setup } from './test-support.js';
import type { WatchlistProvider } from './watchlist.js';

// Per-user request type filter (users.settings.requestTypes): it only ever denies, the
// permission bits still decide the rest, and ADMIN is never filtered.

const off = (...types: Array<keyof typeof ALL_REQUEST_TYPES>) => ({ requestTypes: Object.fromEntries(types.map((t) => [t, false])) });

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe('request type rule', () => {
  it('denies a type turned off, never grants, and does not filter admins', () => {
    expect(requestTypeAllowed({ permissions: P.REQUEST, settings: {} }, 'music')).toBe(true);
    expect(requestTypeAllowed({ permissions: P.REQUEST, settings: off('music') }, 'music')).toBe(false);
    expect(requestTypeAllowed({ permissions: P.REQUEST, settings: off('music') }, 'audiobook')).toBe(true);
    expect(requestTypeAllowed({ permissions: P.ADMIN, settings: off('music') }, 'music')).toBe(true);
    // Malformed values count as every type on; system callers pass no settings.
    expect(requestTypeAllowed({ permissions: P.REQUEST, settings: { requestTypes: 'nope' } }, 'movie')).toBe(true);
    expect(requestTypeAllowed({ permissions: P.NONE, settings: null }, 'movie')).toBe(true);
  });
});

describe('movie and series requests', () => {
  async function harness() {
    const h = await setup();
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addSeries({ tmdbId: 1399, title: 'Thrones', year: 2011, seasons: [0, 2] });
    return h;
  }

  it('a type turned off answers 403 even with REQUEST; the other type still works', async () => {
    const h = await harness();
    const user = addUser(h.db, { permissions: P.REQUEST, settings: off('movie') });
    await expect(h.services.requests.create(user.actor, { mediaType: 'movie', tmdbId: 603 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'movie requests are turned off for this user',
    });
    const outcome = await h.services.requests.create(user.actor, { mediaType: 'series', tmdbId: 1399, seasons: 'all' });
    expect(outcome.kind).toBe('created');
  });

  it('series turned off refuses series; with every type on REQUEST decides', async () => {
    const h = await harness();
    const noSeries = addUser(h.db, { permissions: P.REQUEST, settings: off('series') });
    await expect(h.services.requests.create(noSeries.actor, { mediaType: 'series', tmdbId: 1399, seasons: 'all' })).rejects.toMatchObject({
      message: 'series requests are turned off for this user',
    });
    const plain = addUser(h.db, { permissions: P.REQUEST });
    expect((await h.services.requests.create(plain.actor, { mediaType: 'movie', tmdbId: 603 })).kind).toBe('created');
  });

  it('turning a type on never grants it', async () => {
    const h = await harness();
    const user = addUser(h.db, { permissions: P.REQUEST_TV, settings: { requestTypes: ALL_REQUEST_TYPES } });
    await expect(h.services.requests.create(user.actor, { mediaType: 'movie', tmdbId: 603 })).rejects.toMatchObject({ message: 'not allowed to request movies' });
  });

  it('admins are not filtered', async () => {
    const h = await harness();
    const admin = addUser(h.db, { role: 'admin', settings: off('movie', 'series') });
    expect((await h.services.requests.create(admin.actor, { mediaType: 'movie', tmdbId: 603 })).kind).toBe('created');
  });

  it('requests on behalf of a user apply that user’s filter, not the caller’s', async () => {
    const h = await harness();
    const manager = addUser(h.db, { permissions: P.REQUEST | P.MANAGE_REQUESTS, settings: off('movie') });
    const kid = addUser(h.db, { permissions: P.REQUEST, settings: off('series') });
    await expect(h.services.requests.create(manager.actor, { mediaType: 'series', tmdbId: 1399, seasons: 'all', userId: kid.id })).rejects.toMatchObject({
      message: 'series requests are turned off for this user',
    });
    // The manager's own movie filter does not apply to a request made for the kid.
    expect((await h.services.requests.create(manager.actor, { mediaType: 'movie', tmdbId: 603, userId: kid.id })).kind).toBe('created');
  });

  it('watchlist sync does not auto-request a type turned off', async () => {
    const remote = [
      { mediaType: 'movie' as const, title: 'The Matrix', tmdbId: 603 },
      { mediaType: 'series' as const, title: 'Thrones', tmdbId: 1399 },
    ];
    const fake: WatchlistProvider = { source: 'plex', fetch: async (_u, s) => (s.plexToken ? remote : null) };
    const h = await setup({ watchlistProviders: [fake] });
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addSeries({ tmdbId: 1399, title: 'Thrones', year: 2011, seasons: [0, 2] });
    addUser(h.db, {
      permissions: P.REQUEST | P.AUTO_REQUEST,
      settings: { plexToken: 't', watchlistSyncMovies: true, watchlistSyncSeries: true, ...off('movie') },
    });
    expect(await h.services.watchlist.sync()).toEqual({ users: 1, added: 2, requested: 1 });
    expect(h.db.select().from(mediaRequests).all().map((r) => r.type)).toEqual(['series']);
  });
});

describe('music and audiobook requests', () => {
  async function harness() {
    const net = fixtureFetch();
    let library!: FakeAudioLibrary;
    const events: NotificationEvent[] = [];
    const h = await setup({
      extra: {
        audioSources: fakeAudioSources(net.fetchImpl),
        audioLibrary: {
          addArtist: (req) => library.addArtist(req),
          refreshArtist: (id) => library.refreshArtist(id),
          addAuthor: (req) => library.addAuthor(req),
          addBook: (req) => library.addBook(req),
          search: (kind, ids) => library.search(kind, ids),
        },
        systemDispatch: async (event) => {
          events.push(event);
          return [];
        },
      },
    });
    library = new FakeAudioLibrary(h.db);
    seedAudioLibrary(h.db);
    return h;
  }

  it('music turned off answers 403 with REQUEST; audiobooks still work; admins pass', async () => {
    const h = await harness();
    const user = addUser(h.db, { permissions: P.REQUEST, settings: off('music') });
    await expect(h.services.audio.create(user.actor, { kind: 'album', foreignId: OK_COMPUTER })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'music requests are turned off for this user',
    });
    expect((await h.services.audio.create(user.actor, { kind: 'book', foreignId: PHM })).status).toBe('pending');
    const admin = addUser(h.db, { role: 'admin', settings: off('music') });
    expect(await code(h.services.audio.create(admin.actor, { kind: 'album', foreignId: OK_COMPUTER }))).toBeUndefined();
  });

  it('audiobooks turned off refuses books, also on behalf of that user', async () => {
    const h = await harness();
    const user = addUser(h.db, { permissions: P.REQUEST, settings: off('audiobook') });
    const manager = addUser(h.db, { permissions: P.MANAGE_REQUESTS | P.REQUEST });
    await expect(h.services.audio.create(manager.actor, { kind: 'book', foreignId: PHM, userId: user.id })).rejects.toMatchObject({
      message: 'audiobook requests are turned off for this user',
    });
  });
});

describe('subtitle and audio language requests', () => {
  it('subtitles allowed and audio turned off: options say so and create follows the kind', async () => {
    const h = await languageHarness();
    const user = addUser(h.db, { permissions: P.REQUEST, settings: off('audioLanguages') });
    const options = h.service.options(user.actor, { mediaType: 'movie', tmdbId: MOVIE.tmdbId });
    expect(options).toMatchObject({ canRequest: true, canRequestSubtitles: true, canRequestAudio: false });
    expect((await h.service.create(user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'es' })).kind).toBe('subtitle');
    await expect(h.service.create(user.actor, { kind: 'audio', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'de' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'audio language requests are turned off for this user',
    });
  });

  it('both kinds off: canRequest is false and subtitles are refused; admins keep both', async () => {
    const h = await languageHarness();
    const user = addUser(h.db, { permissions: P.REQUEST, settings: off('subtitles', 'audioLanguages') });
    expect(h.service.options(user.actor, { mediaType: 'movie', tmdbId: MOVIE.tmdbId })).toMatchObject({ canRequest: false, canRequestSubtitles: false, canRequestAudio: false });
    await expect(h.service.create(user.actor, { kind: 'subtitle', mediaType: 'movie', tmdbId: MOVIE.tmdbId, language: 'es' })).rejects.toMatchObject({
      message: 'subtitle requests are turned off for this user',
    });
    const admin = addUser(h.db, { role: 'admin', settings: off('subtitles', 'audioLanguages') });
    expect(h.service.options(admin.actor, { mediaType: 'movie', tmdbId: MOVIE.tmdbId })).toMatchObject({ canRequest: true, canRequestSubtitles: true, canRequestAudio: true });
  });
});

describe('request types over HTTP', () => {
  async function app() {
    const h = await buildApp();
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addSeries({ tmdbId: 1399, title: 'Thrones', year: 2011, seasons: [0, 2] });
    const admin = addUser(h.db, { role: 'admin' });
    const user = addUser(h.db, { permissions: P.REQUEST });
    return { ...h, admin, user, adminCookie: h.cookieFor(admin.id), userCookie: h.cookieFor(user.id) };
  }

  it('managers set requestTypes on /user/:id/permissions; users cannot change their own', async () => {
    const h = await app();
    const read = await h.app.inject({ method: 'GET', url: `/api/v1/user/${h.user.id}/permissions`, headers: { cookie: h.userCookie } });
    expect(read.json().requestTypes).toEqual(ALL_REQUEST_TYPES);
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/user/${h.user.id}/permissions`,
      headers: { cookie: h.adminCookie },
      payload: { permissions: P.REQUEST, requestTypes: { music: false, subtitles: false } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().requestTypes).toEqual({ ...ALL_REQUEST_TYPES, music: false, subtitles: false });
    const lift = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/user/${h.user.id}/permissions`,
      headers: { cookie: h.userCookie },
      payload: { permissions: P.REQUEST, requestTypes: ALL_REQUEST_TYPES },
    });
    expect(lift.statusCode).toBe(403);
    // PUT /user/me (updateSelf) drops the manager-owned key.
    authServiceFor(h.ctx).updateSelf(h.user.id, { settings: { requestTypes: ALL_REQUEST_TYPES } });
    // Permission-only updates keep the filter.
    await h.app.inject({ method: 'PUT', url: `/api/v1/user/${h.user.id}/permissions`, headers: { cookie: h.adminCookie }, payload: { permissions: P.REQUEST | P.CREATE_ISSUES } });
    const again = await h.app.inject({ method: 'GET', url: `/api/v1/user/${h.user.id}/permissions`, headers: { cookie: h.adminCookie } });
    expect(again.json().requestTypes).toMatchObject({ music: false, subtitles: false, movie: true });
  });

  it('title pages tell the web the type is not requestable, and POST /request answers 403', async () => {
    const h = await app();
    await h.app.inject({ method: 'PUT', url: `/api/v1/user/${h.user.id}/permissions`, headers: { cookie: h.adminCookie }, payload: { permissions: P.REQUEST, requestTypes: { movie: false } } });
    const movie = await h.app.inject({ method: 'GET', url: '/api/v1/discover/movie/603', headers: { cookie: h.userCookie } });
    expect(movie.json()).toMatchObject({ canRequest: false, canRequest4k: false });
    const show = await h.app.inject({ method: 'GET', url: '/api/v1/discover/tv/1399', headers: { cookie: h.userCookie } });
    expect(show.json().canRequest).toBe(true);
    const adminView = await h.app.inject({ method: 'GET', url: '/api/v1/discover/movie/603', headers: { cookie: h.adminCookie } });
    expect(adminView.json().canRequest).toBe(true);
    const post = await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.userCookie }, payload: { mediaType: 'movie', tmdbId: 603 } });
    expect(post.statusCode).toBe(403);
    expect(post.json().error).toBe('movie requests are turned off for this user');
  });

  it('users created on the Users page start with the default request types', async () => {
    const h = await app();
    setSection(h.db, 'requests', RequestsSettings.parse({ defaultRequestTypes: { ...ALL_REQUEST_TYPES, music: false, audioLanguages: false } }));
    // POST /user goes through AuthService.createUser.
    const { id } = await authServiceFor(h.ctx).createUser({ username: 'newbie', password: 'long-enough-pw' });
    const read = await h.app.inject({ method: 'GET', url: `/api/v1/user/${id}/permissions`, headers: { cookie: h.adminCookie } });
    expect(read.json().requestTypes).toEqual({ ...ALL_REQUEST_TYPES, music: false, audioLanguages: false });
    // Admin accounts are not filtered and get nothing stored; explicit settings win.
    const admin = await authServiceFor(h.ctx).createUser({ username: 'second-admin', password: 'long-enough-pw', role: 'admin' });
    expect(admin.settings['requestTypes']).toBeUndefined();
    const explicit = await authServiceFor(h.ctx).createUser({ username: 'explicit', password: 'long-enough-pw', settings: { requestTypes: ALL_REQUEST_TYPES } });
    expect(explicit.settings['requestTypes']).toEqual(ALL_REQUEST_TYPES);
  });

  it('existing users without the field behave as every type on', async () => {
    const h = await app();
    setSection(h.db, 'requests', RequestsSettings.parse({ defaultRequestTypes: { ...ALL_REQUEST_TYPES, movie: false } }));
    // The default applies at creation only.
    const post = await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.userCookie }, payload: { mediaType: 'movie', tmdbId: 603 } });
    expect(post.statusCode).toBe(201);
  });
});

describe('media-server accounts', () => {
  it('a user created on first sign-in gets the default request types', async () => {
    const servers = new FakeMediaServers();
    const h = await setup({ extra: { fetch: servers.fetch, plexTvUrl: 'http://plextv.test' } });
    servers.jellyfin.users.push({ id: 'jf-new', name: 'Newcomer', password: 'pw' });
    configureServer(h.db, servers, 'jellyfin');
    setSection(h.db, 'requests', RequestsSettings.parse({ defaultRequestTypes: { ...ALL_REQUEST_TYPES, audiobook: false } }));
    const id = await h.services.accounts.login('jellyfin', 'Newcomer', 'pw');
    const row = h.db.select().from(users).where(eq(users.id, id!)).get()!;
    expect((row.settings as Record<string, unknown>)['requestTypes']).toEqual({ ...ALL_REQUEST_TYPES, audiobook: false });
  });
});
