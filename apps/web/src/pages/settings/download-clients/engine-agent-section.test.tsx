import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { DownloadClientResource, EngineAgentSettingsResponse } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { DownloadClientsPage, clientLocation } from './download-clients-page.js';
import { engineAgentUrl } from './engine-agent-section.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const remote = DownloadClientResource.parse({
  id: 3,
  name: 'Seedbox',
  implementation: 'remoteEngine',
  enable: true,
  protocol: 'torrent',
  priority: 2,
  removeCompletedDownloads: true,
  removeFailedDownloads: true,
  tags: [],
  settings: { url: 'http://seedbox:7879', token: '', category: 'tv', postImportCategory: '', pullMode: false, localDownloadPath: '', followVpnPort: false },
});

let agent: EngineAgentSettingsResponse;
let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  agent = { enabled: false, path: '/api/v1/engine-agent', engineRunning: true };
  const responses: Record<string, unknown> = {
    '/api/v1/downloadclient': [remote],
    '/api/v1/downloadclient/schema': [],
    '/api/v1/remotepathmapping': [],
    '/api/v1/tag': [],
  };
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/v1/settings/engineagent') {
        if (method === 'PUT') agent = { ...agent, ...body };
        return new Response(JSON.stringify(agent), { status: 200 });
      }
      const found = responses[url];
      return found === undefined ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 }) : new Response(JSON.stringify(found), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute();
  const routes = ['/settings/downloadclients', '/settings/torrent', '/settings/security'].map((path) =>
    createRoute({ getParentRoute: () => root, path, component: path === '/settings/downloadclients' ? DownloadClientsPage : () => null }),
  );
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/settings/downloadclients'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('remote engine', () => {
  it('shows the agent URL as the location on a Remote Engine card', async () => {
    expect(clientLocation(remote)).toBe('http://seedbox:7879');
    renderPage();
    const grid = await screen.findByRole('list', { name: 'Download clients' }, { timeout: 5000 });
    const card = within(grid).getByRole('listitem');
    expect(within(card).getByText('http://seedbox:7879').className).toContain('al-card-line--mono');
  });

  it('shows the endpoint, engine state and API key hint, and turns the agent on with PUT', async () => {
    expect(EngineAgentSettingsResponse.safeParse(agent).success).toBe(true);
    renderPage();
    const section = await screen.findByRole('region', { name: 'Remote engine' }, { timeout: 5000 });
    const toggle = (await within(section).findByLabelText('Act as remote engine')) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(within(section).getByText(engineAgentUrl(window.location.origin, '/api/v1/engine-agent'))).toBeTruthy();
    expect(within(section).getByText('Running').className).toContain('al-chip');
    expect(within(section).getByRole('link', { name: 'Open Security' }).getAttribute('href')).toBe('/settings/security');

    fireEvent.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/settings/engineagent')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ enabled: true });
    await waitFor(() => expect((within(section).getByLabelText('Act as remote engine') as HTMLInputElement).checked).toBe(true));
  });

  it('warns when the agent is on but the torrent engine is not running', async () => {
    agent = { enabled: true, path: '/api/v1/engine-agent', engineRunning: false };
    renderPage();
    const section = await screen.findByRole('region', { name: 'Remote engine' }, { timeout: 5000 });
    expect((await within(section).findByRole('alert')).textContent).toMatch(/torrent engine is not running/);
    expect(within(section).getByRole('link', { name: 'Open Torrent engine' }).getAttribute('href')).toBe('/settings/torrent');
  });

  it('joins the origin and agent path with one slash', () => {
    expect(engineAgentUrl('http://arclight:7878/', '/api/v1/engine-agent')).toBe('http://arclight:7878/api/v1/engine-agent');
    expect(engineAgentUrl('http://arclight:7878', 'api/v1/engine-agent')).toBe('http://arclight:7878/api/v1/engine-agent');
  });
});
