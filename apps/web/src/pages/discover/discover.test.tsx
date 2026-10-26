import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { availabilityBadge } from '../../features/requests/status.js';
import { makeItem, makeTitle, renderAt, season, stubApi } from '../../features/requests/test-utils.js';
import { browseQuery, parseBrowseSearch } from '../../features/discover/filters.js';

afterEach(() => vi.unstubAllGlobals());

const discoverPage = (results: unknown[], page = 1, totalPages = 1) => ({ page, totalPages, totalResults: results.length, results });

describe('discover', () => {
  it('turns the filters in the URL into api params, dropping invalid input', () => {
    const search = parseBrowseSearch({ genres: '18,35,x', from: '1990', to: '19x', ratingMin: '7.5', lang: 'EN', runtimeMax: '120', hideRequested: 'true', bogus: 1 });
    expect(search).toEqual({ genres: '18,35', from: '1990', ratingMin: '7.5', lang: 'en', runtimeMax: '120', hideRequested: true });
    expect(browseQuery('movie', search)).toEqual({
      sortBy: 'popularity.desc',
      genre: '18|35',
      releaseDateGte: '1990-01-01',
      voteAverageGte: 7.5,
      language: 'en',
      runtimeLte: 120,
      hideRequested: true,
    });
    expect(availabilityBadge('unknown', 'pending')?.label).toBe('Requested');
    expect(availabilityBadge('unknown', null)).toBeNull();
  });

  it('renders the grid with status badges and loads the next page', async () => {
    const calls = stubApi({ '/api/v1/discover/genres': [{ id: 18, name: 'Drama' }] }, (url) => {
      if (!url.startsWith('/api/v1/discover/movies')) return undefined;
      return url.includes('page=2')
        ? { body: discoverPage([makeItem({ tmdbId: 3, title: 'Third' })], 2, 2) }
        : {
            body: discoverPage(
              [makeItem({ tmdbId: 1, title: 'Got It', mediaStatus: 'available' }), makeItem({ tmdbId: 2, title: 'Asked', requestStatus: 'pending' })],
              1,
              2,
            ),
          };
    });
    renderAt('/discover/movies');
    const grid = await screen.findByTestId('discover-grid');
    expect(within(within(grid).getByRole('article', { name: 'Got It' })).getByText('Available')).toBeTruthy();
    expect(within(within(grid).getByRole('article', { name: 'Asked' })).getByText('Requested')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('article', { name: 'Third' })).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/discover/movies?') && c.url.includes('page=2'))).toBe(true);
  });

  it('renders discover home sliders in order, genre chips and studio links', async () => {
    const slider = (id: number, type: string, order: number, enabled = true) => ({
      id,
      type,
      order,
      isBuiltIn: true,
      enabled,
      title: null,
      data: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const calls = stubApi({
      '/api/v1/discoverslider': [slider(1, 'studios', 3), slider(2, 'trending', 1), slider(3, 'movieGenres', 2), slider(4, 'popularTv', 4, false)],
      '/api/v1/discover/slider/2': discoverPage([makeItem({ title: 'Hot Thing' })]),
      '/api/v1/discover/genres/tiles': [{ id: 28, name: 'Action', imageUrl: 'https://image.tmdb.org/t/p/w1280/action.jpg' }],
      '/api/v1/discover/companies': [{ id: 41077, name: 'A24', imageUrl: null }],
    });
    renderAt('/discover');
    expect(await screen.findByRole('article', { name: 'Hot Thing' })).toBeTruthy();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Trending', 'Movie genres', 'Studios']);
    const action = await screen.findByRole('link', { name: 'Action' });
    expect(action.getAttribute('href')).toBe('/discover/genre/28?mediaType=movie');
    // Genre tiles load backdrops at the tile size, not the api's size.
    expect(action.querySelector('img')?.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w780/action.jpg');
    expect((await screen.findByRole('link', { name: 'A24' })).getAttribute('href')).toBe('/discover/studio/41077');
    // The trending row switches its time window in place.
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/v1/discover/slider/2') && c.url.includes('timeWindow=week'))).toBe(true));
  });

  it('title page offers Request and shows season status in the dialog', async () => {
    stubApi({
      '/api/v1/discover/tv/1399': makeTitle({ mediaType: 'series', tmdbId: 1399, title: 'Dragons', mediaStatus: 'partiallyAvailable', seasons: [season(1, { status: 'available' }), season(2)] }),
      '/api/v1/settings/requests': {},
    });
    renderAt('/discover/tv/1399');
    expect(await screen.findByText('Partially available')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request Dragons' });
    await waitFor(() => expect((within(dialog).getByLabelText('Season 1') as HTMLInputElement).disabled).toBe(true));
    expect((within(dialog).getByLabelText('Season 2') as HTMLInputElement).disabled).toBe(false);
  });
});
