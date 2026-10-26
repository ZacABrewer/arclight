import { describe, expect, it } from 'vitest';
import {
  ImdbListSettings,
  PlexWatchlistSettings,
  StevenLuSettings,
  TmdbCollectionSettings,
  TmdbKeywordSettings,
  TmdbListSettings,
  TmdbPersonSettings,
  TmdbPopularSettings,
  TraktListSettings,
  TraktPopularSettings,
  TraktUserSettings,
} from '@arclight/shared';
import { ImportListFetchError } from './errors.js';
import { parseCsv, parseFeed, parseImdbExport, providers, traktDeviceCode, traktPollToken, withTmdbErrors } from './providers/index.js';
import { request } from './providers/http.js';
import { fakeFetch, json, providerCtx, TMDB_CONFIGURATION } from './test-support.js';

const movie = (id: number, title: string, date = '2010-07-16', extra: object = {}) => ({
  id,
  title,
  release_date: date,
  media_type: 'movie',
  ...extra,
});
const tv = (id: number, name: string, date = '2008-01-20', extra: object = {}) => ({
  id,
  name,
  first_air_date: date,
  media_type: 'tv',
  ...extra,
});

describe('TMDB providers', () => {
  it('tmdbList walks every page and keeps the requested media type', async () => {
    const fetch = fakeFetch([
      [
        /\/3\/list\/42$/,
        (url) =>
          url.searchParams.get('page') === '1'
            ? { items: [movie(1, 'Inception'), tv(2, 'Breaking Bad')], total_pages: 2 }
            : { items: [movie(3, 'Tenet', '2020-08-26')], total_pages: 2 },
      ],
    ]);
    const ctx = providerCtx(fetch);
    const all = await providers.tmdbList(TmdbListSettings.parse({ listId: '42' }), 'both', ctx);
    expect(all).toEqual([
      { mediaType: 'movie', tmdbId: 1, title: 'Inception', year: 2010 },
      { mediaType: 'series', tmdbId: 2, title: 'Breaking Bad', year: 2008 },
      { mediaType: 'movie', tmdbId: 3, title: 'Tenet', year: 2020 },
    ]);
    const movies = await providers.tmdbList(TmdbListSettings.parse({ listId: '42' }), 'movie', ctx);
    expect(movies.map((m) => m.tmdbId)).toEqual([1, 3]);
    expect(fetch.calls[0]!.url.searchParams.get('api_key')).toBe('tmdb-key');
  });

  it('tmdbPopular uses the shared client discover with filters, year range and limit', async () => {
    const fetch = fakeFetch([
      TMDB_CONFIGURATION,
      [
        /\/3\/discover\/movie$/,
        () => ({
          page: 1,
          total_pages: 1,
          results: [
            { id: 10, title: 'Old', release_date: '1999-01-01' },
            { id: 11, title: 'A', release_date: '2015-01-01' },
            { id: 12, title: 'B', release_date: '2016-01-01' },
            { id: 13, title: 'C', release_date: '2017-01-01' },
          ],
        }),
      ],
    ]);
    const settings = TmdbPopularSettings.parse({ minVotes: 50, genreIds: [28, 12], languages: ['en'], yearFrom: 2010, limit: 2 });
    const items = await providers.tmdbPopular(settings, 'movie', providerCtx(fetch));
    expect(items.map((i) => i.tmdbId)).toEqual([11, 12]);
    const discover = fetch.calls.find((c) => c.url.pathname.endsWith('/discover/movie'))!;
    expect(discover.url.searchParams.get('sort_by')).toBe('popularity.desc');
    expect(discover.url.searchParams.get('vote_count.gte')).toBe('50');
    expect(discover.url.searchParams.get('with_genres')).toBe('28|12');
    expect(discover.url.searchParams.get('with_original_language')).toBe('en');
  });

  it('tmdbPopular topRated sorts by rating with a vote floor; series use discover/tv', async () => {
    const fetch = fakeFetch([TMDB_CONFIGURATION, [/\/3\/discover\/tv$/, () => ({ results: [{ id: 5, name: 'Show' }] })]]);
    const items = await providers.tmdbPopular(TmdbPopularSettings.parse({ listType: 'topRated' }), 'series', providerCtx(fetch));
    expect(items).toEqual([{ mediaType: 'series', tmdbId: 5, title: 'Show', year: null }]);
    const call = fetch.calls.find((c) => c.url.pathname.endsWith('/discover/tv'))!;
    expect(call.url.searchParams.get('sort_by')).toBe('vote_average.desc');
    expect(call.url.searchParams.get('vote_count.gte')).toBe('200');
  });

  it('tmdbPopular trending filters language and rating locally', async () => {
    const fetch = fakeFetch([
      TMDB_CONFIGURATION,
      [
        /\/3\/trending\/movie\/week$/,
        () => ({
          results: [
            { id: 1, title: 'En', original_language: 'en', vote_average: 8, vote_count: 100 },
            { id: 2, title: 'Fr', original_language: 'fr', vote_average: 9, vote_count: 100 },
            { id: 3, title: 'Low', original_language: 'en', vote_average: 4, vote_count: 100 },
          ],
        }),
      ],
    ]);
    const s = TmdbPopularSettings.parse({ listType: 'trending', languages: ['en'], minVoteAverage: 6 });
    const items = await providers.tmdbPopular(s, 'movie', providerCtx(fetch));
    expect(items.map((i) => i.tmdbId)).toEqual([1]);
  });

  it('tmdbCollection returns the parts as movies and nothing for series lists', async () => {
    const fetch = fakeFetch([[/\/3\/collection\/10$/, () => ({ parts: [{ id: 1, title: 'Part 1', release_date: '2001-01-01' }] })]]);
    const ctx = providerCtx(fetch);
    expect(await providers.tmdbCollection(TmdbCollectionSettings.parse({ collectionId: 10 }), 'movie', ctx)).toEqual([
      { mediaType: 'movie', tmdbId: 1, title: 'Part 1', year: 2001 },
    ]);
    expect(await providers.tmdbCollection(TmdbCollectionSettings.parse({ collectionId: 10 }), 'series', ctx)).toEqual([]);
  });

  it('tmdbPerson combines cast and selected crew jobs', async () => {
    const fetch = fakeFetch([
      [
        /\/3\/person\/7\/combined_credits$/,
        () => ({
          cast: [movie(1, 'Acted')],
          crew: [movie(2, 'Directed', '2000-01-01', { job: 'Director' }), tv(3, 'Produced', '2001-01-01', { job: 'Producer' })],
        }),
      ],
    ]);
    const s = TmdbPersonSettings.parse({ personId: 7, includeCrew: true, crewJobs: ['director'] });
    const items = await providers.tmdbPerson(s, 'both', providerCtx(fetch));
    expect(items.map((i) => i.tmdbId)).toEqual([1, 2]);
  });

  it('tmdbKeyword queries discover with the keyword and date range', async () => {
    const fetch = fakeFetch([[/\/3\/discover\/movie$/, () => ({ results: [{ id: 1, title: 'K' }, { id: 2, title: 'L' }], total_pages: 3 })]]);
    const s = TmdbKeywordSettings.parse({ keywordId: 9715, yearFrom: 2000, yearTo: 2010, limit: 2 });
    const items = await providers.tmdbKeyword(s, 'movie', providerCtx(fetch));
    expect(items).toHaveLength(2);
    expect(fetch.calls).toHaveLength(1);
    const q = fetch.calls[0]!.url.searchParams;
    expect(q.get('with_keywords')).toBe('9715');
    expect(q.get('primary_release_date.gte')).toBe('2000-01-01');
    expect(q.get('primary_release_date.lte')).toBe('2010-12-31');
  });

  it('maps TMDB auth failures from both the raw and the client paths', async () => {
    const fetch = fakeFetch([[/themoviedb/, () => json({ status_message: 'bad key' }, 401)]]);
    const ctx = providerCtx(fetch);
    await expect(providers.tmdbList(TmdbListSettings.parse({ listId: '1' }), 'both', ctx)).rejects.toMatchObject({ code: 'auth' });
    await expect(
      withTmdbErrors(() => providers.tmdbPopular(TmdbPopularSettings.parse({}), 'movie', ctx)),
    ).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('Trakt providers', () => {
  const auth = { clientId: 'cid' };

  it('trakt list maps wrapped items with ids and sends the api headers', async () => {
    const fetch = fakeFetch([
      [
        /api\.trakt\.tv\/users\/alice\/lists\/faves\/items\/show,movie$/,
        () => [
          { type: 'movie', movie: { title: 'Inception', year: 2010, ids: { trakt: 1, imdb: 'tt1375666', tmdb: 27205 } } },
          { type: 'show', show: { title: 'Dark', year: 2017, ids: { tvdb: 334824, tmdb: 70523 } } },
          { type: 'person', person: { name: 'x' } },
        ],
      ],
    ]);
    const items = await providers.trakt(TraktListSettings.parse({ ...auth, username: 'alice', listName: 'faves' }), 'both', providerCtx(fetch));
    expect(items).toEqual([
      { mediaType: 'movie', tmdbId: 27205, imdbId: 'tt1375666', tvdbId: null, title: 'Inception', year: 2010 },
      { mediaType: 'series', tmdbId: 70523, imdbId: null, tvdbId: 334824, title: 'Dark', year: 2017 },
    ]);
    expect(fetch.calls[0]!.headers['trakt-api-key']).toBe('cid');
    expect(fetch.calls[0]!.headers['trakt-api-version']).toBe('2');
    expect(fetch.calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('traktPopular sends filters and reads bare and wrapped rows', async () => {
    const fetch = fakeFetch([
      [/\/movies\/popular$/, () => [{ title: 'Bare', year: 2020, ids: { tmdb: 1 } }]],
      [/\/shows\/popular$/, () => [{ title: 'Bare show', year: 2019, ids: { tmdb: 2 } }]],
      [/\/movies\/trending$/, () => [{ watchers: 9, movie: { title: 'Wrapped', year: 2021, ids: { tmdb: 3 } } }]],
    ]);
    const ctx = providerCtx(fetch);
    const s = TraktPopularSettings.parse({ ...auth, yearFrom: 2010, yearTo: 2020, genres: ['action', 'drama'], minRating: 70, limit: 25 });
    const items = await providers.traktPopular(s, 'both', ctx);
    expect(items.map((i) => [i.mediaType, i.tmdbId])).toEqual([
      ['series', 2],
      ['movie', 1],
    ]);
    const q = fetch.calls[0]!.url.searchParams;
    expect(q.get('years')).toBe('2010-2020');
    expect(q.get('genres')).toBe('action,drama');
    expect(q.get('ratings')).toBe('70-100');
    expect(q.get('limit')).toBe('25');
    const trending = await providers.traktPopular(TraktPopularSettings.parse({ ...auth, listType: 'trending' }), 'movie', ctx);
    expect(trending[0]).toMatchObject({ tmdbId: 3, title: 'Wrapped' });
  });

  it('traktPopular box office never asks for shows', async () => {
    const fetch = fakeFetch([[/\/movies\/boxoffice$/, () => [{ revenue: 1, movie: { title: 'Hit', ids: { tmdb: 4 } } }]]]);
    const items = await providers.traktPopular(TraktPopularSettings.parse({ ...auth, listType: 'boxOffice' }), 'both', providerCtx(fetch));
    expect(items).toHaveLength(1);
    expect(fetch.calls.map((c) => c.url.pathname)).toEqual(['/movies/boxoffice']);
  });

  it('traktUser needs a token for "me" and sends it as a bearer', async () => {
    const fetch = fakeFetch([[/\/users\/me\/watchlist\/movies$/, () => [{ movie: { title: 'W', ids: { tmdb: 5 } } }]]]);
    const ctx = providerCtx(fetch);
    await expect(providers.traktUser(TraktUserSettings.parse(auth), 'movie', ctx)).rejects.toMatchObject({ code: 'auth' });
    const s = TraktUserSettings.parse({ ...auth, accessToken: 'at', tokenExpiresAt: '2027-01-01T00:00:00Z' });
    const items = await providers.traktUser(s, 'movie', ctx);
    expect(items.map((i) => i.tmdbId)).toEqual([5]);
    expect(fetch.calls.at(-1)!.headers['authorization']).toBe('Bearer at');
  });

  it('refreshes an expiring token and persists the new pair', async () => {
    const fetch = fakeFetch([
      [/\/oauth\/token$/, () => ({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 7200, created_at: 1_793_000_000 })],
      [/\/users\/me\/collection\/shows$/, () => []],
    ]);
    const ctx = providerCtx(fetch);
    const s = TraktUserSettings.parse({
      ...auth,
      clientSecret: 'cs',
      accessToken: 'old-at',
      refreshToken: 'old-rt',
      tokenExpiresAt: '2026-10-25T12:01:00Z',
      listType: 'collection',
    });
    await providers.traktUser(s, 'series', ctx);
    expect(fetch.calls[0]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'old-rt', client_secret: 'cs' });
    expect(ctx.saved).toEqual([{ accessToken: 'new-at', refreshToken: 'new-rt', tokenExpiresAt: new Date((1_793_000_000 + 7200) * 1000).toISOString() }]);
    expect(fetch.calls[1]!.headers['authorization']).toBe('Bearer new-at');
  });

  it('device-code flow: code request and every poll outcome', async () => {
    const codeFetch = fakeFetch([
      [/\/oauth\/device\/code$/, () => ({ device_code: 'dc', user_code: 'ABCD1234', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 })],
    ]);
    expect(await traktDeviceCode(codeFetch, 'cid')).toEqual({
      deviceCode: 'dc',
      userCode: 'ABCD1234',
      verificationUrl: 'https://trakt.tv/activate',
      expiresIn: 600,
      interval: 5,
    });
    expect(codeFetch.calls[0]!.body).toEqual({ client_id: 'cid' });

    const now = new Date('2026-10-25T12:00:00Z');
    const outcomes: Array<[number, string]> = [
      [400, 'pending'],
      [429, 'slowDown'],
      [418, 'denied'],
      [410, 'expired'],
      [404, 'invalid'],
    ];
    for (const [status, expected] of outcomes) {
      const f = fakeFetch([[/device\/token/, () => new Response('', { status })]]);
      expect((await traktPollToken(f, { deviceCode: 'dc', clientId: 'cid', clientSecret: 'cs' }, now)).status).toBe(expected);
    }
    const ok = fakeFetch([[/device\/token/, () => ({ access_token: 'a', refresh_token: 'r', expires_in: 60 })]]);
    expect(await traktPollToken(ok, { deviceCode: 'dc', clientId: 'cid', clientSecret: 'cs' }, now)).toEqual({
      status: 'authorized',
      tokens: { accessToken: 'a', refreshToken: 'r', tokenExpiresAt: '2026-10-25T12:01:00.000Z' },
    });
  });
});

describe('Plex watchlist', () => {
  it('parses guids, paginates and keeps the token out of the URL', async () => {
    const page = (start: number, rows: object[]) => ({ MediaContainer: { totalSize: 101, size: rows.length, offset: start, Metadata: rows } });
    const first = Array.from({ length: 100 }, (_, i) => ({ type: 'movie', title: `M${i}`, year: 2000, Guid: [{ id: `tmdb://${i + 1}` }] }));
    const fetch = fakeFetch([
      [
        /discover\.provider\.plex\.tv\/library\/sections\/watchlist\/all$/,
        (url) =>
          url.searchParams.get('X-Plex-Container-Start') === '0'
            ? page(0, first)
            : page(100, [{ type: 'show', title: 'Severance', year: 2022, Guid: [{ id: 'imdb://tt11280740' }, { id: 'tvdb://371980' }] }]),
      ],
    ]);
    const items = await providers.plexWatchlist(PlexWatchlistSettings.parse({ plexToken: 'plex-secret' }), 'both', providerCtx(fetch));
    expect(items).toHaveLength(101);
    expect(items[100]).toEqual({ mediaType: 'series', title: 'Severance', year: 2022, tmdbId: null, imdbId: 'tt11280740', tvdbId: 371980 });
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]!.url.toString()).not.toContain('plex-secret');
    expect(fetch.calls[0]!.headers['x-plex-token']).toBe('plex-secret');
  });
});

describe('IMDb lists', () => {
  it('parses quoted CSV with CRLF rows', () => {
    expect(parseCsv('a,b,c\r\n1,"x, ""y""",3\r\n\r\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, "y"', '3'],
    ]);
  });

  it('maps an export to movies and series and skips other title types', () => {
    const csv = [
      'Position,Const,Created,Modified,Description,Title,URL,Title Type,IMDb Rating,Runtime (mins),Year',
      '1,tt0133093,2020-01-01,,,"The Matrix",https://www.imdb.com/title/tt0133093/,Movie,8.7,136,1999',
      '2,tt0903747,2020-01-01,,,"Breaking Bad",https://www.imdb.com/title/tt0903747/,TV Series,9.5,49,2008',
      '3,tt1234567,2020-01-01,,,"An Episode",https://www.imdb.com/title/tt1234567/,TV Episode,8,40,2010',
    ].join('\n');
    expect(parseImdbExport(csv)).toEqual([
      { mediaType: 'movie', imdbId: 'tt0133093', title: 'The Matrix', year: 1999 },
      { mediaType: 'series', imdbId: 'tt0903747', title: 'Breaking Bad', year: 2008 },
    ]);
    expect(parseImdbExport('[{"const":"tt0133093","title":"The Matrix","titleType":"movie","year":1999}]')).toHaveLength(1);
  });

  it('fetches the watchlist export for user ids', async () => {
    const fetch = fakeFetch([[/www\.imdb\.com\/user\/ur123\/watchlist\/export$/, () => new Response('Const,Title,Year,Title Type\ntt0133093,The Matrix,1999,movie\n')]]);
    const items = await providers.imdbList(ImdbListSettings.parse({ listId: 'ur123' }), 'series', providerCtx(fetch));
    expect(items).toEqual([]);
    const movies = await providers.imdbList(ImdbListSettings.parse({ listId: 'ur123' }), 'movie', providerCtx(fetch));
    expect(movies[0]).toMatchObject({ imdbId: 'tt0133093' });
    expect(() => ImdbListSettings.parse({ listId: 'https://imdb.com/list/ls1' })).toThrow();
  });
});

describe('feeds', () => {
  it('reads JSON arrays of ids or objects, and wrapped results', () => {
    expect(parseFeed('[603, 604]', 'movie').map((i) => i.tmdbId)).toEqual([603, 604]);
    expect(
      parseFeed('{"results":[{"tmdb_id":1399,"title":"GoT","media_type":"tv","year":2011},{"imdb_id":"tt0133093"},{"title":"no ids"}]}', 'both'),
    ).toEqual([
      { mediaType: 'series', tmdbId: 1399, imdbId: null, tvdbId: null, title: 'GoT', year: 2011 },
      { mediaType: 'movie', tmdbId: null, imdbId: 'tt0133093', tvdbId: null, title: 'tt0133093', year: null },
    ]);
  });

  it('reads RSS items with TMDB links or IMDb ids', () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Inception (2010)</title><link>https://www.themoviedb.org/movie/27205-inception</link></item>
      <item><title><![CDATA[Dark & Light]]></title><guid>https://www.imdb.com/title/tt5753856/</guid></item>
      <item><title>Nothing</title><link>https://example.com</link></item>
      <item><title>Show</title><link>https://www.themoviedb.org/tv/1399</link></item>
    </channel></rss>`;
    expect(parseFeed(xml, 'both')).toEqual([
      { mediaType: 'movie', tmdbId: 27205, imdbId: null, tvdbId: null, title: 'Inception', year: 2010 },
      { mediaType: 'movie', tmdbId: null, imdbId: 'tt5753856', tvdbId: null, title: 'Dark & Light', year: null },
      { mediaType: 'series', tmdbId: 1399, imdbId: null, tvdbId: null, title: 'Show', year: null },
    ]);
    expect(() => parseFeed('hello', 'movie')).toThrow(ImportListFetchError);
  });

  it('stevenLu reads the popular-movies JSON as movies only', async () => {
    const fetch = fakeFetch([
      [/s3\.amazonaws\.com\/popular-movies\/movies\.json$/, () => [{ title: 'Dune', imdb_id: 'tt1160419', poster_url: 'x' }]],
    ]);
    const ctx = providerCtx(fetch);
    const items = await providers.stevenLu(StevenLuSettings.parse({}), 'movie', ctx);
    expect(items).toEqual([{ mediaType: 'movie', tmdbId: null, imdbId: 'tt1160419', tvdbId: null, title: 'Dune', year: null }]);
    expect(await providers.stevenLu(StevenLuSettings.parse({}), 'series', ctx)).toEqual([]);
  });
});

describe('http error mapping', () => {
  it('maps network failures and status codes', async () => {
    const down = Object.assign(async () => {
      throw new TypeError('fetch failed');
    }, {});
    await expect(request({ fetch: down }, 'X', 'https://x.test/')).rejects.toMatchObject({ code: 'unreachable' });
    for (const [status, code] of [
      [404, 'not-found'],
      [429, 'rate-limited'],
      [403, 'auth'],
      [500, 'bad-response'],
    ] as const) {
      const f = fakeFetch([[/x\.test/, () => new Response('', { status })]]);
      await expect(request({ fetch: f }, 'X', 'https://x.test/')).rejects.toMatchObject({ code });
    }
  });
});
