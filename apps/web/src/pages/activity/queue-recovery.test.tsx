import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import type { QueueItem } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { parseManualImportSearch } from './manual-import/manual-import-page.js';
import { QueuePage } from './queue-page.js';
import { canReannounce, canReplace, diskGuardBannerText } from './queue-recovery.js';

const HASH = 'aaaabbbbccccddddeeeeffff0000111122223333';
const MIB = 1024 ** 2;

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: 1,
  downloadId: HASH,
  downloadClientId: 8,
  downloadClientName: 'qBit',
  title: 'Stuck.Release',
  status: 'downloading',
  trackedStatus: 'warning',
  statusMessages: [],
  protocol: 'torrent',
  sizeBytes: 1000,
  sizeLeftBytes: 940,
  progress: 0.06,
  added: '2026-10-26T10:00:00.000Z',
  trackedState: 'downloading',
  seriesId: 1,
  episodeIds: [11],
  stateCode: 'stalled',
  stateSeverity: 'warning',
  stateReason: 'No new data received for 10+ minutes. Asked for fresh peers just now.',
  ...over,
});

describe('recovery helpers', () => {
  it('offers re-announce for sent torrents and replace for linked items', () => {
    expect(canReannounce(item())).toBe(true);
    expect(canReannounce(item({ protocol: 'usenet' }))).toBe(false);
    expect(canReannounce(item({ downloadId: 'pending:1', downloadClientId: null, trackedState: 'pending' }))).toBe(false);
    expect(canReplace(item())).toBe(true);
    expect(canReplace(item({ seriesId: undefined, episodeIds: undefined }))).toBe(false);
    expect(canReplace(item({ seriesId: undefined, episodeIds: undefined, movieId: 4 }))).toBe(true);
    expect(canReplace(item({ trackedState: 'importing' }))).toBe(false);
  });

  it('words the disk-guard banner for paused downloads and held grabs', () => {
    expect(diskGuardBannerText(undefined)).toBeNull();
    expect(diskGuardBannerText({ paused: 0, held: 0, volumes: [], minimumFreeBytes: 100 * MIB })).toBeNull();
    const text = diskGuardBannerText({ paused: 2, held: 1, volumes: [{ path: '/downloads', freeBytes: 50 * MIB }], minimumFreeBytes: 100 * MIB });
    expect(text).toContain('2 downloads are paused below the 100.0 MiB minimum free space (/downloads: 50.0 MiB free)');
    expect(text).toContain('1 grab is held until the download volume has room');
  });
});

// ---------------------------------------------------------------------------------------
// The queue page over a stubbed API
// ---------------------------------------------------------------------------------------

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

let calls: Array<{ method: string; path: string; body?: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).split('?')[0]!;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path === '/api/v1/queue') {
        return json({ page: 1, pageSize: 20, sortKey: 'added', sortDirection: 'desc', totalRecords: 1, records: [item()] });
      }
      if (path === '/api/v1/queue/status') {
        return json({
          totalCount: 1,
          errors: 0,
          warnings: 1,
          unknownCount: 0,
          diskGuard: { paused: 0, held: 1, volumes: [], minimumFreeBytes: 100 * MIB },
        });
      }
      if (path === '/api/v1/queue/1/timeline') return json({ trackedDownloadId: 1, events: [] });
      if (path === '/api/v1/queue/1/replace') {
        return json({ id: 1, blocklisted: true, searchStarted: true, message: 'Replaced on request: searching for another release.' });
      }
      if (path === '/api/v1/queue/1/reannounce') return json({ id: 1, message: 'Asked qBit for fresh peers.' });
      if (path === '/api/v1/queue/1' && method === 'DELETE') {
        return json({ removed: [], failed: [{ id: 1, error: 'The built-in torrent engine is not running.' }] });
      }
      if (path === '/api/v1/downloadclient') return json([]);
      if (path === '/api/v1/vpn/status') return json({ enabled: false, connected: false, lastChecked: null, lastChanged: null });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderQueue() {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/activity/queue', component: QueuePage }),
    createRoute({ getParentRoute: () => root, path: '/activity/manual-import', validateSearch: parseManualImportSearch, component: () => null }),
  ];
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/activity/queue'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('queue page recovery actions', () => {
  it('shows the disk-guard banner', async () => {
    renderQueue();
    expect(await screen.findByText(/1 grab is held until the download volume has room/, {}, { timeout: 5000 })).toBeTruthy();
  });

  it('says why a remove failed and keeps the dialog open to retry without the client', async () => {
    renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Stuck.Release' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 1 item' }));
    expect(await screen.findByText(/The built-in torrent engine is not running/)).toBeTruthy();
    expect(screen.getByText(/Could not remove 1 from the queue/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('re-announces and replaces from the expanded row, after confirming', async () => {
    renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: 'Show details of Stuck.Release' }, { timeout: 5000 }));
    const panel = screen.getByRole('region', { name: 'Details of Stuck.Release' });

    fireEvent.click(within(panel).getByRole('button', { name: 'Ask for fresh peers for Stuck.Release' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/queue/1/reannounce')).toBe(true));

    fireEvent.click(within(panel).getByRole('button', { name: 'Try another release instead of Stuck.Release' }));
    const dialog = await screen.findByRole('dialog');
    const removeData = within(dialog).getByLabelText(/Delete downloaded data/) as HTMLInputElement;
    expect(removeData.checked).toBe(true);
    fireEvent.click(removeData);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove and search' }));
    await waitFor(() => {
      const replace = calls.find((c) => c.path === '/api/v1/queue/1/replace');
      expect(replace).toMatchObject({ method: 'POST', body: { blocklist: true, removeData: false } });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
