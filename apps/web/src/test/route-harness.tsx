import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { vi } from 'vitest';
import { ToastProvider } from '../components/toast.js';
import { createToastStore } from '../lib/toast.js';
import { createQueryClient } from '../query-client.js';
import { routeTree } from '../router.js';

// Whole-app render at a path with a table-driven fake api. Unlisted paths answer 404.

export type FakeRoute = unknown | ((init: RequestInit | undefined, url: URL) => Response | unknown);

export interface FakeApi {
  routes: Record<string, FakeRoute>;
  calls: Array<{ method: string; path: string; body: unknown }>;
}

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

/** Keys are "METHOD /api/v1/path" or "/api/v1/path" (GET). */
export function stubApi(routes: Record<string, FakeRoute>): FakeApi {
  const api: FakeApi = { routes, calls: [] };
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      api.calls.push({ method, path: url.pathname, body });
      const hit = api.routes[`${method} ${url.pathname}`] ?? (method === 'GET' ? api.routes[url.pathname] : undefined);
      if (hit === undefined) return new Response(JSON.stringify({ error: 'not found', code: 'NOT_FOUND' }), { status: 404 });
      const value = typeof hit === 'function' ? (hit as (i: RequestInit | undefined, u: URL) => unknown)(init, url) : hit;
      if (value instanceof Response) return value;
      return new Response(value === null ? null : JSON.stringify(value), { status: value === null ? 204 : 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return api;
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
  return router;
}
