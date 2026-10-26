import { describe, expect, it } from 'vitest';
import { createFakeFetch, defaultRoute, jsonResponse } from '../test-support.js';
import { createTmdbClient } from './client.js';

const movieExtras = {
  id: 603,
  tagline: 'Welcome to the Real World.',
  genres: [{ id: 28, name: 'Action' }],
  production_companies: [{ id: 174, name: 'Warner Bros. Pictures', logo_path: '/wb.png' }],
  credits: {
    cast: [
      { id: 2, name: 'Second', character: 'B', order: 1, profile_path: null },
      { id: 1, name: 'First', character: 'A', order: 0, profile_path: '/a.jpg' },
    ],
    crew: [
      { id: 9, name: 'Grip', job: 'Grip', department: 'Crew' },
      { id: 8, name: 'Boss', job: 'Director', department: 'Directing' },
      { id: 8, name: 'Boss', job: 'Director', department: 'Directing' },
    ],
  },
  similar: { results: [{ id: 604, title: 'Reloaded', release_date: '2003-05-15' }] },
  recommendations: { results: [{ id: 605, title: 'Revolutions', release_date: '2003-11-05' }] },
  videos: {
    results: [
      { key: 'fan', site: 'YouTube', type: 'Featurette', official: false, name: 'Fan' },
      { key: 'tr', site: 'YouTube', type: 'Trailer', official: true, name: 'Official Trailer' },
      { key: 'x', site: 'Dailymotion', type: 'Trailer' },
    ],
  },
  keywords: { keywords: [{ id: 310, name: 'artificial intelligence' }] },
};

const person = {
  id: 6384,
  name: 'Keanu Reeves',
  biography: 'Actor.',
  birthday: '1964-09-02',
  profile_path: '/k.jpg',
  combined_credits: {
    cast: [
      { media_type: 'movie', id: 603, title: 'The Matrix', release_date: '1999-03-30', character: 'Neo' },
      { media_type: 'tv', id: 1, name: 'Show', first_air_date: '2020-01-01', character: 'Self' },
      { media_type: 'person', id: 5 },
    ],
    crew: [
      { media_type: 'movie', id: 700, title: 'Man of Tai Chi', release_date: '2013-07-05', job: 'Director' },
      { media_type: 'movie', id: 700, title: 'Man of Tai Chi', release_date: '2013-07-05', job: 'Producer' },
    ],
  },
};

function client(route = defaultRoute) {
  const fake = createFakeFetch(route);
  return { fake, tmdb: createTmdbClient({ apiKey: 'k', fetchImpl: fake.fetch, sleep: async () => {} }) };
}

describe('title extras', () => {
  it('maps credits, videos, similar, recommendations, keywords and companies', async () => {
    const { fake, tmdb } = client((url) => (url.pathname === '/3/movie/603' ? jsonResponse(movieExtras) : defaultRoute(url)));
    const extras = await tmdb.getMovieExtras(603);
    const call = fake.calls.find((c) => c.url.pathname === '/3/movie/603');
    expect(call?.url.searchParams.get('append_to_response')).toContain('credits');
    expect(extras.cast.map((c) => c.name)).toEqual(['First', 'Second']);
    expect(extras.cast[0]?.profile).toMatch(/\/a\.jpg$/);
    expect(extras.crew.map((c) => c.job)).toEqual(['Director', 'Grip']);
    expect(extras.videos.map((v) => v.key)).toEqual(['tr', 'fan']);
    expect(extras.similar[0]).toMatchObject({ mediaType: 'movie', tmdbId: 604, year: 2003 });
    expect(extras.recommendations[0]?.tmdbId).toBe(605);
    expect(extras.keywords).toEqual([{ tmdbId: 310, name: 'artificial intelligence' }]);
    expect(extras.companies[0]).toMatchObject({ tmdbId: 174, name: 'Warner Bros. Pictures' });
    expect(extras.tagline).toBe('Welcome to the Real World.');
  });

  it('maps a person with de-duplicated, newest-first credits', async () => {
    const { tmdb } = client((url) => (url.pathname === '/3/person/6384' ? jsonResponse(person) : defaultRoute(url)));
    const p = await tmdb.getPerson(6384);
    expect(p.name).toBe('Keanu Reeves');
    expect(p.cast.map((c) => c.tmdbId)).toEqual([1, 603]);
    expect(p.cast[1]).toMatchObject({ character: 'Neo', mediaType: 'movie' });
    expect(p.crew).toHaveLength(1);
    expect(p.crew[0]?.job).toBe('Director, Producer');
  });
});

describe('discover filters', () => {
  it('maps the wider filter set to TMDB params per kind', async () => {
    const empty = { page: 1, total_pages: 1, total_results: 0, results: [] };
    const { fake, tmdb } = client((url) => (url.pathname.startsWith('/3/discover') ? jsonResponse(empty) : defaultRoute(url)));
    await tmdb.discover('movie', { releaseDateGte: '2020-01-01', withCompanies: '2', withKeywords: '9', voteAverageLte: 8 });
    await tmdb.discover('tv', { releaseDateGte: '2021-01-01', withNetworks: '213' });
    const movie = fake.calls.find((c) => c.url.pathname === '/3/discover/movie')!.url.searchParams;
    expect(movie.get('primary_release_date.gte')).toBe('2020-01-01');
    expect(movie.get('with_companies')).toBe('2');
    expect(movie.get('with_keywords')).toBe('9');
    expect(movie.get('vote_average.lte')).toBe('8');
    const tv = fake.calls.find((c) => c.url.pathname === '/3/discover/tv')!.url.searchParams;
    expect(tv.get('first_air_date.gte')).toBe('2021-01-01');
    expect(tv.get('with_networks')).toBe('213');
    expect(tv.has('with_companies')).toBe(false);
  });
});
