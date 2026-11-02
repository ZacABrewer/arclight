import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { Permission } from '@arclight/shared';
import { languageRequests, mediaRequests, movies, users } from '../../db/schema.js';
import { authServiceFor, installAuth } from '../auth/index.js';
import { MediaServersService, setMediaServersService } from '../media-servers/index.js';
import { requestsModuleWith } from '../requests/index.js';
import { SYSTEM_ACTOR } from '../requests/permissions.js';
import { addUser, setup } from '../requests/test-support.js';
import { movieCapForScore, parentalRatingToCaps, tvCapForScore } from '../watch-history/parental.js';
import { mediaServerUsers, watchHistoryModule } from '../watch-history/index.js';
import { addMovie, FakeJellyfin } from '../watch-history/test-support.js';
import { jellyfinPluginModule } from './index.js';

// What a Jellyfin user can see and request through the plugin: always exactly what the linked
// Arclight account may (content caps, permissions, request types, 4K, quotas, visibility).

const KID = 'kkkkkkkk1111kkkk1111kkkkkkkkkkkk';
const ADULT = 'aaaaaaaa2222aaaa2222aaaaaaaaaaaa';
const VIEWER = 'vvvvvvvv3333vvvv3333vvvvvvvvvvvv';

const link = (externalId: string, username: string) => ({ kind: 'jellyfin', externalId, username, linkedAt: '2026-01-01T00:00:00.000Z' });

async function build() {
  const h = await setup();
  const fake = new FakeJellyfin();
  const servers = new MediaServersService({ db: h.db, fetch: fake.fetch, newId: () => 'jf1' });
  setMediaServersService(h.ctx, servers);
  servers.create({ kind: 'jellyfin', name: 'Den', url: 'http://jellyfin.test', apiKey: fake.apiKey, loginEnabled: true });
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
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
  const auth = authServiceFor(h.ctx);
  const key = auth.createPluginKey('test').key;
  const kid = addUser(h.db, {
    username: 'kid',
    permissions: Permission.REQUEST | Permission.CREATE_ISSUES,
    settings: { contentRestrictions: { maxCertification: { movie: 'PG', tv: 'TV-PG' } }, mediaServerLink: link(KID, 'kid') },
  });
  const adult = addUser(h.db, { username: 'adult', permissions: Permission.REQUEST | Permission.CREATE_ISSUES, settings: { mediaServerLink: link(ADULT, 'adult') } });
  const viewer = addUser(h.db, { username: 'viewer', permissions: Permission.REQUEST | Permission.REQUEST_VIEW, settings: { mediaServerLink: link(VIEWER, 'viewer') } });
  h.tmdb.addMovie({ tmdbId: 1, title: 'Kids Movie', year: 2020, certification: 'PG' });
  h.tmdb.addMovie({ tmdbId: 2, title: 'Rough Movie', year: 2021, certification: 'R' });
  h.tmdb.addSeries({ tmdbId: 10, title: 'Kids Show', year: 2019, certification: 'TV-Y7', seasons: [0, 3] });
  h.tmdb.addSeries({ tmdbId: 11, title: 'Adult Show', year: 2018, certification: 'TV-MA', seasons: [0, 2] });
  const as = (user: string) => ({ 'x-api-key': key, 'x-arclight-jellyfin-user': user });
  const get = (user: string, url: string) => app.inject({ method: 'GET', url: `/api/v1/jellyfin/${url}`, headers: as(user) });
  const post = (user: string, url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1/jellyfin/${url}`, headers: as(user), payload: payload as object });
  return { ...h, app, fake, servers, key, kid, adult, viewer, as, get, post, adminKey: auth.apiKey() };
}

describe('Jellyfin plugin access: content caps', () => {
  it('filters capped titles out of search and discover, and refuses them on title, providers and actions', async () => {
    const t = await build();
    const titles = async (user: string, url: string) => (await t.get(user, url)).json().results.map((r: { title: string }) => r.title);

    expect(await titles(KID, 'search?q=movie')).toEqual(['Kids Movie']);
    expect(await titles(ADULT, 'search?q=movie')).toEqual(['Kids Movie', 'Rough Movie']);
    expect(await titles(KID, 'discover?category=popularMovies')).toEqual(['Kids Movie']);
    expect(await titles(KID, 'discover?category=popularSeries')).toEqual(['Kids Show']);
    expect((await titles(KID, 'discover?category=trending')).sort()).toEqual(['Kids Movie', 'Kids Show']);
    expect((await titles(ADULT, 'discover?category=trending')).sort()).toEqual(['Adult Show', 'Kids Movie', 'Kids Show', 'Rough Movie']);
    expect((await t.get(KID, 'discover?category=nonsense')).statusCode).toBe(400);

    const title = await t.get(KID, 'title/movie/2');
    expect(title.statusCode).toBe(404);
    expect(title.json()).toMatchObject({ code: 'content_restricted' });
    expect((await t.get(KID, 'title/movie/1')).statusCode).toBe(200);
    expect((await t.get(KID, 'providers/movie/2')).json()).toMatchObject({ code: 'content_restricted' });

    for (const [url, payload] of [
      ['request', { mediaType: 'movie', tmdbId: 2 }],
      ['issue', { mediaType: 'movie', tmdbId: 2, type: 'video', message: 'broken' }],
      ['language-request', { kind: 'subtitle', mediaType: 'movie', tmdbId: 2, language: 'es' }],
    ] as const) {
      const res = await t.post(KID, url, payload);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code, url).toBe('content_restricted');
    }
    // The same request works for an uncapped account.
    expect((await t.post(ADULT, 'request', { mediaType: 'movie', tmdbId: 2 })).statusCode).toBe(201);
  });

  it('hides request details of capped non-library titles on status badges', async () => {
    const t = await build();
    expect((await t.post(ADULT, 'request', { mediaType: 'movie', tmdbId: 2 })).statusCode).toBe(201);
    const items = [{ id: 'x2', type: 'Movie', providerIds: { Tmdb: '2' } }];
    expect((await t.post(KID, 'status', { items })).json().items).toEqual([{ id: 'x2', inLibrary: false }]);
    // A viewer sees the request and who made it; the requester sees their own.
    expect((await t.post(VIEWER, 'status', { items })).json().items[0].request).toMatchObject({ requestedBy: 'adult' });
    expect((await t.post(ADULT, 'status', { items })).json().items[0].request).toMatchObject({ requestedBy: 'adult' });
    // An account without View requests does not see other users' requests at all.
    addUser(t.db, { username: 'other', permissions: Permission.REQUEST, settings: { mediaServerLink: link('o0', 'other') } });
    expect((await t.post('o0', 'status', { items })).json().items).toEqual([{ id: 'x2', inLibrary: false }]);
  });
});

describe('Jellyfin plugin access: permissions, request types, 4K, profiles', () => {
  it('computes canRequest and requestBlockedReason from the linked account', async () => {
    const t = await build();
    addUser(t.db, { username: 'moviesonly', permissions: Permission.REQUEST_MOVIE, settings: { mediaServerLink: link('m0', 'mo') } });
    addUser(t.db, { username: 'filtered', permissions: Permission.REQUEST, settings: { requestTypes: { series: false }, mediaServerLink: link('f0', 'fi') } });
    addUser(t.db, { username: 'none', permissions: Permission.NONE, settings: { mediaServerLink: link('n0', 'no') } });
    const item = async (user: string, category: string, title: string) =>
      (await t.get(user, `discover?category=${category}`)).json().results.find((r: { title: string }) => r.title === title);

    expect(await item('m0', 'popularMovies', 'Rough Movie')).toMatchObject({ canRequest: true, requestBlockedReason: null, canRequest4k: false });
    expect(await item('m0', 'popularSeries', 'Adult Show')).toMatchObject({ canRequest: false, requestBlockedReason: 'permission' });
    expect(await item('f0', 'popularSeries', 'Adult Show')).toMatchObject({ canRequest: false, requestBlockedReason: 'request_type' });
    expect(await item('n0', 'popularMovies', 'Rough Movie')).toMatchObject({ canRequest: false, requestBlockedReason: 'permission' });

    // Requested titles say so.
    expect((await t.post(ADULT, 'request', { mediaType: 'movie', tmdbId: 2 })).statusCode).toBe(201);
    expect(await item(ADULT, 'popularMovies', 'Rough Movie')).toMatchObject({ canRequest: false, requestBlockedReason: 'requested' });

    // 4K needs the permission AND the 4K switch in Settings > Requests.
    const fourK = addUser(t.db, { username: 'uhd', permissions: Permission.REQUEST | Permission.REQUEST_4K, settings: { mediaServerLink: link('u0', 'uhd') } });
    expect(await item('u0', 'popularMovies', 'Kids Movie')).toMatchObject({ canRequest4k: false });
    const reqs = t.services.requests;
    reqs.updateSettings(SYSTEM_ACTOR, { ...reqs.settings(), movie4k: { ...reqs.settings().movie4k, enabled: true } });
    expect(await item('u0', 'popularMovies', 'Kids Movie')).toMatchObject({ canRequest4k: true });
    expect(await item(ADULT, 'popularMovies', 'Kids Movie')).toMatchObject({ canRequest4k: false });
    expect(fourK.id).toBeGreaterThan(0);
  });

  it('reports a used-up quota and offers quality profiles only to advanced requesters', async () => {
    const t = await build();
    t.db.update(users).set({ settings: { mediaServerLink: link(ADULT, 'adult'), quota: { movieLimit: 1 } } }).where(eq(users.id, t.adult.id)).run();
    expect((await t.post(ADULT, 'request', { mediaType: 'movie', tmdbId: 1 })).statusCode).toBe(201);
    const page = (await t.get(ADULT, 'discover?category=popularMovies')).json();
    expect(page.results.find((r: { tmdbId: number }) => r.tmdbId === 2)).toMatchObject({ canRequest: false, requestBlockedReason: 'quota' });

    expect((await t.get(ADULT, 'title/movie/2')).json()).toMatchObject({ canRequestAdvanced: false, qualityProfiles: [], canRequestFutureSeasons: false });
    addUser(t.db, { username: 'adv', permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED, settings: { mediaServerLink: link('ad0', 'adv') } });
    const adv = (await t.get('ad0', 'title/movie/2')).json();
    expect(adv.canRequestAdvanced).toBe(true);
    expect(adv.qualityProfiles.length).toBeGreaterThan(0);
  });
});

describe('Jellyfin plugin access: accounts', () => {
  it('refuses linked accounts that Jellyfin disabled or deleted', async () => {
    const t = await build();
    expect((await t.get(ADULT, 'watchlist')).statusCode).toBe(200);
    t.db.insert(mediaServerUsers).values({ serverId: 'jf1', externalId: ADULT, name: 'adult', disabled: true, firstSeenAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }).run();
    const res = await t.get(ADULT.toUpperCase(), 'watchlist');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'account_disabled' });
    t.db.update(mediaServerUsers).set({ disabled: false, deleted: true }).run();
    expect((await t.get(ADULT, 'search?q=movie')).json()).toMatchObject({ code: 'account_disabled' });
    t.db.update(mediaServerUsers).set({ deleted: false }).run();
    expect((await t.get(ADULT, 'watchlist')).statusCode).toBe(200);
  });

  it('mirrors Jellyfin parental controls into content caps only when the server setting is on', async () => {
    const t = await build();
    t.fake.account(KID, 'kid', { MaxParentalRating: 10 }).account(ADULT, 'adult', { MaxParentalRating: 13 }).account('stranger', 'stranger', { MaxParentalRating: 0 });
    const caps = (id: number) => (t.db.select().from(users).where(eq(users.id, id)).get()!.settings as Record<string, unknown>)['contentRestrictions'];
    const sync = () => t.app.inject({ method: 'POST', url: '/api/v1/mediaserver/jf1/usersync', headers: { 'x-api-key': t.adminKey } });

    expect((await sync()).statusCode).toBe(200);
    expect(caps(t.adult.id)).toBeUndefined(); // off by default

    const cfg = t.servers.stored()[0]!;
    t.servers.update('jf1', { ...cfg, mirrorParentalControls: true });
    const res = await sync();
    // The kid already had exactly these caps, so only the adult changes.
    expect(res.json()).toMatchObject({ status: 'ok', mirrored: 1 });
    expect(caps(t.kid.id)).toMatchObject({ maxCertification: { movie: 'PG', tv: 'TV-PG' } });
    expect(caps(t.adult.id)).toMatchObject({ maxCertification: { movie: 'PG-13', tv: 'TV-PG' }, hideAdultContent: false });
    // Manual edits are overwritten on the next sync while the setting is on.
    t.db.update(users).set({ settings: { mediaServerLink: link(ADULT, 'adult'), contentRestrictions: { maxCertification: { movie: 'R', tv: null }, hideAdultContent: true } } }).where(eq(users.id, t.adult.id)).run();
    expect((await sync()).json().mirrored).toBe(1);
    expect(caps(t.adult.id)).toEqual({ maxCertification: { movie: 'PG-13', tv: 'TV-PG' }, hideAdultContent: true });
    expect((await sync()).json().mirrored).toBe(0);
  });

  it('maps Jellyfin rating scores to US certifications', () => {
    const rows: [number | null, string | null, string | null][] = [
      [null, null, null],
      [0, 'G', 'TV-G'],
      [7, 'G', 'TV-Y7'],
      [10, 'PG', 'TV-PG'],
      [13, 'PG-13', 'TV-PG'],
      [14, 'PG-13', 'TV-14'],
      [17, 'R', null],
      [18, null, null],
    ];
    for (const [score, movie, tv] of rows) {
      expect(movieCapForScore(score), String(score)).toBe(movie);
      expect(tvCapForScore(score), String(score)).toBe(tv);
    }
    expect(parentalRatingToCaps(null, { maxCertification: { movie: 'G', tv: 'TV-Y' }, hideAdultContent: true })).toEqual({ maxCertification: { movie: null, tv: null }, hideAdultContent: true });
  });
});

describe('Jellyfin plugin: upcoming, providers, my requests', () => {
  it('lists upcoming library releases, filtered by the account caps', async () => {
    const t = await build();
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const late = new Date(Date.now() + 60 * 86_400_000).toISOString();
    const pg = addMovie(t.db, 1, 'Kids Movie');
    const r = addMovie(t.db, 2, 'Rough Movie');
    const far = addMovie(t.db, 3, 'Far Movie');
    t.db.update(movies).set({ digitalRelease: soon, certification: 'PG', images: [{ coverType: 'poster', url: '/api/v1/mediacover/1/poster.jpg', remoteUrl: 'https://img/1.jpg' }] }).where(eq(movies.id, pg)).run();
    t.db.update(movies).set({ digitalRelease: soon, certification: 'R' }).where(eq(movies.id, r)).run();
    t.db.update(movies).set({ digitalRelease: late, certification: 'G' }).where(eq(movies.id, far)).run();

    const adult = (await t.get(ADULT, 'upcoming?days=30')).json();
    expect(adult.days).toBe(30);
    expect(adult.items.map((i: { title: string }) => i.title).sort()).toEqual(['Kids Movie', 'Rough Movie']);
    expect(adult.items.find((i: { title: string }) => i.title === 'Kids Movie')).toMatchObject({ kind: 'movie', releaseType: 'digital', mediaType: 'movie', tmdbId: 1, posterUrl: 'https://img/1.jpg', hasFile: false });
    expect((await t.get(KID, 'upcoming')).json().items.map((i: { title: string }) => i.title)).toEqual(['Kids Movie']);
    expect((await t.get(ADULT, 'upcoming?days=90')).json().items).toHaveLength(3);
    expect((await t.get(ADULT, 'upcoming?days=500')).statusCode).toBe(400);
  });

  it('returns watch providers for a region with the JustWatch attribution', async () => {
    const t = await build();
    const res = await t.get(ADULT, 'providers/movie/2?region=us');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      region: 'US',
      link: 'https://www.themoviedb.org/movie/2/watch?locale=US',
      flatrate: [{ id: 8, name: 'Streamer', logoUrl: 'https://img/streamer.png' }],
      rent: [{ id: 2, name: 'Rentals', logoUrl: null }],
      buy: [],
      attribution: 'Data from JustWatch',
    });
    expect((await t.get(ADULT, 'providers/series/11?region=GB')).json()).toMatchObject({ region: 'GB', flatrate: [] });
    expect((await t.get(ADULT, 'providers/movie/2?region=USA')).statusCode).toBe(400);
  });

  it("lists only the caller's own requests and cancels only own pending ones", async () => {
    const t = await build();
    const mine = (await t.post(ADULT, 'request', { mediaType: 'movie', tmdbId: 1 })).json();
    const theirs = (await t.post(VIEWER, 'request', { mediaType: 'movie', tmdbId: 2 })).json();
    const now = new Date().toISOString();
    const lang = t.db
      .insert(languageRequests)
      .values({ kind: 'subtitle', status: 'pending', mediaType: 'movie', tmdbId: 1, title: 'Kids Movie', language: 'es', forced: 'never', hi: 'also', requestedById: t.adult.id, createdAt: now, updatedAt: now })
      .returning()
      .get();

    const list = (await t.get(ADULT, 'requests')).json();
    expect(list.total).toBe(2);
    expect(list.items.map((i: { kind: string; id: number }) => `${i.kind}:${i.id}`).sort()).toEqual([`language:${lang.id}`, `media:${mine.id}`].sort());
    expect(list.items.find((i: { kind: string }) => i.kind === 'media')).toMatchObject({ title: 'Kids Movie', status: 'pending', canCancel: true, progress: null });
    expect(list.items.find((i: { kind: string }) => i.kind === 'language')).toMatchObject({ language: { kind: 'subtitle' }, canCancel: true });
    // A viewer may see everyone's requests in Arclight, but the plugin lists only their own.
    expect((await t.get(VIEWER, 'requests')).json().items.map((i: { id: number }) => i.id)).toEqual([theirs.id]);
    expect((await t.get(ADULT, 'requests?take=1&skip=1')).json().items).toHaveLength(1);

    const del = (user: string, id: number, kind = 'media') => t.app.inject({ method: 'DELETE', url: `/api/v1/jellyfin/requests/${id}?kind=${kind}`, headers: t.as(user) });
    expect((await del(ADULT, theirs.id)).statusCode).toBe(404);
    t.db.update(mediaRequests).set({ status: 'approved' }).where(eq(mediaRequests.id, mine.id)).run();
    expect((await t.get(ADULT, 'requests')).json().items.find((i: { kind: string }) => i.kind === 'media').canCancel).toBe(false);
    expect((await del(ADULT, mine.id)).statusCode).toBe(403);
    expect((await del(ADULT, lang.id, 'language')).statusCode).toBe(204);
    expect((await del(ADULT, 999)).statusCode).toBe(404);
    expect((await t.get(ADULT, 'requests')).json().total).toBe(1);
  });
});
