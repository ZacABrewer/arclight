import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { api, renderBrowse, stubFetch } from '../../browse/test-utils.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const empty = { tracks: [], albums: [], artists: [], audiobooks: [], movies: [], series: [] };
const movie = {
  id: 7,
  itemKey: 'movie:7',
  title: 'Spider-Man: No Way Home',
  year: 2021,
  posterUrl: null,
  backdropUrl: null,
  runtimeMinutes: 148,
  certification: 'PG-13',
  rating: 8,
  genres: ['Action'],
  addedAt: null,
  progress: null,
  played: false,
  badges: [],
};

describe('RdSearchPage (/player/watch/search)', () => {
  it('searches the ?q= and shows the movies the server found', async () => {
    const calls = stubFetch({ [api('/search')]: (url: URL) => (url.searchParams.get('q') === 'spiderman' ? { ...empty, movies: [movie] } : empty) });
    renderBrowse('/player/watch/search?q=spiderman');
    expect(await screen.findByRole('link', { name: /Spider-Man: No Way Home/ })).toBeTruthy();
    expect(calls.filter((c) => c.path === api('/search')).map((c) => c.search.get('q'))).toEqual(['spiderman']);
  });

  it('a failed search says so instead of "no matches"', async () => {
    stubFetch({ [api('/search')]: new Response('{"error":"down","code":"X"}', { status: 500 }) });
    renderBrowse('/player/watch/search?q=dune');
    expect(await screen.findByText("Search didn't work")).toBeTruthy();
    expect(screen.queryByText(/No matches/i)).toBeNull();
  });
});
