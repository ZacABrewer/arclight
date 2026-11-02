import { Suspense } from 'react';
import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { vi } from 'vitest';
import type {
  AudiobookHome,
  MusicHome,
  PlaybackProgress,
  PlayerAlbum,
  PlayerAlbumDetails,
  PlayerArtist,
  PlayerArtistDetails,
  PlayerAudiobook,
  PlayerAudiobookDetails,
  PlayerTrack,
  UserPlaylistDetails,
  UserPlaylistSummary,
} from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { browseRoutes } from './index.js';
import { BrowsePlayerContext, type BrowsePlayerActions } from './player-hooks.js';

// Test harness for the browse pages: the browse routes under a bare root, a table-driven
// fake api and a mock player adapter.

export type FakeHandler = unknown | ((url: URL, body: unknown) => unknown);
export interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}

/** Keys: "GET /api/v1/playback/..." (or a bare path for GET). Unlisted paths answer 404. */
export function stubFetch(routes: Record<string, FakeHandler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path: url.pathname, search: url.searchParams, body });
      const exact = `${method} ${url.pathname}`;
      const hit = exact in routes ? routes[exact] : method === 'GET' ? routes[url.pathname] : undefined;
      if (hit === undefined) return new Response(JSON.stringify({ error: 'not found', code: 'NOT_FOUND' }), { status: 404 });
      const value = typeof hit === 'function' ? (hit as (u: URL, b: unknown) => unknown)(url, body) : hit;
      if (value instanceof Response) return value;
      return new Response(value === null ? null : JSON.stringify(value), { status: value === null ? 204 : 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

export type MockPlayer = BrowsePlayerActions & {
  playItems: ReturnType<typeof vi.fn>;
  playItem: ReturnType<typeof vi.fn>;
  playNext: ReturnType<typeof vi.fn>;
  addToQueue: ReturnType<typeof vi.fn>;
  toggle: ReturnType<typeof vi.fn>;
};

export function mockPlayer(over: Partial<Pick<BrowsePlayerActions, 'currentItemKey' | 'playing'>> = {}): MockPlayer {
  return {
    currentItemKey: null,
    playing: false,
    playItems: vi.fn(),
    playItem: vi.fn(),
    playNext: vi.fn(),
    addToQueue: vi.fn(),
    toggle: vi.fn(),
    ...over,
  } as MockPlayer;
}

export function renderBrowse(path: string, player: MockPlayer = mockPlayer()) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute({ component: () => <Outlet /> });
  const children = browseRoutes.map((r) => {
    const Page = r.component;
    return createRoute({
      getParentRoute: () => root,
      path: r.path,
      component: () => (
        <Suspense fallback={<p>loading page</p>}>
          <Page />
        </Suspense>
      ),
    });
  });
  const router = createRouter({ routeTree: root.addChildren(children), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <BrowsePlayerContext.Provider value={player}>
          <RouterProvider router={router as never} />
        </BrowsePlayerContext.Provider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { router, player, queryClient, toasts };
}

const API = '/api/v1/playback';
export const api = (p: string) => `${API}${p}`;

export function track(id: number, over: Partial<PlayerTrack> = {}): PlayerTrack {
  return {
    id,
    itemKey: `track:${id}`,
    title: `Track ${id}`,
    artistName: 'Example Artist',
    artistId: 4,
    albumTitle: 'Example Album',
    albumId: 12,
    discNumber: 1,
    trackNumber: id,
    durationMs: 185_000,
    formatLabel: 'FLAC 24/96',
    lossless: true,
    artworkUrl: null,
    explicit: false,
    ...over,
  };
}

export function album(id: number, over: Partial<PlayerAlbum> = {}): PlayerAlbum {
  return {
    id,
    title: `Album ${id}`,
    artistName: 'Example Artist',
    artistId: 4,
    year: 2020,
    albumType: 'Album',
    trackCount: 3,
    durationMs: 555_000,
    formatLabel: 'FLAC 24/96',
    lossless: true,
    artworkUrl: null,
    addedAt: '2026-10-01T00:00:00.000Z',
    genres: ['Electronic'],
    ...over,
  };
}

export function albumDetails(id: number, tracks: PlayerTrack[], over: Partial<PlayerAlbumDetails> = {}): PlayerAlbumDetails {
  return { ...album(id), tracks, discCount: Math.max(1, ...tracks.map((tr) => tr.discNumber ?? 1)), trackCount: tracks.length, ...over };
}

export function artist(id: number, over: Partial<PlayerArtist> = {}): PlayerArtist {
  return { id, name: `Artist ${id}`, imageUrl: null, albumCount: 2, trackCount: 6, genres: ['Electronic'], ...over };
}

export function artistDetails(id: number, over: Partial<PlayerArtistDetails> = {}): PlayerArtistDetails {
  return { ...artist(id), overview: null, topTracks: [], albums: [], ...over };
}

export function playlistSummary(id: number, over: Partial<UserPlaylistSummary> = {}): UserPlaylistSummary {
  return { id, name: `Mix ${id}`, description: null, trackCount: 2, durationMs: 370_000, artworkUrls: [], updatedAt: '2026-10-01T00:00:00.000Z', ...over };
}

export function playlistDetails(id: number, tracks: PlayerTrack[], over: Partial<UserPlaylistDetails> = {}): UserPlaylistDetails {
  return { ...playlistSummary(id), tracks, trackCount: tracks.length, ...over };
}

export function progress(itemKey: string, over: Partial<PlaybackProgress> = {}): PlaybackProgress {
  return {
    itemKey,
    positionMs: 0,
    durationMs: 0,
    played: false,
    playCount: 0,
    lastPlayedAt: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    favorite: false,
    prefs: {},
    source: 'arclight',
    ...over,
  };
}

export function book(id: number, over: Partial<PlayerAudiobook> = {}): PlayerAudiobook {
  return {
    id,
    itemKey: `audiobook:${id}`,
    title: `Book ${id}`,
    authors: ['A. Writer'],
    narrators: ['N. Reader'],
    seriesTitle: null,
    seriesPosition: null,
    durationMs: 36_000_000,
    artworkUrl: null,
    addedAt: '2026-10-01T00:00:00.000Z',
    progress: null,
    ...over,
  };
}

export function bookDetails(id: number, over: Partial<PlayerAudiobookDetails> = {}): PlayerAudiobookDetails {
  return { ...book(id), description: null, chapters: [], series: [], ...over };
}

export const emptyMusicHome: MusicHome = { recentlyPlayed: [], jumpBackIn: [], recentlyAdded: [], playlists: [], onThisDay: [] };
export const emptyBookHome: AudiobookHome = { continueListening: [], recentlyAdded: [], series: [], finished: [] };

export function page<T>(items: T[], over: { total?: number; page?: number; pageSize?: number } = {}) {
  return { items, total: over.total ?? items.length, page: over.page ?? 1, pageSize: over.pageSize ?? 60 };
}
