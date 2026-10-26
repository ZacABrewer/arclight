import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import type { QueueItem, TorrentDetail } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { parseManualImportSearch } from './manual-import/manual-import-page.js';
import { QueuePage } from './queue-page.js';
import { priorityOption } from './torrent-drawer.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const HASH = 'aaaabbbbccccddddeeeeffff0000111122223333';

const item = (over: Partial<QueueItem>): QueueItem => ({
  id: 1,
  downloadId: HASH,
  downloadClientId: 7,
  downloadClientName: 'Built-in',
  title: 'Builtin.Release',
  status: 'downloading',
  trackedStatus: 'ok',
  statusMessages: [],
  protocol: 'torrent',
  sizeBytes: 1000,
  sizeLeftBytes: 500,
  progress: 0.5,
  added: '2026-10-25T10:00:00.000Z',
  trackedState: 'downloading',
  seriesId: 1,
  ...over,
});

const torrent: TorrentDetail = {
  id: HASH,
  name: 'Builtin.Release.1080p',
  state: 'downloading',
  progress: 0.5,
  totalBytes: 2048,
  wantedBytes: 2048,
  bytesLeft: 1024,
  downloaded: 1024,
  uploaded: 0,
  downloadRate: 4096,
  uploadRate: 0,
  etaSeconds: 60,
  ratio: 0,
  connectedPeers: 1,
  connectedSeeds: 1,
  swarmSeeds: 10,
  swarmLeechers: 3,
  seedingTimeMs: 0,
  addedAt: '2026-10-25T10:00:00.000Z',
  completedAt: null,
  savePath: '/downloads/tv',
  contentPath: '/downloads/tv/Builtin.Release.1080p',
  category: 'tv',
  tags: [],
  piecesHave: 21,
  pieceCount: 42,
  private: false,
  sequential: false,
  peers: [
    {
      address: '203.0.113.5:51413',
      client: 'qBittorrent 5.0',
      source: 'dht',
      incoming: false,
      progress: 1,
      downloadRate: 4096,
      uploadRate: 0,
      amChoking: true,
      amInterested: true,
      peerChoking: false,
      peerInterested: false,
      snubbed: false,
    },
  ],
  trackers: [{ url: 'udp://tracker.example:1337/announce', tier: 0, state: 'working', peers: 12 }],
  files: [
    { index: 0, path: 'Builtin.Release.1080p/episode.mkv', length: 2000, priority: 1, progress: 0.5 },
    { index: 1, path: 'Builtin.Release.1080p/sample.mkv', length: 48, priority: 0, progress: 0 },
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
      const path = url.split('?')[0]!;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path === '/api/v1/queue') {
        const records = [item({}), item({ id: 2, downloadId: 'other', downloadClientId: 8, downloadClientName: 'qBit', title: 'Remote.Release' })];
        return json({ page: 1, pageSize: 20, sortKey: 'added', sortDirection: 'desc', totalRecords: 2, records });
      }
      if (path === '/api/v1/queue/status') return json({ totalCount: 2, errors: 0, warnings: 0, unknownCount: 0 });
      if (path === '/api/v1/downloadclient') {
        const common = { enable: true, protocol: 'torrent', priority: 1, removeCompletedDownloads: true, removeFailedDownloads: true, tags: [] };
        return json([
          { ...common, id: 7, name: 'Built-in', implementation: 'builtin', settings: { category: 'tv', postImportCategory: '', savePath: '', categories: [], initialState: 'start' } },
        ]);
      }
      if (path === '/api/v1/torrent/torrents') return json([torrent]);
      if (path.startsWith('/api/v1/torrent/') && method === 'POST') return json({ ok: true });
      if (path.startsWith('/api/v1/queue/') && method === 'DELETE') return json({ removed: [2], failed: [] });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  // Minimal router (not the app routeTree) so shell changes cannot break these tests.
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/activity/queue', component: QueuePage }),
    createRoute({ getParentRoute: () => root, path: '/activity/history', component: () => null }),
    createRoute({ getParentRoute: () => root, path: '/activity/blocklist', component: () => null }),
    createRoute({ getParentRoute: () => root, path: '/activity/pending', component: () => null }),
    createRoute({ getParentRoute: () => root, path: '/activity/manual-import', validateSearch: parseManualImportSearch, component: () => null }),
  ];
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('queue torrent drawer', () => {
  it('offers details only for built-in rows and shows general, peers and files', async () => {
    renderAt('/activity/queue');
    const details = await screen.findByRole('button', { name: 'Details Builtin.Release' }, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Details Remote.Release' })).toBeNull();
    fireEvent.click(details);

    const dialog = await screen.findByRole('dialog', { name: 'Builtin.Release.1080p' }, { timeout: 5000 });
    expect(await within(dialog).findByText('21/42', {}, { timeout: 5000 })).toBeTruthy();
    expect(within(dialog).getByText('/downloads/tv')).toBeTruthy();
    expect(calls.some((c) => c.url === `/api/v1/torrent/torrents?id=${HASH}`)).toBe(true);

    fireEvent.click(within(dialog).getByRole('tab', { name: /^Peers/ }));
    const peers = within(dialog).getByRole('table', { name: 'Peers' });
    expect(within(peers).getByText('203.0.113.5:51413')).toBeTruthy();
    expect(within(peers).getByText('qBittorrent 5.0')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('tab', { name: /^Trackers/ }));
    expect(within(dialog).getByText('udp://tracker.example:1337/announce')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('tab', { name: /^Files/ }));
    const sample = within(dialog).getByLabelText('Priority of Builtin.Release.1080p/sample.mkv') as HTMLSelectElement;
    expect(sample.value).toBe('0');
    fireEvent.change(within(dialog).getByLabelText('Priority of Builtin.Release.1080p/episode.mkv'), { target: { value: '7' } });
    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/torrent/${HASH}/priority`)).toBe(true));
    expect(calls.find((c) => c.url === `/api/v1/torrent/${HASH}/priority`)!.body).toEqual({ files: [{ index: 0, priority: 7 }] });
  });

  it('pauses and rechecks through the engine', async () => {
    renderAt('/activity/queue');
    fireEvent.click(await screen.findByRole('button', { name: 'Details Builtin.Release' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Builtin.Release.1080p' }, { timeout: 5000 });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Pause' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recheck' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/v1/torrent/${HASH}/pause`)).toBe(true);
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/v1/torrent/${HASH}/recheck`)).toBe(true);
    });
  });

  it('shows the bulk bar for a selection and removes with the chosen flags', async () => {
    renderAt('/activity/queue');
    const header = await screen.findByRole('tab', { name: /^Queue/ }, { timeout: 5000 });
    expect(header.getAttribute('aria-selected')).toBe('true');
    const check = await screen.findByRole('checkbox', { name: 'Select Remote.Release' }, { timeout: 5000 });
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull();
    fireEvent.click(check);
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('1 selected')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Retry import' }).className).toContain('al-btn--secondary');
    fireEvent.click(within(bar).getByRole('button', { name: 'Remove…' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Remote.Release?' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Add to blocklist/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 1 item' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.startsWith('/api/v1/queue/2'))).toBe(true));
    const url = calls.find((c) => c.method === 'DELETE')!.url;
    expect(url).toContain('removeFromClient=true');
    expect(url).toContain('blocklist=true');
    expect(url).toContain('skipRedownload=false');
  });

  it('snaps engine priorities to the select options', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(priorityOption)).toEqual(['0', '1', '1', '1', '4', '4', '4', '7']);
  });
});
