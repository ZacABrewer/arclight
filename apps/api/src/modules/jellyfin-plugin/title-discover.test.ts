import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { Permission } from '@arclight/shared';
import { authServiceFor, installAuth } from '../auth/index.js';
import { MediaServersService, setMediaServersService } from '../media-servers/index.js';
import { requestsModuleWith } from '../requests/index.js';
import { addUser, fakeSearchResult, setup } from '../requests/test-support.js';
import { mediaServerUsers, watchHistoryModule } from '../watch-history/index.js';
import { watchState } from '../watch-history/schema.js';
import { addMovie, FakeJellyfin } from '../watch-history/test-support.js';
import { jellyfinPluginModule } from './index.js';
import { pickTrailer } from './service.js';

// Plugin 1.2: title pages, the bigger Discover (rows, recommended, genres) — all through the
// linked account's content caps.

const KID = 'kkkkkkkk1111kkkk1111kkkkkkkkkkkk';
const ADULT = 'aaaaaaaa2222aaaa2222aaaaaaaaaaaa';
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
  const key = authServiceFor(h.ctx).createPluginKey('test').key;
  const kid = addUser(h.db, {
    username: 'kid',
    permissions: Permission.REQUEST,
    settings: { contentRestrictions: { maxCertification: { movie: 'PG', tv: 'TV-PG' } }, mediaServerLink: link(KID, 'kid') },
  });
  const adult = addUser(h.db, { username: 'adult', permissions: Permission.REQUEST, settings: { mediaServerLink: link(ADULT, 'adult') } });
  const get = (user: string, url: string) =>
    app.inject({ method: 'GET', url: `/api/v1/jellyfin/${url}`, headers: { 'x-api-key': key, 'x-arclight-jellyfin-user': user } });
  return { ...h, app, get, kid, adult };
}

const MOVIES = [
  { tmdbId: 1, title: 'Kids Movie', year: 2020, certification: 'PG', genreIds: [16] },
  { tmdbId: 2, title: 'Rough Movie', year: 2021, certification: 'R', genreIds: [28] },
  { tmdbId: 3, title: 'Family Movie', year: 2022, certification: 'G', genreIds: [16] },
  { tmdbId: 4, title: 'Watched Movie', year: 2019, certification: 'PG', genreIds: [16] },
  { tmdbId: 5, title: 'Library Movie', year: 2018, certification: 'PG', genreIds: [16] },
];

function seed(t: Awaited<ReturnType<typeof build>>) {
  for (const m of MOVIES) t.tmdb.addMovie(m);
  t.tmdb.addSeries({ tmdbId: 10, title: 'Kids Show', year: 2019, certification: 'TV-Y7', seasons: [0, 3] });
  const r = (id: number) => fakeSearchResult('movie', MOVIES.find((m) => m.tmdbId === id)!);
  t.tmdb.extrasOverride.set('movie:1', {
    cast: Array.from({ length: 20 }, (_, i) => ({ tmdbId: 100 + i, name: `Actor ${i}`, ...(i === 0 ? { character: 'Hero' } : {}) })),
    crew: [
      { tmdbId: 200, name: 'Dee Rector', job: 'Director' },
      { tmdbId: 201, name: 'Pro Ducer', job: 'Producer' },
    ],
    companies: [{ tmdbId: 300, name: 'Big Studio' }],
    videos: [
      { name: 'Teaser', key: 'tease', site: 'YouTube', type: 'Teaser' },
      { name: 'Trailer', key: 'trail', site: 'YouTube', type: 'Trailer' },
    ],
    recommendations: [r(2), r(3), r(5)],
  });
  t.tmdb.extrasOverride.set('series:10', { creators: ['Show Runner'], companies: [{ tmdbId: 400, name: 'Kids Network' }] });
}

describe('Jellyfin plugin: title page', () => {
  it('maps cast (max 15), director, studios, trailer, dates and cap-filtered recommendations', async () => {
    const t = await build();
    seed(t);
    const res = await t.get(KID, 'title/movie/1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cast).toHaveLength(15);
    expect(body.cast[0]).toEqual({ name: 'Actor 0', character: 'Hero', profileUrl: null });
    expect(body.cast[1].character).toBeNull();
    expect(body.directors).toEqual(['Dee Rector']);
    expect(body.creators).toEqual([]);
    expect(body.studios).toEqual(['Big Studio']);
    expect(body.networks).toEqual([]);
    expect(body.trailer).toEqual({ site: 'YouTube', key: 'trail', url: 'https://www.youtube.com/watch?v=trail' });
    expect(body.certification).toBe('PG');
    expect(body.tagline).toBe('A tagline');
    expect(body.inLibrary).toBe(false);
    expect(body.releaseDates).toMatchObject({ firstAirDate: null, lastAirDate: null });
    // The kid's caps drop the R-rated recommendation; the rest carry status and request rights.
    expect(body.recommendations.map((x: { tmdbId: number }) => x.tmdbId)).toEqual([3, 5]);
    expect(body.recommendations[0]).toMatchObject({ mediaType: 'movie', status: 'none', canRequest: true, requestBlockedReason: null });

    const adult = (await t.get(ADULT, 'title/movie/1')).json();
    expect(adult.recommendations.map((x: { tmdbId: number }) => x.tmdbId)).toEqual([2, 3, 5]);
  });

  it('series: creators and networks; capped titles stay 404 content_restricted', async () => {
    const t = await build();
    seed(t);
    const show = (await t.get(KID, 'title/series/10')).json();
    expect(show.creators).toEqual(['Show Runner']);
    expect(show.networks).toEqual(['Kids Network']);
    expect(show.studios).toEqual([]);
    expect(show.directors).toEqual([]);
    expect(show.seasons.map((s: { seasonNumber: number }) => s.seasonNumber)).toContain(1);
    // No recommendations from TMDB: falls back to similar titles.
    expect(Array.isArray(show.recommendations)).toBe(true);

    const capped = await t.get(KID, 'title/movie/2');
    expect(capped.statusCode).toBe(404);
    expect(capped.json().code).toBe('content_restricted');
  });

  it('a series with only some seasons requested can still be requested (the other seasons)', async () => {
    const t = await build();
    seed(t);
    t.tmdb.addSeries({ tmdbId: 11, title: 'Long Show', year: 2018, certification: 'TV-PG', seasons: [0, 8, 8] });
    const before = (await t.get(ADULT, 'title/series/11')).json();
    expect(before.canRequest).toBe(true);
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/jellyfin/request',
      headers: { 'x-api-key': authServiceFor(t.ctx).createPluginKey('t2').key, 'x-arclight-jellyfin-user': ADULT },
      payload: { mediaType: 'series', tmdbId: 11, seasons: [1] },
    });
    expect([201, 202]).toContain(created.statusCode);
    const after = (await t.get(ADULT, 'title/series/11')).json();
    expect(after.seasons.find((s: { seasonNumber: number }) => s.seasonNumber === 1).status).toBe('requested');
    expect(after.canRequest).toBe(true);
    expect(after.requestBlockedReason).toBeNull();
  });

  it('picks the trailer: official YouTube trailer, else trailer, else teaser, never other sites', () => {
    expect(pickTrailer([])).toBeNull();
    expect(pickTrailer([{ name: 'x', key: 'k', site: 'Dailymotion', type: 'Trailer' }])).toBeNull();
    expect(pickTrailer([{ name: 't', key: 'v1', site: 'Vimeo', type: 'Trailer' }])).toEqual({ site: 'Vimeo', key: 'v1', url: 'https://vimeo.com/v1' });
    expect(
      pickTrailer([
        { name: 't', key: 'v1', site: 'Vimeo', type: 'Trailer' },
        { name: 'y', key: 'y1', site: 'YouTube', type: 'Trailer' },
      ])?.key,
    ).toBe('y1');
    expect(pickTrailer([{ name: 'z', key: 'z1', site: 'YouTube', type: 'Teaser' }])?.key).toBe('z1');
  });
});

describe('Jellyfin plugin: Discover rows', () => {
  it('maps every category to the right TMDB call', async () => {
    const t = await build();
    seed(t);
    const cases: Array<[string, string]> = [
      ['trending', 'trending:all:week'],
      ['trendingDay', 'trending:all:day'],
      ['popularMovies', 'list:movie:popular:1'],
      ['popularSeries', 'list:tv:popular:1'],
      ['topRatedMovies', 'list:movie:topRated:1'],
      ['topRatedSeries', 'list:tv:topRated:1'],
      ['nowPlaying', 'list:movie:nowPlaying:1'],
      ['airingToday', 'list:tv:airingToday:1'],
      ['onTheAir', 'list:tv:onTheAir:1'],
    ];
    for (const [category, call] of cases) {
      t.tmdb.calls.length = 0;
      const res = await t.get(ADULT, `discover?category=${category}`);
      expect(res.statusCode, category).toBe(200);
      expect(t.tmdb.calls, category).toContain(call);
    }
    // trendingWeek is the same list as trending (served from the discover cache).
    const week = await t.get(ADULT, 'discover?category=trendingWeek');
    expect(week.json().results).toEqual((await t.get(ADULT, 'discover?category=trending')).json().results);
    t.tmdb.calls.length = 0;
    await t.get(ADULT, 'discover?category=upcomingMovies');
    expect(t.tmdb.calls.some((c) => c.startsWith('discover:movie:') && c.includes('primary_release_date.asc'))).toBe(true);
    // Caps apply to every row.
    const kidRows = (await t.get(KID, 'discover?category=topRatedMovies')).json().results.map((r: { tmdbId: number }) => r.tmdbId);
    expect(kidRows).not.toContain(2);
  });

  it('recommended: from the watch history, without library and watched titles; trending without history', async () => {
    const t = await build();
    seed(t);
    // No history yet: trending.
    t.tmdb.calls.length = 0;
    const fallback = await t.get(ADULT, 'discover?category=recommended');
    expect(fallback.statusCode).toBe(200);
    expect(t.tmdb.calls).toContain('trending:all:week');

    addMovie(t.db, 5, 'Library Movie');
    const now = '2026-10-01T00:00:00.000Z';
    const account = t.db
      .insert(mediaServerUsers)
      .values({ serverId: 'jf1', externalId: ADULT, name: 'adult', firstSeenAt: now, updatedAt: now })
      .returning()
      .get();
    // Watched 1 (recommends 2, 3, 5) and 4.
    for (const [tmdbId, at] of [
      [1, '2026-10-02T00:00:00.000Z'],
      [4, '2026-10-01T00:00:00.000Z'],
    ] as const) {
      t.db
        .insert(watchState)
        .values({
          serverId: 'jf1',
          mediaServerUserId: account.id,
          jellyfinItemId: `jf-${tmdbId}`,
          itemType: 'movie',
          itemKey: `jf:jf-${tmdbId}`,
          tmdbId,
          title: `Movie ${tmdbId}`,
          played: true,
          playCount: 1,
          lastPlayedAt: at,
          updatedAt: at,
        })
        .run();
    }
    const ids = (await t.get(ADULT, 'discover?category=recommended')).json().results.map((r: { tmdbId: number }) => r.tmdbId);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).not.toContain(5); // in the library
    expect(ids).not.toContain(1); // watched
    expect(ids).not.toContain(4); // watched
  });

  it('genres list and genre browse with sort, paging and caps', async () => {
    const t = await build();
    seed(t);
    const genres = await t.get(KID, 'genres/movie');
    expect(genres.statusCode).toBe(200);
    expect(genres.json()).toEqual({ mediaType: 'movie', genres: [{ id: 28, name: 'Action' }, { id: 16, name: 'Animation' }] });
    expect((await t.get(KID, 'genres/tv')).json().mediaType).toBe('series');

    const sorts: Array<[string, string[]]> = [
      ['popularity', ['"sortBy":"popularity.desc"']],
      ['rating', ['"sortBy":"vote_average.desc"', '"voteCountGte":200']],
      ['releaseDate', ['"sortBy":"primary_release_date.desc"', '"releaseDateLte"']],
      ['title', ['"sortBy":"original_title.asc"']],
    ];
    for (const [sort, parts] of sorts) {
      t.tmdb.calls.length = 0;
      const res = await t.get(KID, `discover/genre/movie/16?sort=${sort}&page=2`);
      expect(res.statusCode, sort).toBe(200);
      const call = t.tmdb.calls.find((c) => c.startsWith('discover:movie:'))!;
      expect(call, sort).toContain('"withGenres":"16"');
      expect(call, sort).toContain('"page":2');
      for (const p of parts) expect(call, sort).toContain(p);
    }
    t.tmdb.calls.length = 0;
    await t.get(KID, 'discover/genre/series/16?sort=title');
    expect(t.tmdb.calls.find((c) => c.startsWith('discover:tv:'))).toContain('"sortBy":"name.asc"');

    // The fake returns every movie for any genre: the kid's caps still remove the R-rated one.
    const kid = (await t.get(KID, 'discover/genre/movie/28')).json().results.map((r: { tmdbId: number }) => r.tmdbId);
    expect(kid).not.toContain(2);
    expect((await t.get(KID, 'discover/genre/movie/16?sort=weird')).statusCode).toBe(400);
    expect((await t.get(KID, 'discover/genre/movie/0')).statusCode).toBe(400);
  });
});
