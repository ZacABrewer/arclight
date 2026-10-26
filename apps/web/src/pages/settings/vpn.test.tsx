import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  lastChecked: new Date().toISOString(),
  lastChanged: null,
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
  it('shows live status and saves the form with masked secrets kept', async () => {
    renderAt('/settings/vpn');
    expect(await screen.findByText('41234 (synced to qBittorrent)')).toBeTruthy();
    const url = await screen.findByDisplayValue('http://localhost:8000');
    fireEvent.change(url, { target: { value: 'http://gluetun:8000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
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
    expect(await screen.findByText('185.1.2.3')).toBeTruthy();
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0);
    expect(screen.getByText('41234 (synced to qBittorrent)')).toBeTruthy();
  });

  it('invalidates the vpn queries on a vpn event', () => {
    const qc = new QueryClient();
    qc.setQueryData(['vpn', 'status'], status);
    applyServerEvent(qc, { type: 'vpn', status: { ...status, connected: false } });
    expect(qc.getQueryState(['vpn', 'status'])?.isInvalidated).toBe(true);
  });
});
