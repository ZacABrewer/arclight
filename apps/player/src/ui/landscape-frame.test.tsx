import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { createToastStore } from '@web/lib/toast';
import { createQueryClient } from '@web/query-client';
import { stubFetch } from '@web/features/player/browse/test-utils';
import { PlayerControllerScope } from '@web/features/player/player-context';
import type { PlayerController } from '@web/features/player/player-controller';
import { setSession } from '../core/session';
import { LandscapeFrame, isOverlayPage, isPlainPage } from './landscape-frame';

// Phone landscape (features spec §5.5): the wide header with the tabs, no bottom tab bar, the
// mini-player docked on its own, and the avatar opening the same sheet as in portrait.

function fakeController(current: unknown = null): PlayerController {
  const state = { current, playing: false, positionMs: 0, durationMs: 0, chapterIndex: -1, queue: [], queueIndex: 0, repeat: 'off' };
  return { subscribe: () => () => {}, getState: () => state, toggle: vi.fn(), next: vi.fn(), skip: vi.fn() } as unknown as PlayerController;
}

function renderFrame(path: string, controller = fakeController()) {
  const qc = createQueryClient(createToastStore());
  const root = createRootRoute();
  const page = () => (
    <LandscapeFrame sheet={(close) => <div role="dialog" aria-label="Profile sheet" onClick={close} />}>
      <p>Page body</p>
    </LandscapeFrame>
  );
  const routes = ['/player', '/player/watch/shows', '/player/queue', '/player/watch/movies/$id'].map((p) => createRoute({ getParentRoute: () => root, path: p, component: page }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={qc}>
      <PlayerControllerScope controller={controller}>
        <RouterProvider router={router as never} />
      </PlayerControllerScope>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setSession({ accountId: 'acct-1', serverUrl: 'https://music.example.com', token: 'alt_test', deviceId: 1 });
  stubFetch({});
});
afterEach(() => {
  act(() => setSession(null));
  vi.unstubAllGlobals();
});

describe('LandscapeFrame', () => {
  it('shows the wide header with the tabs and no bottom tab bar', async () => {
    renderFrame('/player/watch/shows');
    const header = (await screen.findByText('Page body')).closest('.rd-root')!.querySelector('header')!;
    expect(header.classList.contains('rd-header')).toBe(true);
    const nav = within(header).getByRole('navigation');
    const tabs = within(nav).getAllByRole('link');
    expect(tabs).toHaveLength(5);
    expect(tabs.find((a) => a.getAttribute('aria-current') === 'page')?.getAttribute('href')).toBe('/player/watch/shows');
    for (const name of ['Music', 'Audiobooks', 'Settings']) expect(within(header).getByRole('link', { name })).toBeTruthy();
    expect(document.querySelector('.app-tabs, .rd-tabbar')).toBeNull();
    expect(document.querySelector('.rd-root')?.getAttribute('data-layout')).toBe('wide');
    expect(document.querySelector('main')?.classList.contains('rd-legacy')).toBe(false);
  });

  it('opens the profile sheet from the avatar', async () => {
    renderFrame('/player');
    const avatar = await screen.findByRole('button', { name: 'Switch profile' });
    act(() => avatar.click());
    expect(await screen.findByRole('dialog', { name: 'Profile sheet' })).toBeTruthy();
    expect(document.querySelector('main')?.hasAttribute('data-overlay')).toBe(true);
  });

  it('docks the mini-player while something plays, and frames the app pages plainly', async () => {
    renderFrame('/player/queue', fakeController({ itemKey: 'track:1', kind: 'track', title: 'Night Lines', subtitle: 'Solo Singer', artworkUrl: null, chapters: [] }));
    await screen.findByText('Page body');
    const mini = screen.getByRole('region', { name: 'Now playing' });
    expect(mini.closest('.app-wide__mini')).toBeTruthy();
    expect(document.querySelector('main')?.classList.contains('rd-legacy')).toBe(true);
  });
});

describe('page kinds', () => {
  it('runs Home and title pages under the header', () => {
    expect(isOverlayPage('/player')).toBe(true);
    expect(isOverlayPage('/player/watch/movies/12')).toBe(true);
    expect(isOverlayPage('/player/watch/movies')).toBe(false);
    expect(isOverlayPage('/player/music')).toBe(false);
  });
  it('keeps the app pages and Now playing on the plain frame', () => {
    for (const p of ['/player/queue', '/player/downloads', '/player/settings/app', '/player/now-playing']) expect(isPlainPage(p)).toBe(true);
    for (const p of ['/player/settings', '/player/music', '/player']) expect(isPlainPage(p)).toBe(false);
  });
});
