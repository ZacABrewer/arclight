import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { VpnStatus } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { applyServerEvent } from '../../live.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const status: VpnStatus = {
  enabled: true,
  provider: 'gluetun',
  connected: true,
  publicIp: '185.1.2.3',
  country: 'Netherlands',
  forwardedPort: 41234,
  downloadClientPortSynced: true,
  interfaceName: 'tun0',
  tunnelAddress: '10.2.0.2',
  lastChecked: new Date().toISOString(),
  lastChanged: new Date(Date.now() - (2 * 3600 + 5 * 60) * 1000).toISOString(),
};

const settings = {
  enabled: true,
  provider: { type: 'gluetun', controlUrl: 'http://localhost:8000', apiKey: '********' },
  syncForwardedPortToDownloadClient: true,
  pauseGrabsWhenDown: true,
  publicIpCheckUrl: 'https://api.ipify.org?format=json',
  pollIntervalSeconds: 60,
};

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/v1/settings/vpn') return new Response(JSON.stringify(settings), { status: 200 });
      if (url === '/api/v1/vpn/status' || url === '/api/v1/vpn/test') return new Response(JSON.stringify(status), { status: 200 });
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
}

describe('Settings -> VPN', () => {
  it('shows the live status pane with mono public IP, port forward, uptime and interface', async () => {
    renderAt('/settings/vpn');
    const pane = await screen.findByRole('region', { name: 'Live status' });
    expect(pane.getAttribute('data-chamfer')).toBe('tl');
    const ip = await within(pane).findByText('185.1.2.3');
    expect(ip.className).toContain('al-kv__value--mono');
    const value = (label: string) => within(pane).getByText(label).nextElementSibling as HTMLElement;
    expect(value('Port forward').textContent).toBe('41234 · synced to qBittorrent');
    expect(value('Port forward').className).toContain('al-kv__value--mono');
    expect(value('Uptime').textContent).toBe('2h 5m');
    expect(value('Uptime').className).toContain('al-kv__value--mono');
    expect(value('Interface').textContent).toBe('tun0 10.2.0.2');
    expect(within(pane).getByRole('status').textContent).toBe('Connected');
    expect(pane.querySelector('.al-live')).toBeTruthy();
  });

  it('says why it is disconnected and drops the live dot', async () => {
    Object.assign(status, { connected: false, error: 'handshake timed out' });
    try {
      renderAt('/settings/vpn');
      const pane = await screen.findByRole('region', { name: 'Live status' });
      expect((await within(pane).findByRole('status')).textContent).toBe('Disconnected · handshake timed out');
      expect(pane.querySelector('.al-live')).toBeNull();
    } finally {
      Object.assign(status, { connected: true, error: undefined });
    }
  });

  it('saves the form from the unsaved-changes bar with masked secrets kept', async () => {
    renderAt('/settings/vpn');
    const url = await screen.findByDisplayValue('http://localhost:8000');
    fireEvent.change(url, { target: { value: 'http://gluetun:8000' } });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('1 unsaved change');
    fireEvent.click(within(bar).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ provider: { type: 'gluetun', controlUrl: 'http://gluetun:8000', apiKey: '********' }, homePublicIp: null });
  });

  it('switches provider fields and tests the draft', async () => {
    renderAt('/settings/vpn');
    const select = await screen.findByLabelText('Provider');
    fireEvent.change(select, { target: { value: 'wireguard-windows' } });
    const conf = await screen.findByLabelText('WireGuard config (.conf)');
    fireEvent.change(conf, { target: { value: 'C:\\vpn\\proton-nl.conf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByLabelText('Test result')).toBeTruthy();
    const test = calls.find((c) => c.url === '/api/v1/vpn/test')!;
    expect(test.body).toMatchObject({ provider: { type: 'wireguard-windows', configPath: 'C:\\vpn\\proton-nl.conf', killSwitch: true } });
  });

  it('shows the VPN card on the dashboard', async () => {
    renderAt('/');
    // Dashboard VPN block: location headline, forwarded port in mono.
    const port = await screen.findByText('41234');
    expect(port.className).toContain('al-num');
    expect(screen.getAllByText(/Netherlands/).length).toBeGreaterThan(0);
  });

  it('invalidates the vpn queries on a vpn event', () => {
    const qc = new QueryClient();
    qc.setQueryData(['vpn', 'status'], status);
    applyServerEvent(qc, { type: 'vpn', status: { ...status, connected: false } });
    expect(qc.getQueryState(['vpn', 'status'])?.isInvalidated).toBe(true);
  });
});
