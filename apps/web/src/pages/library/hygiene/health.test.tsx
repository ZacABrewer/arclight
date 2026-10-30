import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { HealthFinding, HealthListResponse } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { ItemHealthPanel } from '../item-health.js';
import { activeFilterCount, applyFilters, clock, explain, hasFile, itemLink, NO_FILTERS, summaryTiles } from './health-model.js';

afterEach(() => vi.unstubAllGlobals());

const CHECKED = '2026-10-30T03:00:00.000Z';

const finding = (over: Partial<HealthFinding> & { id: number }): HealthFinding => ({
  type: 'decodeErrors',
  severity: 'warning',
  status: 'open',
  source: 'media',
  fileId: 100 + over.id,
  mediaType: 'movie',
  path: `/data/movies/Heat (1995)/Heat.${over.id}.mkv`,
  title: 'Heat (1995)',
  seriesId: null,
  movieId: 7,
  artistId: null,
  albumId: null,
  authorId: null,
  bookId: null,
  episodeIds: [],
  details: 'English details',
  data: { mode: 'quick', errorCount: 3, errors: ['bad'] },
  firstSeen: CHECKED,
  lastChecked: CHECKED,
  fixedAt: null,
  ...over,
});

const RECORDS = [
  finding({ id: 1 }),
  finding({ id: 2, type: 'truncated', severity: 'warning', title: 'Severance S01E03', mediaType: 'series', movieId: null, seriesId: 1, data: { actualSeconds: 1200, expectedSeconds: 2700 } }),
  finding({ id: 3, type: 'trackGaps', severity: 'warning', source: null, fileId: null, mediaType: 'music', movieId: null, albumId: 4, artistId: 2, title: 'Band – Record', data: { missingNumbers: [3], disc: 1 } }),
  finding({ id: 4, type: 'missing', severity: 'error', data: {} }),
];

const response = (records: HealthFinding[] = RECORDS, over: Partial<HealthListResponse> = {}): HealthListResponse => ({
  lastScan: CHECKED,
  running: false,
  filesChecked: 40,
  filesTotal: 50,
  ffprobe: true,
  ffmpeg: true,
  counts: {
    open: records.length,
    ignored: 1,
    fixed: 2,
    byType: { missing: 1, empty: 0, unreadable: 0, unparseable: 0, decodeErrors: 1, truncated: 1, sample: 0, noAudio: 0, noVideo: 0, wrongLanguage: 0, trackNumberMissing: 0, trackGaps: 1, bookParts: 0 },
    bySeverity: { error: 1, warning: 3, info: 0 },
  },
  records,
  ...over,
});

const SETTINGS = { schedule: 'weekly', mode: 'quick', concurrency: 1, lowPriority: true, window: { enabled: false, start: '01:00', end: '06:00' }, truncatedPercent: 75, checkLanguages: true, notify: true };

const actionResult = (action: string, ids: number[]) => ({ action, succeeded: ids.length, failed: 0, results: ids.map((id) => ({ id, ok: true })), jobId: null });

function healthRoutes(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/library/hygiene': { lastScan: null, counts: { orphan: 0, duplicate: 0, empty: 0 }, records: [] },
    '/api/v1/library/health': response(),
    '/api/v1/settings/healthscan': SETTINGS,
    'POST /api/v1/library/health/action': (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as { action: string; ids: number[] };
      return actionResult(body.action, body.ids);
    },
    ...extra,
  });
}

describe('health model', () => {
  it('explains findings in plain language', () => {
    expect(explain(finding({ id: 1 }))).toBe('The quick check found 3 decode errors. Playback may stutter, freeze or stop.');
    expect(explain({ type: 'truncated', data: { actualSeconds: 1200, expectedSeconds: 2700 } })).toBe(
      "The file plays for 20:00, but the runtime should be about 45:00. It's probably cut short.",
    );
    expect(explain({ type: 'bookParts', data: { missingNumbers: [2], outOfOrder: true } })).toBe("The book's parts don't line up: part 2 missing; file names are out of part order.");
    expect(explain({ type: 'wrongLanguage', data: { have: ['ja'], wanted: ['en'] } })).toBe('The audio is Japanese, but the profile wants English.');
    expect(clock(3909)).toBe('1:05:09');
  });

  it('filters, summarises and links', () => {
    expect(applyFilters(RECORDS, { ...NO_FILTERS, mediaType: 'series' }).map((f) => f.id)).toEqual([2]);
    expect(applyFilters(RECORDS, { ...NO_FILTERS, severity: 'error' }).map((f) => f.id)).toEqual([4]);
    expect(activeFilterCount({ type: 'missing', severity: '', mediaType: 'movie' })).toBe(2);
    expect(summaryTiles({ missing: 1, truncated: 3, sample: 0 })).toEqual([
      { type: 'truncated', count: 3 },
      { type: 'missing', count: 1 },
    ]);
    expect(itemLink(RECORDS[2]!)).toEqual({ to: '/library/music/album/$id', params: { id: '4' } });
    expect(itemLink(RECORDS[0]!)).toEqual({ to: '/library/movie/$id', params: { id: '7' } });
    expect(hasFile(RECORDS[2]!)).toBe(false);
  });
});

describe('Hygiene → Health tab', () => {
  async function openHealth() {
    renderAt('/library/hygiene');
    fireEvent.click(await screen.findByRole('tab', { name: /Health/ }));
    return screen.findByRole('table', { name: 'Health findings' });
  }

  it('shows summary counts by type, the findings and the scan header action', async () => {
    healthRoutes();
    const table = await openHealth();
    expect(screen.getByRole('tab', { name: /Health/ }).textContent).toContain('4');
    const summary = screen.getByRole('region', { name: 'Health summary' });
    expect(within(summary).getByText('40 of 50 files checked', { exact: false })).toBeTruthy();
    expect(within(summary).getByRole('button', { name: /Decode errors/ })).toBeTruthy();
    expect(within(table).getByText('Severance S01E03')).toBeTruthy();
    expect(within(table).getByText('Track numbers on disc 1 skip 3.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run health scan' })).toBeTruthy();
    // Clicking a tile filters the table to that type.
    fireEvent.click(within(summary).getByRole('button', { name: /Truncated/ }));
    await waitFor(() => expect(within(table).queryByText('Band – Record')).toBeNull());
    expect(within(table).getByText('Severance S01E03')).toBeTruthy();
  });

  it('starts a whole-library scan', async () => {
    const api = healthRoutes({
      'POST /api/v1/library/health/scan': { id: 3, name: 'HealthScan', status: 'running', trigger: 'manual', queuedAt: CHECKED, startedAt: CHECKED, endedAt: null, durationMs: null, message: null },
    });
    await openHealth();
    fireEvent.click(screen.getByRole('button', { name: 'Run health scan' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/library/health/scan')?.body).toEqual({ all: true }));
  });

  it('ignores the selection in bulk', async () => {
    const api = healthRoutes();
    const table = await openHealth();
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Severance S01E03' }));
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Band – Record' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/library/health/action')?.body).toEqual({ action: 'ignore', ids: [2, 3] }));
  });

  it('replaces one file after a confirm that names it', async () => {
    const api = healthRoutes();
    const table = await openHealth();
    const row = within(table).getByText('/data/movies/Heat (1995)/Heat.4.mkv').closest('tr')!;
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Fix Heat (1995)' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Replace' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace 1 file?' });
    expect(within(dialog).getByText('/data/movies/Heat (1995)/Heat.4.mkv')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/library/health/action')?.body).toEqual({ action: 'replace', ids: [4] }));
  });

  it('album findings offer no replace or delete', async () => {
    healthRoutes();
    const table = await openHealth();
    fireEvent.click(within(table).getByRole('button', { name: 'Fix Band – Record' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Replace' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Re-check' })).toBeTruthy();
  });

  it('saves scan settings', async () => {
    const api = healthRoutes({ 'PUT /api/v1/settings/healthscan': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown });
    await openHealth();
    fireEvent.click(screen.getByRole('button', { name: /Scan settings/ }));
    fireEvent.change(await screen.findByLabelText('Decode check'), { target: { value: 'deep' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ mode: 'deep', schedule: 'weekly' }));
  });

  it('warns when ffmpeg is missing', async () => {
    healthRoutes({ '/api/v1/library/health': response(RECORDS, { ffmpeg: false }) });
    await openHealth();
    expect(await screen.findByText('ffmpeg was not found: decode errors are not checked.')).toBeTruthy();
  });
});

describe('item Health tab', () => {
  function renderPanel() {
    const toasts = createToastStore();
    render(
      <QueryClientProvider client={createQueryClient(toasts)}>
        <ToastProvider store={toasts}>
          <ItemHealthPanel scope={{ movieId: 7 }} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it("lists the item's findings and checks it now", async () => {
    const api = healthRoutes({
      '/api/v1/library/health': response([RECORDS[0]!]),
      'POST /api/v1/library/health/scan': { id: 4, name: 'HealthCheck', status: 'running', trigger: 'manual', queuedAt: CHECKED, startedAt: CHECKED, endedAt: null, durationMs: null, message: null },
    });
    renderPanel();
    const table = await screen.findByRole('table', { name: 'Health findings' });
    expect(within(table).getByText('Decode errors')).toBeTruthy();
    const listCall = api.calls.find((c) => c.path === '/api/v1/library/health');
    expect(listCall).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/library/health/scan')?.body).toEqual({ movieIds: [7] }));
  });

  it('shows ignored and fixed findings on request', async () => {
    const urls: string[] = [];
    healthRoutes({
      '/api/v1/library/health': (_init: RequestInit | undefined, url: URL) => {
        urls.push(url.search);
        return response([]);
      },
    });
    renderPanel();
    expect(await screen.findByText('No problems found')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Show ignored and fixed' }));
    await waitFor(() => expect(urls.some((u) => u.includes('status=all') && u.includes('movieId=7'))).toBe(true));
  });
});
