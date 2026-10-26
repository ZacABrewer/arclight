import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { availabilityBadge } from '../../features/requests/status.js';
import { makeItem, makeTitle, renderAt, season, stubApi } from '../../features/requests/test-utils.js';
import { buildDiscoverQuery, EMPTY_FILTERS } from './discover-browse.js';

afterEach(() => vi.unstubAllGlobals());

const discoverPage = (results: unknown[], page = 1, totalPages = 1) => ({ page, totalPages, totalResults: results.length, results });

describe('discover', () => {
  it('turns the filter bar into api params, dropping invalid input', () => {
    expect(buildDiscoverQuery({ ...EMPTY_FILTERS, genre: '18', yearFrom: '1990', yearTo: '19x', minRating: '7.5', language: 'EN', runtimeMax: '120' })).toEqual({
      sortBy: 'popularity.desc',
      genre: '18',
      releaseDateGte: '1990-01-01',
      voteAverageGte: 7.5,
      language: 'en',
      runtimeLte: 120,
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
    stubApi({
      '/api/v1/discoverslider': [slider(1, 'studios', 3), slider(2, 'trending', 1), slider(3, 'movieGenres', 2), slider(4, 'popularTv', 4, false)],
      '/api/v1/discover/slider/2': discoverPage([makeItem({ title: 'Hot Thing' })]),
      '/api/v1/discover/genres': [{ id: 28, name: 'Action' }],
    });
    renderAt('/discover');
    expect(await screen.findByRole('article', { name: 'Hot Thing' })).toBeTruthy();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Trending', 'Movie genres', 'Studios']);
    expect((await screen.findByRole('link', { name: 'Action' })).getAttribute('href')).toBe('/discover/genre/28?mediaType=movie');
    expect(screen.getByRole('link', { name: 'A24' }).getAttribute('href')).toBe('/discover/studio/41077');
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
