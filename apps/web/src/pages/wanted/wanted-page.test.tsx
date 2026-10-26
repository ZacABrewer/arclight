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
};
const paged = (records: unknown[]) => ({ page: 1, pageSize: 50, totalRecords: records.length, records });

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
      const routes: Record<string, unknown> = {
        '/api/v1/wanted/missing/episodes': paged([wantedEp(1, 'Severance', 8), wantedEp(2, 'Andor', 3)]),
        '/api/v1/wanted/missing/movies': paged([makeMovie({ id: 9, title: 'Arrival', digitalRelease: '2017-02-14' })]),
        '/api/v1/wanted/cutoff/episodes': paged([wantedEp(3, 'Silo', 10), wantedEp(4, 'Foundation', 2)]),
        '/api/v1/wanted/cutoff/movies': paged([makeMovie({ id: 12, title: 'Heat', digitalRelease: '1999-06-01' })]),
        '/api/v1/qualityprofile': [{ id: 1, name: 'HD-1080p' }],
        '/api/v1/profilemigration/mismatch': paged([mismatch]),
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
    expect(within(table).getAllByText('Missing')).toHaveLength(2);
    expect(within(table).getByText('S02E08').className).toContain('al-td--mono');
    expect(screen.getByText('2 episodes')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Missing' }).getAttribute('aria-selected')).toBe('true');
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
    expect(within(table).getByText('Waiting')).toBeTruthy();
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
