import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { album, albumDetails, api, artist, emptyMusicHome, mockPlayer, page, playlistSummary, renderBrowse, stubFetch, track } from './test-utils.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MusicHomePage', () => {
  it('shows each shelf and the section nav', async () => {
    stubFetch({
      [api('/music/home')]: {
        ...emptyMusicHome,
        jumpBackIn: [album(1, { title: 'Back Again' })],
        recentlyPlayed: [track(2, { title: 'Last Heard' })],
        recentlyAdded: [album(3, { title: 'Brand New' })],
        playlists: [playlistSummary(7, { name: 'Evening' })],
        onThisDay: [album(4, { title: 'Years Ago' })],
      },
      [api('/music/albums')]: page([album(5, { title: 'Alpha' })], { total: 12 }),
      [api('/music/artists')]: page([artist(6, { name: 'Solo Singer' })]),
    });
    renderBrowse('/player/music');

    expect(await screen.findByRole('heading', { level: 1, name: 'Music' })).toBeTruthy();
    expect(await screen.findByText('12 albums')).toBeTruthy();
    for (const name of ['Recently played', 'Albums', 'Artists', 'Jump back in', 'Recently added', 'Your playlists', 'On this day']) {
      expect(await screen.findByRole('heading', { level: 2, name })).toBeTruthy();
    }
    // The rows follow the template's order: Recently played, Albums, Artists, then the rest.
    const rows = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(rows.slice(0, 3)).toEqual(['Recently played', 'Albums', 'Artists']);
    const nav = screen.getByRole('navigation', { name: 'Music sections' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Albums', 'Artists', 'Playlists']);
    expect(within(nav).queryByRole('link', { current: 'page' })).toBeNull();
    expect(screen.getByRole('link', { name: /Brand New/ }).getAttribute('href')).toBe('/player/music/album/3');
    expect(screen.getByRole('link', { name: /Alpha/ }).getAttribute('href')).toBe('/player/music/album/5');
    expect(screen.getByRole('link', { name: /Solo Singer/ }).getAttribute('href')).toBe('/player/music/artist/6');
    expect(screen.getByRole('link', { name: 'Search' }).getAttribute('href')).toBe('/player/search');
  });

  it('plays recent tracks from the clicked one', async () => {
    stubFetch({ [api('/music/home')]: { ...emptyMusicHome, recentlyPlayed: [track(1, { title: 'One' }), track(2, { title: 'Two' })] } });
    const player = mockPlayer();
    renderBrowse('/player/music', player);
    await userEvent.click(await screen.findByRole('button', { name: 'Play Two by Example Artist' }));
    expect(player.playItems).toHaveBeenCalledWith(['track:1', 'track:2'], { startIndex: 1, source: 'recent' });
  });

  it('plays a Jump back in album; other tiles open their page', async () => {
    stubFetch({
      [api('/music/home')]: {
        ...emptyMusicHome,
        jumpBackIn: [album(3, { title: 'Brand New' })],
        recentlyAdded: [album(4, { title: 'Fresh' })],
        playlists: [playlistSummary(7, { name: 'Evening' })],
      },
      [api('/music/albums/3')]: albumDetails(3, [track(30), track(31)]),
    });
    const player = mockPlayer();
    renderBrowse('/player/music', player);
    await userEvent.click(await screen.findByRole('button', { name: 'Play Brand New' }));
    await waitFor(() => expect(player.playItems).toHaveBeenCalledWith(['track:30', 'track:31'], { source: 'album:3' }));
    expect(screen.getByRole('link', { name: /Fresh/ }).getAttribute('href')).toBe('/player/music/album/4');
    expect(screen.getByRole('link', { name: /Evening/ }).getAttribute('href')).toBe('/player/music/playlist/7');
  });

  it('shows the empty library', async () => {
    stubFetch({ [api('/music/home')]: emptyMusicHome });
    renderBrowse('/player/music');
    expect(await screen.findByText('No music yet')).toBeTruthy();
  });

  it('shows an error that can be retried', async () => {
    let fail = true;
    stubFetch({
      [api('/music/home')]: () =>
        fail ? new Response('{"error":"down","code":"X"}', { status: 500 }) : { ...emptyMusicHome, recentlyAdded: [album(3, { title: 'Brand New' })] },
    });
    renderBrowse('/player/music');
    expect(await screen.findByText("Couldn't load your music")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(await screen.findByRole('link', { name: /Brand New/ })).toBeTruthy();
  });

  it('draws the placeholder art when there is no artwork', async () => {
    stubFetch({ [api('/music/home')]: { ...emptyMusicHome, recentlyAdded: [album(3, { title: 'Bare', artworkUrl: null })] } });
    renderBrowse('/player/music');
    const tile = await screen.findByRole('link', { name: /Bare/ });
    const art = tile.querySelector('.rd-tile__art') as HTMLElement;
    expect(art).toBeTruthy();
    expect(art.querySelector('img')).toBeNull();
    expect(art.style.background).not.toBe('');
  });
});
