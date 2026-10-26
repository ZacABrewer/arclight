import { describe, expect, it } from 'vitest';
import { Permission as P, RequestsSettings } from '@arclight/shared';
import { setSection } from '../settings/service.js';
import { configureServer, FakeMediaServers } from './media-server-fakes.js';
import { mediaServerAvailability } from './media-server.js';
import { mediaRequests } from './schema.js';
import { addUser, giveMovieFile, giveSeasonFiles, setup } from './test-support.js';

const SHOW = { tmdbId: 1399, tvdbId: 121361, title: 'Thrones', year: 2011, seasons: [0, 2, 2] };

async function harness(kind: 'jellyfin' | 'emby' | 'plex' | null = 'jellyfin') {
  const servers = new FakeMediaServers();
  const h = await setup({ extra: { fetch: servers.fetch, plexTvUrl: 'http://plextv.test' } });
  if (kind) configureServer(h.db, servers, kind);
  setSection(h.db, 'requests', RequestsSettings.parse({ useMediaServerAvailability: true }));
  h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addSeries(SHOW);
  const user = addUser(h.db, { permissions: P.REQUEST | P.AUTO_APPROVE });
  return { ...h, servers, user };
}

async function request(h: Awaited<ReturnType<typeof harness>>, body: Parameters<typeof h.services.requests.create>[1]) {
  const out = await h.services.requests.create(h.user.actor, body);
  if (out.kind !== 'created') throw new Error('not created');
  return out.request;
}

describe('availability via the media server (useMediaServerAvailability)', () => {
  it('a movie with a file on disk is not available until Jellyfin has it; then the request completes with availableOn', async () => {
    const h = await harness('jellyfin');
    const req = await request(h, { mediaType: 'movie', tmdbId: 603 });
    giveMovieFile(h.db, 603);
    await h.services.requests.syncStatuses();
    expect(h.services.requests.get(h.user.actor, req.id)).toMatchObject({ status: 'approved', mediaStatus: 'processing', availableOn: null });
    h.servers.jellyfin.library.push({ Id: 'm603', Name: 'The Matrix', Type: 'Movie', ProviderIds: { Tmdb: '603' } });
    expect(await h.services.requests.syncStatuses()).toMatch(/1 requests completed/);
    expect(h.services.requests.get(h.user.actor, req.id)).toMatchObject({ status: 'completed', mediaStatus: 'available', availableOn: 'Jellyfin' });
    expect(h.sent.map((s) => s.event.type)).not.toContain('requestAvailable'); // no personal agents configured
  });

  it('series seasons complete one by one as the server gets every episode', async () => {
    const h = await harness('jellyfin');
    const req = await request(h, { mediaType: 'series', tmdbId: 1399, seasons: [1, 2] });
    h.servers.jellyfin.library.push({ Id: 'got', Name: 'Thrones', Type: 'Series', ProviderIds: { Tvdb: '121361' } });
    h.servers.jellyfin.episodes.set('got', [
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
      { season: 2, episode: 1 },
      { season: 2, episode: 2, virtual: true },
    ]);
    await h.services.requests.syncStatuses();
    let got = h.services.requests.get(h.user.actor, req.id);
    expect(got.status).toBe('approved');
    expect(got.seasons).toEqual([
      { seasonNumber: 1, status: 'completed' },
      { seasonNumber: 2, status: 'approved' },
    ]);
    expect(got.mediaStatus).toBe('partiallyAvailable');
    h.servers.jellyfin.episodes.get('got')![3] = { season: 2, episode: 2 };
    await h.services.requests.syncStatuses();
    got = h.services.requests.get(h.user.actor, req.id);
    expect(got).toMatchObject({ status: 'completed', mediaStatus: 'available', availableOn: 'Jellyfin' });
  });

  it('library files the server has not picked up do not complete a series', async () => {
    const h = await harness('jellyfin');
    const req = await request(h, { mediaType: 'series', tmdbId: 1399, seasons: [1] });
    giveSeasonFiles(h.db, 1399, 1);
    await h.services.requests.syncStatuses();
    expect(h.services.requests.get(h.user.actor, req.id)).toMatchObject({ status: 'approved', mediaStatus: 'processing' });
  });

  it('an unreachable server completes nothing, even when the library has the file', async () => {
    const h = await harness('jellyfin');
    const req = await request(h, { mediaType: 'movie', tmdbId: 603 });
    giveMovieFile(h.db, 603);
    h.servers.jellyfin.down = true;
    expect(await h.services.requests.syncStatuses()).toMatch(/0 requests completed/);
    expect(h.services.requests.get(h.user.actor, req.id).status).toBe('approved');
  });

  it('with no media server configured, the library decides (as before)', async () => {
    const h = await harness(null);
    const req = await request(h, { mediaType: 'movie', tmdbId: 603 });
    giveMovieFile(h.db, 603);
    await h.services.requests.syncStatuses();
    expect(h.services.requests.get(h.user.actor, req.id)).toMatchObject({ status: 'completed', availableOn: null });
  });

  it('Plex: matches library items by guid and counts episodes per season (index cached between lookups)', async () => {
    const h = await harness('plex');
    const movie = await request(h, { mediaType: 'movie', tmdbId: 603 });
    const show = await request(h, { mediaType: 'series', tmdbId: 1399, seasons: [1, 2] });
    h.servers.plex.items.push(
      { ratingKey: '10', title: 'The Matrix', type: 'movie', guids: ['imdb://tt0133093', 'tmdb://603'] },
      { ratingKey: '20', title: 'Thrones', type: 'show', guids: ['tvdb://121361'], seasons: { 1: 2, 2: 1 } },
    );
    await h.services.requests.syncStatuses();
    expect(h.services.requests.get(h.user.actor, movie.id)).toMatchObject({ status: 'completed', availableOn: 'Plex' });
    expect(h.services.requests.get(h.user.actor, show.id).seasons).toEqual([
      { seasonNumber: 1, status: 'completed' },
      { seasonNumber: 2, status: 'approved' },
    ]);
    expect(h.servers.plex.sectionRequests).toBe(2); // one per library, shared by both titles
  });

  it('Emby is asked through Settings > Media server too', async () => {
    const h = await harness('emby');
    const req = await request(h, { mediaType: 'movie', tmdbId: 603 });
    h.servers.emby.library.push({ Id: 'e603', Name: 'The Matrix', Type: 'Movie', ProviderIds: { tmdb: '603' } });
    await h.services.requests.syncStatuses();
    expect(h.services.requests.get(h.user.actor, req.id)).toMatchObject({ status: 'completed', availableOn: 'Emby' });
  });

  it('the hook reports unconfigured, absent, present and error states', async () => {
    const h = await harness(null);
    const hook = mediaServerAvailability(h.db, h.servers.fetch);
    expect(await hook.lookup!({ mediaType: 'movie', tmdbId: 603 })).toEqual({ state: 'unconfigured' });
    configureServer(h.db, h.servers, 'jellyfin', { name: 'Den' });
    expect(await hook.lookup!({ mediaType: 'movie', tmdbId: 603 })).toEqual({ state: 'absent' });
    h.servers.jellyfin.library.push({ Id: 'm', Name: 'The Matrix', Type: 'Movie', ProviderIds: { Tmdb: '603' } });
    expect(await hook.lookup!({ mediaType: 'movie', tmdbId: 603 })).toMatchObject({ state: 'present', serverName: 'Den', itemId: 'm' });
    expect(await hook.isAvailable({ mediaType: 'movie', tmdbId: 603 })).toBe(true);
    h.servers.jellyfin.down = true;
    expect((await hook.lookup!({ mediaType: 'movie', tmdbId: 603 })).state).toBe('error');
    expect(await hook.isAvailable({ mediaType: 'movie', tmdbId: 603 })).toBeNull();
  });
});

describe('Jellyfin/Emby favourites as a watchlist', () => {
  async function watchHarness(kind: 'jellyfin' | 'emby' = 'jellyfin') {
    const servers = new FakeMediaServers();
    const h = await setup({ extra: { fetch: servers.fetch, plexTvUrl: 'http://plextv.test' } });
    configureServer(h.db, servers, kind);
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addSeries(SHOW);
    const fake = kind === 'jellyfin' ? servers.jellyfin : servers.emby;
    fake.users.push({ id: 'u1', name: 'alice', password: 'pw' });
    fake.favorites.set('u1', [
      { Id: 'f1', Name: 'The Matrix', Type: 'Movie', ProductionYear: 1999, ProviderIds: { Tmdb: '603' } },
      { Id: 'f2', Name: 'Thrones', Type: 'Series', ProviderIds: { Tvdb: '121361' } },
    ]);
    return { ...h, servers, fake };
  }

  it('mirrors the linked account favourites and auto-requests them', async () => {
    const h = await watchHarness();
    const u = addUser(h.db, { permissions: P.REQUEST | P.AUTO_REQUEST, settings: { watchlistSyncMovies: true, watchlistSyncSeries: true } });
    await h.services.accounts.link(u.actor, u.id, { username: 'alice', password: 'pw' });
    expect(await h.services.watchlist.sync()).toEqual({ users: 1, added: 2, requested: 2 });
    const list = h.services.watchlist.list(u.actor);
    expect(list.map((i) => [i.tmdbId, i.source]).sort()).toEqual([
      [1399, 'jellyfin'],
      [603, 'jellyfin'],
    ]);
    const reqs = h.db.select().from(mediaRequests).all();
    expect(reqs.map((r) => [r.type, r.tmdbId, r.isAutoRequest])).toEqual(
      expect.arrayContaining([
        ['movie', 603, true],
        ['series', 1399, true],
      ]),
    );
    // The favourites were read with the user's own token.
    expect(h.servers.calls).toContain('GET jf.test/Users/u1/Items');
  });

  it('autoRequestFromWatchlist off mirrors the list but requests nothing', async () => {
    const h = await watchHarness();
    const u = addUser(h.db, { permissions: P.REQUEST | P.AUTO_REQUEST, settings: { watchlistSyncMovies: true, watchlistSyncSeries: true, autoRequestFromWatchlist: false } });
    await h.services.accounts.link(u.actor, u.id, { username: 'alice', password: 'pw' });
    expect(await h.services.watchlist.sync()).toEqual({ users: 1, added: 2, requested: 0 });
    expect(h.db.select().from(mediaRequests).all()).toHaveLength(0);
  });

  it('unlinked users and links of another kind are skipped; Emby favourites use the emby source', async () => {
    const h = await watchHarness('emby');
    addUser(h.db, { settings: { watchlistSyncMovies: true } }); // no link
    addUser(h.db, { settings: { mediaServerLink: { kind: 'jellyfin', externalId: 'u1', username: 'alice', linkedAt: 'x' } } });
    expect(await h.services.watchlist.sync()).toEqual({ users: 0, added: 0, requested: 0 });
    const linked = addUser(h.db, { permissions: P.REQUEST });
    await h.services.accounts.link(linked.actor, linked.id, { username: 'alice', password: 'pw' });
    await h.services.watchlist.sync();
    expect(h.services.watchlist.list(linked.actor).every((i) => i.source === 'emby')).toBe(true);
  });

  it('imported users without a token are read with the server API key', async () => {
    const h = await watchHarness();
    const admin = addUser(h.db, { role: 'admin' });
    const out = await h.services.accounts.importUsers(admin.actor, { externalIds: ['u1'] });
    expect(await h.services.watchlist.sync()).toMatchObject({ users: 1, added: 2 });
    expect(h.services.watchlist.list(admin.actor, out.created[0]!.id)).toHaveLength(2);
  });
});
