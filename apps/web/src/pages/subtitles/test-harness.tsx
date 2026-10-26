import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { LanguageProfile, MediaFileSubtitles, SubtitleState } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';

// Shared harness for the subtitles tests (only imported by *.test.tsx): a fetch mock keyed by
// "METHOD /path" that records every call, plus router rendering.

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

export interface Call {
  method: string;
  path: string;
  url: string;
  body: unknown;
  init: RequestInit | undefined;
}

export type Handler = (call: Call) => unknown;

export function mockApi(routes: Record<string, unknown | Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = url.split('?')[0]!.replace('/api/v1', '');
      let body: unknown = init?.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const call: Call = { method, path, url, body, init };
      calls.push(call);
      const key = `${method} ${path}`;
      if (!(key in routes)) {
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      const route = routes[key];
      const result = typeof route === 'function' ? (route as Handler)(call) : route;
      if (result === undefined) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(result), { status: method === 'POST' ? 201 : 200 });
    }),
  );
  return calls;
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
  return { router, queryClient };
}

export const languages = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
];

export const languageProfiles: LanguageProfile[] = [
  { id: 1, name: 'English', languages: [{ code: 'en', forced: 'never', hi: 'also' }], cutoff: null, mustContain: [], mustNotContain: [], originalFormat: false },
  { id: 2, name: 'Euro', languages: [{ code: 'de', forced: 'never', hi: 'also' }, { code: 'fr', forced: 'also', hi: 'never' }], cutoff: '*', mustContain: [], mustNotContain: [], originalFormat: false },
];

export function makeSubtitle(over: Partial<SubtitleState> & { id: number }): SubtitleState {
  return {
    mediaFileId: 7,
    language: 'en',
    forced: false,
    hi: false,
    path: '/movies/Dune/Dune.en.srt',
    embedded: false,
    streamIndex: null,
    codec: null,
    provider: null,
    providerSubtitleId: null,
    score: null,
    percent: null,
    size: 1000,
    mtime: null,
    added: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

export const movieFile: MediaFileSubtitles = {
  mediaFileId: 7,
  mediaType: 'movie',
  seriesId: null,
  movieId: 1,
  episodeIds: [],
  seasonNumber: null,
  path: '/movies/Dune/Dune.mkv',
  languageProfileId: 2,
  subtitles: [
    makeSubtitle({ id: 11, language: 'fr', forced: true, provider: 'opensubtitlescom', providerSubtitleId: 'os-1', path: '/movies/Dune/Dune.fr.forced.srt' }),
    makeSubtitle({ id: 12, language: 'en', hi: true, embedded: true, path: null, streamIndex: 2, codec: 'subrip' }),
  ],
  missing: [{ language: 'de', forced: false, hi: false }],
};
