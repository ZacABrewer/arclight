import { describe, expect, it } from 'vitest';
import { createFakeFetch, defaultRoute, fixtures, jsonResponse } from '../test-support.js';
import { createTmdbClient } from './client.js';

// Discover catalogue endpoints: ready-made lists, people search, collections, watch
// providers and the filter vocabularies, plus in-flight de-duplication.

const NOW = new Date('2024-01-01T00:00:00Z');

function route(url: URL): Response {
  const path = url.pathname.replace(/^\/3/, '');
  switch (path) {
    case '/movie/now_playing':
    case '/movie/top_rated':
      return jsonResponse(fixtures.searchMovie);
    case '/tv/on_the_air':
      return jsonResponse(fixtures.searchTv);
    case '/search/person':
      return jsonResponse({
        page: 1,
        total_pages: 3,
        total_results: 41,
        results: [
          {
            id: 31,
            name: 'Ada Example',
            profile_path: '/ada.jpg',
            known_for_department: 'Acting',
            popularity: 12.5,
            known_for: [
              { media_type: 'movie', id: 10, title: 'First Film', release_date: '2001-05-01' },
              { media_type: 'tv', id: 11, name: 'A Show', first_air_date: '2010-01-01' },
              { media_type: 'person', id: 99 },
            ],
          },
        ],
      });
    case '/collection/10':
      return jsonResponse({
        id: 10,
        name: 'Example Collection',
        overview: 'Three films.',
        poster_path: '/c.jpg',
        backdrop_path: '/cb.jpg',
        parts: [
          { id: 3, title: 'Third', release_date: '2010-01-01' },
          { id: 1, title: 'First', release_date: '2001-01-01' },
          { id: 4, title: 'Announced' },
          { id: 2, title: 'Second', release_date: '2005-01-01' },
        ],
      });
    case '/watch/providers/movie':
      return jsonResponse({
        results: [
          { provider_id: 9, provider_name: 'Late Service', logo_path: '/l.png', display_priority: 20 },
          { provider_id: 8, provider_name: 'First Service', logo_path: '/f.png', display_priority: 1 },
        ],
      });
    case '/watch/providers/regions':
      return jsonResponse({ results: [{ iso_3166_1: 'GB', english_name: 'United Kingdom' }, { iso_3166_1: 'DE', english_name: 'Germany' }] });
    case '/certification/movie/list':
      return jsonResponse({
        certifications: {
          US: [
            { certification: 'R', meaning: 'Restricted', order: 4 },
            { certification: 'G', meaning: 'General', order: 1 },
          ],
          DE: [{ certification: '12', meaning: '', order: 2 }],
        },
      });
    case '/configuration/languages':
      return jsonResponse([
        { iso_639_1: 'fr', english_name: 'French', name: 'Français' },
        { iso_639_1: 'de', english_name: 'German', name: 'Deutsch' },
      ]);
    case '/search/keyword':
      return jsonResponse({ page: 1, total_pages: 1, total_results: 1, results: [{ id: 818, name: 'based on novel' }] });
    case '/keyword/818':
      return jsonResponse({ id: 818, name: 'based on novel' });
    default:
      return defaultRoute(url);
  }
}

function makeClient(fake = createFakeFetch(route)) {
  return { fake, client: createTmdbClient({ apiKey: 'k', fetchImpl: fake.fetch, now: () => NOW, sleep: async () => {} }) };
}

describe('TMDB catalogue endpoints', () => {
  it('reads ready-made lists with paging, sending the region for movie lists', async () => {
    const { fake, client } = makeClient();
    const movies = await client.getList('movie', 'nowPlaying', 2);
    expect(movies.results[0]?.mediaType).toBe('movie');
    const call = fake.calls.find((c) => c.url.pathname === '/3/movie/now_playing');
    expect(call?.url.searchParams.get('page')).toBe('2');
    expect(call?.url.searchParams.get('region')).toBe('US');
    const tv = await client.getList('tv', 'onTheAir');
    expect(tv.results[0]?.mediaType).toBe('series');
  });

  it('rejects list names a media type does not have', async () => {
    const { client } = makeClient();
    await expect(client.getList('tv', 'nowPlaying')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('maps people search with known-for titles (people rows dropped)', async () => {
    const { client } = makeClient();
    const page = await client.searchPeople('ada');
    expect(page).toMatchObject({ page: 1, totalPages: 3, totalResults: 41 });
    const ada = page.results[0]!;
    expect(ada).toMatchObject({ tmdbId: 31, name: 'Ada Example', knownForDepartment: 'Acting' });
    expect(ada.profile).toMatch(/\/ada\.jpg$/);
    expect(ada.knownFor.map((k) => `${k.mediaType}:${k.tmdbId}`)).toEqual(['movie:10', 'series:11']);
  });

  it('sorts collection parts by release date with undated parts last', async () => {
    const { client } = makeClient();
    const c = await client.getCollection(10);
    expect(c.name).toBe('Example Collection');
    expect(c.parts.map((p) => p.tmdbId)).toEqual([1, 2, 3, 4]);
    expect(c.images.poster).toMatch(/\/c\.jpg$/);
  });

  it('orders watch providers by display priority and regions by name', async () => {
    const { fake, client } = makeClient();
    const providers = await client.getWatchProviders('movie', 'GB');
    expect(providers.map((p) => p.tmdbId)).toEqual([8, 9]);
    expect(fake.calls.find((c) => c.url.pathname === '/3/watch/providers/movie')?.url.searchParams.get('watch_region')).toBe('GB');
    const regions = await client.getWatchRegions();
    expect(regions.map((r) => r.code)).toEqual(['DE', 'GB']);
  });

  it('returns one country of certifications in TMDB order', async () => {
    const { client } = makeClient();
    expect((await client.getCertifications('movie')).map((c) => c.certification)).toEqual(['G', 'R']);
    expect((await client.getCertifications('movie', 'de')).map((c) => c.certification)).toEqual(['12']);
    expect(await client.getCertifications('movie', 'ZZ')).toEqual([]);
  });

  it('lists languages and keywords', async () => {
    const { client } = makeClient();
    expect((await client.getLanguages()).map((l) => l.code)).toEqual(['fr', 'de']);
    expect((await client.searchKeywords('novel')).results).toEqual([{ tmdbId: 818, name: 'based on novel' }]);
    expect(await client.getKeyword(818)).toEqual({ tmdbId: 818, name: 'based on novel' });
  });

  it('passes certification filters with the certification country', async () => {
    const { fake, client } = makeClient();
    await client.discover('movie', { certificationLte: 'PG-13' });
    const url = fake.calls.find((c) => c.url.pathname === '/3/discover/movie')!.url;
    expect(url.searchParams.get('certification.lte')).toBe('PG-13');
    expect(url.searchParams.get('certification_country')).toBe('US');
  });

  it('shares one TMDB call between identical requests in flight', async () => {
    const fake = createFakeFetch(route);
    const { client } = makeClient(fake);
    await client.getConfiguration();
    const before = fake.calls.length;
    await Promise.all([client.getList('movie', 'topRated'), client.getList('movie', 'topRated'), client.getList('movie', 'topRated')]);
    expect(fake.calls.length - before).toBe(1);
  });
});
