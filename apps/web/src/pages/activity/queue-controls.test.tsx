import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { QueueItem, TorrentSessionStatus, TorrentSpeedMode } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { formatRate } from '../../lib/format.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { stubApi } from '../../test/route-harness.js';
import { hasEngineControls, QueueRowControls, SlowModeControl, slowModeUntil, speedModeText } from './queue-controls.js';

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: 4,
  downloadId: 'ab'.repeat(20),
  downloadClientId: 7,
  downloadClientName: 'Built-in',
  title: 'Show.S01E01',
  status: 'queued',
  trackedStatus: 'ok',
  statusMessages: [],
  protocol: 'torrent',
  sizeBytes: 1000,
  sizeLeftBytes: 1000,
  progress: 0,
  added: '2026-10-26T10:00:00.000Z',
  trackedState: 'downloading',
  live: { downloadRate: 0, uploadRate: 0, downloadLimit: 102_400, uploadLimit: 0, queuePosition: 2, forceStart: false },
  ...over,
});

const speed = (over: Partial<TorrentSpeedMode> = {}): TorrentSpeedMode => ({
  mode: 'normal',
  reason: null,
  slowMode: false,
  slowModeUntil: null,
  downloadLimit: 0,
  uploadLimit: 512 * 1024,
  ...over,
});

const status = (s: TorrentSpeedMode): TorrentSessionStatus => ({
  enabled: true,
  state: 'running',
  listenPort: 6881,
  configuredListenPort: 6881,
  boundAddress: null,
  vpn: { bindToVpn: false, enabled: false, connected: false, killSwitchEngaged: false },
  dhtNodes: 0,
  peers: 0,
  downloadRate: 0,
  uploadRate: 0,
  torrents: { total: 0, downloading: 0, seeding: 0, paused: 0, queued: 0, checking: 0, error: 0 },
  speed: s,
});

function wrap(children: ReactNode) {
  const toasts = createToastStore();
  return render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>{children}</ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('per-download controls', () => {
  it('shows only for clients that report controls', () => {
    expect(hasEngineControls(item())).toBe(true);
    expect(hasEngineControls(item({ live: { downloadRate: 1, uploadRate: 1 } }))).toBe(false);
    expect(hasEngineControls(item({ live: undefined }))).toBe(false);
    expect(hasEngineControls(item({ downloadId: 'pending:1', downloadClientId: null, trackedState: 'pending' }))).toBe(false);
  });

  it('moves, force-starts and saves limits through the queue api', async () => {
    const api = stubApi({
      'POST /api/v1/queue/4/move': item(),
      'POST /api/v1/queue/4/forcestart': item(),
      'POST /api/v1/queue/4/limits': item(),
    });
    wrap(<QueueRowControls item={item()} />);
    expect(screen.getByText('#2 in the download queue')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move Show.S01E01 to the top of the queue' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/queue/4/move')).toBe(true));
    expect(api.calls.find((c) => c.path === '/api/v1/queue/4/move')?.body).toEqual({ move: 'top' });

    fireEvent.click(screen.getByRole('switch', { name: 'Force start' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/queue/4/forcestart')?.body).toEqual({ enabled: true }));

    const down = screen.getByLabelText('Download limit') as HTMLInputElement;
    expect(down.value).toBe('100');
    fireEvent.change(down, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Upload limit'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/queue/4/limits')?.body).toEqual({ downloadLimit: 0, uploadLimit: 51_200 }));
  });

  it('disables moving up at the top and hides queue moves once finished', () => {
    stubApi({});
    const { unmount } = wrap(<QueueRowControls item={item({ live: { downloadRate: 0, uploadRate: 0, queuePosition: 1, forceStart: false } })} />);
    expect((screen.getByRole('button', { name: 'Move Show.S01E01 up in the queue' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Move Show.S01E01 down in the queue' }) as HTMLButtonElement).disabled).toBe(false);
    unmount();
    wrap(<QueueRowControls item={item({ progress: 1, live: { downloadRate: 0, uploadRate: 0, forceStart: false, downloadLimit: 0 } })} />);
    expect(screen.getByText('Finished: no longer queued for download.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /to the top/ })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Force start' })).toBeNull();
  });
});

describe('slow mode', () => {
  it('describes the speed mode', () => {
    expect(speedModeText(speed())).toBe(`Normal limits · ↓ unlimited ↑ ${formatRate(512 * 1024)}`);
    expect(speedModeText(speed({ mode: 'alternative', reason: 'schedule', downloadLimit: 1024 * 1024 }))).toBe(
      `Slow mode (scheduled) · ↓ ${formatRate(1024 * 1024)} ↑ ${formatRate(512 * 1024)}`,
    );
    expect(speedModeText(speed({ mode: 'alternative', reason: 'manual' }))).toMatch(/^Slow mode \(manual\)/);
    expect(slowModeUntil('off')).toBeNull();
    expect(slowModeUntil('3h', Date.parse('2026-10-26T10:00:00.000Z'))).toBe('2026-10-26T13:00:00.000Z');
  });

  it('turns slow mode on for the chosen duration and off again', async () => {
    let current = speed();
    const api = stubApi({
      '/api/v1/torrent/status': () => status(current),
      'POST /api/v1/torrent/slowmode': (init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body)) as { enabled: boolean; until?: string | null };
        current = speed(body.enabled ? { mode: 'alternative', reason: 'manual', slowMode: true, slowModeUntil: body.until ?? null } : {});
        return current;
      },
    });
    wrap(<SlowModeControl />);
    const toggle = (await screen.findByRole('switch', { name: 'Slow mode' })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Slow mode duration'), { target: { value: '1h' } });
    fireEvent.click(toggle);
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    const sent = api.calls.find((c) => c.method === 'POST')?.body as { enabled: boolean; until: string };
    expect(sent.enabled).toBe(true);
    expect(Date.parse(sent.until) - Date.now()).toBeGreaterThan(59 * 60_000);
    await waitFor(() => expect((screen.getByRole('switch', { name: 'Slow mode' }) as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText(/^until /)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Slow mode' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ enabled: false }));
  });

  it('flags slow mode applied by the schedule', async () => {
    stubApi({ '/api/v1/torrent/status': status(speed({ mode: 'alternative', reason: 'schedule' })) });
    wrap(<SlowModeControl />);
    expect(await screen.findByText('Scheduled slow mode')).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Slow mode' }) as HTMLInputElement).checked).toBe(false);
  });
});
