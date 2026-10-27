import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';
import { makeEpisode, makeMovie } from '../library/test-fixtures.js';
import { shortDate } from './wanted-page.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const wantedEp = (id: number, seriesTitle: string, episodeNumber: number) => ({
  ...makeEpisode({ id, seriesId: id + 10, seasonNumber: 2, episodeNumber, airDate: '2025-03-07' }),
  seriesTitle,
  seriesTmdbId: 100 + id,
  qualityProfileId: 1,
});
const mismatch = {
  mediaFileId: 77,
  mediaType: 'series',
  seriesId: 5,
  movieId: null,
  episodeIds: [51],
  title: 'Severance',
  year: 2022,
  episodeLabel: 'S01E03',
  versionTag: null,
  qualityProfileId: 1,
  qualityProfileName: 'HD-1080p',
  quality: 'Bluray-2160p',
  formatScore: 0,
  status: 'notAllowed',
  reasons: ['qualityNotAllowed'],
  migration: { state: 'queued', attempts: 1, lastSearchedAt: null, message: null },
  replacement: { state: 'manualOnly', nextSearchAt: null, maxAttempts: 3 },
};
const paged = (records: unknown[]) => ({ page: 1, pageSize: 50, totalRecords: records.length, records });
const HOUR = 3_600_000;
/** Episode 1 / movie 9 were searched 3 h ago and come back in 5 h; the rest were never searched. */
const searchStatus = (mediaType: string, id: number) => ({
  mediaType,
  id,
  monitored: true,
  lastSearch:
    id === 1 || id === 9
      ? { time: new Date(Date.now() - 3 * HOUR).toISOString(), source: 'automatic', outcome: 'rejected', releases: 4, approved: 0, detail: 'Quality not wanted' }
      : null,
  automatic: {
    state: 'scheduled',
    job: mediaType === 'movie' ? 'MissingMovieSearch' : 'MissingEpisodeSearch',
    nextSearchAt: new Date(Date.now() + 5 * HOUR + 60_000).toISOString(),
    searchCount: 1,
    runsAhead: 0,
  },
});

let calls: Array<{ url: string; method: string; body?: unknown }> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = url.split('?')[0] ?? '';
      if (method === 'POST' && path === '/api/v1/command/search') {
        return new Response(JSON.stringify({ releases: 3, approved: 1, pending: 0, grabbed: [] }), { status: 200 });
      }
      if (path === '/api/v1/release/searchstatus') {
        const params = new URL(url, 'http://localhost').searchParams;
        const ids = (params.get('ids') ?? '').split(',').map(Number);
        return new Response(JSON.stringify(ids.map((id) => searchStatus(params.get('mediaType') ?? 'episode', id))), { status: 200 });
      }
      const routes: Record<string, unknown> = {
        '/api/v1/wanted/missing/episodes': paged([wantedEp(1, 'Severance', 8), wantedEp(2, 'Andor', 3)]),
        '/api/v1/wanted/missing/movies': paged([makeMovie({ id: 9, title: 'Arrival', digitalRelease: '2017-02-14' })]),
        '/api/v1/wanted/cutoff/episodes': paged([wantedEp(3, 'Silo', 10), wantedEp(4, 'Foundation', 2)]),
        '/api/v1/wanted/cutoff/movies': paged([makeMovie({ id: 12, title: 'Heat', digitalRelease: '1999-06-01' })]),
        '/api/v1/qualityprofile': [{ id: 1, name: 'HD-1080p' }],
        '/api/v1/profilemigration/mismatch': paged([mismatch]),
        // Andor S02E03 (episode 2) is downloading.
        '/api/v1/queue/summary': [{ id: 4, mediaType: 'series', seriesId: 12, episodeIds: [2], trackedState: 'downloading', trackedStatus: 'ok', status: 'downloading', progress: 0.42 }],
        '/api/v1/health': { status: 'ok', checks: [] },
        '/api/v1/system/status': {},
      };
      const body = routes[path];
      return body === undefined
        ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const queryClient = createQueryClient(createToastStore());
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={createToastStore()}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

const searchPosts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/command/search').map((c) => c.body);

describe('wanted page', () => {
  it('lists missing episodes in a rich table with Missing chips and mono codes', async () => {
    renderAt('/wanted/missing');
    const table = await screen.findByRole('table');
    expect(await within(table).findByRole('link', { name: 'Severance' })).toBeTruthy();
    // Andor S02E03 is in the download queue: its chip says so instead of Missing.
    expect(await within(table).findByText('Downloading 42%')).toBeTruthy();
    expect(within(table).getAllByText('Missing')).toHaveLength(1);
    expect(within(table).getByText('S02E08').className).toContain('al-td--mono');
    expect(screen.getByText('2 episodes')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Missing' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows per row the last search, the next automatic search and the queue state', async () => {
    renderAt('/wanted/missing');
    const table = await screen.findByRole('table');
    const severance = (await within(table).findByRole('link', { name: 'Severance' })).closest('tr')!;
    await waitFor(() => expect(within(severance).getByText('Last searched 3h ago · all results rejected: Quality not wanted')).toBeTruthy());
    expect(within(severance).getByText('Next automatic search ~in 5h')).toBeTruthy();
    const andor = within(table).getByRole('link', { name: 'Andor' }).closest('tr')!;
    expect(within(andor).getByText('Not searched yet')).toBeTruthy();
    expect(await within(andor).findByText('Downloading 42%')).toBeTruthy();
    // One status request for the page, not one per row.
    expect(calls.filter((c) => c.url.startsWith('/api/v1/release/searchstatus?'))).toHaveLength(1);
    expect(calls.find((c) => c.url.startsWith('/api/v1/release/searchstatus?'))?.url).toContain('ids=1%2C2');
  });

  it('selecting rows shows the bulk bar; Search selected posts the episode ids', async () => {
    renderAt('/wanted/missing');
    fireEvent.click(await screen.findByLabelText('Select Severance S02E08'));
    fireEvent.click(screen.getByLabelText('Select Andor S02E03'));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Search selected' }));
    await waitFor(() => expect(searchPosts()).toEqual([{ episodeIds: [1, 2] }]));
  });

  it('Search all collects every id with one large page', async () => {
    renderAt('/wanted/missing');
    await screen.findByLabelText('Select Severance S02E08');
    fireEvent.click(screen.getByRole('button', { name: 'Search all' }));
    await waitFor(() => expect(searchPosts()).toEqual([{ episodeIds: [1, 2] }]));
    expect(calls.some((c) => c.url.startsWith('/api/v1/wanted/missing/episodes?') && c.url.includes('pageSize=500'))).toBe(true);
  });

  it('row Search searches one episode', async () => {
    renderAt('/wanted/missing');
    fireEvent.click(await screen.findByRole('button', { name: 'Search Andor S02E03' }));
    await waitFor(() => expect(searchPosts()).toEqual([{ episodeIds: [2] }]));
  });

  it('switches to movies and to the cutoff tab', async () => {
    const router = renderAt('/wanted/missing');
    await screen.findByLabelText('Select Severance S02E08');
    fireEvent.click(screen.getByRole('button', { name: 'Movies' }));
    expect(await screen.findByRole('link', { name: 'Arrival' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Episodes' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Cutoff unmet' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/wanted/cutoff'));
    const silo = await screen.findByRole('link', { name: 'Silo' });
    expect(within(silo.closest('table')!).getAllByText('Cutoff unmet').length).toBeGreaterThan(0);
  });

  it('cutoff unmet lists episodes from /wanted/cutoff/episodes; Search selected posts their ids', async () => {
    renderAt('/wanted/cutoff');
    const table = await screen.findByRole('table');
    expect(await within(table).findByRole('link', { name: 'Silo' })).toBeTruthy();
    expect(within(table).getAllByText('Cutoff unmet')).toHaveLength(2);
    expect(screen.getByText('2 episodes')).toBeTruthy();
    expect(screen.queryByText(/not available yet/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Select Silo S02E10'));
    fireEvent.click(screen.getByLabelText('Select Foundation S02E02'));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByRole('button', { name: 'Search selected' }));
    await waitFor(() => expect(searchPosts()).toEqual([{ episodeIds: [3, 4] }]));
    expect(calls.some((c) => c.url.startsWith('/api/v1/wanted/cutoff/episodes?'))).toBe(true);
  });

  it('cutoff unmet movies: row Search searches one movie', async () => {
    renderAt('/wanted/cutoff');
    await screen.findByLabelText('Select Silo S02E10');
    fireEvent.click(screen.getByRole('button', { name: 'Movies' }));
    const heat = await screen.findByRole('link', { name: 'Heat' });
    expect(within(heat.closest('table')!).getByText('Cutoff unmet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search Heat' }));
    await waitFor(() => expect(searchPosts()).toEqual([{ movieId: 12 }]));
  });

  it('lists profile mismatches with status and replacement state, and searches a row', async () => {
    renderAt('/wanted/mismatch');
    const link = await screen.findByRole('link', { name: 'Severance' });
    const table = link.closest('table')!;
    expect(within(table).getByText('Not allowed by profile')).toBeTruthy();
    expect(within(table).getByText('Not automatic: replacement is manual for this profile')).toBeTruthy();
    expect(within(table).getByText('Waiting · search 1 of 3')).toBeTruthy();
    expect(within(table).getByText('Bluray-2160p')).toBeTruthy();
    const req = calls.find((c) => c.url.startsWith('/api/v1/profilemigration/mismatch?'));
    expect(req?.url).toContain('mediaType=series');
    expect(req?.url).toContain('status=notAllowed');
    fireEvent.click(screen.getByRole('button', { name: 'Search Severance S01E03' }));
    await waitFor(() => expect(searchPosts()).toEqual([{ episodeIds: [51] }]));
  });

  it('formats dates short', () => {
    expect(shortDate('2025-03-07')).toMatch(/2025/);
    expect(shortDate(null)).toBe('—');
  });
});
