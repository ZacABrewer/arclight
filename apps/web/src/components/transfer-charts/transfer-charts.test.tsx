import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { DownloadMetrics, MetricAnnotation, VpnMetrics } from '@arclight/shared';
import { renderAt, stubApi } from '../../test/route-harness.js';
import { createQueryClient } from '../../query-client.js';
import { createToastStore } from '../../lib/toast.js';
import { ToastProvider } from '../toast.js';
import { DownloadTransferHistory, EngineTransferSection } from '../../pages/activity/transfer-history.js';
import { clusterAnnotations, gapPath, niceCeil, summarizeRates, vpnSegments, vpnState, vpnTotals } from './chart-model.js';
import { annotationLabel, SpeedChart } from './transfer-charts.js';

afterEach(() => vi.unstubAllGlobals());

const FROM = '2026-10-26T11:00:00.000Z';
const TO = '2026-10-26T12:00:00.000Z';
const at = (min: number) => new Date(Date.parse(FROM) + min * 60_000).toISOString();

const killPause: MetricAnnotation = {
  time: at(20),
  source: 'download',
  type: 'paused',
  severity: 'warning',
  reason: 'killSwitch',
  trackedDownloadId: 1,
  title: 'Show.S01E01',
};
const vpnDown: MetricAnnotation = { time: at(20), source: 'vpn', type: 'disconnected', severity: 'error', message: 'tunnel down' };

const downloadMetrics: DownloadMetrics = {
  trackedDownloadId: 1,
  range: '1h',
  from: FROM,
  to: TO,
  stepMs: 60_000,
  points: [
    { time: at(0), downloadRate: 1024, uploadRate: 0, peers: 4, seeds: 1, progress: 0.1 },
    { time: at(1), downloadRate: 3072, uploadRate: 1024, peers: 6, seeds: 2, progress: 0.2 },
  ],
  annotations: [vpnDown, killPause],
};

describe('chart model', () => {
  it('breaks lines where samples are missing', () => {
    const pts = [{ time: at(0) }, { time: at(1) }, { time: at(5) }];
    expect(gapPath(pts, () => 1, (p) => Date.parse(p.time) / 60_000 - Date.parse(FROM) / 60_000, (v) => v, 60_000)).toBe('M0 1 L1 1 M5 1');
  });

  it('rounds axis maxima up to 1/2/5 steps and summarises rates', () => {
    expect(niceCeil(0, 1024)).toBe(2000);
    expect(niceCeil(3_100_000)).toBe(5_000_000);
    expect(niceCeil(7)).toBe(10);
    expect(summarizeRates([])).toBeNull();
    expect(summarizeRates([{ time: at(0), down: 10, up: 2, aux: 3 }, { time: at(1), down: 30, up: 4, aux: 5 }])).toEqual({
      avgDown: 20,
      peakDown: 30,
      avgUp: 3,
      peakUp: 4,
      peakAux: 5,
      points: 2,
    });
  });

  it('clusters close markers and keeps the worst severity', () => {
    const clusters = clusterAnnotations([killPause, vpnDown, { ...vpnDown, time: at(50), type: 'connected', severity: 'ok' }], Date.parse(FROM), Date.parse(TO), 600);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ severity: 'error', x: 200 });
    expect(clusters[0]!.items).toHaveLength(2);
  });

  it('classifies VPN steps and merges them into segments', () => {
    expect(vpnState({ connected: 1, killSwitch: 0, warning: 0 })).toBe('up');
    expect(vpnState({ connected: 1, killSwitch: 0, warning: 0.2 })).toBe('warning');
    expect(vpnState({ connected: 0.4, killSwitch: 1, warning: 0 })).toBe('down');
    const p = (min: number, connected: number) => ({ time: at(min), connected, killSwitch: 0, warning: 0, forwardedPort: null });
    const segs = vpnSegments([p(0, 1), p(1, 1), p(2, 0), p(5, 1)], 60_000);
    expect(segs.map((s) => s.state)).toEqual(['up', 'down', 'up']);
    expect(vpnTotals(segs)).toEqual({ up: 180_000, warning: 0, down: 60_000 });
  });

  it('words annotations', () => {
    expect(annotationLabel(killPause)).toBe('Paused by the VPN kill switch');
    expect(annotationLabel(vpnDown)).toBe('VPN disconnected');
    expect(annotationLabel({ ...vpnDown, type: 'portChanged', port: 41234 })).toBe('Forwarded port changed to 41234');
    expect(annotationLabel({ ...vpnDown, type: 'portChanged' })).toBe('Port forward removed');
    expect(annotationLabel({ ...killPause, type: 'stalled', reason: undefined } as MetricAnnotation)).not.toBe('');
  });
});

describe('SpeedChart', () => {
  it('has a text summary, markers and a data table on demand', () => {
    render(
      <SpeedChart
        title="Engine speed"
        range="1h"
        from={FROM}
        to={TO}
        stepMs={60_000}
        points={[
          { time: at(0), down: 1024, up: 0, aux: 4 },
          { time: at(1), down: 3072, up: 1024, aux: 6 },
        ]}
        annotations={[vpnDown, killPause]}
        auxLabel="Peers"
        annotationTitles
      />,
    );
    const img = screen.getByRole('img', { name: /Engine speed\. Average 2\.0 KiB\/s down and 512 B\/s up; peak 3\.0 KiB\/s down/ });
    expect(img.getAttribute('aria-label')).toContain('Peak Peers: 6.');
    expect(img.getAttribute('aria-label')).toContain('2 events marked.');
    expect(img.querySelector('[data-series="aux"]')).toBeTruthy();
    expect(img.querySelectorAll('[data-marker]')).toHaveLength(1);
    expect(screen.queryByRole('table')).toBeNull();
    const details = screen.getByText('Show data').closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const table = screen.getByRole('table', { name: 'Engine speed' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    const events = screen.getByRole('list', { name: 'Events' });
    expect(within(events).getByText(/Paused by the VPN kill switch · Show\.S01E01/)).toBeTruthy();
    expect(within(events).getByText(/VPN disconnected · tunnel down/)).toBeTruthy();
  });

  it('says when there is nothing yet', () => {
    render(<SpeedChart title="X" range="6h" from={FROM} to={TO} stepMs={60_000} points={[]} annotations={[]} />);
    expect(screen.getAllByText('No transfer history for this period yet.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('img')).toBeNull();
  });
});

function renderWithQuery(node: React.ReactNode) {
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe('DownloadTransferHistory', () => {
  it('loads the range the picker selects', async () => {
    const api = stubApi({ '/api/v1/metrics/downloads/1': (_init: RequestInit | undefined, url: URL) => ({ ...downloadMetrics, range: url.searchParams.get('range') }) });
    renderWithQuery(<DownloadTransferHistory id={1} title="Show.S01E01" />);
    expect(await screen.findByRole('img', { name: /Speed of Show\.S01E01/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '24 h' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/metrics/downloads/1')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: '24 h' }).getAttribute('aria-pressed')).toBe('true'));
  });

  it('treats a 404 as no history yet', async () => {
    stubApi({});
    renderWithQuery(<DownloadTransferHistory id={9} title="Old" />);
    expect(await screen.findByText('No transfer history for this period yet.')).toBeTruthy();
  });
});

describe('EngineTransferSection', () => {
  it('stays collapsed without fetching, then charts the engine with download titles on markers', async () => {
    const api = stubApi({
      '/api/v1/metrics/engine': {
        range: '1h',
        from: FROM,
        to: TO,
        stepMs: 60_000,
        points: [{ time: at(0), downloadRate: 2048, uploadRate: 0, peers: 9, activeTorrents: 2 }],
        annotations: [killPause],
      },
    });
    const engine = {
      enabled: true,
      state: 'running' as const,
      listenPort: 6881,
      configuredListenPort: 6881,
      boundAddress: null,
      vpn: { bindToVpn: true, enabled: true, connected: true, killSwitchEngaged: false },
      dhtNodes: 0,
      peers: 9,
      downloadRate: 2048,
      uploadRate: 0,
      torrents: { total: 2, downloading: 2, seeding: 0, paused: 0, queued: 0, checking: 0, error: 0 },
    };
    renderWithQuery(<EngineTransferSection engine={engine} />);
    const toggle = screen.getByRole('button', { name: /Transfer/ });
    expect(screen.getByText('↓ 2.0 KiB/s · ↑ 0 B/s')).toBeTruthy();
    expect(api.calls).toHaveLength(0);
    fireEvent.click(toggle);
    const chart = await screen.findByRole('img', { name: /Built-in engine speed/ });
    expect(chart.querySelector('[data-marker] title')?.textContent).toContain('Paused by the VPN kill switch · Show.S01E01');
  });
});

describe('Settings -> VPN connection history', () => {
  it('shows uptime, the strip and kill-switch and port changes under the live status', async () => {
    const vpn: VpnMetrics = {
      range: '24h',
      from: FROM,
      to: TO,
      stepMs: 300_000,
      points: [
        { time: at(0), connected: 1, killSwitch: 0, warning: 0, forwardedPort: 41234 },
        { time: at(5), connected: 0, killSwitch: 1, warning: 0, forwardedPort: null },
        { time: at(10), connected: 1, killSwitch: 0, warning: 0.5, forwardedPort: 50000 },
      ],
      annotations: [
        vpnDown,
        { time: at(5), source: 'vpn', type: 'killSwitchEngaged', severity: 'error' },
        { time: at(10), source: 'vpn', type: 'portChanged', severity: 'info', port: 50000 },
      ],
      uptime: 0.667,
    };
    stubApi({
      '/api/v1/settings/vpn': { enabled: true, provider: { type: 'gluetun', controlUrl: 'http://localhost:8000', apiKey: '' }, syncForwardedPortToDownloadClient: true, pauseGrabsWhenDown: true, publicIpCheckUrl: '', pollIntervalSeconds: 60 },
      '/api/v1/vpn/status': { enabled: true, connected: true, lastChecked: null, lastChanged: null },
      '/api/v1/metrics/vpn': vpn,
    });
    renderAt('/settings/vpn');
    const pane = await screen.findByRole('region', { name: 'Connection history' }, { timeout: 5000 });
    expect(await within(pane).findByText('Connected 66.7% of the sampled time')).toBeTruthy();
    const strip = within(pane).getByRole('img', { name: /VPN over the last 24 hours: connected 5m 0s, with warnings 5m 0s, down 5m 0s\./ });
    expect(strip.querySelectorAll('[data-state]')).toHaveLength(3);
    expect(within(within(pane).getByRole('list', { name: 'Kill switch' })).getByText('Kill switch engaged')).toBeTruthy();
    expect(within(within(pane).getByRole('list', { name: 'Port forward' })).getByText('Forwarded port changed to 50000')).toBeTruthy();
    expect(within(within(pane).getByRole('list', { name: 'Connection' })).getByText(/VPN disconnected/)).toBeTruthy();
  });
});
