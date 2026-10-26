import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  '/api/v1/health': { status: 'warning', checks: [{ source: 'IndexerCheck', status: 'warning', message: 'Nyaa is rate-limited. Retry at 20:55.' }] },
  '/api/v1/jobs': [],
  '/api/v1/jobs/scheduled': [{ name: 'housekeeping', interval: 'PT1H', lastRun: null, nextRun: null, enabled: true }],
  '/api/v1/vpn/status': { enabled: true, connected: true, country: 'Switzerland', city: 'Zürich', lastChecked: null, lastChanged: null },
  '/api/v1/request/count': { total: 6, movie: 2, series: 4, pending: 4, approved: 1, declined: 0, failed: 0, processing: 1, available: 0, completed: 0 },
};

beforeEach(() => {
  FakeSocket.instances = [];
  connectionStore.set('connecting', { attempt: 0, retryInMs: null });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/jobs/run' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'Unknown job', code: 'NOT_FOUND' }), { status: 404 });
      }
      const body = responses[url.split('?')[0]!];
      return body === undefined ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
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
  return { router, toasts };
}

describe('app shell', () => {
  it('renders the system status page inside the shell with rail, section tabs and two-column panes', async () => {
    renderAt('/system/status');
    expect(await screen.findByRole('heading', { level: 1, name: 'Status' })).toBeTruthy();
    expect(await screen.findByText('/config/arclight.db')).toBeTruthy();
    const rail = screen.getAllByRole('navigation', { name: 'Main' })[0]!;
    expect(within(rail).getByRole('link', { name: 'System' }).getAttribute('aria-current')).toBe('page');
    const tabs = screen.getByRole('navigation', { name: 'Section' });
    expect(within(tabs).getByRole('link', { name: 'Tasks' })).toBeTruthy();
    expect(within(tabs).getByRole('link', { name: 'Status' }).getAttribute('aria-current')).toBe('page');
  });

  it('maps all 11 rail codes for admins, in kit order', async () => {
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    const codes = Array.from(document.querySelectorAll('.al-rail__code')).map((n) => n.textContent);
    expect(codes).toEqual(['DB', 'LB', 'DS', 'RQ', 'CL', 'WN', 'AC', 'SB', 'IX', 'ST', 'SY']);
  });

  it('redirects a section root to its first child', async () => {
    const { router } = renderAt('/activity');
    await waitFor(() => expect(router.state.location.pathname).toBe('/activity/queue'));
  });

  it('renders the 404 page for unknown paths with no rail item active', async () => {
    renderAt('/does/not/exist');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByText('404')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to dashboard' })).toBeTruthy();
    expect(document.querySelector('.al-rail [aria-current="page"]')).toBeNull();
  });

  it('opens the global search overlay on "/" and groups results', async () => {
    renderAt('/system/status');
    await screen.findByRole('heading', { level: 1, name: 'Status' });
    fireEvent.keyDown(document.body, { key: '/' });
    const dialog = await screen.findByRole('dialog', { name: 'Search' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Search' }), { target: { value: 'tasks' } });
    const settings = await within(dialog).findByRole('group', { name: 'Settings' });
    expect(within(settings).getByRole('option', { name: /Tasks/ })).toBeTruthy();
    expect(within(dialog).getByRole('group', { name: 'People' })).toBeTruthy();
    expect(within(dialog).getByRole('option', { name: /Search indexers for "tasks"/ })).toBeTruthy();
  });

  it('opens the command palette with Ctrl+K and the keyboard sheet with "?"', async () => {
    renderAt('/system/status');
    await screen.findByRole('heading', { level: 1, name: 'Status' });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(within(palette).getByRole('option', { name: /Add series/ })).toBeTruthy();
    fireEvent.keyDown(within(palette).getByRole('combobox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
    fireEvent.keyDown(document.body, { key: '?' });
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  it('shows an error toast when running a task fails', async () => {
    renderAt('/system/tasks');
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not run job');
    expect(alert.textContent).toContain('Unknown job');
  });

  it('drives the status cluster: connection, VPN, requests and an orange issue count', async () => {
    renderAt('/system/status');
    await screen.findByRole('heading', { level: 1, name: 'Status' });
    const socket = FakeSocket.instances.at(-1)!;
    expect(socket.url).toMatch(/\/api\/v1\/events$/);
    expect(screen.getByText('Connecting…')).toBeTruthy();
    act(() => socket.onopen?.());
    expect(connectionStore.get().state).toBe('open');
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(await screen.findByText('VPN Switzerland')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.al-topbar__requests')?.textContent).toBe('4 requests'));
    await waitFor(() => expect(document.querySelector('.al-topbar__issues')?.getAttribute('data-active')).toBe('true'));
  });
});
