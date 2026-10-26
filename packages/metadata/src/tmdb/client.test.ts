import { describe, expect, it } from 'vitest';
import { MetadataError } from '../types.js';
import { createFakeFetch, defaultRoute, fixtures, jsonResponse } from '../test-support.js';
import { createTmdbClient, parseRetryAfter } from './client.js';

const NOW = new Date('2024-01-01T00:00:00Z');

function makeClient(fake = createFakeFetch(), extra: Parameters<typeof createTmdbClient>[0] = {}) {
  return createTmdbClient({
    apiKey: 'test-key',
    fetchImpl: fake.fetch,
    now: () => NOW,
    sleep: async () => {},
    ...extra,
  });
}

describe('createTmdbClient transport', () => {
  it('sends api_key and language as query params', async () => {
    const fake = createFakeFetch();
    await makeClient(fake).getConfiguration();
    const url = fake.calls[0]?.url;
    expect(url?.pathname).toBe('/3/configuration');
    expect(url?.searchParams.get('api_key')).toBe('test-key');
    expect(url?.searchParams.get('language')).toBe('en-US');
  });

  it('uses a Bearer header instead of api_key when an access token is given', async () => {
    const fake = createFakeFetch();
    await createTmdbClient({ accessToken: 'v4-token', fetchImpl: fake.fetch }).getConfiguration();
    const call = fake.calls[0];
    expect(call?.url.searchParams.has('api_key')).toBe(false);
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer v4-token');
  });

  it('caches /configuration and repeated identical requests', async () => {
    const fake = createFakeFetch();
    const client = makeClient(fake);
    await client.searchSeries('signal');
    await client.searchSeries('signal');
    await client.searchMovies('harbor');
    expect(fake.paths().filter((p) => p === '/3/configuration')).toHaveLength(1);
    expect(fake.paths().filter((p) => p === '/3/search/tv')).toHaveLength(1);
    expect(fake.paths().filter((p) => p === '/3/search/movie')).toHaveLength(1);
  });

  it('expires cache entries after the TTL', async () => {
    let clock = NOW.getTime();
    const fake = createFakeFetch();
    const client = makeClient(fake, { now: () => new Date(clock), cacheTtlMs: 1000 });
    await client.getGenres('movie');
    await client.searchSeries('signal');
    clock += 5000;
    await client.searchSeries('signal');
    expect(fake.paths().filter((p) => p === '/3/search/tv')).toHaveLength(2);
  });

  it('retries on 429 honouring Retry-After and then succeeds', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const fake = createFakeFetch((url) => {
      if (url.pathname === '/3/search/tv' && attempts < 2) {
        attempts += 1;
        return jsonResponse({ status_code: 25 }, 429, { 'retry-after': '2' });
      }
      return defaultRoute(url);
    });
    const client = makeClient(fake, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const page = await client.searchSeries('signal');
    expect(page.results).toHaveLength(2);
    expect(waits).toEqual([2000, 2000]);
    expect(fake.paths().filter((p) => p === '/3/search/tv')).toHaveLength(3);
  });

  it('gives up with rate-limited after the retry budget', async () => {
    const fake = createFakeFetch((url) =>
      url.pathname === '/3/search/tv' ? jsonResponse({}, 429) : defaultRoute(url),
    );
    const client = makeClient(fake, { maxRetries: 3 });
    const err = await client.searchSeries('signal').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetadataError);
    expect((err as MetadataError).code).toBe('rate-limited');
    expect(fake.paths().filter((p) => p === '/3/search/tv')).toHaveLength(4);
  });

  it('maps 404 to not-found', async () => {
    const err = await makeClient().getSeries(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetadataError);
    expect((err as MetadataError).code).toBe('not-found');
    expect((err as MetadataError).httpStatus).toBe(404);
  });

  it('maps 401 to unauthorized', async () => {
    const fake = createFakeFetch(() => jsonResponse({ status_code: 7 }, 401));
    const err = await makeClient(fake).getConfiguration().catch((e: unknown) => e);
    expect((err as MetadataError).code).toBe('unauthorized');
  });

  it('maps 5xx and malformed payloads to bad-response', async () => {
    const fiveHundred = createFakeFetch(() => jsonResponse({}, 503));
    const a = await makeClient(fiveHundred).getConfiguration().catch((e: unknown) => e);
    expect((a as MetadataError).code).toBe('bad-response');

    const wrongShape = createFakeFetch((url) =>
      url.pathname === '/3/configuration' ? defaultRoute(url) : jsonResponse({ nope: true }),
    );
    const b = await makeClient(wrongShape).getSeries(90210).catch((e: unknown) => e);
    expect((b as MetadataError).code).toBe('bad-response');
  });

  it('maps network failures to unreachable', async () => {
    const fake = createFakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await makeClient(fake).getConfiguration().catch((e: unknown) => e);
    expect((err as MetadataError).code).toBe('unreachable');
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('3', NOW)).toBe(3000);
    expect(parseRetryAfter(new Date(NOW.getTime() + 10_000).toUTCString(), NOW)).toBe(10_000);
    expect(parseRetryAfter('garbage', NOW)).toBeUndefined();
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
  });
});

describe('createTmdbClient endpoints', () => {
  it('searches series and returns normalized results with image URLs', async () => {
    const fake = createFakeFetch();
    const page = await makeClient(fake).searchSeries('signal', { year: 2021, page: 1 });
    const call = fake.calls.find((c) => c.url.pathname === '/3/search/tv');
    expect(call?.url.searchParams.get('query')).toBe('signal');
    expect(call?.url.searchParams.get('first_air_date_year')).toBe('2021');
    expect(page.totalResults).toBe(2);
    expect(page.results[0]).toMatchObject({
      mediaType: 'series',
      tmdbId: 90210,
      title: 'Signal Lost',
      year: 2021,
      firstAired: '2021-09-14',
      images: {
        poster: 'https://image.tmdb.org/t/p/w500/signal-poster.jpg',
        backdrop: 'https://image.tmdb.org/t/p/w1280/signal-backdrop.jpg',
      },
      ratings: { tmdb: { value: 8.1, votes: 1304 } },
    });
    expect(page.results[1]).not.toHaveProperty('year');
    expect(page.results[1]?.images).toEqual({});
  });

  it('searches movies and passes year and region', async () => {
    const fake = createFakeFetch();
    const page = await makeClient(fake, { region: 'GB' }).searchMovies('harbor', { year: 2023 });
    const call = fake.calls.find((c) => c.url.pathname === '/3/search/movie');
    expect(call?.url.searchParams.get('year')).toBe('2023');
    expect(call?.url.searchParams.get('region')).toBe('GB');
    expect(page.results[0]).toMatchObject({
      mediaType: 'movie',
      tmdbId: 55500,
      title: 'The Last Harbor',
      year: 2023,
      releaseDate: '2023-07-21',
    });
  });

  it('multi search keeps tv and movie rows and drops people', async () => {
    const page = await makeClient().searchMulti('harbor');
    expect(page.results.map((r) => r.mediaType)).toEqual(['movie', 'series']);
    expect(page.totalResults).toBe(3);
  });

  it('finds by imdb id', async () => {
    const fake = createFakeFetch();
    const results = await makeClient(fake).findByImdbId('tt5550001');
    const call = fake.calls.find((c) => c.url.pathname.startsWith('/3/find/'));
    expect(call?.url.pathname).toBe('/3/find/tt5550001');
    expect(call?.url.searchParams.get('external_source')).toBe('imdb_id');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ mediaType: 'movie', tmdbId: 55500 });
  });

  it('finds by tvdb id with the right external_source', async () => {
    const fake = createFakeFetch();
    await makeClient(fake).findByTvdbId(400123);
    const call = fake.calls.find((c) => c.url.pathname.startsWith('/3/find/'));
    expect(call?.url.pathname).toBe('/3/find/400123');
    expect(call?.url.searchParams.get('external_source')).toBe('tvdb_id');
  });

  it('loads series details with the appended sub-resources', async () => {
    const fake = createFakeFetch();
    const series = await makeClient(fake).getSeries(90210);
    const call = fake.calls.find((c) => c.url.pathname === '/3/tv/90210');
    expect(call?.url.searchParams.get('append_to_response')).toBe(
      'external_ids,alternative_titles,content_ratings,images,keywords',
    );
    expect(series.title).toBe('Signal Lost');
    expect(series.tvdbId).toBe(400123);
    expect(series.seasons).toHaveLength(4);
    expect(series.status).toBe('continuing');
  });

  it('loads season episodes', async () => {
    const episodes = await makeClient().getSeason(90210, 1);
    expect(episodes.map((e) => e.episodeNumber)).toEqual([1, 2, 3]);
    expect(episodes[0]?.title).toBe('Frequency');
  });

  it('loads movie details and derives status from the injected clock', async () => {
    const fake = createFakeFetch();
    const movie = await makeClient(fake).getMovie(55500);
    const call = fake.calls.find((c) => c.url.pathname === '/3/movie/55500');
    expect(call?.url.searchParams.get('append_to_response')).toBe(
      'external_ids,alternative_titles,release_dates,images,videos,keywords',
    );
    expect(movie.status).toBe('released');
    expect(movie.physicalRelease).toBe('2023-10-24');

    const upcoming = await makeClient(fake).getMovie(66600);
    expect(upcoming.status).toBe('announced');
  });

  it('loads genre lists', async () => {
    const genres = await makeClient().getGenres('movie');
    expect(genres).toEqual([
      { tmdbId: 28, name: 'Action' },
      { tmdbId: 16, name: 'Animation' },
      { tmdbId: 878, name: 'Science Fiction' },
    ]);
  });

  it('stamps media_type on single-kind trending results', async () => {
    const fake = createFakeFetch((url) =>
      url.pathname === '/3/trending/movie/day'
        ? jsonResponse({ page: 1, results: fixtures.searchMovie.results })
        : defaultRoute(url),
    );
    const page = await makeClient(fake).getTrending('movie', 'day');
    expect(page.results).toHaveLength(2);
    expect(page.results.every((r) => r.mediaType === 'movie')).toBe(true);
  });

  it('maps discover options onto TMDB query params', async () => {
    const fake = createFakeFetch();
    const client = makeClient(fake);
    await client.discover('movie', { sortBy: 'popularity.desc', withGenres: '878', year: 2023, voteCountGte: 50 });
    await client.discover('tv', { year: 2021 });
    const movieCall = fake.calls.find((c) => c.url.pathname === '/3/discover/movie');
    expect(movieCall?.url.searchParams.get('sort_by')).toBe('popularity.desc');
    expect(movieCall?.url.searchParams.get('with_genres')).toBe('878');
    expect(movieCall?.url.searchParams.get('primary_release_year')).toBe('2023');
    expect(movieCall?.url.searchParams.get('vote_count.gte')).toBe('50');
    const tvCall = fake.calls.find((c) => c.url.pathname === '/3/discover/tv');
    expect(tvCall?.url.searchParams.get('first_air_date_year')).toBe('2021');
  });
});
