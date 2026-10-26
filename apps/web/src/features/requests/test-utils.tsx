import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { configure, render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import {
  RequestsSettings,
  type DiscoverItem,
  type MediaRequest,
  type TitleDetail,
  type TitleSeason,
  type User,
} from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore, type ToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';

// Fixtures and render helpers shared by the requests-area tests.

// Full-router renders wait on /auth/status first; under a loaded parallel run the default
// 1s findBy window is too tight. Applies only to test files importing this module.
configure({ asyncUtilTimeout: 4000 });

export class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

export const user = (over: Partial<User> = {}): User => ({
  id: 2,
  username: 'amy',
  role: 'user',
  permissions: 32,
  createdAt: '2026-01-01T00:00:00.000Z',
  settings: {},
  ...over,
});

export function makeRequest(over: Partial<MediaRequest> = {}): MediaRequest {
  return {
    id: 1,
    type: 'movie',
    status: 'pending',
    is4k: false,
    mediaTmdbId: 603,
    mediaTitle: 'The Matrix',
    mediaYear: 1999,
    mediaPoster: null,
    seasons: [],
    requestedBy: { id: 2, username: 'amy' },
    modifiedBy: null,
    tags: [],
    ignoreQuota: false,
    isAutoRequest: false,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    mediaStatus: 'pending',
    canRemove: true,
    ...over,
  };
}

export function makeItem(over: Partial<DiscoverItem> = {}): DiscoverItem {
  return {
    mediaType: 'movie',
    tmdbId: 603,
    title: 'The Matrix',
    year: 1999,
    overview: 'A hacker learns the truth.',
    posterUrl: null,
    mediaStatus: 'unknown',
    mediaStatus4k: 'unknown',
    ...over,
  };
}

export function season(n: number, over: Partial<TitleSeason> = {}): TitleSeason {
  return { seasonNumber: n, episodeCount: 10, status: 'unknown', status4k: 'unknown', ...over };
}

export function makeTitle(over: Partial<TitleDetail> = {}): TitleDetail {
  return {
    ...makeItem(),
    genres: [],
    keywords: [],
    companies: [],
    cast: [],
    crew: [],
    videos: [],
    similar: [],
    recommendations: [],
    seasons: [],
    requests: [],
    canRequest: true,
    canRequest4k: false,
    canRequestAdvanced: false,
    onWatchlist: false,
    openIssues: 0,
    ...over,
  };
}

export const defaultSettings = (over: Partial<RequestsSettings> = {}): RequestsSettings => ({ ...RequestsSettings.parse({}), ...over });

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

export type Handler = (url: string, method: string, body: unknown) => { status?: number; body?: unknown } | undefined;

/**
 * Stubs fetch and WebSocket. `routes` answers GETs by exact URL (query string included,
 * falling back to the path); `handler` answers anything first. Unknown URLs are 404.
 */
export function stubApi(routes: Record<string, unknown>, handler?: Handler): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      calls.push({ url, method, body });
      const custom = handler?.(url, method, body);
      if (custom) return new Response(custom.body === undefined ? null : JSON.stringify(custom.body), { status: custom.status ?? 200 });
      const path = url.split('?')[0] ?? url;
      const hit = method === 'GET' ? (routes[url] ?? routes[path]) : undefined;
      return hit === undefined
        ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        : new Response(JSON.stringify(hit), { status: 200 });
    }),
  );
  return calls;
}

/** A signed-in session for /auth/status (role user unless overridden). */
export function authRoutes(u: User, isAdmin = u.role === 'admin'): Record<string, unknown> {
  const session = { user: u, via: 'session', isAdmin };
  return {
    '/api/v1/auth/status': { needsSetup: false, authMethod: 'forms', authenticated: true, session },
    '/api/v1/auth/me': session,
  };
}

export function renderAt(path: string) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { router, toasts, queryClient };
}

/** Render a component with a query client and toast store but no router. */
export function renderWithClient(ui: ReactNode, toasts: ToastStore = createToastStore()) {
  const queryClient = createQueryClient(toasts);
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
  return { queryClient, toasts };
}
