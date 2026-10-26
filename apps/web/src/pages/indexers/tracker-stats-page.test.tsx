import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { TrackerAccountSettings, TrackerStatsResource } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { formatBuffer, formatSeedTime, hnrRuleText, ratioStatusChip, sortTrackers, trackerWarnings } from './tracker-stats-model.js';
import { TrackerStatsPage } from './tracker-stats-page.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const GIB = 1024 ** 3;

const stat = (over: Partial<TrackerStatsResource>): TrackerStatsResource =>
  TrackerStatsResource.parse({
    indexerId: 1,
    indexerName: 'PrivTracker',
    account: TrackerAccountSettings.parse({ enabled: true, ratioRequired: 1, hnrRule: { minSeedHours: 72, minRatio: 1 }, minBufferBytes: 10 * GIB }),
    hosts: ['tracker.example'],
    torrents: 12,
    seeding: 9,
    uploaded: 300 * GIB,
    downloaded: 200 * GIB,
    seedingTimeMs: (3 * 24 + 4) * 3_600_000,
    hnrPending: 2,
    engineUpdatedAt: '2026-10-26T10:00:00.000Z',
    accountRatio: 0.95,
    accountUploaded: 950 * GIB,
    accountDownloaded: 1000 * GIB,
    accountBuffer: -50 * GIB,
    accountHnrCount: 1,
    accountSeedBonus: 12345,
    accountUpdatedAt: '2026-10-26T09:00:00.000Z',
    accountError: null,
    buffer: -50 * GIB,
    ratio: 0.95,
    ratioStatus: 'low',
    ...over,
  });

const healthy = stat({
  indexerId: 2,
  indexerName: 'AlphaTracker',
  ratioStatus: 'ok',
  ratio: 2.5,
  buffer: 500 * GIB,
  accountHnrCount: 0,
  accountRatio: null,
  accountUploaded: null,
  accountDownloaded: null,
  accountBuffer: null,
  accountSeedBonus: null,
  accountUpdatedAt: null,
  hnrPending: 0,
});

let calls: Array<{ url: string; method: string }>;
let list: TrackerStatsResource[];

beforeEach(() => {
  calls = [];
  list = [healthy, stat({})];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/v1/tracker/stats') return new Response(JSON.stringify(list), { status: 200 });
      if (url === '/api/v1/tracker/stats/sync' && method === 'POST') return new Response(JSON.stringify({ message: 'Synced 2 trackers', stats: list }), { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/indexers/trackers', component: TrackerStatsPage }),
    createRoute({ getParentRoute: () => root, path: '/settings/indexers', component: () => null }),
  ];
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/indexers/trackers'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return toasts;
}

describe('tracker stats model', () => {
  it('maps ratio status to chip tones and labels', () => {
    expect(ratioStatusChip('ok')).toEqual({ tone: 'accent', label: 'Ratio OK' });
    expect(ratioStatusChip('warning')).toEqual({ tone: 'warn', label: 'Ratio near limit' });
    expect(ratioStatusChip('low')).toEqual({ tone: 'danger', label: 'Ratio low' });
    expect(ratioStatusChip('unknown')).toEqual({ tone: 'muted', label: 'Ratio unknown' });
  });

  it('derives warnings for low ratio, low buffer, hit-and-runs and account errors', () => {
    expect(trackerWarnings(stat({ accountError: 'login failed' }))).toEqual([
      'Ratio 0.95 is below the required 1.00.',
      'Buffer -50.0 GiB is below the 10.0 GiB minimum.',
      'The tracker reports 1 hit-and-run.',
      'Account page could not be read: login failed',
    ]);
    expect(trackerWarnings(healthy)).toEqual([]);
    expect(trackerWarnings(stat({ ratioStatus: 'warning', ratio: 1.05, buffer: null, accountHnrCount: null }))).toEqual([
      'Ratio 1.05 is within 10 % of the required 1.00.',
    ]);
  });

  it('formats buffers, seed time, H&R rules and sorts problem trackers first', () => {
    expect(formatBuffer(null)).toBe('—');
    expect(formatBuffer(-2 * GIB)).toBe('-2.0 GiB');
    expect(formatSeedTime(76 * 3_600_000)).toBe('3d 4h');
    expect(formatSeedTime(90 * 60_000)).toBe('1h 30m');
    expect(hnrRuleText({ minSeedHours: 72, minRatio: 1 })).toBe('72 h seeding · ratio 1');
    expect(hnrRuleText({})).toBe('—');
    expect(sortTrackers([healthy, stat({})]).map((s) => s.indexerName)).toEqual(['PrivTracker', 'AlphaTracker']);
  });
});

describe('Indexers -> Tracker stats', () => {
  it('renders one pane per tracker with ratio chips, warnings and account values', async () => {
    renderPage();
    const trackers = await screen.findByRole('list', { name: 'Trackers' }, { timeout: 5000 });
    const items = [...trackers.children];
    expect(items.map((i) => i.firstElementChild!.getAttribute('aria-label'))).toEqual(['PrivTracker', 'AlphaTracker']);
    const priv = screen.getByRole('region', { name: 'PrivTracker' });
    expect(within(priv).getByText('Ratio low').className).toContain('al-chip');
    const warnings = within(priv).getByRole('list', { name: 'Warnings' });
    expect(within(warnings).getAllByRole('listitem')).toHaveLength(3);
    const client = within(priv).getByRole('region', { name: 'This client' });
    expect(within(client).getByText('0.95 / 1.00')).toBeTruthy();
    expect(within(client).getByText('9 of 12')).toBeTruthy();
    expect(within(client).getByText('3d 4h')).toBeTruthy();
    const page = within(priv).getByRole('region', { name: 'Account page' });
    expect(within(page).getByText('950.0 GiB')).toBeTruthy();
    expect(within(page).getByText((12345).toLocaleString())).toBeTruthy();

    const alpha = screen.getByRole('region', { name: 'AlphaTracker' });
    expect(within(alpha).getByText('Ratio OK')).toBeTruthy();
    expect(within(alpha).queryByRole('list', { name: 'Warnings' })).toBeNull();
    expect(within(alpha).getByText(/Not read yet/)).toBeTruthy();
  });

  it('syncs now with POST and confirms with a toast', async () => {
    const toasts = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }, { timeout: 5000 }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/tracker/stats/sync')).toBe(true));
    await waitFor(() => expect(toasts.list().some((x) => x.message === 'Synced 2 trackers')).toBe(true));
  });

  it('explains how to add a tracker account when there are none', async () => {
    list = [];
    renderPage();
    expect(await screen.findByText('No tracker accounts yet', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open indexers' }).getAttribute('href')).toBe('/settings/indexers');
  });
});
