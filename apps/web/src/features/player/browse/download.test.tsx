import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { aggregateDownloadState, type DownloadState } from './player-hooks.js';
import { albumDetails, api, bookDetails, mockPlayer, playlistDetails, renderBrowse, stubFetch, track } from './test-utils.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const tracks = [track(1), track(2), track(3)];

/** A player with downloads (what the mobile app provides). */
function appPlayer(states: Record<string, DownloadState> = {}) {
  const download = vi.fn();
  return { player: mockPlayer({ download, downloadState: (key: string) => states[key] ?? 'none' }), download };
}

describe('aggregateDownloadState', () => {
  it('is none while anything is missing, then busy, then done', () => {
    expect(aggregateDownloadState([])).toBe('none');
    expect(aggregateDownloadState(['done', 'none'])).toBe('none');
    expect(aggregateDownloadState(['done', 'queued', 'downloading'])).toBe('downloading');
    expect(aggregateDownloadState(['done', 'queued'])).toBe('queued');
    expect(aggregateDownloadState(['done', 'done'])).toBe('done');
  });
});

describe('Download buttons', () => {
  it('are hidden on the web, where the player has no downloads', async () => {
    stubFetch({ [api('/music/albums/12')]: albumDetails(12, tracks, { title: 'Night Lines' }) });
    renderBrowse('/player/music/album/12', mockPlayer());
    await screen.findByRole('heading', { level: 1, name: 'Night Lines' });
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'More for Track 1' }));
    await screen.findByRole('menuitem', { name: 'Play next' });
    expect(screen.queryByRole('menuitem', { name: 'Download' })).toBeNull();
  });

  it('downloads a whole album and shows its state', async () => {
    stubFetch({ [api('/music/albums/12')]: albumDetails(12, tracks, { title: 'Night Lines' }) });
    const { player, download } = appPlayer({ 'track:1': 'done' });
    renderBrowse('/player/music/album/12', player);

    await userEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect(download).toHaveBeenCalledWith(['track:1', 'track:2', 'track:3']);
  });

  it('shows an album being downloaded or done as not clickable', async () => {
    stubFetch({ [api('/music/albums/12')]: albumDetails(12, tracks, { title: 'Night Lines' }) });
    const { player } = appPlayer({ 'track:1': 'done', 'track:2': 'downloading', 'track:3': 'queued' });
    renderBrowse('/player/music/album/12', player);

    const busy = await screen.findByRole('button', { name: 'Downloading…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute('data-download-state')).toBe('downloading');
  });

  it('offers a download in a track row menu', async () => {
    stubFetch({ [api('/music/albums/12')]: albumDetails(12, tracks) });
    const { player, download } = appPlayer({ 'track:1': 'done' });
    renderBrowse('/player/music/album/12', player);

    await userEvent.click(await screen.findByRole('button', { name: 'More for Track 2' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Download' }));
    expect(download).toHaveBeenCalledWith(['track:2']);

    await userEvent.click(screen.getByRole('button', { name: 'More for Track 1' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Downloaded' }));
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('downloads a playlist', async () => {
    stubFetch({ [api('/playlists/7')]: playlistDetails(7, tracks, { name: 'Evening' }) });
    const { player, download } = appPlayer();
    renderBrowse('/player/music/playlist/7', player);

    await userEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect(download).toHaveBeenCalledWith(['track:1', 'track:2', 'track:3']);
  });

  it('downloads a book and shows when it is kept', async () => {
    stubFetch({ [api('/audiobooks/3')]: bookDetails(3, { title: 'Long Road' }) });
    const { player, download } = appPlayer();
    renderBrowse('/player/books/3', player);

    await userEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect(download).toHaveBeenCalledWith(['audiobook:3']);
  });

  it('shows a downloaded book as done', async () => {
    stubFetch({ [api('/audiobooks/3')]: bookDetails(3, { title: 'Long Road' }) });
    const { player } = appPlayer({ 'audiobook:3': 'done' });
    renderBrowse('/player/books/3', player);

    const hero = (await screen.findByRole('heading', { level: 1, name: 'Long Road' })).closest('section')!;
    const done = within(hero as HTMLElement).getByRole('button', { name: 'Downloaded' });
    expect((done as HTMLButtonElement).disabled).toBe(true);
  });
});
