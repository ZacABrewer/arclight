import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '@web/components/toast';
import { createToastStore } from '@web/lib/toast';
import { createQueryClient } from '@web/query-client';
import { AlbumPage } from '@web/features/player/browse/album-page';
import { albumDetails, api, stubFetch, track } from '@web/features/player/browse/test-utils';
import { PlayerControllerScope } from '@web/features/player/player-context';
import type { PlayerController } from '@web/features/player/player-controller';
import { AppServicesContext } from '../app/context';
import type { AppServices } from '../app/services';
import { setSession } from '../core/session';
import { BrowsePlayerBridge } from './shell';

// The redesigned album page in the phone app (features spec §5.1): the Download action is still
// on the title page, wired through BrowsePlayerBridge to the app's download manager.

const ACCOUNT = 'acct-1';

function fakeController(): PlayerController {
  const state = { current: null, playing: false };
  return {
    subscribe: () => () => {},
    getState: () => state,
    playItems: vi.fn(),
    playItem: vi.fn(),
    playNext: vi.fn(),
    addToQueue: vi.fn(),
    toggle: vi.fn(),
  } as unknown as PlayerController;
}

function renderAlbum() {
  const download = vi.fn(async (_account: string, keys: string[]) => keys);
  const services = {
    tv: false,
    index: { get: () => null, all: () => [], subscribe: () => () => {} },
    downloads: { available: true, download },
  } as unknown as AppServices;
  const toasts = createToastStore();
  const qc = createQueryClient(toasts);
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/player/music/album/$albumId', component: AlbumPage });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/player/music/album/12'] }) });
  render(
    <AppServicesContext.Provider value={services}>
      <QueryClientProvider client={qc}>
        <ToastProvider store={toasts}>
          <PlayerControllerScope controller={fakeController()}>
            <BrowsePlayerBridge>
              <RouterProvider router={router as never} />
            </BrowsePlayerBridge>
          </PlayerControllerScope>
        </ToastProvider>
      </QueryClientProvider>
    </AppServicesContext.Provider>,
  );
  return { download };
}

const setWidth = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

beforeEach(() => {
  setSession({ accountId: ACCOUNT, serverUrl: 'https://music.example.com', token: 'alt_test', deviceId: 1 });
  stubFetch({ [api('/music/albums/12')]: albumDetails(12, [track(1), track(2)], { title: 'Night Lines' }) });
});
afterEach(() => {
  act(() => setSession(null));
  vi.unstubAllGlobals();
  setWidth(1024, 768);
});

describe('browse pages in the phone app', () => {
  it('keeps Download on the redesigned album page (phone portrait) and starts the download', async () => {
    setWidth(390, 844);
    const { download } = renderAlbum();
    const title = await screen.findByRole('heading', { level: 1, name: 'Night Lines' });
    const hero = title.closest('section')!;
    const button = within(hero).getByRole('button', { name: 'Download' });
    expect(button.className).toContain('rd-action');
    expect(button.getAttribute('data-download-state')).toBe('none');
    act(() => button.click());
    await waitFor(() => expect(download).toHaveBeenCalledWith(ACCOUNT, ['track:1', 'track:2']));
  });

  it('shows Download as an icon button in the wide layout (phone landscape)', async () => {
    setWidth(844, 390);
    renderAlbum();
    const title = await screen.findByRole('heading', { level: 1, name: 'Night Lines' });
    const button = within(title.closest('section')!).getByRole('button', { name: 'Download' });
    expect(button.className).toContain('rd-btn--square');
  });
});
