import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  AnilistSettings,
  CustomUrlSettings,
  ImdbTopSettings,
  JellyfinFavoritesSettings,
  KitsuSettings,
  LetterboxdSettings,
  MdblistSettings,
  MyAnimeListSettings,
  SimklSettings,
  TmdbCompanySettings,
  TmdbDiscoverSettings,
  TmdbNetworkSettings,
  TmdbPopularSettings,
  TraktListsSettings,
  TraktPopularSettings,
  TraktUserSettings,
} from '@arclight/shared';
import { ImportListFetchError } from './errors.js';
import { providers, simklPin, simklPollPin } from './providers/index.js';
import { ANIME_IDS_URL, AnimeIdIndex, animeItem, animeKind, currentSeason } from './providers/anime-ids.js';
import { createDatasetCache } from './providers/datasets.js';
import { parseCsvList, parseCustomDocument } from './providers/feed.js';
import { IMDB_RATINGS_URL, parseImdbRatings } from './providers/imdb.js';
import { parseLetterboxdFilm, parseLetterboxdPage, parseLetterboxdRss, letterboxdStartUrl } from './providers/letterboxd.js';
import { mdblistPath, parseMdblistItems } from './providers/mdblist.js';
import { parseSimklItems } from './providers/simkl.js';
import { parseTraktLists } from './providers/trakt.js';
import { fakeFetch, json, memoryIds, providerCtx, silentLog, TMDB_CONFIGURATION } from './test-support.js';

// Fixtures below follow the shapes the services return (trimmed to the fields that matter).

/** A trimmed anime_ids.json: AniDB id -> ids of the same title elsewhere. */
const ANIME_IDS = {
  '1': { anilist_id: 1, mal_id: 1, tvdb_id: 76885, tvdb_season: 1, tmdb_show_id: 30991, imdb_id: 'tt0213338' }, // Cowboy Bebop
  '5': { anilist_id: 5, mal_id: 5, tmdb_movie_id: 11299, imdb_id: 'tt0275277' }, // Cowboy Bebop: The Movie
  '69': { anilist_id: '21,22', mal_id: 21, tvdb_id: 81797 }, // One Piece (several AniList ids)
  '70': { anilist_id: 21, mal_id: 9999, tvdb_id: 1 }, // duplicate AniList id: the first entry wins
  '99': { anilist_id: 99, mal_id: 99 }, // no external ids: not indexed
};
const animeRoute: [RegExp, () => Response] = [
  /raw\.githubusercontent\.com\/Kometa-Team\/Anime-IDs\/master\/anime_ids\.json$/,
  () => new Response(JSON.stringify(ANIME_IDS)),
];

const searchResult = (id: number, title: string, extra: object = {}) => ({
  id,
  title,
  original_title: title,
  overview: '',
  original_language: 'en',
  release_date: '2010-07-16',
  vote_average: 8.1,
  vote_count: 30000,
  ...extra,
});

describe('anime id mapping', () => {
  it('indexes AniList and MAL ids, takes the first of comma lists and the first entry per id', () => {
    const index = AnimeIdIndex.parse(ANIME_IDS);
    expect(index.anilist(1)).toEqual({ tvdbId: 76885, tmdbShowId: 30991, tmdbMovieId: null, imdbId: 'tt0213338' });
    expect(index.anilist(22)?.tvdbId).toBe(81797);
    expect(index.anilist(21)?.tvdbId).toBe(81797);
    expect(index.mal(5)?.tmdbMovieId).toBe(11299);
    expect(index.anilist(99)).toBeUndefined();
  });

  it('maps entries to library items: movies by TMDB movie id, series by show then TVDB, unmapped without ids', () => {
    const index = AnimeIdIndex.parse(ANIME_IDS);
    expect(animeItem(index.anilist(5), { kind: 'movie', title: 'Bebop Movie', year: 2001 })).toEqual({
      mediaType: 'movie',
      tmdbId: 11299,
      imdbId: 'tt0275277',
      title: 'Bebop Movie',
      year: 2001,
    });
    expect(animeItem(index.anilist(1), { kind: 'series', title: 'Cowboy Bebop' })).toMatchObject({ mediaType: 'series', tmdbId: 30991 });
    expect(animeItem(index.anilist(21), { kind: 'series', title: 'One Piece' })).toMatchObject({ mediaType: 'series', tvdbId: 81797 });
    const unmapped = animeItem(undefined, { kind: 'series', title: 'Obscure OVA' });
    expect(unmapped).toEqual({ mediaType: 'series', title: 'Obscure OVA', year: null });
  });

  it('knows anime formats and seasons', () => {
    expect(animeKind('MOVIE')).toBe('movie');
    expect(animeKind('TV_SHORT')).toBe('series');
    expect(animeKind('ona')).toBe('series');
    expect(animeKind('MUSIC')).toBeNull();
    expect(currentSeason(new Date('2026-10-25T00:00:00Z'))).toEqual({ season: 'fall', year: 2026 });
    expect(currentSeason(new Date('2026-02-01T00:00:00Z')).season).toBe('winter');
  });
});

describe('dataset cache', () => {
  it('downloads once per max age, revalidates with the ETag and falls back to the stale copy', async () => {
    let now = new Date('2026-10-25T00:00:00Z');
    let fail = false;
    const fetch = fakeFetch([
      [
        /example\.com\/data\.json$/,
        (_url, call) => {
          if (fail) return new Response('down', { status: 503 });
          if (call.headers['if-none-match'] === '"v1"') return new Response(null, { status: 304 });
          return new Response('{"a":1}', { headers: { etag: '"v1"' } });
        },
      ],
    ]);
    const cache = createDatasetCache({ fetch, log: silentLog, now: () => now, dir: null });
    const get = () => cache.get('data.json', 'https://example.com/data.json', { maxAgeMs: 3_600_000 });
    expect((await get()).toString()).toBe('{"a":1}');
    await get();
    expect(fetch.calls).toHaveLength(1);
    now = new Date('2026-10-25T02:00:00Z');
    expect((await get()).toString()).toBe('{"a":1}');
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[1]!.headers['if-none-match']).toBe('"v1"');
    now = new Date('2026-10-25T04:00:00Z');
    fail = true;
    expect((await get()).toString()).toBe('{"a":1}');
  });

  it('throws when nothing was ever downloaded', async () => {
    const fetch = fakeFetch([]);
    const cache = createDatasetCache({ fetch, log: silentLog, now: () => new Date(), dir: null });
    await expect(cache.get('x', 'https://example.com/x', { maxAgeMs: 1 })).rejects.toBeInstanceOf(ImportListFetchError);
  });
});

describe('AniList', () => {
  const media = (id: number, format: string, english: string | null, romaji: string, year: number) => ({
    id,
    idMal: id,
    format,
    title: { english, romaji },
    startDate: { year },
    seasonYear: year,
  });

  it('reads a user list by status and maps entries through the id mapping', async () => {
    const fetch = fakeFetch([
      animeRoute,
      [
        /graphql\.anilist\.co\/$/,
        () => ({
          data: {
            MediaListCollection: {
              lists: [
                { entries: [{ media: media(1, 'TV', 'Cowboy Bebop', 'Cowboy Bebop', 1998) }, { media: media(5, 'MOVIE', null, 'Cowboy Bebop: Tengoku no Tobira', 2001) }] },
                { entries: [{ media: media(4242, 'OVA', null, 'Unmapped OVA', 1990) }, { media: media(7, 'MUSIC', null, 'A music video', 2000) }] },
              ],
            },
          },
        }),
      ],
    ]);
    const items = await providers.anilist(AnilistSettings.parse({ source: 'user', username: 'someone' }), 'both', providerCtx(fetch));
    expect(items).toEqual([
      { mediaType: 'series', tmdbId: 30991, title: 'Cowboy Bebop', year: 1998 },
      { mediaType: 'movie', tmdbId: 11299, imdbId: 'tt0275277', title: 'Cowboy Bebop: Tengoku no Tobira', year: 2001 },
      { mediaType: 'series', title: 'Unmapped OVA', year: 1990 },
    ]);
    const gql = fetch.calls.find((c) => c.url.host === 'graphql.anilist.co')!;
    expect(gql.body).toMatchObject({ variables: { user: 'someone', status: ['CURRENT', 'PLANNING'] } });
  });

  it('walks seasonal pages for the current season by default', async () => {
    const fetch = fakeFetch([
      animeRoute,
      [
        /graphql\.anilist\.co\/$/,
        (_url, call) => {
          const page = (call.body as { variables: { page: number } }).variables.page;
          return {
            data: {
              Page: {
                pageInfo: { hasNextPage: page === 1 },
                media: page === 1 ? [media(1, 'TV', 'Cowboy Bebop', 'x', 2026)] : [media(21, 'TV', 'One Piece', 'x', 2026)],
              },
            },
          };
        },
      ],
    ]);
    const items = await providers.anilist(AnilistSettings.parse({ source: 'seasonal' }), 'series', providerCtx(fetch));
    expect(items.map((i) => i.title)).toEqual(['Cowboy Bebop', 'One Piece']);
    const first = fetch.calls.find((c) => c.url.host === 'graphql.anilist.co')!;
    expect(first.body).toMatchObject({ variables: { season: 'FALL', year: 2026, sort: ['POPULARITY_DESC'] } });
  });

  it('requires a username for user lists and surfaces GraphQL errors', async () => {
    expect(AnilistSettings.safeParse({ source: 'user' }).success).toBe(false);
    const fetch = fakeFetch([animeRoute, [/graphql\.anilist\.co\/$/, () => ({ errors: [{ message: 'User not found', status: 404 }] })]]);
    await expect(
      providers.anilist(AnilistSettings.parse({ source: 'user', username: 'nobody' }), 'both', providerCtx(fetch)),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('MyAnimeList', () => {
  it('reads each status of a user list with the client id header and follows paging', async () => {
    const fetch = fakeFetch([
      animeRoute,
      [
        /api\.myanimelist\.net\/v2\/users\/someone\/animelist$/,
        (url) => {
          if (url.searchParams.get('status') === 'plan_to_watch') {
            return { data: [{ node: { id: 5, title: 'Cowboy Bebop: Tengoku no Tobira', media_type: 'movie', start_season: { year: 2001 } }, list_status: { status: 'plan_to_watch' } }], paging: {} };
          }
          if (url.searchParams.get('offset') === '1') {
            return { data: [{ node: { id: 21, title: 'One Piece', media_type: 'tv', start_date: '1999-10-20' }, list_status: { status: 'watching' } }], paging: {} };
          }
          return {
            data: [{ node: { id: 1, title: 'Cowboy Bebop', alternative_titles: { en: 'Cowboy Bebop' }, media_type: 'tv', start_season: { year: 1998 } }, list_status: { status: 'watching' } }],
            paging: { next: 'https://api.myanimelist.net/v2/users/someone/animelist?status=watching&offset=1' },
          };
        },
      ],
    ]);
    const items = await providers.myAnimeList(
      MyAnimeListSettings.parse({ clientId: 'mal-client', username: 'someone' }),
      'both',
      providerCtx(fetch),
    );
    expect(items.map((i) => [i.mediaType, i.tmdbId ?? i.tvdbId, i.title])).toEqual([
      ['series', 30991, 'Cowboy Bebop'],
      ['series', 81797, 'One Piece'],
      ['movie', 11299, 'Cowboy Bebop: Tengoku no Tobira'],
    ]);
    const malCall = fetch.calls.find((c) => c.url.host === 'api.myanimelist.net')!;
    expect(malCall.headers['x-mal-client-id']).toBe('mal-client');
  });

  it('uses the season and ranking endpoints', async () => {
    const fetch = fakeFetch([
      animeRoute,
      [/api\.myanimelist\.net\/v2\/anime\/season\/2025\/spring$/, () => ({ data: [{ node: { id: 1, title: 'Cowboy Bebop', media_type: 'tv' } }] })],
      [/api\.myanimelist\.net\/v2\/anime\/ranking$/, () => ({ data: [{ node: { id: 5, title: 'Bebop Movie', media_type: 'movie' } }] })],
    ]);
    const ctx = providerCtx(fetch);
    const seasonal = await providers.myAnimeList(
      MyAnimeListSettings.parse({ clientId: 'c', source: 'seasonal', season: 'spring', seasonYear: 2025 }),
      'both',
      ctx,
    );
    expect(seasonal.map((i) => i.title)).toEqual(['Cowboy Bebop']);
    const ranking = await providers.myAnimeList(MyAnimeListSettings.parse({ clientId: 'c', source: 'ranking', rankingType: 'movie' }), 'movie', ctx);
    expect(ranking).toEqual([{ mediaType: 'movie', tmdbId: 11299, imdbId: 'tt0275277', title: 'Bebop Movie', year: null }]);
    expect(fetch.calls.find((c) => c.url.pathname.endsWith('/ranking'))!.url.searchParams.get('ranking_type')).toBe('movie');
  });
});

describe('Kitsu', () => {
  it('finds the user, reads library entries with included anime and MAL mappings', async () => {
    const fetch = fakeFetch([
      animeRoute,
      [/kitsu\.app\/api\/edge\/users$/, (url) => (url.searchParams.get('filter[slug]') ? { data: [] } : { data: [{ id: '42', type: 'users' }] })],
      [
        /kitsu\.app\/api\/edge\/library-entries$/,
        (url) => {
          expect(url.searchParams.get('filter[userId]')).toBe('42');
          expect(url.searchParams.get('filter[status]')).toBe('current,planned');
          return {
            data: [
              { id: 'e1', type: 'libraryEntries', relationships: { anime: { data: { type: 'anime', id: '1' } } } },
              { id: 'e2', type: 'libraryEntries', relationships: { anime: { data: { type: 'anime', id: '2' } } } },
            ],
            included: [
              {
                id: '1',
                type: 'anime',
                attributes: { canonicalTitle: 'Cowboy Bebop', titles: { en: 'Cowboy Bebop' }, subtype: 'TV', startDate: '1998-04-03' },
                relationships: { mappings: { data: [{ type: 'mappings', id: 'm1' }] } },
              },
              { id: 'm1', type: 'mappings', attributes: { externalSite: 'myanimelist/anime', externalId: '1' } },
              { id: '2', type: 'anime', attributes: { canonicalTitle: 'No Mapping', subtype: 'OVA', startDate: '1990-01-01' } },
            ],
            links: {},
          };
        },
      ],
    ]);
    const items = await providers.kitsu(KitsuSettings.parse({ username: 'Some Name' }), 'both', providerCtx(fetch));
    expect(items).toEqual([
      { mediaType: 'series', tmdbId: 30991, title: 'Cowboy Bebop', year: 1998 },
      { mediaType: 'series', title: 'No Mapping', year: 1990 },
    ]);
  });

  it('reads trending anime with a second request for their mappings', async () => {
    const fetch = fakeFetch([
      animeRoute,
      [/kitsu\.app\/api\/edge\/trending\/anime$/, () => ({ data: [{ id: '5', type: 'anime' }] })],
      [
        /kitsu\.app\/api\/edge\/anime$/,
        () => ({
          data: [{ id: '5', type: 'anime', attributes: { canonicalTitle: 'Bebop Movie', subtype: 'movie', startDate: '2001-09-01' }, relationships: { mappings: { data: [{ type: 'mappings', id: 'm5' }] } } }],
          included: [{ id: 'm5', type: 'mappings', attributes: { externalSite: 'myanimelist/anime', externalId: '5' } }],
        }),
      ],
    ]);
    const items = await providers.kitsu(KitsuSettings.parse({ source: 'trending' }), 'movie', providerCtx(fetch));
    expect(items).toEqual([{ mediaType: 'movie', tmdbId: 11299, imdbId: 'tt0275277', title: 'Bebop Movie', year: 2001 }]);
  });
});

describe('Letterboxd', () => {
  const page1 = `
    <ul class="poster-list">
      <li class="poster-container"><div class="really-lazy-load poster film-poster" data-item-slug="the-matrix" data-item-name="The Matrix (1999)" data-target-link="/film/the-matrix/"></div></li>
      <li class="poster-container"><div data-film-slug="amelie" data-film-name="Am&eacute;lie" data-film-release-year="2001" class="poster"></div></li>
    </ul>
    <div class="paginate-nextprev"><a class="next" href="/someone/watchlist/page/2/">Older</a></div>`;
  const page2 = `<div class="poster film-poster" data-item-slug="parasite-2019" data-item-name="Parasite (2019)"></div>`;
  const film = (id: number) => `<body class="film backdrop-loaded" data-tmdb-type="movie" data-tmdb-id="${id}"><a href="http://www.imdb.com/title/tt0133093/maindetails">IMDb</a></body>`;

  it('parses poster pages, film pages and the diary feed', () => {
    const parsed = parseLetterboxdPage(page1);
    expect(parsed.posters).toEqual([
      { slug: 'the-matrix', title: 'The Matrix', year: 1999 },
      { slug: 'amelie', title: 'Am&eacute;lie', year: 2001 },
    ]);
    expect(parsed.next).toBe('https://letterboxd.com/someone/watchlist/page/2/');
    expect(parseLetterboxdFilm(film(603))).toEqual({ mediaType: 'movie', tmdbId: 603, imdbId: 'tt0133093' });
    const rss = `<rss><channel><item><title>The Matrix, 1999</title><letterboxd:filmTitle>The Matrix</letterboxd:filmTitle><letterboxd:filmYear>1999</letterboxd:filmYear><tmdb:movieId>603</tmdb:movieId></item><item><title>A list</title></item></channel></rss>`;
    expect(parseLetterboxdRss(rss)).toEqual([{ mediaType: 'movie', tmdbId: 603, title: 'The Matrix', year: 1999 }]);
  });

  it('parses hostile unclosed tags in linear time', () => {
    let t0 = performance.now();
    expect(parseLetterboxdRss('<item>'.repeat(50_000))).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(100);
    t0 = performance.now();
    expect(parseLetterboxdPage('<div data-item-slug="x" '.repeat(20_000)).posters).toEqual([]);
    expect(parseLetterboxdPage('<a class="next" '.repeat(50_000)).next).toBeNull();
    expect(parseLetterboxdPage(`${'<div '.repeat(50_000)}>`).posters).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('builds start URLs and validates the settings', () => {
    expect(letterboxdStartUrl(LetterboxdSettings.parse({ username: 'someone' }))).toBe('https://letterboxd.com/someone/watchlist/');
    expect(letterboxdStartUrl(LetterboxdSettings.parse({ source: 'list', username: 'someone', listSlug: 'best-of' }))).toBe(
      'https://letterboxd.com/someone/list/best-of/',
    );
    expect(letterboxdStartUrl(LetterboxdSettings.parse({ source: 'url', url: 'https://letterboxd.com/someone/list/top/page/3/?x=1' }))).toBe(
      'https://letterboxd.com/someone/list/top/',
    );
    expect(LetterboxdSettings.safeParse({ source: 'url', url: 'https://example.com/list' }).success).toBe(false);
    expect(LetterboxdSettings.safeParse({ source: 'list', username: 'someone' }).success).toBe(false);
  });

  it('walks pages, resolves slugs once through the id cache and sends an honest user agent', async () => {
    const fetch = fakeFetch([
      [/letterboxd\.com\/someone\/watchlist\/$/, () => new Response(page1)],
      [/letterboxd\.com\/someone\/watchlist\/page\/2\/$/, () => new Response(page2)],
      [/letterboxd\.com\/film\/the-matrix\/$/, () => new Response(film(603))],
      [/letterboxd\.com\/film\/amelie\/$/, () => new Response(film(194))],
      [/letterboxd\.com\/film\/parasite-2019\/$/, () => new Response(film(496243))],
    ]);
    const ids = memoryIds();
    const ctx = providerCtx(fetch, { ids });
    const settings = LetterboxdSettings.parse({ username: 'someone' });
    const items = await providers.letterboxd(settings, 'movie', ctx);
    expect(items.map((i) => i.tmdbId)).toEqual([603, 194, 496243]);
    expect(ids.map.get('letterboxd:the-matrix')?.tmdbId).toBe(603);
    expect(fetch.calls[0]!.headers['user-agent']).toMatch(/^Arclight\//);
    const before = fetch.calls.length;
    await providers.letterboxd(settings, 'movie', ctx);
    // Second run: only the two list pages, no film pages.
    expect(fetch.calls.length - before).toBe(2);
  });
});

describe('MDBList', () => {
  it('accepts list ids, user/slug and URLs', () => {
    expect(mdblistPath('12345')).toBe('/lists/12345');
    expect(mdblistPath('someone/top-horror')).toBe('/lists/someone/top-horror');
    expect(mdblistPath('https://mdblist.com/lists/someone/top-horror')).toBe('/lists/someone/top-horror');
    expect(() => mdblistPath('https://example.com/lists/a/b')).toThrow(ImportListFetchError);
  });

  it('parses the movies/shows document and the legacy array', () => {
    expect(
      parseMdblistItems({
        movies: [{ id: 1, title: 'Inception', release_year: 2010, mediatype: 'movie', ids: { tmdb: 27205, imdb: 'tt1375666' } }],
        shows: [{ title: 'Breaking Bad', release_year: 2008, mediatype: 'show', ids: { tmdb: 1396, tvdb: 81189 } }],
      }),
    ).toEqual([
      { mediaType: 'movie', tmdbId: 27205, imdbId: 'tt1375666', tvdbId: null, title: 'Inception', year: 2010 },
      { mediaType: 'series', tmdbId: 1396, imdbId: null, tvdbId: 81189, title: 'Breaking Bad', year: 2008 },
    ]);
    expect(parseMdblistItems([{ id: 27205, title: 'Inception', imdb_id: 'tt1375666', mediatype: 'movie', release_year: 2010 }])).toEqual([
      { mediaType: 'movie', tmdbId: 27205, imdbId: 'tt1375666', tvdbId: null, title: 'Inception', year: 2010 },
    ]);
    expect(() => parseMdblistItems({ error: 'Invalid API key' })).toThrow(/Invalid API key/);
  });

  it('pages with offset while X-Has-More is true', async () => {
    const fetch = fakeFetch([
      [
        /api\.mdblist\.com\/lists\/someone\/top\/items$/,
        (url) =>
          url.searchParams.get('offset') === '0'
            ? new Response(JSON.stringify({ movies: [{ title: 'A', ids: { tmdb: 1 } }], shows: [] }), { headers: { 'x-has-more': 'true' } })
            : json({ movies: [{ title: 'B', ids: { tmdb: 2 } }], shows: [] }),
      ],
    ]);
    const items = await providers.mdblist(MdblistSettings.parse({ apiKey: 'k', list: 'someone/top', limit: 2000 }), 'movie', providerCtx(fetch));
    expect(items.map((i) => i.tmdbId)).toEqual([1, 2]);
    expect(fetch.calls[1]!.url.searchParams.get('offset')).toBe('1000');
    expect(fetch.calls[0]!.url.searchParams.get('apikey')).toBe('k');
  });
});

describe('Simkl', () => {
  it('parses shows, movies and anime; anime without TMDB ids fall back to the MAL mapping', () => {
    const index = AnimeIdIndex.parse(ANIME_IDS);
    const items = parseSimklItems(
      {
        shows: [{ show: { title: 'Breaking Bad', year: 2008, ids: { simkl: 1, tmdb: '1396', imdb: 'tt0903747', tvdb: '81189' } } }],
        movies: [{ movie: { title: 'Inception', year: 2010, ids: { simkl: 2, tmdb: '27205' } } }],
        anime: [{ anime_type: 'tv', show: { title: 'Cowboy Bebop', year: 1998, ids: { simkl: 3, mal: '1' } } }],
      },
      index,
    );
    expect(items).toEqual([
      { mediaType: 'movie', tmdbId: 27205, imdbId: null, tvdbId: null, title: 'Inception', year: 2010 },
      { mediaType: 'series', tmdbId: 1396, imdbId: 'tt0903747', tvdbId: 81189, title: 'Breaking Bad', year: 2008 },
      { mediaType: 'series', tmdbId: 30991, title: 'Cowboy Bebop', year: 1998 },
    ]);
  });

  it('reads all-items per type and status with the API key and token, and needs a token', async () => {
    const fetch = fakeFetch([
      animeRoute,
      [/api\.simkl\.com\/sync\/all-items\/movies\/plantowatch$/, () => ({ movies: [{ movie: { title: 'Inception', year: 2010, ids: { tmdb: 27205 } } }] })],
      [/api\.simkl\.com\/sync\/all-items\/[a-z]+\/[a-z]+$/, () => ({})],
    ]);
    const settings = SimklSettings.parse({ clientId: 'simkl-client', accessToken: 'tok' });
    const items = await providers.simkl(settings, 'both', providerCtx(fetch));
    expect(items.map((i) => i.tmdbId)).toEqual([27205]);
    const call = fetch.calls.find((c) => c.url.pathname.endsWith('/movies/plantowatch'))!;
    expect(call.headers['simkl-api-key']).toBe('simkl-client');
    expect(call.headers['authorization']).toBe('Bearer tok');
    await expect(providers.simkl(SimklSettings.parse({ clientId: 'c' }), 'both', providerCtx(fetch))).rejects.toMatchObject({ code: 'auth' });
  });

  it('runs the PIN flow', async () => {
    let polls = 0;
    const fetch = fakeFetch([
      [/api\.simkl\.com\/oauth\/pin$/, () => ({ result: 'OK', user_code: 'ABC12', verification_url: 'https://simkl.com/pin/', expires_in: 900, interval: 5 })],
      [
        /api\.simkl\.com\/oauth\/pin\/ABC12$/,
        () => (++polls === 1 ? { result: 'KO', message: 'Authorization pending' } : { result: 'OK', access_token: 'tok' }),
      ],
    ]);
    expect(await simklPin(fetch, 'c')).toEqual({ userCode: 'ABC12', verificationUrl: 'https://simkl.com/pin/', expiresIn: 900, interval: 5 });
    expect(await simklPollPin(fetch, 'c', 'ABC12')).toEqual({ status: 'pending' });
    expect(await simklPollPin(fetch, 'c', 'ABC12')).toEqual({ status: 'authorized', accessToken: 'tok' });
    expect(await simklPollPin(fakeFetch([]), 'c', 'GONE')).toEqual({ status: 'expired' });
  });
});

describe('Jellyfin / Emby favourites', () => {
  const items = {
    Items: [
      { Name: 'Inception', Type: 'Movie', ProductionYear: 2010, ProviderIds: { Tmdb: '27205', Imdb: 'tt1375666' } },
      { Name: 'Breaking Bad', Type: 'Series', ProductionYear: 2008, ProviderIds: { TMDB: '1396', Tvdb: '81189' } },
      { Name: 'A Season', Type: 'Season' },
    ],
    TotalRecordCount: 3,
  };

  it('finds the user and reads favourite movies and series (Jellyfin)', async () => {
    const fetch = fakeFetch([
      [/jellyfin\.example\.com\/Users$/, () => [{ Name: 'Viewer', Id: 'u1' }]],
      [/jellyfin\.example\.com\/Items$/, () => items],
    ]);
    const settings = JellyfinFavoritesSettings.parse({ url: 'http://jellyfin.example.com/', apiKey: 'key', username: 'viewer' });
    const out = await providers.jellyfinFavorites(settings, 'both', providerCtx(fetch));
    expect(out).toEqual([
      { mediaType: 'movie', title: 'Inception', year: 2010, tmdbId: 27205, imdbId: 'tt1375666', tvdbId: null },
      { mediaType: 'series', title: 'Breaking Bad', year: 2008, tmdbId: 1396, imdbId: null, tvdbId: 81189 },
    ]);
    const call = fetch.calls[1]!;
    expect(call.url.searchParams.get('userId')).toBe('u1');
    expect(call.url.searchParams.get('Filters')).toBe('IsFavorite');
    expect(call.headers['x-emby-token']).toBe('key');
  });

  it('uses the per-user path on Emby and reports an unknown user', async () => {
    const fetch = fakeFetch([
      [/emby\.example\.com\/Users$/, () => [{ Name: 'Viewer', Id: 'u1' }]],
      [/emby\.example\.com\/Users\/u1\/Items$/, () => items],
    ]);
    const emby = JellyfinFavoritesSettings.parse({ serverType: 'emby', url: 'http://emby.example.com', apiKey: 'k', username: 'Viewer' });
    expect((await providers.jellyfinFavorites(emby, 'movie', providerCtx(fetch))).map((i) => i.title)).toEqual(['Inception']);
    await expect(
      providers.jellyfinFavorites({ ...emby, username: 'nobody' }, 'movie', providerCtx(fetch)),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('custom JSON / CSV URL', () => {
  it('reads JSON at a dotted path and Trakt-style wrapped rows', () => {
    const doc = JSON.stringify({ data: { items: [{ movie: { title: 'Inception', year: 2010, ids: { tmdb: 27205, trakt: 16662 } } }, { show: { title: 'Breaking Bad', ids: { tvdb: 81189 } } }] } });
    expect(parseCustomDocument(doc, { format: 'auto', itemsPath: 'data.items' }, 'both')).toEqual([
      expect.objectContaining({ mediaType: 'movie', tmdbId: 27205, title: 'Inception' }),
      expect.objectContaining({ mediaType: 'series', tvdbId: 81189, title: 'Breaking Bad' }),
    ]);
    expect(() => parseCustomDocument(doc, { format: 'json', itemsPath: 'nope' }, 'both')).toThrow(/nothing at "nope"/);
  });

  it('reads CSV with flexible id columns', () => {
    const csv = '﻿Title,Year,IMDb ID,TMDB,Type\r\nInception,2010,tt1375666,27205,movie\r\n"Breaking Bad, the show",2008,tt0903747,,tv\r\nNo ids,2000,,,\r\n';
    expect(parseCsvList(csv, 'both')).toEqual([
      { mediaType: 'movie', tmdbId: 27205, imdbId: 'tt1375666', tvdbId: null, title: 'Inception', year: 2010 },
      { mediaType: 'series', tmdbId: null, imdbId: 'tt0903747', tvdbId: null, title: 'Breaking Bad, the show', year: 2008 },
    ]);
    expect(() => parseCsvList('title,year\nA,2000\n', 'movie')).toThrow(/no tmdb, imdb or tvdb column/);
  });

  it('fetches with the optional header and keeps the media type', async () => {
    const fetch = fakeFetch([[/lists\.example\.com\/mine\.csv$/, () => new Response('tmdb_id,title,type\n27205,Inception,movie\n1396,Breaking Bad,series\n')]]);
    const settings = CustomUrlSettings.parse({ url: 'https://lists.example.com/mine.csv', headerName: 'Authorization', headerValue: 'Bearer x' });
    const items = await providers.customUrl(settings, 'movie', providerCtx(fetch));
    expect(items.map((i) => i.tmdbId)).toEqual([27205]);
    expect(fetch.calls[0]!.headers['authorization']).toBe('Bearer x');
  });
});

describe('IMDb Top Rated (official dataset)', () => {
  const tsv = [
    'tconst\taverageRating\tnumVotes',
    'tt0111161\t9.3\t3000000',
    'tt0903747\t9.5\t2200000',
    'tt0959621\t9.9\t150000', // an episode: TMDB find has no movie/series for it
    'tt0068646\t9.2\t2000000',
    'tt9999999\t9.8\t500', // too few votes
  ].join('\n');

  it('parses, filters by votes and sorts by rating', () => {
    expect(parseImdbRatings(tsv, 1000).map((r) => r.imdbId)).toEqual(['tt0959621', 'tt0903747', 'tt0111161', 'tt0068646']);
  });

  it('resolves the best-rated titles through TMDB find, caching hits and misses', async () => {
    const find: Record<string, object> = {
      tt0111161: { movie_results: [searchResult(278, 'The Shawshank Redemption', { release_date: '1994-09-23' })], tv_results: [] },
      tt0903747: { movie_results: [], tv_results: [{ id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', overview: '', original_language: 'en', first_air_date: '2008-01-20', vote_average: 8.9, vote_count: 15000 }] },
      tt0068646: { movie_results: [searchResult(238, 'The Godfather', { release_date: '1972-03-14' })], tv_results: [] },
    };
    const fetch = fakeFetch([
      TMDB_CONFIGURATION,
      [/datasets\.imdbws\.com\/title\.ratings\.tsv\.gz$/, () => new Response(gzipSync(tsv))],
      [/themoviedb\.org\/3\/find\/(tt\d+)$/, (url) => find[url.pathname.split('/').pop()!] ?? { movie_results: [], tv_results: [], tv_episode_results: [{ id: 1 }] }],
    ]);
    const ids = memoryIds();
    const ctx = providerCtx(fetch, { ids });
    const settings = ImdbTopSettings.parse({ minVotes: 1000, limit: 2 });
    const movies = await providers.imdbTop(settings, 'movie', ctx);
    expect(movies.map((m) => [m.tmdbId, m.imdbId])).toEqual([
      [278, 'tt0111161'],
      [238, 'tt0068646'],
    ]);
    expect(ids.map.get('imdb:tt0959621')?.tmdbId).toBeNull();
    expect(ids.map.get('imdb:tt0903747')?.mediaType).toBe('series');
    const finds = fetch.calls.filter((c) => c.url.pathname.includes('/find/')).length;
    await providers.imdbTop(settings, 'both', ctx);
    expect(fetch.calls.filter((c) => c.url.pathname.includes('/find/')).length).toBe(finds);
    expect(fetch.calls.filter((c) => c.url.host === 'datasets.imdbws.com')).toHaveLength(1);
    expect(IMDB_RATINGS_URL).toContain('datasets.imdbws.com');
    expect(ANIME_IDS_URL).toContain('Anime-IDs');
  });

  it('walks past a long run of top-rated episodes to fill the list', async () => {
    const episodes = Array.from({ length: 300 }, (_, i) => `tt5${String(i).padStart(6, '0')}\t9.${String(9 - (i % 9))}\t${200000 - i}`);
    const rows = ['tconst\taverageRating\tnumVotes', ...episodes, 'tt0111161\t8.0\t3000000'].join('\n');
    const fetch = fakeFetch([
      TMDB_CONFIGURATION,
      [/datasets\.imdbws\.com\/title\.ratings\.tsv\.gz$/, () => new Response(gzipSync(rows))],
      [
        /themoviedb\.org\/3\/find\/(tt\d+)$/,
        (url) =>
          url.pathname.endsWith('tt0111161')
            ? { movie_results: [searchResult(278, 'The Shawshank Redemption', { release_date: '1994-09-23' })], tv_results: [] }
            : { movie_results: [], tv_results: [], tv_episode_results: [{ id: 1 }] },
      ],
    ]);
    const items = await providers.imdbTop(ImdbTopSettings.parse({ minVotes: 1000, limit: 1 }), 'movie', providerCtx(fetch, { ids: memoryIds() }));
    expect(items.map((i) => i.tmdbId)).toEqual([278]);
  });
});

describe('TMDB extras', () => {
  const page = (results: object[]) => ({ page: 1, total_pages: 1, total_results: results.length, results });

  it('company, network and discover map their filters onto discover', async () => {
    const fetch = fakeFetch([
      TMDB_CONFIGURATION,
      [/\/3\/discover\/movie$/, () => page([searchResult(27205, 'Inception')])],
      [/\/3\/discover\/tv$/, () => page([{ id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', overview: '', original_language: 'en', first_air_date: '2008-01-20', vote_average: 8.9, vote_count: 15000 }])],
    ]);
    const ctx = providerCtx(fetch);
    const company = await providers.tmdbCompany(TmdbCompanySettings.parse({ companyId: 420, yearFrom: 2000, minVotes: 100 }), 'movie', ctx);
    expect(company).toEqual([{ mediaType: 'movie', tmdbId: 27205, title: 'Inception', year: 2010, rating: 8.1, votes: 30000 }]);
    const c = fetch.calls.find((x) => x.url.pathname.endsWith('/discover/movie'))!.url.searchParams;
    expect(c.get('with_companies')).toBe('420');
    expect(c.get('primary_release_date.gte')).toBe('2000-01-01');
    expect(c.get('vote_count.gte')).toBe('100');

    expect(await providers.tmdbNetwork(TmdbNetworkSettings.parse({ networkId: 213 }), 'movie', ctx)).toEqual([]);
    const network = await providers.tmdbNetwork(TmdbNetworkSettings.parse({ networkId: 213 }), 'series', ctx);
    expect(network.map((n) => n.tmdbId)).toEqual([1396]);
    expect(fetch.calls.find((x) => x.url.pathname.endsWith('/discover/tv'))!.url.searchParams.get('with_networks')).toBe('213');

    fetch.calls.length = 0;
    const discover = await providers.tmdbDiscover(
      TmdbDiscoverSettings.parse({ sortBy: 'vote_average.desc', keywordIds: [9715, 9717], watchProviderIds: [8], watchRegion: 'GB', runtimeMax: 120, networkIds: [213] }),
      'both',
      ctx,
    );
    // Networks only filter series, so the movie half is skipped.
    expect(discover.map((d) => d.mediaType)).toEqual(['series']);
    const d = fetch.calls.find((x) => x.url.pathname.endsWith('/discover/tv'))!.url.searchParams;
    expect(d.get('with_keywords')).toBe('9715|9717');
    expect(d.get('with_watch_providers')).toBe('8');
    expect(d.get('watch_region')).toBe('GB');
    expect(d.get('with_runtime.lte')).toBe('120');
    expect(d.get('vote_count.gte')).toBe('200');
  });

  it('tmdbPopular reads the ready-made lists only for the kind they exist for', async () => {
    const fetch = fakeFetch([
      TMDB_CONFIGURATION,
      [/\/3\/movie\/now_playing$/, () => page([searchResult(1, 'In Cinemas', { release_date: '2026-10-01' })])],
      [/\/3\/tv\/on_the_air$/, () => page([{ id: 2, name: 'On Air', original_name: 'On Air', overview: '', original_language: 'en', first_air_date: '2026-01-01', vote_average: 0, vote_count: 0 }])],
    ]);
    const ctx = providerCtx(fetch);
    const now = await providers.tmdbPopular(TmdbPopularSettings.parse({ listType: 'nowPlaying' }), 'both', ctx);
    expect(now.map((i) => [i.mediaType, i.tmdbId])).toEqual([['movie', 1]]);
    const onAir = await providers.tmdbPopular(TmdbPopularSettings.parse({ listType: 'onTheAir' }), 'both', ctx);
    expect(onAir).toEqual([{ mediaType: 'series', tmdbId: 2, title: 'On Air', year: 2026 }]);
    expect(fetch.calls.some((c) => c.url.pathname.includes('/tv/now_playing'))).toBe(false);
  });
});

describe('Trakt extras', () => {
  const movieRow = (id: number, title: string) => ({ movie: { title, year: 2010, ids: { trakt: id, tmdb: id } } });

  it('charts take the period segment; box office stays without one', async () => {
    const fetch = fakeFetch([[/api\.trakt\.tv\/movies\/[a-z]+(\/[a-z]+)?$/, () => [movieRow(1, 'A')]]]);
    const ctx = providerCtx(fetch);
    await providers.traktPopular(TraktPopularSettings.parse({ clientId: 'c', listType: 'played', period: 'monthly' }), 'movie', ctx);
    await providers.traktPopular(TraktPopularSettings.parse({ clientId: 'c', listType: 'recommended', period: 'all' }), 'movie', ctx);
    await providers.traktPopular(TraktPopularSettings.parse({ clientId: 'c', listType: 'watched' }), 'movie', ctx);
    await providers.traktPopular(TraktPopularSettings.parse({ clientId: 'c', listType: 'boxOffice' }), 'movie', ctx);
    expect(fetch.calls.map((c) => c.url.pathname)).toEqual(['/movies/played/monthly', '/movies/recommended/all', '/movies/watched/weekly', '/movies/boxoffice']);
  });

  it('user favourites and personal recommendations', async () => {
    const fetch = fakeFetch([
      [/api\.trakt\.tv\/users\/someone\/favorites\/movies$/, () => [movieRow(1, 'Fav')]],
      [/api\.trakt\.tv\/recommendations\/movies$/, () => [{ title: 'Rec', year: 2011, ids: { trakt: 2, tmdb: 2 } }]],
    ]);
    const ctx = providerCtx(fetch);
    const fav = await providers.traktUser(TraktUserSettings.parse({ clientId: 'c', username: 'someone', listType: 'favorites' }), 'movie', ctx);
    expect(fav.map((i) => i.title)).toEqual(['Fav']);
    const rec = await providers.traktUser(TraktUserSettings.parse({ clientId: 'c', accessToken: 't', listType: 'recommendations' }), 'movie', ctx);
    expect(rec).toEqual([{ mediaType: 'movie', tmdbId: 2, imdbId: null, tvdbId: null, title: 'Rec', year: 2011 }]);
    await expect(
      providers.traktUser(TraktUserSettings.parse({ clientId: 'c', username: 'someone', listType: 'recommendations' }), 'movie', ctx),
    ).rejects.toMatchObject({ code: 'auth' });
  });

  it('every own or liked list, filtered by name, de-duplicated', async () => {
    expect(parseTraktLists([{ name: 'Mine', ids: { trakt: 10, slug: 'mine' } }, { list: { name: 'Liked', ids: { trakt: 11, slug: 'liked' } } }, { name: 'bad' }])).toEqual([
      { id: 10, slug: 'mine', name: 'Mine' },
      { id: 11, slug: 'liked', name: 'Liked' },
    ]);
    const fetch = fakeFetch([
      [/api\.trakt\.tv\/users\/someone\/lists$/, () => [{ name: 'Horror', ids: { trakt: 10, slug: 'horror' } }, { name: 'Comedy', ids: { trakt: 11, slug: 'comedy' } }]],
      [/api\.trakt\.tv\/users\/someone\/likes\/lists$/, () => [{ type: 'list', list: { name: 'Classics', ids: { trakt: 12, slug: 'classics' } } }]],
      [/api\.trakt\.tv\/lists\/10\/items\/movie$/, () => [movieRow(1, 'A'), movieRow(2, 'B')]],
      [/api\.trakt\.tv\/lists\/11\/items\/movie$/, () => [movieRow(2, 'B'), movieRow(3, 'C')]],
      [/api\.trakt\.tv\/lists\/12\/items\/movie$/, () => [movieRow(4, 'D')]],
    ]);
    const ctx = providerCtx(fetch);
    const own = await providers.traktLists(TraktListsSettings.parse({ clientId: 'c', username: 'someone' }), 'movie', ctx);
    expect(own.map((i) => i.tmdbId)).toEqual([1, 2, 3]);
    const onlyComedy = await providers.traktLists(TraktListsSettings.parse({ clientId: 'c', username: 'someone', listNames: ['comedy'] }), 'movie', ctx);
    expect(onlyComedy.map((i) => i.tmdbId)).toEqual([2, 3]);
    const liked = await providers.traktLists(TraktListsSettings.parse({ clientId: 'c', username: 'someone', source: 'liked' }), 'movie', ctx);
    expect(liked.map((i) => i.tmdbId)).toEqual([4]);
  });
});
