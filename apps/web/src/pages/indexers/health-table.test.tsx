import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import type { Indexer, IndexerHealth, IndexerHealthEntry } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { IndexerHealthPane } from './health-table.js';
import { formatAvgResults, formatRatio, healthOrder, toggleEnabledBody, VERDICT_TONE, verdictLabel, verdictReason } from './health-model.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const THRESHOLDS = { failureRate: 0.25, slowAvgMs: 5000, slowP95Ms: 10000, zeroResultRate: 0.9, minQueriesForNoResults: 10 };

const entry = (over: Partial<IndexerHealthEntry>): IndexerHealthEntry => ({
  indexerId: 1,
  indexerName: 'Alpha',
  enabled: true,
  queries: 40,
  failures: 0,
  failureRate: 0,
  avgResponseMs: 320,
  p95ResponseMs: 900,
  avgResults: 12.5,
  zeroResultRate: 0.1,
  grabs: 3,
  lastSuccessAt: '2026-10-25T11:00:00.000Z',
  lastFailureAt: null,
  lastFailureMessage: null,
  failureCount: 0,
  disabledTill: null,
  verdict: 'healthy',
  ...over,
});

const indexer = (id: number, name: string, over: Partial<Indexer> = {}): Indexer => ({
  id,
  name,
  implementation: 'torznab',
  protocol: 'torrent',
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  priority: 25,
  tags: [],
  settings: { baseUrl: `http://${name.toLowerCase()}.example`, apiPath: '/api', categories: [], animeCategories: [] },
  ...over,
});

const health: IndexerHealth = {
  days: 7,
  since: '2026-10-18T12:00:00.000Z',
  thresholds: THRESHOLDS,
  indexers: [
    entry({}),
    entry({
      indexerId: 2,
      indexerName: 'Bravo',
      verdict: 'failing',
      failures: 20,
      failureRate: 0.5,
      failureCount: 3,
      disabledTill: '2099-01-01T00:00:00.000Z',
      lastFailureAt: '2026-10-25T11:30:00.000Z',
      lastFailureMessage: 'unreachable: Could not reach indexer',
    }),
    entry({ indexerId: 3, indexerName: 'Charlie', verdict: 'unused', enabled: false, queries: 0, failureRate: null, avgResponseMs: null, p95ResponseMs: null, avgResults: null, zeroResultRate: null, lastSuccessAt: null }),
  ],
};

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/indexer/health')) return json({ ...health, days: Number(new URL(url, 'http://x').searchParams.get('days') ?? 7) });
      if (method === 'PUT' && url.includes('/indexer/3')) return json(indexer(3, 'Charlie'));
      if (url.endsWith('/indexer') || url.includes('/indexer?')) return json([indexer(1, 'Alpha'), indexer(2, 'Bravo'), indexer(3, 'Charlie', { enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false })]);
      return json([]);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPane() {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/indexers/stats', component: IndexerHealthPane });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/indexers/stats'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('health model', () => {
  it('labels and tones every verdict', () => {
    expect(verdictLabel('noResults')).toBe('No results');
    expect(VERDICT_TONE.failing).toBe('danger');
    expect(VERDICT_TONE.unused).toBe('muted');
  });

  it('explains the verdict with the thresholds', () => {
    expect(verdictReason(entry({ verdict: 'failing', failureRate: 0.5 }), THRESHOLDS)).toBe('50% of queries failed (threshold 25%).');
    expect(verdictReason(entry({ verdict: 'failing', disabledTill: '2099-01-01T00:00:00.000Z', failureCount: 2 }), THRESHOLDS)).toBe('Backing off after 2 failures in a row.');
    expect(verdictReason(entry({ verdict: 'noResults', zeroResultRate: 0.95 }), THRESHOLDS)).toContain('95%');
  });

  it('sorts problems first and formats empty metrics', () => {
    const sorted = [entry({ indexerName: 'Z', verdict: 'healthy' }), entry({ indexerName: 'Y', verdict: 'slow' }), entry({ indexerName: 'X', verdict: 'failing' })].sort(healthOrder);
    expect(sorted.map((e) => e.indexerName)).toEqual(['X', 'Y', 'Z']);
    expect(formatRatio(null)).toBe('—');
    expect(formatAvgResults(null)).toBe('—');
    expect(formatAvgResults(12.46)).toBe('12.5');
  });

  it('switches every use on or off together', () => {
    expect(toggleEnabledBody(true)).toEqual({ enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false });
    expect(toggleEnabledBody(false)).toEqual({ enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true });
  });
});

describe('indexer health pane', () => {
  it('lists every indexer with its verdict, worst first', async () => {
    renderPane();
    const table = await screen.findByRole('table', { name: 'Indexer health' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['Bravo', 'Charlie', 'Alpha']);
    expect(within(rows[0]!).getByText('Failing')).toBeTruthy();
    expect(within(rows[0]!).getByText('Backing off')).toBeTruthy();
    expect(within(rows[0]!).getByText('unreachable: Could not reach indexer')).toBeTruthy();
    expect(within(rows[1]!).getByText('Unused')).toBeTruthy();
    expect(within(rows[2]!).getByText('Healthy')).toBeTruthy();
    expect(within(rows[2]!).getByText('12.5')).toBeTruthy();
    expect(screen.getByText('1 indexer needs attention.')).toBeTruthy();
  });

  it('sorts by a metric column', async () => {
    renderPane();
    const table = await screen.findByRole('table', { name: 'Indexer health' });
    fireEvent.click(within(table).getByRole('button', { name: /Failure rate/ }));
    const names = () => within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    await waitFor(() => expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']));
  });

  it('asks the api for the chosen period', async () => {
    renderPane();
    await screen.findByRole('table', { name: 'Indexer health' });
    expect(calls.some((c) => c.url.includes('/indexer/health') && c.url.includes('days=7'))).toBe(true);
    fireEvent.change(screen.getByLabelText('Health period'), { target: { value: '30' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('/indexer/health') && c.url.includes('days=30'))).toBe(true));
  });

  it('enables a disabled indexer', async () => {
    renderPane();
    fireEvent.click(await screen.findByRole('button', { name: 'Enable Charlie' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ body: { enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true } }));
    expect(calls.find((c) => c.method === 'PUT')!.url).toContain('/indexer/3');
  });

  it('opens the edit dialog from the indexer name', async () => {
    renderPane();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Alpha' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
