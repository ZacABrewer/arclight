import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { Permission } from '@arclight/shared';
import { mediaRequests } from '../../db/schema.js';
import { authServiceFor, installAuth } from '../auth/index.js';
import { MediaServersService, setMediaServersService } from '../media-servers/index.js';
import { requestsModuleWith } from '../requests/index.js';
import { addUser, setup } from '../requests/test-support.js';
import { mediaServerUsers, watchEvents, watchHistoryModule, watchState } from '../watch-history/index.js';
import { addMovie, addSeries, FakeJellyfin } from '../watch-history/test-support.js';
import { jellyfinPluginModule } from './index.js';

const ALICE = 'aaaaaaaa1111aaaa1111aaaaaaaaaaaa';
const CAROL = 'cccccccc3333cccc3333cccccccccccc';

async function build(opts: { createUsers?: boolean } = {}) {
  const h = await setup();
  const fake = new FakeJellyfin();
  const servers = new MediaServersService({ db: h.db, fetch: fake.fetch, newId: () => 'jf1' });
  setMediaServersService(h.ctx, servers);
  servers.create({ kind: 'jellyfin', name: 'Den', url: 'http://jellyfin.test', apiKey: fake.apiKey, loginEnabled: true, createUsersOnLogin: opts.createUsers ?? false });
  servers.rememberRemoteId('jf1', fake.serverId);
  addUser(h.db, { role: 'admin', username: 'owner' });
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (api) => {
      installAuth(api, h.ctx);
      await api.register(requestsModuleWith({})(h.ctx));
      await api.register(watchHistoryModule(h.ctx));
      await api.register(jellyfinPluginModule(h.ctx));
      // Stand-in for every other admin route.
      api.get('/series', async () => []);
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
  const auth = authServiceFor(h.ctx);
  const key = auth.createPluginKey('test').key;
  const alice = addUser(h.db, {
    username: 'alice',
    permissions: Permission.REQUEST,
    settings: { mediaServerLink: { kind: 'jellyfin', externalId: ALICE, username: 'alice', linkedAt: '2026-01-01T00:00:00.000Z' } },
  });
  const as = (user?: string) => ({ 'x-api-key': key, ...(user ? { 'x-arclight-jellyfin-user': user } : {}) });
  return { ...h, app, fake, servers, key, alice, as, adminKey: auth.apiKey() };
}

describe('Jellyfin plugin API: auth', () => {
  it('confines plugin keys to /api/v1/jellyfin/*', async () => {
    const t = await build();
    const ping = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/ping', headers: t.as() });
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toMatchObject({ serverName: 'Arclight', linkedUsers: 1, features: expect.arrayContaining(['events', 'request']) });
    expect(authServiceFor(t.ctx).listPluginKeys()[0]!.lastPingAt).not.toBeNull();

    expect((await t.app.inject({ method: 'GET', url: '/api/v1/series', headers: t.as() })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/request', headers: t.as() })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/settings/jellyfinplugin/keys', headers: t.as(), payload: {} })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/ping', headers: { 'x-api-key': 'alj_wrong' } })).statusCode).toBe(401);
    // The admin key manages plugin keys; the secret is shown once.
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/settings/jellyfinplugin/keys', headers: { 'x-api-key': t.adminKey }, payload: { name: 'Living room' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().key).toMatch(/^alj_/);
    const overview = await t.app.inject({ method: 'GET', url: '/api/v1/settings/jellyfinplugin', headers: { 'x-api-key': t.adminKey } });
    expect(JSON.stringify(overview.json())).not.toContain(created.json().key);
    expect(overview.json()).toMatchObject({ manifestUrl: 'https://arclight.moviemethat.com/jellyfin/manifest.json', servers: [{ serverId: 'jf1', remoteId: t.fake.serverId }] });
  });

  it('needs the user header, refuses unlinked users and imports them when sign-in may create users', async () => {
    const t = await build();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/watchlist', headers: t.as() })).json()).toMatchObject({ code: 'missing_user' });
    const refused = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/watchlist', headers: t.as(CAROL) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'not_linked' });

    const u = await build({ createUsers: true });
    u.fake.account(CAROL, 'carol');
    const ok = await u.app.inject({ method: 'GET', url: '/api/v1/jellyfin/watchlist', headers: u.as(CAROL.toUpperCase()) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ items: [] });
    expect((await u.app.inject({ method: 'GET', url: '/api/v1/jellyfin/ping', headers: u.as() })).json().linkedUsers).toBe(2);
  });
});

describe('Jellyfin plugin API: events', () => {
  it('ingests a batch, dedupes resent events and throttles progress', async () => {
    const t = await build();
    const movieId = addMovie(t.db, 603, 'The Matrix');
    const item = { id: 'm1', type: 'Movie', name: 'The Matrix', providerIds: { Tmdb: '603' }, runTimeTicks: 81_600_000_000 };
    const ev = (type: string, at: string, extra: Record<string, unknown> = {}) => ({ type, at, jellyfinUserId: ALICE, userName: 'alice', item, sessionId: 'sess1', client: 'Web', deviceName: 'Firefox', playMethod: 'DirectPlay', ...extra });
    const events = [
      ev('playbackStart', '2026-06-01T10:00:00Z', { positionTicks: 0 }),
      ev('playbackProgress', '2026-06-01T10:00:20Z', { positionTicks: 200_000_000 }),
      ev('playbackProgress', '2026-06-01T10:02:00Z', { positionTicks: 1_200_000_000 }),
      ev('playbackStop', '2026-06-01T11:30:00Z', { positionTicks: 81_600_000_000, played: true }),
      { type: 'itemAdded', at: '2026-06-01T11:31:00Z', item },
    ];
    const unknown = await t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/events', headers: t.as(), payload: { serverId: 'nope', events } });
    expect(unknown.statusCode).toBe(404);
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/events', headers: t.as(), payload: { serverId: t.fake.serverId.toUpperCase(), events } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 5 });
    const again = await t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/events', headers: t.as(), payload: { serverId: t.fake.serverId, events } });
    expect(again.json()).toEqual({ accepted: 5 });

    const stored = t.db.select().from(watchEvents).all();
    // Once each, and the progress 20 s after the start is not stored (the one at 2 min is).
    expect(stored.filter((e) => e.type === 'progress')).toHaveLength(1);
    expect(stored.filter((e) => e.type === 'start' || e.type === 'stop' || e.type === 'played')).toHaveLength(3);
    expect(stored.find((e) => e.type === 'stop')).toMatchObject({ movieId, client: 'Web', device: 'Firefox', playMethod: 'DirectPlay', source: 'plugin' });
    const account = t.db.select().from(mediaServerUsers).get()!;
    expect(account).toMatchObject({ externalId: ALICE, name: 'alice' });
    expect(t.db.select().from(watchState).get()).toMatchObject({ itemKey: `movie:${movieId}`, played: true, playCount: 1, positionMs: 0 });

    // History shows under the linked user; "now playing" is empty after the stop.
    const history = await t.app.inject({ method: 'GET', url: '/api/v1/watchhistory', headers: { 'x-api-key': t.adminKey } });
    expect(history.json().records[0].user).toMatchObject({ arclightUserId: t.alice.id });
  });

  it('applies userDataSaved changes and user events', async () => {
    const t = await build();
    addMovie(t.db, 603, 'The Matrix');
    const item = { id: 'm1', type: 'Movie', name: 'The Matrix', providerIds: { Tmdb: '603' } };
    const post = (events: unknown[]) => t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/events', headers: t.as(), payload: { serverId: t.fake.serverId, events } });
    await post([{ type: 'userDataSaved', at: '2026-06-01T10:00:00Z', jellyfinUserId: ALICE, item, played: true, playCount: 1, isFavorite: true }]);
    await post([{ type: 'userDataSaved', at: '2026-06-01T11:00:00Z', jellyfinUserId: ALICE, item, played: false }]);
    expect(t.db.select().from(watchEvents).all().map((e) => e.type)).toEqual(['played', 'unplayed']);
    expect(t.db.select().from(watchState).get()).toMatchObject({ played: false, favorite: true });

    await post([{ type: 'userUpdated', at: '2026-06-01T12:00:00Z', jellyfinUserId: ALICE, userName: 'alice2' }]);
    const link = (await t.app.inject({ method: 'GET', url: `/api/v1/user/${t.alice.id}/requestsettings`, headers: { 'x-api-key': t.adminKey } })).json().mediaServerLink;
    expect(link.username).toBe('alice2');
    await post([{ type: 'userDeleted', at: '2026-06-01T13:00:00Z', jellyfinUserId: ALICE }]);
    expect(t.db.select().from(mediaServerUsers).get()!.deleted).toBe(true);
    const after = (await t.app.inject({ method: 'GET', url: `/api/v1/user/${t.alice.id}/requestsettings`, headers: { 'x-api-key': t.adminKey } })).json();
    expect(after.mediaServerLink).toBeUndefined();
  });
});

describe('Jellyfin plugin API: per-user actions', () => {
  it('requests as the linked user, honouring permissions and request types', async () => {
    const t = await build();
    t.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/request', headers: t.as(ALICE), payload: { mediaType: 'movie', tmdbId: 603 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'pending', requestedBy: { id: t.alice.id } });

    const noRights = addUser(t.db, {
      username: 'dave',
      permissions: Permission.NONE,
      settings: { mediaServerLink: { kind: 'jellyfin', externalId: 'dddd', username: 'dave', linkedAt: '2026-01-01T00:00:00.000Z' } },
    });
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/request', headers: t.as('dddd'), payload: { mediaType: 'movie', tmdbId: 603 } })).statusCode).toBe(403);
    const filtered = addUser(t.db, {
      username: 'erin',
      permissions: Permission.REQUEST,
      settings: { requestTypes: { movie: false }, mediaServerLink: { kind: 'jellyfin', externalId: 'eeee', username: 'erin', linkedAt: '2026-01-01T00:00:00.000Z' } },
    });
    const refused = await t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/request', headers: t.as('eeee'), payload: { mediaType: 'movie', tmdbId: 603 } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toContain('movie requests are turned off');
    expect(noRights.id).not.toBe(filtered.id);
  });

  it('answers status badges for library items with their request', async () => {
    const t = await build();
    addMovie(t.db, 603, 'The Matrix');
    const seriesId = addSeries(t.db, 1399, 121361, 'Thrones', [2]);
    t.db
      .insert(mediaRequests)
      .values({ type: 'movie', status: 'approved', tmdbId: 603, title: 'The Matrix', tags: [], requestedById: t.alice.id, is4k: false, createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' })
      .run();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/jellyfin/status',
      headers: t.as(ALICE),
      payload: {
        items: [
          { id: 'm1', type: 'Movie', providerIds: { Tmdb: '603' } },
          { id: 's1', type: 'Series', providerIds: { Tvdb: '121361' } },
          { id: 'x', type: 'MusicAlbum', providerIds: {} },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const [movie, show, album] = res.json().items;
    expect(movie).toMatchObject({ id: 'm1', inLibrary: true, monitored: true, request: { status: 'approved', requestedBy: 'alice', is4k: false } });
    expect(show).toMatchObject({ id: 's1', inLibrary: true, missingEpisodes: 2 });
    expect(album).toEqual({ id: 'x', inLibrary: false });
    expect(seriesId).toBeGreaterThan(0);

    // GET looks the ids up on the Jellyfin server first.
    t.fake.item({ Id: 'm1', Name: 'The Matrix', Type: 'Movie', ProviderIds: { Tmdb: '603' } });
    const byId = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/status?items=m1,unknown', headers: t.as(ALICE) });
    expect(byId.json().items).toMatchObject([{ id: 'm1', inLibrary: true }, { id: 'unknown', inLibrary: false }]);
  });

  it('manages the watchlist: plugin adds, lists and removes only its own items', async () => {
    const t = await build();
    t.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const added = await t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/watchlist', headers: t.as(ALICE), payload: { mediaType: 'movie', tmdbId: 603 } });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ mediaType: 'movie', tmdbId: 603, title: 'The Matrix', source: 'jellyfin' });
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/watchlist', headers: t.as(ALICE) });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toHaveProperty('addedAt');
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/jellyfin/watchlist?mediaType=movie&tmdbId=603', headers: t.as(ALICE) })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/jellyfin/watchlist?mediaType=movie&tmdbId=603', headers: t.as(ALICE) })).statusCode).toBe(404);
  });

  it('reports issues as the user, with their permissions', async () => {
    const t = await build();
    t.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const payload = { mediaType: 'movie', tmdbId: 603, type: 'audio', message: 'Out of sync' };
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/issue', headers: t.as(ALICE), payload })).statusCode).toBe(403);
    addUser(t.db, {
      username: 'frank',
      permissions: Permission.CREATE_ISSUES,
      settings: { mediaServerLink: { kind: 'jellyfin', externalId: 'ffff', username: 'frank', linkedAt: '2026-01-01T00:00:00.000Z' } },
    });
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/jellyfin/issue', headers: t.as('ffff'), payload });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: 'audio', mediaTmdbId: 603, comments: [{ message: 'Out of sync' }] });
  });
});
