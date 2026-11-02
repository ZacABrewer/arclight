import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, mockPlayer, playlistDetails, playlistSummary, renderBrowse, stubFetch, track } from './test-utils.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const tracks = [track(1), track(2), track(3)];

describe('PlaylistsPage', () => {
  it('lists playlists as links', async () => {
    stubFetch({ [api('/playlists')]: [playlistSummary(7, { name: 'Evening' }), playlistSummary(8, { name: 'Morning' })] });
    renderBrowse('/player/music/playlists');
    const list = await screen.findByRole('list', { name: 'Your playlists' });
    expect(within(list).getByRole('link', { name: /Evening/ }).getAttribute('href')).toBe('/player/music/playlist/7');
    expect(within(list).getByRole('link', { name: /Morning/ })).toBeTruthy();
  });

  it('accepts an { items } answer too', async () => {
    stubFetch({ [api('/playlists')]: { items: [playlistSummary(7, { name: 'Evening' })] } });
    renderBrowse('/player/music/playlists');
    expect(await screen.findByRole('link', { name: /Evening/ })).toBeTruthy();
  });

  it('shows an empty state with a way to start one', async () => {
    stubFetch({ [api('/playlists')]: [] });
    renderBrowse('/player/music/playlists');
    expect(await screen.findByText('No playlists yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New playlist' }).length).toBe(2);
  });

  it('creates a playlist and opens it', async () => {
    const calls = stubFetch({
      [api('/playlists')]: [],
      [`POST ${api('/playlists')}`]: playlistSummary(9, { name: 'Road trip', trackCount: 0 }),
      [api('/playlists/9')]: playlistDetails(9, [], { name: 'Road trip' }),
    });
    const { router } = renderBrowse('/player/music/playlists');

    await userEvent.click((await screen.findAllByRole('button', { name: 'New playlist' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Road trip');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create playlist' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/player/music/playlist/9'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Road trip' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Road trip' })).toBeTruthy();
  });
});

describe('PlaylistPage', () => {
  function stub(extra: Record<string, unknown> = {}) {
    return stubFetch({
      [api('/playlists/7')]: playlistDetails(7, tracks, { name: 'Evening' }),
      [`PUT ${api('/playlists/7')}`]: (_u: URL, body: unknown) => playlistSummary(7, body as { name: string }),
      ...extra,
    });
  }

  it('plays the playlist with the playlist as the source', async () => {
    stub();
    const player = mockPlayer();
    renderBrowse('/player/music/playlist/7', player);
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    expect(player.playItems).toHaveBeenCalledWith(['track:1', 'track:2', 'track:3'], { source: 'playlist:7' });
    await userEvent.click(screen.getByRole('button', { name: 'Play Track 3' }));
    expect(player.playItems).toHaveBeenLastCalledWith(['track:1', 'track:2', 'track:3'], { startIndex: 2, source: 'playlist:7' });
  });

  it('moves a track down by saving the new order', async () => {
    const calls = stub();
    renderBrowse('/player/music/playlist/7');
    await userEvent.click(await screen.findByRole('button', { name: 'Move Track 1 down' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: 'Evening', trackIds: [2, 1, 3] });
  });

  it('moves a track up and cannot move the first one up', async () => {
    const calls = stub();
    renderBrowse('/player/music/playlist/7');
    expect((await screen.findByRole('button', { name: 'Move Track 1 up' })).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Move Track 3 down' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Move Track 3 up' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: 'Evening', trackIds: [1, 3, 2] });
  });

  it('removes a track', async () => {
    const calls = stub();
    renderBrowse('/player/music/playlist/7');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Track 2 from the playlist' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: 'Evening', trackIds: [1, 3] });
  });

  it('renames without touching the tracks', async () => {
    const calls = stub();
    renderBrowse('/player/music/playlist/7');
    await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Name');
    expect((input as HTMLInputElement).value).toBe('Evening');
    await userEvent.clear(input);
    await userEvent.type(input, 'Late night');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: 'Late night' });
  });

  it('deletes after confirming and goes back to the list', async () => {
    const calls = stub({ [`DELETE ${api('/playlists/7')}`]: null, [api('/playlists')]: [] });
    const { router } = renderBrowse('/player/music/playlist/7');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete playlist' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Evening?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete playlist' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/player/music/playlists'));
    expect(calls.some((c) => c.method === 'DELETE' && c.path === api('/playlists/7'))).toBe(true);
  });

  it('shows an empty playlist', async () => {
    stubFetch({ [api('/playlists/7')]: playlistDetails(7, [], { name: 'Evening' }) });
    renderBrowse('/player/music/playlist/7');
    expect(await screen.findByText('This playlist is empty')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' }).hasAttribute('disabled')).toBe(true);
  });
});
