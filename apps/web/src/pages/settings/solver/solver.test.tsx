import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import type { Indexer, IndexerDefinitionSummary, SolverStatus } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { hasSolverProxy, isManagedProxy } from '../indexer-proxies/proxy-model.js';
import { definitionNeedsSolver } from '../indexers/definition-fields.js';
import { IndexerCard } from '../indexers/indexers-page.js';
import { solverStatusText, solverTestText } from './solver-page.js';

afterEach(() => vi.unstubAllGlobals());

const status: SolverStatus = {
  enabled: true,
  browser: { name: 'Microsoft Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  running: false,
  pending: 0,
  profileDir: 'C:\\arclight\\solver-profile',
  proxyId: 4,
  externalSolvers: [],
  docker: false,
};

describe('solver helpers', () => {
  it('describes the live status in plain words', () => {
    expect(solverStatusText(undefined)).toEqual({ text: 'Off', tone: 'off' });
    expect(solverStatusText({ ...status, browser: null }).tone).toBe('warn');
    expect(solverStatusText(status).text).toBe('Ready · browser starts on first use');
    expect(solverStatusText({ ...status, running: true, pending: 2 }).text).toBe('Solving · 2 requests in progress');
  });

  it('treats a missing browser as fine when a FlareSolverr proxy solves challenges', () => {
    const docker = { ...status, browser: null, docker: true };
    expect(solverStatusText({ ...docker, externalSolvers: [{ id: 2, name: 'FlareSolverr (bundled)' }] })).toEqual({
      text: 'Challenges go through FlareSolverr (bundled), which runs its own browser.',
      tone: 'ok',
    });
    expect(solverStatusText({ ...docker, enabled: false, externalSolvers: [{ id: 2, name: 'FS' }] }).tone).toBe('ok');
    expect(solverStatusText(docker)).toEqual({ text: 'No solver: the Arclight image has no browser. Add the FlareSolverr container.', tone: 'warn' });
  });

  it('formats the test result with the elapsed time', () => {
    expect(solverTestText({ response: { status: 'ok', solution: { status: 200 } }, elapsedMs: 4210 })).toEqual({ ok: true, text: 'Solved https://example.com/ in 4.2 s · HTTP 200' });
    expect(solverTestText({ response: { status: 'error', message: 'No browser' }, elapsedMs: 15 })).toEqual({ ok: false, text: 'Failed after 0.0 s · No browser' });
  });

  it('recognises managed proxies and definitions that need a solver', () => {
    expect(isManagedProxy({ name: 'FlareSolverr (bundled)' })).toBe(true);
    expect(isManagedProxy({ name: 'Built-in solver' })).toBe(true);
    expect(isManagedProxy({ name: 'My proxy', managed: true })).toBe(true);
    expect(isManagedProxy({ name: 'My proxy' })).toBe(false);
    expect(hasSolverProxy([{ type: 'http' }])).toBe(false);
    expect(hasSolverProxy([{ type: 'http' }, { type: 'flaresolverr' }])).toBe(true);
    const def = { settingsFields: [] } as unknown as IndexerDefinitionSummary;
    expect(definitionNeedsSolver(def)).toBe(false);
    expect(definitionNeedsSolver({ ...def, requiresFlareSolverr: true })).toBe(true);
    expect(definitionNeedsSolver({ settingsFields: [{ name: 'fs', type: 'info_flaresolverr', label: 'FlareSolverr', informational: true }] })).toBe(true);
  });
});

describe('Settings → Challenge solver', () => {
  it('shows live status, detects, saves and runs the example.com test', async () => {
    const api = stubApi({
      '/api/v1/settings/solver': { enabled: true, timeoutSeconds: 60, idleCloseSeconds: 300 },
      'PUT /api/v1/settings/solver': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown,
      '/api/v1/solver/status': status,
      'POST /api/v1/solver/autodetect': { bundledCreated: null, builtinProxyId: 4, messages: ['Updated Built-in solver'] },
      'POST /api/v1/solver/v1': { status: 'ok', message: '', solution: { url: 'https://example.com/', status: 200 } },
    });
    renderAt('/settings/solver');
    // The status pane remounts once the settings arrive: wait for the form first.
    await screen.findByLabelText('Timeout');
    const live = await screen.findByRole('region', { name: 'Live status' });
    expect(await within(live).findByText('Microsoft Edge')).toBeTruthy();
    expect(within(live).getByText('Built-in solver (#4)')).toBeTruthy();
    fireEvent.click(within(live).getByRole('button', { name: 'Detect now' }));
    expect(await within(live).findByText('Updated Built-in solver')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const result = await screen.findByRole('region', { name: 'Test result' });
    expect(within(result).getByText(/^Solved https:\/\/example\.com\/ in \d+\.\d s · HTTP 200$/)).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/v1/solver/v1')?.body).toMatchObject({ cmd: 'request.get', url: 'https://example.com/', maxTimeout: 60000 });

    fireEvent.change(screen.getByLabelText('Timeout'), { target: { value: '90' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ timeoutSeconds: 90 }));
    expect(screen.getByRole('link', { name: 'How it works' }).getAttribute('href')).toMatch(/CLOUDFLARE\.md$/);
  });

  it('badges auto-created proxies as managed', async () => {
    stubApi({
      '/api/v1/indexerproxy': [
        { id: 1, name: 'Built-in solver', type: 'flaresolverr', host: 'http://127.0.0.1/api/v1/solver', port: 7878, tags: [1] },
        { id: 2, name: 'Office proxy', type: 'http', host: 'proxy.lan', port: 3128, tags: [] },
      ],
      '/api/v1/tag': [{ id: 1, label: 'cloudflare' }],
    });
    renderAt('/settings/indexerproxies');
    const solver = (await screen.findByRole('button', { name: 'Built-in solver' })).closest('.al-item-card') as HTMLElement;
    expect(within(solver).getByText('Managed')).toBeTruthy();
    const office = screen.getByRole('button', { name: 'Office proxy' }).closest('.al-item-card') as HTMLElement;
    expect(within(office).queryByText('Managed')).toBeNull();
  });
});

describe('indexer solver hint', () => {
  it('links a card to the solver page when its definition needs one', async () => {
    const indexer = {
      id: 3,
      name: '1337x',
      implementation: 'definition',
      protocol: 'torrent',
      enableRss: true,
      enableAutomaticSearch: true,
      enableInteractiveSearch: true,
      priority: 25,
      tags: [],
      settings: { baseUrl: 'https://1337x.to/', apiPath: '', categories: [], animeCategories: [], definitionId: '1337x' },
    } as Indexer;
    const toasts = createToastStore();
    const root = createRootRoute({ component: () => <IndexerCard indexer={indexer} onEdit={() => undefined} needsSolver /> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(
      <QueryClientProvider client={createQueryClient(toasts)}>
        <ToastProvider store={toasts}>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const note = await screen.findByRole('note');
    expect(note.textContent).toBe('Needs a challenge solver.Set up');
    expect(within(note).getByRole('link', { name: 'Set up' }).getAttribute('href')).toBe('/settings/solver');
  });
});
