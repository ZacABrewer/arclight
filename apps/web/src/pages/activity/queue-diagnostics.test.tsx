import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import type { DownloadEvent, QueueItem, QueuePage as QueuePageData, TorrentSessionStatus, VpnStatus } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { hasActiveDownloads } from '../../hooks/activity.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { parseManualImportSearch } from './manual-import/manual-import-page.js';
import { EngineBanner, engineBannerKind, formatPeers, QueueStateChip, SpeedCell, timelineItems } from './queue-diagnostics.js';
import { QueuePage } from './queue-page.js';

const HASH = 'aaaabbbbccccddddeeeeffff0000111122223333';
const NOW = Date.parse('2026-10-26T12:00:00.000Z');

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: 1,
  downloadId: HASH,
  downloadClientId: 7,
  downloadClientName: 'Built-in',
  title: 'Builtin.Release',
  status: 'paused',
  trackedStatus: 'warning',
  statusMessages: [],
  protocol: 'torrent',
  sizeBytes: 1000,
  sizeLeftBytes: 940,
  progress: 0.06,
  added: '2026-10-26T10:00:00.000Z',
  trackedState: 'downloading',
  seriesId: 1,
  stateCode: 'killSwitch',
  stateSeverity: 'error',
  stateReason: 'Paused by the VPN kill switch (VPN disconnected: timeout). It resumes on its own when the VPN reconnects.',
  live: {
    downloadRate: 1536,
    uploadRate: 512,
    connectedPeers: 4,
    connectedSeeds: 1,
    swarmSeeds: 12,
    swarmLeechers: 3,
    piecesHave: 6,
    pieceCount: 100,
    ratio: 0.1,
    transports: { tcp: 3, utp: 1 },
    encryptedPeers: 2,
  },
  ...over,
});

const engine = (over: Partial<TorrentSessionStatus> = {}): TorrentSessionStatus => ({
  enabled: true,
  state: 'running',
  listenPort: 6881,
  configuredListenPort: 6881,
  boundAddress: null,
  vpn: { bindToVpn: true, enabled: true, connected: true, killSwitchEngaged: false },
  dhtNodes: 0,
  peers: 0,
  downloadRate: 0,
  uploadRate: 0,
  torrents: { total: 1, downloading: 1, seeding: 0, paused: 0, queued: 0, checking: 0, error: 0 },
  ...over,
});

const vpnDown: VpnStatus = {
  enabled: true,
  connected: false,
  lastChecked: '2026-10-26T11:59:00.000Z',
  lastChanged: '2026-10-26T11:50:00.000Z',
  error: 'gluetun did not answer.',
};

const events: DownloadEvent[] = [
  { id: 1, trackedDownloadId: 1, downloadId: HASH, title: 'Builtin.Release', type: 'grabbed', severity: 'info', time: '2026-10-26T10:00:00.000Z', message: 'Sent to Built-in.' },
  {
    id: 2,
    trackedDownloadId: 1,
    downloadId: HASH,
    title: 'Builtin.Release',
    type: 'paused',
    severity: 'warning',
    time: '2026-10-26T10:05:00.000Z',
    message: 'Paused by the VPN kill switch: VPN disconnected.',
    data: { reason: 'killSwitch' },
  },
];

describe('queue diagnostics pieces', () => {
  it('colours the state chip by severity and puts the reason in its accessible name', () => {
    render(<QueueStateChip item={item()} />);
    const chip = screen.getByText('Paused · VPN kill switch');
    expect(chip.getAttribute('data-tone')).toBe('danger');
    expect(chip.getAttribute('aria-label')).toContain('It resumes on its own');
    expect(chip.tabIndex).toBe(0);
  });

  it('formats speeds and peers, with dashes when the client reports nothing', () => {
    expect(formatPeers(item().live)).toBe('4 (1)');
    expect(formatPeers({ downloadRate: 0, uploadRate: 0, connectedPeers: 2 })).toBe('2');
    expect(formatPeers(undefined)).toBe('—');
    const { container } = render(<SpeedCell item={item()} />);
    expect(container.textContent).toBe('↓ 1.5 KiB/s↑ 512 B/s');
    expect(render(<SpeedCell item={item({ live: undefined })} />).container.textContent).toBe('—');
  });

  it('picks one banner: lockdown, then VPN down, then a flapping kill switch', () => {
    expect(engineBannerKind(engine({ state: 'lockdown' }), vpnDown)).toBe('lockdown');
    expect(engineBannerKind(engine(), vpnDown)).toBe('vpnDown');
    expect(engineBannerKind(engine({ lockdownsLastHour: 3 }), undefined)).toBe('flapping');
    expect(engineBannerKind(engine({ lockdownsLastHour: 2 }), { ...vpnDown, connected: true })).toBeNull();
    expect(engineBannerKind(undefined, undefined)).toBeNull();
  });

  it('explains a lockdown with its reason, since when and how many torrents wait', () => {
    render(
      <EngineBanner
        now={NOW}
        engine={engine({ state: 'lockdown', lockdownReason: 'VPN kill switch engaged.', lockdownSince: '2026-10-26T11:55:00.000Z', killSwitchPaused: 2 })}
      />,
    );
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('Downloads are paused by the VPN kill switch.');
    expect(banner.textContent).toContain('locked down: VPN kill switch engaged.');
    expect(banner.textContent).toContain('Since 5m ago.');
    expect(banner.textContent).toContain('2 torrents resume on their own');
  });

  it('reports a VPN outage and a flapping kill switch as warnings', () => {
    const { unmount } = render(<EngineBanner now={NOW} vpn={vpnDown} />);
    expect(screen.getByRole('status').textContent).toContain('The VPN is down. gluetun did not answer. Since 10m ago.');
    unmount();
    render(<EngineBanner engine={engine({ lockdownsLastHour: 4 })} />);
    expect(screen.getByRole('status').textContent).toContain('4 times in the last hour');
  });

  it('turns events into timeline entries, newest first, warn/danger by severity', () => {
    const items = timelineItems(events);
    expect(items.map((i) => i.title)).toEqual(['Paused', 'Sent to download client']);
    expect(items[0]!.tone).toBe('warn');
    expect(items[0]!.description).toBe('Paused by the VPN kill switch: VPN disconnected.');
  });

  it('polls fast only while something downloads', () => {
    const page = (records: QueueItem[]): QueuePageData => ({ page: 1, pageSize: 20, sortKey: 'added', sortDirection: 'desc', totalRecords: records.length, records });
    expect(hasActiveDownloads(page([item({ status: 'downloading' })]))).toBe(true);
    expect(hasActiveDownloads(page([item({ status: 'paused' })]))).toBe(false);
    expect(hasActiveDownloads(page([item({ status: 'downloading', trackedState: 'importPending' })]))).toBe(false);
    expect(hasActiveDownloads(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The queue page end to end over a stubbed API
// ---------------------------------------------------------------------------------------

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

let calls: string[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      calls.push(url);
      const path = url.split('?')[0]!;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path === '/api/v1/queue') {
        const records = [item(), item({ id: 2, downloadId: 'other', downloadClientId: 8, downloadClientName: 'qBit', title: 'Remote.Release', stateCode: 'stalled', stateSeverity: 'warning', stateReason: 'No new data received for 10+ minutes.', live: { downloadRate: 0, uploadRate: 0, connectedPeers: 0, connectedSeeds: 0 } })];
        return json({ page: 1, pageSize: 20, sortKey: 'added', sortDirection: 'desc', totalRecords: 2, records });
      }
      if (path === '/api/v1/queue/status') return json({ totalCount: 2, errors: 0, warnings: 2, unknownCount: 0 });
      if (path === '/api/v1/queue/1/timeline') return json({ trackedDownloadId: 1, events });
      if (path === '/api/v1/torrent/status') {
        return json(engine({ state: 'lockdown', lockdownReason: 'VPN kill switch engaged.', lockdownSince: '2026-10-26T11:55:00.000Z', killSwitchPaused: 1 }));
      }
      if (path === '/api/v1/vpn/status') return json(vpnDown);
      if (path === '/api/v1/downloadclient') {
        const common = { enable: true, protocol: 'torrent', priority: 1, removeCompletedDownloads: true, removeFailedDownloads: true, tags: [] };
        return json([
          { ...common, id: 7, name: 'Built-in', implementation: 'builtin', settings: { category: 'tv', postImportCategory: '', savePath: '', categories: [], initialState: 'start' } },
        ]);
      }
      if (path === '/api/v1/torrent/torrents') {
        return json([
          {
            id: HASH,
            name: 'Builtin.Release',
            state: 'paused',
            progress: 0.06,
            totalBytes: 1000,
            wantedBytes: 1000,
            bytesLeft: 940,
            downloaded: 60,
            uploaded: 6,
            downloadRate: 0,
            uploadRate: 0,
            ratio: 0.1,
            connectedPeers: 1,
            connectedSeeds: 1,
            swarmSeeds: 12,
            swarmLeechers: 3,
            seedingTimeMs: 0,
            addedAt: '2026-10-26T10:00:00.000Z',
            completedAt: null,
            savePath: '/downloads/tv',
            contentPath: '/downloads/tv/Builtin.Release',
            category: 'tv',
            tags: [],
            piecesHave: 6,
            pieceCount: 100,
            private: false,
            sequential: false,
            peers: [
              {
                address: '203.0.113.9:51413',
                client: 'Transmission 4.0',
                source: 'tracker',
                incoming: false,
                progress: 1,
                downloadRate: 2048,
                uploadRate: 0,
                amChoking: true,
                amInterested: true,
                peerChoking: false,
                peerInterested: false,
                snubbed: false,
                encrypted: true,
                transport: 'tcp',
              },
            ],
            trackers: [],
            files: [],
          },
        ]);
      }
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

describe('queue page diagnostics', () => {
  it('shows the lockdown banner, live columns and state chips', async () => {
    renderQueue();
    const banner = await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(banner.textContent).toContain('locked down: VPN kill switch engaged.');
    const table = await screen.findByRole('table', { name: 'Download queue' }, { timeout: 5000 });
    const row = within(table).getByText('Builtin.Release').closest('tr')!;
    expect(within(row).getByText('Paused · VPN kill switch')).toBeTruthy();
    expect(within(row).getByText('4 (1)')).toBeTruthy();
    expect(within(row).getByText('↓ 1.5 KiB/s')).toBeTruthy();
    const remote = within(table).getByText('Remote.Release').closest('tr')!;
    expect(within(remote).getByText('Stalled').getAttribute('data-tone')).toBe('warn');
  });

  it('expands a row into live stats, pieces, peers and the timeline', async () => {
    renderQueue();
    const toggle = await screen.findByRole('button', { name: 'Show details of Builtin.Release' }, { timeout: 5000 });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const hide = screen.getByRole('button', { name: 'Hide details of Builtin.Release' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('region', { name: 'Details of Builtin.Release' });
    expect(hide.getAttribute('aria-controls')).toBe(panel.id);

    expect(within(panel).getAllByText('6 of 100 pieces').length).toBeGreaterThan(0);
    expect(within(panel).getByText('4 peers (1 seeds)')).toBeTruthy();
    expect(within(panel).getByText('12 seeds / 3 leechers')).toBeTruthy();
    expect(within(panel).getByText('TCP 3 · uTP 1')).toBeTruthy();
    expect(within(panel).getByText(/It resumes on its own/)).toBeTruthy();

    expect(await within(panel).findByText('Sent to download client', {}, { timeout: 5000 })).toBeTruthy();
    expect(within(panel).getByText('Paused by the VPN kill switch: VPN disconnected.')).toBeTruthy();
    expect(calls).toContain('/api/v1/queue/1/timeline');

    const peers = await within(panel).findByRole('table', { name: 'Peers' }, { timeout: 5000 });
    const peer = within(peers).getByText('Transmission 4.0').closest('tr')!;
    expect(within(peer).getByText('Encrypted')).toBeTruthy();
    expect(within(peer).getByText('TCP')).toBeTruthy();
    expect(within(peer).getByText('2.0 KiB/s')).toBeTruthy();

    fireEvent.click(hide);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Details of Builtin.Release' })).toBeNull());
  });

  it('does not load engine peers for rows of other clients', async () => {
    renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: 'Show details of Remote.Release' }, { timeout: 5000 }));
    const panel = screen.getByRole('region', { name: 'Details of Remote.Release' });
    expect(within(panel).queryByRole('table', { name: 'Peers' })).toBeNull();
    expect(within(panel).getByText('No new data received for 10+ minutes.')).toBeTruthy();
    await waitFor(() => expect(calls).toContain('/api/v1/queue/2/timeline'));
    expect(calls.some((c) => c === '/api/v1/torrent/torrents?id=other')).toBe(false);
  });
});
