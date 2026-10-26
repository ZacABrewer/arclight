import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { CalendarItem, MediaRequest, QueueItem, RootFolder, VpnStatus } from '@arclight/shared';
import { ToastProvider } from '../components/toast.js';
import { createToastStore } from '../lib/toast.js';
import { createQueryClient } from '../query-client.js';
import { routeTree } from '../router.js';
import { LOW_DISK_BYTES, attentionChecks, queueRow, storageRows, upcomingRows, vpnSummary } from './dashboard-model.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const episodeItem = (id: number, airDateUtc: string, over: Partial<{ title: string; network: string }> = {}): CalendarItem => ({
  type: 'episode',
  date: airDateUtc.slice(0, 10),
  seriesId: 70 + id,
  seriesTitle: over.title ?? `Show ${id}`,
  episode: { id, seriesId: 70 + id, seasonNumber: 2, episodeNumber: id, title: 'Ep', overview: '', airDateUtc, monitored: true, hasFile: false, unverifiedSceneNumbering: false },
  ...(over.network
    ? {
        series: {
          id: 70 + id,
          tmdbId: 1,
          title: over.title ?? `Show ${id}`,
          year: 2022,
          status: 'continuing',
          network: over.network,
          monitored: true,
          images: [],
          tags: [],
          path: '/tv/x',
          qualityProfileId: 1,
        },
      }
    : {}),
});

const queueItem = (over: Partial<QueueItem>): QueueItem => ({
  id: 1,
  downloadId: 'abc',
  downloadClientId: 1,
  downloadClientName: 'qBittorrent',
  title: 'Severance.S02E09.2160p.WEB-DL',
  status: 'downloading',
  trackedStatus: 'ok',
  statusMessages: [],
  protocol: 'torrent',
  sizeBytes: 6 * 1024 ** 3,
  sizeLeftBytes: 2 * 1024 ** 3,
  progress: 0.68,
  eta: 12 * 60_000,
  added: '2026-10-25T10:00:00.000Z',
  trackedState: 'downloading',
  ...over,
});

const request = (over: Partial<MediaRequest>): MediaRequest => ({
  id: 11,
  type: 'movie',
  status: 'pending',
  is4k: false,
  mediaTmdbId: 603,
  mediaTitle: 'Sinners',
  seasons: [],
  requestedBy: { id: 2, username: 'maya', displayName: 'Maya' },
  modifiedBy: null,
  tags: [],
  ignoreQuota: false,
  isAutoRequest: false,
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  mediaStatus: 'pending',
  canRemove: true,
  ...over,
});

describe('dashboard view models', () => {
  it('keeps the next 24 hours, soonest first, with mono clock and episode code', () => {
    const now = new Date();
    const rows = upcomingRows([episodeItem(3, inHours(30)), episodeItem(2, inHours(5), { title: 'The Bear', network: 'FX' }), episodeItem(1, inHours(1))], now);
    expect(rows.map((r) => r.title)).toEqual(['Show 1', 'The Bear']);
    expect(rows[1]!.detail).toBe('S02E02 · FX');
    expect(rows[0]!.time).toMatch(/^\d{2}:\d{2}$/);
    expect(upcomingRows(null, now)).toEqual([]);
  });

  it('summarises the VPN: off, up with port and uptime, down with a cause', () => {
    const base: VpnStatus = { enabled: true, connected: true, lastChecked: null, lastChanged: null };
    expect(vpnSummary({ ...base, enabled: false })).toEqual({ state: 'off', headline: 'VPN off' });
    const now = Date.parse('2026-10-25T12:00:00.000Z');
    expect(vpnSummary({ ...base, city: 'Zürich', provider: 'wireguard-windows', forwardedPort: 51413, lastChanged: '2026-10-22T05:00:00.000Z' }, now)).toEqual({
      state: 'up',
      headline: 'Zürich · WireGuard',
      port: 51413,
      uptime: '3d 7h',
    });
    expect(vpnSummary({ ...base, connected: false, error: 'Handshake timed out.' })).toMatchObject({ state: 'down', cause: 'Handshake timed out.' });
  });

  it('flags root folders under the low-disk threshold or unreachable', () => {
    const folders: RootFolder[] = [
      { id: 1, path: '/media/tv', mediaType: 'series', freeSpaceBytes: LOW_DISK_BYTES - 1, accessible: true },
      { id: 2, path: '/media/movies', mediaType: 'movie', freeSpaceBytes: 412 * 1024 ** 3, accessible: true },
      { id: 3, path: '/mnt/gone', mediaType: 'movie', freeSpaceBytes: null, accessible: false },
    ];
    expect(storageRows(folders).map((r) => [r.free, r.low])).toEqual([
      ['100 GB free', true],
      ['412 GB free', false],
      ['Not reachable', true],
    ]);
  });

  it('maps queue items to trails and chips; failed and stalled say why', () => {
    expect(queueRow(queueItem({}))).toMatchObject({ pct: 68, pctLabel: '68%', eta: '12m', trail: 'active', detail: 'qBittorrent · 6.0 GB' });
    expect(queueRow(queueItem({ trackedStatus: 'error', statusMessages: [{ title: 'x', messages: ['sample only'] }] }))).toMatchObject({
      trail: 'failed',
      chip: { status: 'failed', cause: 'sample only' },
    });
    expect(queueRow(queueItem({ trackedStatus: 'warning' }))).toMatchObject({ trail: 'stalled', chip: { status: 'stalled', cause: 'no progress' } });
    expect(queueRow(queueItem({ status: 'paused' }))).toMatchObject({ trail: 'paused', eta: '—' });
    expect(attentionChecks([{ source: 'a', status: 'ok', message: '' }, { source: 'b', status: 'warning', message: 'w' }, { source: 'c', status: 'error', message: 'e' }]).map((c) => c.source)).toEqual(['c', 'b']);
  });
});

describe('dashboard page', () => {
  let calls: Array<{ url: string; method: string }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    const responses: Record<string, unknown> = {
      '/api/v1/calendar': [episodeItem(1, inHours(1), { title: 'Severance', network: 'Apple TV+' })],
      '/api/v1/vpn/status': { enabled: true, connected: true, city: 'Zürich', country: 'Switzerland', provider: 'wireguard-windows', forwardedPort: 51413, lastChecked: null, lastChanged: null },
      '/api/v1/rootfolder': [{ id: 1, path: '/media/tv', mediaType: 'series', freeSpaceBytes: Math.round(0.9 * 1024 ** 4), accessible: true }],
      '/api/v1/health': { status: 'warning', checks: [{ source: 'IndexerStatusCheck', status: 'warning', message: 'Nyaa is rate-limited. Retry at 20:55.' }] },
      '/api/v1/queue': { page: 1, pageSize: 5, sortKey: 'added', sortDirection: 'desc', totalRecords: 2, records: [queueItem({}), queueItem({ id: 2, title: 'Andor.S02E01', progress: 0.12, trackedStatus: 'warning', statusMessages: [{ title: 'Stalled', messages: ['no peers'] }] })] },
      '/api/v1/request': { pageInfo: { total: 1, take: 4, skip: 0 }, results: [request({})] },
      '/api/v1/request/count': { total: 1, movie: 1, series: 0, pending: 1, approved: 0, declined: 0, failed: 0, processing: 0, available: 0, completed: 0 },
      '/api/v1/request/11/approve': request({ status: 'approved' }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = url.split('?')[0]!;
        calls.push({ url: path, method: init?.method ?? 'GET' });
        const body = responses[path];
        return body === undefined ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderDashboard() {
    const toasts = createToastStore();
    const queryClient = createQueryClient(toasts);
    const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider store={toasts}>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('renders both hero panes with real data, and keeps the traces decorative', async () => {
    renderDashboard();
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeTruthy();
    const next = document.querySelector('.dash-hero--next') as HTMLElement;
    expect(next.getAttribute('data-chamfer')).toBe('tl');
    expect(await within(next).findByText('Severance')).toBeTruthy();
    expect(within(next).getByText('S02E01 · Apple TV+')).toBeTruthy();

    const status = document.querySelector('.dash-hero--status') as HTMLElement;
    expect(status.getAttribute('data-chamfer')).toBe('br');
    expect(await within(status).findByText('Zürich · WireGuard')).toBeTruthy();
    expect(within(status).getByText('51413')).toBeTruthy();
    expect(await within(status).findByText('/media/tv')).toBeTruthy();
    expect(within(status).getByText('922 GB free')).toBeTruthy();
    expect(await within(status).findByText(/Nyaa is rate-limited/)).toBeTruthy();
    expect(within(status).getByText('Issues · 1')).toBeTruthy();

    const traces = document.querySelectorAll('.dash-trace');
    expect(traces).toHaveLength(2);
    traces.forEach((t) => expect(t.getAttribute('aria-hidden')).toBe('true'));
    expect(document.querySelectorAll('[data-chamfer]').length).toBeLessThanOrEqual(2);
  });

  it('shows the queue with trails and causes, and approves a pending request', async () => {
    renderDashboard();
    const queue = (await screen.findByText('Queue')).closest('section') as HTMLElement;
    expect(await within(queue).findByText('Severance.S02E09.2160p.WEB-DL')).toBeTruthy();
    expect(within(queue).getByText('68%')).toBeTruthy();
    expect(within(queue).getByText('Stalled · no peers')).toBeTruthy();
    expect(queue.querySelectorAll('.al-trail')).toHaveLength(2);

    const approve = await screen.findByRole('button', { name: 'Approve Sinners' });
    expect(screen.getByText('Movie · Maya')).toBeTruthy();
    fireEvent.click(approve);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/request/11/approve' && c.method === 'POST')).toBe(true));
  });
});
