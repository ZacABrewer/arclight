import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { ToastProvider } from './components/toast.js';
import { connectionStore } from './lib/connection.js';
import { createToastStore } from './lib/toast.js';
import { createQueryClient } from './query-client.js';
import { routeTree } from './router.js';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close() {}
}

const responses: Record<string, unknown> = {
  '/api/v1/system/status': {
    appName: 'Arclight',
    version: '0.1.0',
    startTime: '2026-10-25T09:00:00.000Z',
    uptimeSeconds: 3700,
    runtime: { node: 'v24.0.0', platform: 'linux', arch: 'x64' },
    paths: { config: '/config', database: '/config/arclight.db', logs: '/config/logs' },
    isDocker: true,
  },
  '/api/v1/health': { status: 'ok', checks: [] },
  '/api/v1/jobs': [],
  '/api/v1/jobs/scheduled': [{ name: 'housekeeping', interval: 'PT1H', lastRun: null, nextRun: null, enabled: true }],
};

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/jobs/run' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'Unknown job', code: 'NOT_FOUND' }), { status: 404 });
      }
      const body = responses[url];
      return body === undefined
        ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { router, toasts };
}

describe('app shell', () => {
  it('renders the system status page inside the shell', async () => {
    renderAt('/system/status');
    expect(await screen.findByRole('heading', { level: 1, name: 'Status' })).toBeTruthy();
    expect(await screen.findByText('/config/arclight.db')).toBeTruthy();
    expect(screen.getByRole('navigation')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeTruthy();
  });

  it('renders the top-level Indexers section', async () => {
    renderAt('/indexers');
    expect(await screen.findByRole('heading', { level: 1, name: 'Indexers' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Stats' })).toBeTruthy();
  });

  it('redirects a section root to its first child', async () => {
    const { router } = renderAt('/activity');
    expect(await screen.findByRole('heading', { level: 1, name: 'Queue' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/activity/queue');
  });

  it('renders the 404 page for unknown paths', async () => {
    renderAt('/does/not/exist');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeTruthy();
  });

  it('focuses the global search on "/"', async () => {
    renderAt('/');
    const input = await screen.findByRole('searchbox');
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(input);
  });

  it('shows an error toast when running a job fails', async () => {
    renderAt('/system/tasks');
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not run job');
    expect(alert.textContent).toContain('Unknown job');
  });

  it('drives the connection indicator from the WebSocket state', async () => {
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    const socket = FakeSocket.instances.at(-1)!;
    expect(socket.url).toMatch(/\/api\/v1\/events$/);
    act(() => socket.onopen?.());
    expect(connectionStore.get().state).toBe('open');
    expect(screen.getByText('Live')).toBeTruthy();
  });
});
