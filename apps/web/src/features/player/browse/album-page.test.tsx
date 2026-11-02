import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { album, albumDetails, api, artistDetails, mockPlayer, playlistDetails, playlistSummary, renderBrowse, stubFetch, track } from './test-utils.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const tracks = [track(1), track(2), track(3, { explicit: true })];

describe('AlbumPage', () => {
  it('shows the album and plays all of it with the album as the source', async () => {
    stubFetch({ [api('/music/albums/12')]: albumDetails(12, tracks, { title: 'Night Lines' }) });
    const player = mockPlayer();
    renderBrowse('/player/music/album/12', player);

    expect(await screen.findByRole('heading', { level: 1, name: 'Night Lines' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Example Artist' })[0]?.getAttribute('href')).toBe('/player/music/artist/4');
    expect(screen.getAllByText('FLAC 24/96').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(player.playItems).toHaveBeenCalledWith(['track:1', 'track:2', 'track:3'], { source: 'album:12' });
  });

  it('starts at the clicked track', async () => {
    stubFetch({ [api('/music/albums/12')]: albumDetails(12, tracks) });
    const player = mockPlayer();
    renderBrowse('/player/music/album/12', player);

    await userEvent.click(await screen.findByRole('button', { name: 'Play Track 2' }));
    expect(player.playItems).toHaveBeenCalledWith(['track:1', 'track:2', 'track:3'], { startIndex: 1, source: 'album:12' });
  });

  it('toggles instead of restarting when the track is already current', async () => {
    stubFetch({ [api('/music/albums/12')]: albumDetails(12, tracks) });
    const player = mockPlayer({ currentItemKey: 'track:2', playing: true });
    renderBrowse('/player/music/album/12', player);

    const row = (await screen.findByRole('button', { name: 'Pause Track 2' })).closest('li');
    expect(row?.getAttribute('aria-current')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Pause Track 2' }));
    expect(player.toggle).toHaveBeenCalled();
    expect(player.playItems).not.toHaveBeenCalled();
  });

  it('shuffles every track of the album', async () => {
    stubFetch({ [api('/music/albums/12')]: albumDetails(12, tracks) });
    const player = mockPlayer();
    renderBrowse('/player/music/album/12', player);

    await userEvent.click(await screen.findByRole('button', { name: 'Shuffle' }));
    const [keys, opts] = player.playItems.mock.calls[0] as [string[], unknown];
    expect([...keys].sort()).toEqual(['track:1', 'track:2', 'track:3']);
    expect(opts).toEqual({ source: 'album:12' });
  });

  it('queues a track from its menu', async () => {
    stubFetch({ [api('/music/albums/12')]: albumDetails(12, tracks) });
    const player = mockPlayer();
    renderBrowse('/player/music/album/12', player);

    await userEvent.click(await screen.findByRole('button', { name: 'More for Track 3' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Play next' }));
    expect(player.playNext).toHaveBeenCalledWith(['track:3']);

    await userEvent.click(screen.getByRole('button', { name: 'More for Track 1' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Add to queue' }));
    expect(player.addToQueue).toHaveBeenCalledWith(['track:1']);
  });

  it('adds the whole album to an existing playlist', async () => {
    const calls = stubFetch({
      [api('/music/albums/12')]: albumDetails(12, tracks),
      [api('/playlists')]: [playlistSummary(7, { name: 'Evening' })],
      [api('/playlists/7')]: playlistDetails(7, [track(40)], { name: 'Evening' }),
      [`POST ${api('/playlists/7/tracks')}`]: playlistDetails(7, [track(40), ...tracks], { name: 'Evening' }),
    });
    renderBrowse('/player/music/album/12');

    await userEvent.click(await screen.findByRole('button', { name: 'Add to playlist' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('button', { name: /Evening/ }));

    // Only the new tracks are sent: the server appends them, nothing is read and rewritten.
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(api('/playlists/7/tracks'));
    expect(post?.body).toEqual({ trackIds: [1, 2, 3] });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('shows an error with a retry when loading fails', async () => {
    stubFetch({ [api('/music/albums/12')]: new Response('{"error":"boom","code":"X"}', { status: 500 }) });
    renderBrowse('/player/music/album/12');
    expect(await screen.findByText("Couldn't load this album")).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeTruthy();
  });

  it('says so for a bad id', async () => {
    stubFetch({});
    renderBrowse('/player/music/album/abc');
    expect(await screen.findByText('Album not found')).toBeTruthy();
  });
});

describe('ArtistPage', () => {
  it('groups releases and plays all albums oldest first', async () => {
    const a1 = album(1, { title: 'Early', year: 2001, albumType: 'Album' });
    const a2 = album(2, { title: 'Later', year: 2010, albumType: 'Album' });
    const ep = album(3, { title: 'Small One', year: 2005, albumType: 'EP' });
    stubFetch({
      [api('/music/artists/4')]: artistDetails(4, { name: 'Example Artist', albums: [a2, ep, a1], topTracks: [track(9, { title: 'Hit' })] }),
      [api('/music/albums/1')]: albumDetails(1, [track(11)]),
      [api('/music/albums/2')]: albumDetails(2, [track(21)]),
      [api('/music/albums/3')]: albumDetails(3, [track(31)]),
    });
    const player = mockPlayer();
    renderBrowse('/player/music/artist/4', player);

    expect(await screen.findByRole('heading', { level: 1, name: 'Example Artist' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Albums' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'EPs' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Top tracks' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Play all' }));
    await waitFor(() => expect(player.playItems).toHaveBeenCalled());
    expect(player.playItems).toHaveBeenCalledWith(['track:11', 'track:31', 'track:21'], { source: 'artist:4' });
  });

  it('plays a top track in place', async () => {
    stubFetch({ [api('/music/artists/4')]: artistDetails(4, { topTracks: [track(9), track(8)], albums: [album(1)] }) });
    const player = mockPlayer();
    renderBrowse('/player/music/artist/4', player);
    await userEvent.click(await screen.findByRole('button', { name: 'Play Track 8' }));
    expect(player.playItems).toHaveBeenCalledWith(['track:9', 'track:8'], expect.objectContaining({ startIndex: 1 }));
  });
});
