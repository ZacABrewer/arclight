import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { TorrentSessionStatus, TorrentSettingsResponse } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { formatRate } from '../../lib/format.js';
import { createToastStore } from '../../lib/toast.js';
import { NAV, navEntry } from '../../nav.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';
import { toTorrentDraft, toTorrentUpdate } from './torrent.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const settings: TorrentSettingsResponse = {
  enabled: true,
  autoRegisterClient: true,
  listenPort: 6881,
  maxConnections: 200,
  maxConnectionsPerTorrent: 50,
  downloadLimitKbps: 0,
  uploadLimitKbps: 0,
  dht: true,
  pex: true,
  maxActiveDownloads: 3,
  maxActiveSeeds: 5,
  defaultSeedRatio: 2,
  defaultSeedTimeMinutes: null,
  bindToVpn: true,
  downloadsRoot: '',
  effectiveDownloadsRoot: '/downloads',
  resumeDir: '/config/torrents',
};

const running: TorrentSessionStatus = {
  enabled: true,
  state: 'running',
  listenPort: 41234,
  configuredListenPort: 6881,
  boundAddress: null,
  vpn: { bindToVpn: true, enabled: true, connected: true, tunnelAddress: '10.2.0.2', forwardedPort: 41234, killSwitchEngaged: false },
  dhtNodes: 312,
  peers: 17,
  downloadRate: 1572864,
  uploadRate: 2048,
  torrents: { total: 4, downloading: 2, seeding: 1, paused: 1, queued: 0, checking: 0, error: 0 },
};

let status: TorrentSessionStatus | null;
let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  status = running;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/v1/settings/torrent') return new Response(JSON.stringify(settings), { status: 200 });
      if (url === '/api/v1/torrent/status' && status) return new Response(JSON.stringify(status), { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
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
  return router;
}

describe('Settings -> Torrent Engine', () => {
  it('is routed and listed in the settings nav next to Download Clients', async () => {
    const children = NAV.find((s) => s.label === 'Settings')!.children!.map((c) => c.label);
    expect(children.indexOf('Torrent Engine')).toBe(children.indexOf('Download Clients') + 1);
    expect(navEntry('/settings/torrent')).toMatchObject({ label: 'Torrent Engine', section: 'Settings' });
    renderAt('/settings/torrent');
    expect(await screen.findByRole('heading', { level: 1, name: 'Torrent Engine' })).toBeTruthy();
  });

  it('renders the form, shows the effective folder as placeholder and saves with PUT', async () => {
    renderAt('/settings/torrent');
    const port = (await screen.findByLabelText('Listen port', {}, { timeout: 5000 })) as HTMLInputElement;
    expect(port.value).toBe('6881');
    expect((screen.getByLabelText('Downloads folder') as HTMLInputElement).placeholder).toBe('/downloads');
    const resume = screen.getByLabelText('Resume data folder') as HTMLInputElement;
    expect(resume.value).toBe('/config/torrents');
    expect(resume.readOnly).toBe(true);

    fireEvent.change(port, { target: { value: '51413' } });
    fireEvent.change(screen.getByLabelText('Default seed ratio'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('DHT'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/v1/settings/torrent');
    expect(put.body).toMatchObject({ listenPort: 51413, dht: false, defaultSeedRatio: null, defaultSeedTimeMinutes: null, downloadsRoot: '' });
    expect(put.body).not.toHaveProperty('effectiveDownloadsRoot');
    expect(put.body).not.toHaveProperty('resumeDir');
  });

  it('shows live status: forwarded port, all interfaces, rates and counts', async () => {
    renderAt('/settings/torrent');
    const panel = await screen.findByLabelText('Torrent engine status', {}, { timeout: 5000 });
    expect(within(panel).getByText('Running')).toBeTruthy();
    expect(within(panel).getByText('41234 (forwarded by VPN; configured 6881)')).toBeTruthy();
    expect(within(panel).getByText('all interfaces')).toBeTruthy();
    expect(within(panel).getByText('1.5 MiB/s')).toBeTruthy();
    expect(within(panel).getByText('312')).toBeTruthy();
    expect(within(panel).getByText(/4 total · 2 downloading · 1 seeding/)).toBeTruthy();
  });

  it('explains lockdown when the VPN is down', async () => {
    status = {
      ...running,
      state: 'lockdown',
      lockdownReason: 'VPN tunnel is down',
      listenPort: 6881,
      boundAddress: '127.0.0.1',
      vpn: { bindToVpn: true, enabled: true, connected: false, killSwitchEngaged: true },
    };
    renderAt('/settings/torrent');
    const panel = await screen.findByLabelText('Torrent engine status', {}, { timeout: 5000 });
    expect(within(panel).getByText('Lockdown', { selector: '.badge' })).toBeTruthy();
    expect(within(panel).getByText(/VPN down — all torrents paused, sockets bound to 127\.0\.0\.1/)).toBeTruthy();
    expect(within(panel).getByText(/VPN tunnel is down/)).toBeTruthy();
    expect(within(panel).getByText('127.0.0.1')).toBeTruthy();
    expect(within(panel).getByText(/kill switch engaged/)).toBeTruthy();
  });

  it('maps drafts to update bodies (empty nullable -> null, empty required -> omitted)', () => {
    const draft = { ...toTorrentDraft(settings), maxConnections: '', defaultSeedTimeMinutes: '90' };
    const body = toTorrentUpdate(draft);
    expect(body).not.toHaveProperty('maxConnections');
    expect(body.defaultSeedTimeMinutes).toBe(90);
    expect(body.defaultSeedRatio).toBe(2);
    expect(formatRate(0)).toBe('0 B/s');
  });
});

describe('dashboard torrent engine card', () => {
  it('shows engine rates and active torrents', async () => {
    renderAt('/');
    const card = await screen.findByLabelText('Torrent engine activity', {}, { timeout: 5000 });
    expect(within(card).getByText('1.5 MiB/s')).toBeTruthy();
    expect(within(card).getByText('2.0 KiB/s')).toBeTruthy();
    expect(within(card).getByText(/3 \(2 downloading, 1 seeding\) of 4/)).toBeTruthy();
  });

  it('renders nothing extra when the engine is disabled or the request fails', async () => {
    status = { ...running, enabled: false, state: 'disabled' };
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/torrent/status')).toBe(true));
    expect(screen.queryByLabelText('Torrent engine activity')).toBeNull();
  });
});
