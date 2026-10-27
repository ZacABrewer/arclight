import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Permission, type DebugRunResponse, type DebugSnapshot, type LogPage } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { copyText } from '../../lib/clipboard.js';
import { createToastStore } from '../../lib/toast.js';
import { visibleNav } from '../../nav.js';
import { createQueryClient } from '../../query-client.js';
import { SystemDebuggingPage } from './debugging.js';
import { appendCommand, logLine, memoryShare, pushHistory, resultsText, snapshotText } from './debugging-model.js';

vi.mock('../../lib/clipboard.js', () => ({ copyText: vi.fn(async () => true), downloadText: vi.fn() }));

const MiB = 1024 * 1024;

const snapshot: DebugSnapshot = {
  time: '2026-10-26T10:00:00.000Z',
  version: '1.2.3',
  uptimeSeconds: 3600,
  node: 'v24.5.0',
  platform: 'linux',
  arch: 'x64',
  pid: 1,
  isDocker: true,
  memory: { rss: 600 * MiB, heapTotal: 200 * MiB, heapUsed: 150 * MiB, external: 50 * MiB, arrayBuffers: 40 * MiB },
  cgroup: { version: 2, limit: 1024 * MiB, usage: 800 * MiB, anon: 650 * MiB, file: 150 * MiB },
  eventLoopLagP99Ms: 21.5,
  handles: { available: true, total: 12, queuedBytes: 4096, byType: [{ type: 'Socket', count: 9, queuedBytes: 4096, maxQueuedBytes: 4096 }] },
  engine: { enabled: true, state: 'running', listenPort: 51413, boundAddress: null, torrents: 4, downloading: 1, seeding: 3, peers: 17, downloadRate: 0, uploadRate: 0 },
  vpn: { enabled: true, provider: 'gluetun', connected: true, publicIp: '203.0.113.9', forwardedPort: 51413, killSwitchEngaged: false, lastChecked: null },
};

const logPage: LogPage = {
  page: 1,
  pageSize: 200,
  totalRecords: 2,
  records: [
    { id: 2, time: '2026-10-26T10:00:02.000Z', level: 'warn', message: 'tracker timed out', component: 'torrent' },
    { id: 1, time: '2026-10-26T10:00:01.000Z', level: 'info', message: 'login with apikey=abc123', component: 'auth' },
  ],
};

let runs: string[];
beforeEach(() => {
  runs = [];
  vi.mocked(copyText).mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      if (url.startsWith('/api/v1/system/debug/snapshot')) return json(snapshot);
      if (url.startsWith('/api/v1/system/debug/run')) {
        const input = (JSON.parse(String(init?.body)) as { input: string }).input;
        runs.push(input);
        const lines = input.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
        const res: DebugRunResponse = {
          results: lines.map((command) => ({ command, ok: command !== 'nope', output: `output of ${command}`, durationMs: 3 })),
          truncated: false,
        };
        return json(res);
      }
      if (url.startsWith('/api/v1/log')) return json(logPage);
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <SystemDebuggingPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return toasts;
}

describe('System → Debugging', () => {
  it('shows the live snapshot with memory against the container limit', async () => {
    renderPage();
    expect(await screen.findByText('800 MB of 1.0 GB')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Container memory' }).getAttribute('aria-valuenow')).toBe('78');
    expect(screen.getByText('21.5 ms')).toBeTruthy();
    expect(screen.getByText(/running · port 51413 · 4 torrents/)).toBeTruthy();
    expect(screen.getByText(/gluetun · connected · 203\.0\.113\.9/)).toBeTruthy();
  });

  it('runs a pasted two-line input as two result blocks, and Copy uses the clipboard helper', async () => {
    const toasts = renderPage();
    const input = screen.getByRole('textbox', { name: 'Commands' });
    fireEvent.change(input, { target: { value: 'version\n# comment\nnope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const blocks = await screen.findAllByTestId('debug-result');
    expect(blocks).toHaveLength(2);
    expect(runs).toEqual(['version\n# comment\nnope']);
    expect(within(blocks[0]!).getByText('output of version')).toBeTruthy();
    expect(within(blocks[0]!).getByText('OK')).toBeTruthy();
    expect(within(blocks[1]!).getByText('Failed')).toBeTruthy();

    fireEvent.click(within(blocks[0]!).getByRole('button', { name: 'Copy output of version' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('> version  [ok, 3 ms]\noutput of version'));
    await waitFor(() => expect(toasts.list().some((x) => x.title === 'Copied version')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith(expect.stringContaining('> nope  [error, 3 ms]')));
  });

  it('runs with Ctrl+Enter, inserts commands from the chips and recalls history with ArrowUp', async () => {
    renderPage();
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Commands' });
    fireEvent.click(screen.getByRole('button', { name: 'memory' }));
    fireEvent.click(screen.getByRole('button', { name: 'handles' }));
    expect(input.value).toBe('memory\nhandles');
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(await screen.findAllByTestId('debug-result')).toHaveLength(2);
    fireEvent.change(input, { target: { value: '' } });
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('memory\nhandles');
  });

  it('Copy debug report runs `report` and copies its output', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Copy debug report' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('output of report'));
    expect(runs).toEqual(['report']);
  });

  it('shows recent logs redacted, oldest first, and copies the visible lines', async () => {
    renderPage();
    const pre = await screen.findByTestId('debug-logs');
    expect(pre.textContent).toBe(
      '2026-10-26T10:00:01.000Z INFO  [auth] login with apikey=********\n2026-10-26T10:00:02.000Z WARN  [torrent] tracker timed out',
    );
    const pane = pre.closest('section, .al-pane') as HTMLElement;
    fireEvent.click(within(pane).getAllByRole('button', { name: 'Copy' })[0]!);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(pre.textContent));
  });

  it('is in the System nav for admins only', () => {
    const system = visibleNav(true).find((s) => s.label === 'System');
    expect(system?.children?.some((c) => c.to === '/system/debugging' && c.label === 'Debugging')).toBe(true);
    expect(visibleNav(false).some((s) => s.children?.some((c) => c.to === '/system/debugging'))).toBe(false);
    const manager = visibleNav({ admin: false, areas: ['activity', 'library'], permissions: Permission.MANAGE_REQUESTS });
    expect(JSON.stringify(manager.map((s) => [s.to, s.children?.map((c) => c.to)]))).not.toContain('/system/debugging');
  });
});

describe('debugging model', () => {
  it('formats the snapshot as plain text without the public IP', () => {
    const text = snapshotText(snapshot);
    expect(text).toContain('rss             600.0 MiB');
    expect(text).toContain('cgroup v2: 800.0 MiB of 1024.0 MiB, anon 650.0 MiB, file 150.0 MiB');
    expect(text).toContain('gluetun · connected · forwarded port 51413');
    expect(text).not.toContain('203.0.113.9');
    expect(memoryShare(snapshot)).toBeCloseTo(78.1, 1);
    expect(memoryShare({ ...snapshot, cgroup: { ...snapshot.cgroup, limit: null } })).toBeNull();
  });

  it('keeps a short de-duplicated history and appends commands on new lines', () => {
    expect(pushHistory(['b', 'a'], 'a')).toEqual(['a', 'b']);
    expect(pushHistory([], '   ')).toEqual([]);
    expect(pushHistory(Array.from({ length: 40 }, (_v, i) => String(i)), 'x')).toHaveLength(30);
    expect(appendCommand('', 'help')).toBe('help');
    expect(appendCommand('memory', 'gc')).toBe('memory\ngc');
    expect(appendCommand('memory\n', 'gc')).toBe('memory\ngc');
  });

  it('formats results and log lines', () => {
    expect(resultsText([{ command: 'a', ok: true, output: '1', durationMs: 1.4 }, { command: 'b', ok: false, output: '2', durationMs: 0 }])).toBe(
      '> a  [ok, 1 ms]\n1\n\n> b  [error, 0 ms]\n2',
    );
    expect(logLine({ id: 1, time: 't', level: 'error', message: 'x\ny', context: { password: 'p' } })).toBe('t ERROR x\\ny {"password":"********"}');
  });
});
