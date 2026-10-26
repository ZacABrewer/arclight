import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { SystemHealthPage } from './health.js';
import { TailStatus } from './logs.js';
import { LEVEL_TONES } from './logs-model.js';
import { indexerChip } from './status.js';
import { jobStatusLabel } from './tasks.js';

let health: unknown;
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url === '/api/v1/health' ? new Response(JSON.stringify(health)) : new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderWith(node: React.ReactNode) {
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe('System → Health', () => {
  it('lists issues first with a tone chip, the cause and a fix link', async () => {
    health = {
      status: 'error',
      checks: [
        { source: 'RootFolderCheck', status: 'ok', message: 'Every root folder is reachable.' },
        { source: 'IndexerStatusCheck', status: 'warning', message: 'Nyaa is rate-limited. Retry at 20:55.' },
        { source: 'DownloadClientCheck', status: 'error', message: 'qBittorrent refused the connection.', wikiUrl: 'https://example.invalid/fix' },
      ],
    };
    renderWith(<SystemHealthPage />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['error', 'warning', 'ok']);
    expect(within(rows[0]!).getByText('Failed')).toBeTruthy();
    expect(within(rows[0]!).getByText('qBittorrent refused the connection.')).toBeTruthy();
    expect(within(rows[0]!).getByRole('link', { name: 'How to fix' }).getAttribute('href')).toBe('https://example.invalid/fix');
    expect(within(rows[1]!).getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('issues', { exact: false }).textContent).toBe('2 issues');
  });

  it('says so when every check passes', async () => {
    health = { status: 'ok', checks: [] };
    renderWith(<SystemHealthPage />);
    expect(await screen.findByText('No issues')).toBeTruthy();
  });
});

describe('System → Logs', () => {
  it('glows the tail dot only while live records stream in', () => {
    const { container, rerender } = render(<TailStatus tailing connected paused={false} fresh={3} />);
    expect(container.querySelector('.al-live')).not.toBeNull();
    expect(container.textContent).toBe('Tailing · 3 new');
    rerender(<TailStatus tailing connected paused fresh={0} />);
    expect(container.querySelector('.al-live')).toBeNull();
    expect(container.textContent).toBe('Paused');
    rerender(<TailStatus tailing={false} connected={false} paused={false} fresh={0} />);
    expect(container.querySelector('.al-live')).toBeNull();
    expect(container.textContent).toBe('Not tailing');
  });

  it('maps log levels to the chip vocabulary: info neutral, warn warn, error failed', () => {
    expect([LEVEL_TONES.info, LEVEL_TONES.warn, LEVEL_TONES.error, LEVEL_TONES.fatal]).toEqual(['neutral', 'warn', 'danger', 'danger']);
  });
});

describe('System → Tasks and Status helpers', () => {
  it('appends the cause after Failed', () => {
    expect(jobStatusLabel({ status: 'failed', message: 'TMDB timed out' })).toBe('Failed · TMDB timed out');
    expect(jobStatusLabel({ status: 'failed', message: null })).toBe('Failed · no reason given');
    expect(jobStatusLabel({ status: 'completed', message: 'ok' })).toBe('Completed');
  });

  it('shows indexer health as a chip with the reason', () => {
    const now = Date.parse('2026-10-25T12:00:00.000Z');
    expect(indexerChip({ status: { failureCount: 2, disabledTill: '2026-10-25T12:30:00.000Z' } }, now)).toEqual({ tone: 'warn', label: 'Paused · retry in 30m' });
    expect(indexerChip({ status: { failureCount: 1 } }, now)).toEqual({ tone: 'warn', label: '1 recent failure' });
    expect(indexerChip({}, now)).toEqual({ tone: 'accent', label: 'OK' });
  });
});
