import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { album, albumDetails, api, emptyMusicHome, mockPlayer, playlistDetails, playlistSummary, renderBrowse, stubFetch, track } from './test-utils.js';

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
    });
    renderBrowse('/player/music');

    for (const name of ['Jump back in', 'Recently played', 'Recently added', 'Your playlists', 'On this day']) {
      expect(await screen.findByRole('heading', { name })).toBeTruthy();
    }
    const nav = screen.getByRole('navigation', { name: 'Music sections' });
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: /Brand New/ }).getAttribute('href')).toBe('/player/music/album/3');
    expect(screen.getByRole('button', { name: 'Scroll Recently added forward' })).toBeTruthy();
  });

  it('plays recent tracks from the clicked one', async () => {
    stubFetch({ [api('/music/home')]: { ...emptyMusicHome, recentlyPlayed: [track(1, { title: 'One' }), track(2, { title: 'Two' })] } });
    const player = mockPlayer();
    renderBrowse('/player/music', player);
    await userEvent.click(await screen.findByRole('button', { name: 'Play Two by Example Artist' }));
    expect(player.playItems).toHaveBeenCalledWith(['track:1', 'track:2'], { startIndex: 1, source: 'recent' });
  });

  it('plays an album and a playlist from their cards', async () => {
    stubFetch({
      [api('/music/home')]: { ...emptyMusicHome, recentlyAdded: [album(3, { title: 'Brand New' })], playlists: [playlistSummary(7, { name: 'Evening' })] },
      [api('/music/albums/3')]: albumDetails(3, [track(30), track(31)]),
      [api('/playlists/7')]: playlistDetails(7, [track(70)]),
    });
    const player = mockPlayer();
    renderBrowse('/player/music', player);
    await userEvent.click(await screen.findByRole('button', { name: 'Play Brand New' }));
    await waitFor(() => expect(player.playItems).toHaveBeenCalledWith(['track:30', 'track:31'], { source: 'album:3' }));
    await userEvent.click(screen.getByRole('button', { name: 'Play Evening' }));
    await waitFor(() => expect(player.playItems).toHaveBeenLastCalledWith(['track:70'], { source: 'playlist:7' }));
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

  it('uses the placeholder mark when there is no artwork', async () => {
    stubFetch({ [api('/music/home')]: { ...emptyMusicHome, recentlyAdded: [album(3)] } });
    renderBrowse('/player/music');
    await screen.findByRole('heading', { name: 'Recently added' });
    expect(screen.getAllByTestId('pb-art-placeholder').length).toBeGreaterThan(0);
  });
});
