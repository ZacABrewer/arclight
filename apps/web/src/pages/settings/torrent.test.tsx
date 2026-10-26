import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import type { TorrentSessionStatus, TorrentSettingsResponse } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { formatRate } from '../../lib/format.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { TorrentSessionStatus as TorrentSessionStatusSchema, TorrentSettingsResponse as TorrentSettingsResponseSchema, TorrentSpeedSettings } from '@arclight/shared';
import { TORRENT_SECTIONS, TorrentSettingsPage, encryptedPeersText, toTorrentDraft, toTorrentUpdate } from './torrent.js';

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
      // The speed schedule and seeding rules panes below the form.
      if (url === '/api/v1/settings/torrent/speed') return new Response(JSON.stringify(TorrentSpeedSettings.parse({})), { status: 200 });
      if (url === '/api/v1/settings/torrent/seedingrules') return new Response(JSON.stringify({ rules: [] }), { status: 200 });
      if (url === '/api/v1/indexer') return new Response('[]', { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** The torrent page in a minimal router (independent of the app shell). */
function renderPage() {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/settings/torrent', component: TorrentSettingsPage });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/settings/torrent'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

/** The full app (dashboard tests). The router loads lazily so a shell problem stays in these tests. */
async function renderApp(path: string) {
  const { routeTree } = await import('../../router.js');
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

describe('Settings -> Torrent engine', () => {
  it('renders the engine form in FormSection groups with the six handoff sections', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 2, name: 'Torrent engine' })).toBeTruthy();
    await screen.findByLabelText('Listen port', {}, { timeout: 5000 });
    const form = screen.getByRole('form', { name: 'Torrent engine settings' });
    const labels = [...form.querySelectorAll('.al-form-section .al-label')].map((el) => el.textContent);
    expect(labels).toEqual([...TORRENT_SECTIONS]);
    for (const label of ['Port', 'Limits', 'Ratio & time', 'Interface binding', 'DHT & PEX', 'Encryption']) expect(labels).toContain(label);
    // Numbers are mono with their unit at the end.
    const limit = screen.getByLabelText('Download limit') as HTMLInputElement;
    expect(limit.className).toContain('mono');
    expect(limit.parentElement!.textContent).toContain('KiB/s');
  });

  it('shows the effective folder as placeholder and keeps the resume folder read-only', async () => {
    renderPage();
    const port = (await screen.findByLabelText('Listen port', {}, { timeout: 5000 })) as HTMLInputElement;
    expect(port.value).toBe('6881');
    expect((screen.getByLabelText('Downloads folder') as HTMLInputElement).placeholder).toBe('/downloads');
    const resume = screen.getByLabelText('Resume data folder') as HTMLInputElement;
    expect(resume.value).toBe('/config/torrents');
    expect(resume.readOnly).toBe(true);
  });

  it('shows the unsaved-changes bar with a count while editing, and Discard restores the saved values', async () => {
    renderPage();
    const port = (await screen.findByLabelText('Listen port', {}, { timeout: 5000 })) as HTMLInputElement;
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    fireEvent.change(port, { target: { value: '51413' } });
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('DHT'));
    expect(screen.getByText('2 unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(port.value).toBe('6881');
    expect((screen.getByLabelText('DHT') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it('Save changes sends the PUT body', async () => {
    renderPage();
    const port = (await screen.findByLabelText('Listen port', {}, { timeout: 5000 })) as HTMLInputElement;
    fireEvent.change(port, { target: { value: '51413' } });
    fireEvent.change(screen.getByLabelText('Default seed ratio'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('DHT'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/v1/settings/torrent');
    expect(put.body).toMatchObject({ listenPort: 51413, dht: false, defaultSeedRatio: null, defaultSeedTimeMinutes: null, downloadsRoot: '' });
    expect(put.body).not.toHaveProperty('effectiveDownloadsRoot');
    expect(put.body).not.toHaveProperty('resumeDir');
  });

  it('shows live status in the side pane: forwarded port, all interfaces, rates, counts and a live dot', async () => {
    renderPage();
    const panel = await screen.findByLabelText('Torrent engine status', {}, { timeout: 5000 });
    expect(within(panel).getByText('Running').closest('.al-chip')).toBeTruthy();
    expect(within(panel).getByText('41234 (forwarded by VPN; configured 6881)')).toBeTruthy();
    expect(within(panel).getByText('all interfaces')).toBeTruthy();
    expect(within(panel).getByText('1.5 MiB/s')).toBeTruthy();
    expect(within(panel).getByText('312')).toBeTruthy();
    expect(within(panel).getByText(/4 total · 2 downloading · 1 seeding/)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Engine running' })).toBeTruthy();
  });

  it('explains lockdown when the VPN is down, without a live dot', async () => {
    status = {
      ...running,
      state: 'lockdown',
      lockdownReason: 'VPN tunnel is down',
      listenPort: 6881,
      boundAddress: '127.0.0.1',
      vpn: { bindToVpn: true, enabled: true, connected: false, killSwitchEngaged: true },
    };
    renderPage();
    const panel = await screen.findByLabelText('Torrent engine status', {}, { timeout: 5000 });
    expect(within(panel).getByText('Lockdown').closest('.al-chip')).toBeTruthy();
    expect(within(panel).getByText(/VPN down — all torrents paused, sockets bound to 127\.0\.0\.1/)).toBeTruthy();
    expect(within(panel).getByText(/VPN tunnel is down/)).toBeTruthy();
    expect(within(panel).getByText('127.0.0.1')).toBeTruthy();
    expect(within(panel).getByText(/kill switch engaged/)).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Engine running' })).toBeNull();
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

describe('Settings -> Torrent engine transport and encryption', () => {
  it('fills the transport defaults when never saved and shows Preferred encryption', async () => {
    expect(TorrentSettingsResponseSchema.safeParse(settings).success).toBe(true);
    renderPage();
    const tcp = (await screen.findByLabelText('TCP', {}, { timeout: 5000 })) as HTMLInputElement;
    expect(tcp.checked).toBe(true);
    expect((screen.getByLabelText('uTP') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('IPv6') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Web seed connections') as HTMLInputElement).value).toBe('4');
    const group = screen.getByRole('group', { name: 'Peer encryption' });
    expect(within(group).getByRole('button', { name: 'Preferred' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Try an encrypted connection first and fall back to plain.')).toBeTruthy();
  });

  it('saves encryption, transports and web seed connections in the PUT body', async () => {
    renderPage();
    const group = await screen.findByRole('group', { name: 'Peer encryption' }, { timeout: 5000 });
    fireEvent.click(within(group).getByRole('button', { name: 'Required' }));
    expect(screen.getByText('Encrypted connections only. Fewer peers can connect.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('uTP'));
    fireEvent.click(screen.getByLabelText('IPv6'));
    fireEvent.change(screen.getByLabelText('Web seed connections'), { target: { value: '8' } });
    expect(screen.getByText('4 unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ encryption: 'required', tcp: true, utp: false, ipv6: false, webSeedConnectionsPerTorrent: 8 });
  });

  it('warns when TCP and uTP are both off', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText('TCP', {}, { timeout: 5000 }));
    expect(screen.queryByText(/TCP and uTP are both off/)).toBeNull();
    fireEvent.click(screen.getByLabelText('uTP'));
    expect(screen.getByRole('alert').textContent).toMatch(/TCP and uTP are both off/);
  });

  it('keeps saved transport values in the draft and update body', () => {
    const draft = toTorrentDraft({ ...settings, encryption: 'disabled', tcp: false, utp: true, ipv6: false, webSeedConnectionsPerTorrent: 0 });
    expect(draft).toMatchObject({ encryption: 'disabled', tcp: false, utp: true, ipv6: false, webSeedConnectionsPerTorrent: '0' });
    expect(toTorrentUpdate({ ...draft, webSeedConnectionsPerTorrent: '' })).not.toHaveProperty('webSeedConnectionsPerTorrent');
  });

  it('shows uTP connections, IPv6 DHT nodes and the encrypted peer ratio in the status pane', async () => {
    status = { ...running, dht6Nodes: 88, utpConnections: 9, encryptedPeers: 12, encryptedPeerRatio: 12 / 17 };
    expect(TorrentSessionStatusSchema.safeParse(status).success).toBe(true);
    renderPage();
    const panel = await screen.findByLabelText('Torrent engine status', {}, { timeout: 5000 });
    expect(within(panel).getByText('uTP connections')).toBeTruthy();
    expect(within(panel).getByText('9')).toBeTruthy();
    expect(within(panel).getByText('IPv6 DHT nodes')).toBeTruthy();
    expect(within(panel).getByText('88')).toBeTruthy();
    expect(within(panel).getByText('12 of 17 (71%)')).toBeTruthy();
  });

  it('formats the encrypted peer share with or without the count', () => {
    expect(encryptedPeersText({ peers: 0, encryptedPeers: 0, encryptedPeerRatio: 0 })).toBe('0 of 0 (0%)');
    expect(encryptedPeersText({ peers: 4, encryptedPeerRatio: 0.5 })).toBe('50%');
    expect(encryptedPeersText({ peers: 4, encryptedPeers: 1 })).toBe('1 of 4 (25%)');
  });
});

describe('dashboard torrent engine card', () => {
  it('shows engine rates in mono in the dashboard queue pane', async () => {
    await renderApp('/');
    const down = await screen.findByText(/^1\.5 Mi?B\/s$/, {}, { timeout: 5000 });
    expect(down.className).toContain('al-num');
    expect(screen.getByText(/^2(\.0)? Ki?B\/s$/).className).toContain('al-num');
  }, 20_000);

  it('renders nothing extra when the engine is disabled or the request fails', async () => {
    status = { ...running, enabled: false, state: 'disabled' };
    await renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/torrent/status')).toBe(true));
    expect(screen.queryByLabelText('Torrent engine activity')).toBeNull();
  }, 20_000);
});
