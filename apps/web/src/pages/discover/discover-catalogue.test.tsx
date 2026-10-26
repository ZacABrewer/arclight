import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { authRoutes, defaultSettings, makeItem, makeTitle, renderAt, season, stubApi, user } from '../../features/requests/test-utils.js';
import { collectionResultMessage } from './collection-page.js';
import { knownFor } from './person-page.js';
import { quotaText } from './request-modal.js';
import { seeAllTarget } from './discover-home.js';

afterEach(() => vi.unstubAllGlobals());

const page = (results: unknown[], n = 1, total = 1) => ({ page: n, totalPages: total, totalResults: results.length * total, results });
const options = { region: 'GB', language: 'en-GB', regions: [{ code: 'GB', name: 'United Kingdom' }], languages: [{ code: 'fr', name: 'French' }], certifications: { movie: [{ certification: '12A', meaning: '' }], tv: [] } };

describe('discover catalogue helpers', () => {
  it('sends every slider to its full page', () => {
    expect(seeAllTarget({ type: 'nowPlaying', data: null })).toEqual({ to: '/list/$list', params: { list: 'nowPlaying' } });
    expect(seeAllTarget({ type: 'airingTv', data: null })).toEqual({ to: '/list/$list', params: { list: 'onTheAir' } });
    expect(seeAllTarget({ type: 'recentRequests', data: null })).toBeNull();
    expect(seeAllTarget({ type: 'recentRequests', data: null }, true)).toEqual({ to: '/requests' });
    expect(seeAllTarget({ type: 'tmdbTvGenre', data: '18,35' })).toEqual({ to: '/genre/$id', params: { id: '18' }, search: { mediaType: 'tv' } });
  });

  it('words quotas and collection results', () => {
    expect(quotaText('movie', { days: 7, limit: 10, used: 3, remaining: 7, restricted: false })).toBe('Movie requests left: 7 of 10 per 7 days');
    expect(quotaText('series', { days: null, limit: 4, used: 4, remaining: 0, restricted: true })).toBe('Season requests left: 0 of 4');
    expect(quotaText('movie', { days: null, limit: null, used: 3, remaining: null, restricted: false })).toBeNull();
    expect(collectionResultMessage({ requested: [{ tmdbId: 1, title: 'A', status: 'pending' }], skipped: 2, failed: [] })).toEqual({ tone: 'ok', title: 'Requested 1 movie' });
    expect(collectionResultMessage({ requested: [], skipped: 3, failed: [] }).tone).toBe('info');
    expect(collectionResultMessage({ requested: [], skipped: 0, failed: [{ tmdbId: 2, title: 'B', error: 'Movie Quota exceeded.' }] })).toMatchObject({ tone: 'warning', message: 'B: Movie Quota exceeded.' });
  });

  it('picks the best-known credits by votes', () => {
    const credits = [
      { ...makeItem({ tmdbId: 1, voteCount: 10 }), character: 'A' },
      { ...makeItem({ tmdbId: 2, voteCount: 9000 }), character: 'B' },
      { ...makeItem({ tmdbId: 3, voteCount: 0 }), character: 'C' },
    ];
    expect(knownFor(credits).map((c) => c.tmdbId)).toEqual([2, 1]);
  });
});

describe('browse pages', () => {
  it('keeps filters in the URL and asks the api with them', async () => {
    const calls = stubApi(
      {
        '/api/v1/discover/genres': [
          { id: 18, name: 'Drama' },
          { id: 35, name: 'Comedy' },
        ],
        '/api/v1/discover/options': options,
        '/api/v1/discover/providers': [{ id: 8, name: 'Streamer', imageUrl: null }],
      },
      (url) => (url.startsWith('/api/v1/discover/movies') ? { body: page([makeItem({ tmdbId: 1, title: 'Found' })]) } : undefined),
    );
    const { router } = renderAt('/discover/movies?genres=18&hideAvailable=true');
    expect(await screen.findByRole('article', { name: 'Found' })).toBeTruthy();
    const first = calls.find((c) => c.url.startsWith('/api/v1/discover/movies'))!.url;
    expect(first).toContain('genre=18');
    expect(first).toContain('hideAvailable=true');
    // Toggling a genre updates the URL (shareable) and the query.
    const genres = screen.getByRole('group', { name: 'Genres' });
    expect(within(genres).getByRole('button', { name: 'Drama', pressed: true })).toBeTruthy();
    fireEvent.click(within(genres).getByRole('button', { name: 'Comedy' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ genres: '18,35' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('genre=18%7C35'))).toBe(true));
    // More filters: age rating and streaming services (listed for the instance region).
    fireEvent.click(screen.getByRole('button', { name: 'More filters' }));
    fireEvent.change(await screen.findByLabelText('Age rating'), { target: { value: '12A' } });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ cert: '12A' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Streamer' }));
    // No region in the URL: the api uses the instance region (the one the provider list came from).
    await waitFor(() => expect(calls.some((c) => c.url.includes('watchProviders=8') && !c.url.includes('watchRegion'))).toBe(true));
    expect(calls.some((c) => c.url === '/api/v1/discover/providers?mediaType=movie&region=GB')).toBe(true);
    // Switching to series keeps the filters.
    fireEvent.click(screen.getByRole('button', { name: 'Series' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/discover/tv'));
    expect(router.state.location.search).toMatchObject({ genres: '18,35', cert: '12A' });
  });

  it('serves ready-made lists as infinite grids', async () => {
    const calls = stubApi({}, (url) => (url.startsWith('/api/v1/discover/list/topRatedTv') ? { body: page([makeItem({ mediaType: 'series', tmdbId: 5, title: 'Best Show' })]) } : undefined));
    renderAt('/discover/list/topRatedTv');
    expect(await screen.findByRole('heading', { name: 'Top rated series' })).toBeTruthy();
    const card = await screen.findByRole('article', { name: 'Best Show' });
    expect(within(card).getAllByRole('link')[0]!.getAttribute('href')).toBe('/discover/tv/5');
    expect(calls.some((c) => c.url.startsWith('/api/v1/discover/list/topRatedTv?page=1'))).toBe(true);
  });
});

describe('search, title, collection', () => {
  it('searches people on the results page', async () => {
    stubApi({}, (url) => {
      if (url.startsWith('/api/v1/discover/search/people')) {
        return url.includes('page=2')
          ? { body: { page: 2, totalPages: 2, totalResults: 2, results: [{ tmdbId: 32, name: 'Second Person', knownFor: [] }] } }
          : { body: { page: 1, totalPages: 2, totalResults: 2, results: [{ tmdbId: 31, name: 'Ann Actor', profileUrl: null, knownFor: ['First Role'] }] } };
      }
      return undefined;
    });
    renderAt('/discover/search?q=ann&type=person');
    const ann = await screen.findByRole('article', { name: 'Ann Actor' });
    expect(within(ann).getByRole('link').getAttribute('href')).toBe('/discover/person/31');
    expect(screen.getByText('First Role')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('article', { name: 'Second Person' })).toBeTruthy();
  });

  it('requests one season from the seasons list and shows the quota', async () => {
    const calls = stubApi(
      {
        ...authRoutes(user({ id: 2 })),
        '/api/v1/discover/tv/9': makeTitle({ mediaType: 'series', tmdbId: 9, title: 'Rivers', seasons: [season(1, { status: 'available' }), season(2), season(3)] }),
        '/api/v1/settings/requests': defaultSettings(),
        '/api/v1/user/2/quota': {
          overrides: { movieLimit: null, movieDays: null, tvLimit: null, tvDays: null },
          effective: { movieLimit: null, movieDays: null, tvLimit: 6, tvDays: 30 },
          exempt: false,
          status: { movie: { days: null, limit: null, used: 0, remaining: null, restricted: false }, series: { days: 30, limit: 6, used: 2, remaining: 4, restricted: false } },
        },
      },
      (url, method) => (url === '/api/v1/request' && method === 'POST' ? { status: 202, body: { message: 'Queued' } } : undefined),
    );
    renderAt('/discover/tv/9');
    const seasons = await screen.findByRole('region', { name: 'Seasons' });
    expect(within(seasons).queryByRole('button', { name: 'Request Season 1' })).toBeNull();
    fireEvent.click(within(seasons).getByRole('button', { name: 'Request Season 3' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request Rivers' });
    expect(await within(dialog).findByText('Season requests left: 4 of 6 per 30 days')).toBeTruthy();
    await waitFor(() => expect((within(dialog).getByLabelText('Season 3') as HTMLInputElement).checked).toBe(true));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request 1 season' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/request' && c.method === 'POST')?.body).toMatchObject({ seasons: [3] }));
  });

  it('requests every missing movie of a collection', async () => {
    const calls = stubApi(
      {
        '/api/v1/discover/collection/2344': {
          tmdbId: 2344,
          name: 'The Matrix Collection',
          overview: 'Three films.',
          parts: [makeItem({ tmdbId: 603, mediaStatus: 'available' }), makeItem({ tmdbId: 604, title: 'Reloaded' })],
          missing: 1,
          canRequest: true,
          canRequest4k: false,
        },
      },
      (url, method) =>
        url === '/api/v1/discover/collection/2344/request' && method === 'POST' ? { body: { requested: [{ tmdbId: 604, title: 'Reloaded', status: 'pending' }], skipped: 1, failed: [] } } : undefined,
    );
    renderAt('/discover/collection/2344');
    expect(await screen.findByRole('heading', { name: 'The Matrix Collection' })).toBeTruthy();
    const parts = screen.getByRole('region', { name: 'Movies in this collection' });
    expect(within(within(parts).getByRole('article', { name: 'The Matrix' })).getByText('Available')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Request all missing (1)' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/discover/collection/2344/request' && c.method === 'POST')).toBe(true));
    expect(await screen.findByText('Requested 1 movie')).toBeTruthy();
  });

  it('shows release dates, certification, crew and a Declined badge on posters', async () => {
    stubApi({
      '/api/v1/discover/movie/603': makeTitle({
        certification: 'R',
        releaseDates: { inCinemas: '1999-03-31', digital: '1999-09-21', physical: null },
        crew: [{ tmdbId: 9, name: 'Lana Example', job: 'Director' }],
        similar: [makeItem({ tmdbId: 604, title: 'Turned Down', requestStatus: 'declined' })],
      }),
      '/api/v1/settings/requests': defaultSettings(),
    });
    renderAt('/discover/movie/603');
    expect(await screen.findByText('1999-03-31')).toBeTruthy();
    expect(screen.getByText('R')).toBeTruthy();
    const crew = screen.getByRole('region', { name: 'Crew' });
    expect(within(crew).getByRole('link', { name: /Lana Example/ }).getAttribute('href')).toBe('/discover/person/9');
    const similar = screen.getByRole('region', { name: 'Similar' });
    expect(within(within(similar).getByRole('article', { name: 'Turned Down' })).getByText('Declined')).toBeTruthy();
  });
});
