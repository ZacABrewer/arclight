import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { authRoutes, renderAt, stubApi, user } from '../../requests/test-utils.js';
import { book, flush, makeController, progress, renderWithPlayer, track } from '../test-utils.js';
import { MiniPlayer } from './mini-player.js';
import { NowPlayingPage } from './now-playing.js';
import { PlayerShortcuts } from './player-layout.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const caps = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  allowed: true,
  remote: false,
  canStream: true,
  maxBitrateKbps: 0,
  sections: { music: true, audiobooks: true, podcasts: false, books: false, video: false },
  ...over,
});

describe('/player guard', () => {
  it('explains the player is off for this account', async () => {
    stubApi({ ...authRoutes(user()), '/api/v1/playback/me': caps({ allowed: false }) });
    renderAt('/player');
    expect(await screen.findByText("The player isn't turned on for your account")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the portal' }).getAttribute('href')).toBe('/portal');
    expect(screen.queryByRole('navigation', { name: 'Player sections' })).toBeNull();
  });

  it('treats a missing playback api as off', async () => {
    stubApi(authRoutes(user()));
    renderAt('/player');
    expect(await screen.findByText("The player isn't turned on for your account")).toBeTruthy();
  });

  it('opens the player home when allowed', async () => {
    stubApi({
      ...authRoutes(user()),
      '/api/v1/playback/me': caps(),
      '/api/v1/playback/continue': { items: [{ item: book(), progress: progress('audiobook:7', 1_800_000, 3_600_000) }] },
    });
    renderAt('/player');
    expect(await screen.findByRole('heading', { name: 'Continue listening' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Resume The Test Book' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Player sections' });
    expect(within(nav).getByRole('link', { name: 'Music' })).toBeTruthy();
    expect(within(nav).getAllByText('Coming soon').length).toBe(2);
  });
});

describe('MiniPlayer', () => {
  it('renders nothing until something is loaded', async () => {
    const h = makeController([track(1)]);
    renderWithPlayer(<MiniPlayer />, h.controller);
    await flush();
    expect(screen.queryByRole('region', { name: 'Now playing' })).toBeNull();
  });

  it('shows the track, toggles playback and goes next', async () => {
    const h = makeController([track(1), track(2)]);
    await h.controller.playItems(['track:1', 'track:2']);
    renderWithPlayer(<MiniPlayer />, h.controller);
    const bar = await screen.findByRole('region', { name: 'Now playing' });
    expect(within(bar).getByText('Song 1')).toBeTruthy();
    expect(within(bar).getByRole('link', { name: 'Open now playing: Song 1' }).getAttribute('href')).toBe('/player/now-playing');
    fireEvent.click(within(bar).getByRole('button', { name: 'Pause' }));
    expect(h.controller.getState().playing).toBe(false);
    expect(within(bar).getByRole('button', { name: 'Play' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(bar).getByRole('button', { name: 'Next' }));
      await flush();
    });
    expect(within(bar).getByText('Song 2')).toBeTruthy();
  });

  it('offers 30-second skips and the chapter for audiobooks', async () => {
    const h = makeController([book()]);
    await h.controller.playItem('audiobook:7', { startMs: 1_300_000 });
    renderWithPlayer(<MiniPlayer />, h.controller);
    const bar = await screen.findByRole('region', { name: 'Now playing' });
    expect(within(bar).getByText('Middle')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Back 30 seconds' }));
    expect(h.controller.getState().positionMs).toBe(1_270_000);
    expect(within(bar).queryByRole('button', { name: 'Next' })).toBeNull();
  });
});

describe('Now playing', () => {
  it('asks to find something when nothing plays', async () => {
    const h = makeController([]);
    renderWithPlayer(<NowPlayingPage />, h.controller);
    expect(await screen.findByText('Nothing playing')).toBeTruthy();
  });

  it('says "via Jellyfin" on the format badge when Jellyfin serves the item', async () => {
    const links = { links: [{ fileId: 101, url: 'http://x/stream', expiresAt: '2026-01-01T18:00:00Z', backend: 'jellyfin' }], backendInUse: 'jellyfin' };
    stubApi({ '/api/v1/playback/me': caps({ engine: 'jellyfin' }) }, (url, method) => (method === 'POST' && url.endsWith('/playback/stream-links') ? { body: links } : undefined));
    const h = makeController([track(1)]);
    await h.controller.playItems(['track:1']);
    renderWithPlayer(<NowPlayingPage />, h.controller);
    expect(await screen.findByText('FLAC · DIRECT · VIA JELLYFIN', { exact: false })).toBeTruthy();
  });

  it('shows the music view with the queue', async () => {
    stubApi({ '/api/v1/playback/item/track%3A2': track(2), '/api/v1/playback/item/track%3A1': track(1) });
    const h = makeController([track(1), track(2)]);
    await h.controller.playItems(['track:1', 'track:2'], { source: 'search' });
    renderWithPlayer(<NowPlayingPage />, h.controller);
    expect(await screen.findByRole('heading', { level: 1, name: 'Song 1' })).toBeTruthy();
    expect(screen.getByText('FLAC · DIRECT', { exact: false })).toBeTruthy();
    const queue = screen.getByRole('complementary', { name: 'Queue' });
    expect(within(queue).getByText('Playing from search')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Repeat off' }));
    expect(h.controller.getState().repeat).toBe('all');
    expect(screen.getByRole('button', { name: 'Repeat all' })).toBeTruthy();
    fireEvent.click(await within(queue).findByRole('button', { name: 'Move Song 2 up' }));
    expect(h.controller.getState().queue.map((e) => e.itemKey)).toEqual(['track:2', 'track:1']);
  });

  it('shows the audiobook view with chapters, speed and the sleep timer', async () => {
    stubApi({ '/api/v1/playback/bookmarks': [] });
    const h = makeController([book()]);
    await h.controller.playItem('audiobook:7', { startMs: 1_300_000 });
    renderWithPlayer(<NowPlayingPage />, h.controller);
    expect(await screen.findByRole('heading', { level: 1, name: 'The Test Book' })).toBeTruthy();
    expect(screen.getByText('Chapter 2 of 3')).toBeTruthy();
    const seek = screen.getByRole('slider', { name: 'Position in the chapter' });
    expect(seek).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next chapter' }));
    expect(h.controller.getState().positionMs).toBe(2_400_000);
    fireEvent.click(screen.getByRole('button', { name: 'Forward 30 seconds' }));
    expect(h.controller.getState().positionMs).toBe(2_430_000);
    fireEvent.change(screen.getByLabelText('Sleep timer'), { target: { value: 'chapter' } });
    expect(h.controller.getState().sleepTimer?.kind).toBe('chapter');
  });
});

describe('keyboard shortcuts', () => {
  it('toggles with Space, skips with the arrows and ignores typing', async () => {
    const h = makeController([track(1)]);
    await h.controller.playItem('track:1', { startMs: 60_000 });
    renderWithPlayer(
      <>
        <PlayerShortcuts />
        <input aria-label="field" />
      </>,
      h.controller,
    );
    await screen.findByLabelText('field');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(h.controller.getState().positionMs).toBe(50_000);
    fireEvent.keyDown(window, { key: ' ' });
    expect(h.controller.getState().playing).toBe(false);
    fireEvent.keyDown(screen.getByLabelText('field'), { key: ' ' });
    expect(h.controller.getState().playing).toBe(false);
    fireEvent.keyDown(window, { key: 'm' });
    expect(h.controller.getState().muted).toBe(true);
  });
});
