import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { album, api, artist, book, mockPlayer, renderBrowse, stubFetch, track } from './test-utils.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const empty = { tracks: [], albums: [], artists: [], audiobooks: [], movies: [], series: [] };

describe('PlayerSearchPage', () => {
  it('starts with a prompt and no request', async () => {
    const calls = stubFetch({ [api('/search')]: empty });
    renderBrowse('/player/search');
    expect(await screen.findByText('Find something to play')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search movies, shows, music and audiobooks' })).toBeTruthy();
    expect(calls.filter((c) => c.path === api('/search'))).toHaveLength(0);
  });

  it('waits for typing to settle before searching once', async () => {
    const calls = stubFetch({
      [api('/search')]: (url: URL) => (url.searchParams.get('q') === 'glass' ? { ...empty, tracks: [track(1, { title: 'Glass Steps' })] } : empty),
    });
    renderBrowse('/player/search');
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search movies, shows, music and audiobooks' }), 'glass');
    expect(await screen.findByRole('button', { name: 'Play Glass Steps' })).toBeTruthy();
    const searches = calls.filter((c) => c.path === api('/search'));
    expect(searches.map((c) => c.search.get('q'))).toEqual(['glass']);
  });

  it('starts with the ?q= from the URL and searches it', async () => {
    const calls = stubFetch({
      [api('/search')]: (url: URL) => (url.searchParams.get('q') === 'glass' ? { ...empty, tracks: [track(1, { title: 'Glass Steps' })] } : empty),
    });
    renderBrowse('/player/search?q=glass');
    const box = await screen.findByRole('searchbox', { name: 'Search movies, shows, music and audiobooks' });
    expect((box as HTMLInputElement).value).toBe('glass');
    expect(await screen.findByRole('button', { name: 'Play Glass Steps' })).toBeTruthy();
    expect(calls.filter((c) => c.path === api('/search')).map((c) => c.search.get('q'))).toEqual(['glass']);
  });

  it('groups results and plays a track with the search as the source', async () => {
    stubFetch({
      [api('/search')]: {
        tracks: [track(1, { title: 'Glass Steps' }), track(2, { title: 'Glass Floor' })],
        albums: [album(3, { title: 'Glass House' })],
        artists: [artist(4, { name: 'The Glaziers' })],
        audiobooks: [book(5, { title: 'Glass Ages' })],
        movies: [],
        series: [],
      },
    });
    const player = mockPlayer();
    renderBrowse('/player/search', player);
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search movies, shows, music and audiobooks' }), 'glass');

    expect(await screen.findByRole('heading', { name: 'Tracks' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Albums' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Artists' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Audiobooks' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /The Glaziers/ }).getAttribute('href')).toBe('/player/music/artist/4');
    expect(screen.getByRole('link', { name: /Glass Ages/ }).getAttribute('href')).toBe('/player/books/5');

    await userEvent.click(screen.getByRole('button', { name: 'Play Glass Floor' }));
    expect(player.playItems).toHaveBeenCalledWith(['track:1', 'track:2'], { startIndex: 1, source: 'search:glass' });
    // Albums and books are the same tiles as their own pages: one link each, no play overlay.
    expect(screen.getByRole('link', { name: /Glass House/ }).getAttribute('href')).toBe('/player/music/album/3');
    expect(screen.queryByRole('button', { name: 'Play Glass Ages' })).toBeNull();
  });

  it('says when nothing matched', async () => {
    stubFetch({ [api('/search')]: empty });
    renderBrowse('/player/search');
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search movies, shows, music and audiobooks' }), 'zzz');
    expect(await screen.findByText('Nothing found for “zzz”')).toBeTruthy();
  });

  it('shows the error state', async () => {
    stubFetch({ [api('/search')]: new Response('{"error":"down","code":"X"}', { status: 500 }) });
    renderBrowse('/player/search');
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search movies, shows, music and audiobooks' }), 'x');
    await waitFor(() => expect(screen.getByText("Search didn't work")).toBeTruthy());
  });
});
