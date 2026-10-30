import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';
import { makeMovie, makeSeries } from '../library/test-fixtures.js';
import { blocklistBody } from './blocklist-page.js';

configure({ asyncUtilTimeout: 4000 });

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const record = (id: number, sourceTitle: string) => ({
  id,
  mediaType: 'series',
  seriesId: 1,
  episodeIds: [],
  movieId: null,
  sourceTitle,
  quality: { quality: { id: 0, name: 'Unknown' } },
  date: '2026-10-25T10:00:00.000Z',
  protocol: 'torrent',
  indexer: 'Nyaa',
  message: 'Manual',
});

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = url.split('?')[0] ?? '';
      if (method === 'POST' && path === '/api/v1/blocklist') {
        return new Response(JSON.stringify(record(9, (calls.at(-1)!.body as { sourceTitle: string }).sourceTitle)), { status: 201 });
      }
      if (method === 'POST' && path === '/api/v1/blocklist/clear') return new Response(JSON.stringify({ deleted: 2 }), { status: 200 });
      const routes: Record<string, unknown> = {
        '/api/v1/blocklist': { page: 1, pageSize: 25, totalRecords: 2, records: [record(1, 'Bad.Release.S01E01'), record(2, 'Bad.Release.S01E02')] },
        '/api/v1/series': [makeSeries({ id: 1, title: 'Severance', year: 2022 }), makeSeries({ id: 2, title: 'Andor', year: 2022 })],
        '/api/v1/movie': [makeMovie({ id: 7, title: 'Heat', year: 1995 })],
      };
      const body = method === 'GET' ? routes[path] : undefined;
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
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.url === path).map((c) => c.body);

describe('blocklist page', () => {
  it('Add opens a modal and posts the release to /blocklist', async () => {
    renderAt('/activity/blocklist');
    await screen.findByText('Bad.Release.S01E01');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to blocklist' });

    // Missing fields are named before anything is sent.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to blocklist' }));
    expect(await within(dialog).findByText('Choose a series.')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Series to block' }));
    fireEvent.mouseDown(await within(dialog).findByRole('option', { name: /Andor/ }));
    fireEvent.change(within(dialog).getByLabelText('Source title'), { target: { value: 'Andor.S01E01.1080p.WEB-DL-GRP' } });
    fireEvent.change(within(dialog).getByLabelText('Indexer'), { target: { value: 'Nyaa' } });
    fireEvent.change(within(dialog).getByLabelText('Protocol'), { target: { value: 'usenet' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to blocklist' }));

    await waitFor(() => expect(posts('/api/v1/blocklist')).toHaveLength(1));
    expect(posts('/api/v1/blocklist')[0]).toMatchObject({
      mediaType: 'series',
      seriesId: 2,
      sourceTitle: 'Andor.S01E01.1080p.WEB-DL-GRP',
      indexer: 'Nyaa',
      protocol: 'usenet',
      quality: { quality: { id: 0, name: 'Unknown' }, revision: { version: 1, real: 0, isRepack: false } },
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add to blocklist' })).toBeNull());
    expect(await screen.findByText('Added to blocklist')).toBeTruthy();
  });

  it('Clear all confirms, then posts /blocklist/clear', async () => {
    renderAt('/activity/blocklist');
    await screen.findByText('Bad.Release.S01E01');
    const clear = screen.getByRole('button', { name: 'Clear all' });
    expect(clear.className).toContain('al-btn--danger');
    fireEvent.click(clear);
    const dialog = await screen.findByRole('dialog', { name: 'Clear the blocklist?' });
    expect(posts('/api/v1/blocklist/clear')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(posts('/api/v1/blocklist/clear')).toHaveLength(1));
    expect(await screen.findByText('Blocklist cleared')).toBeTruthy();
  });

  it('sends q to GET /blocklist, resets to page 1 and clears the selection on a new search', async () => {
    renderAt('/activity/blocklist?q=bad');
    const table = await screen.findByRole('table', { name: 'Blocklist' });
    await within(table).findByText('Bad.Release.S01E01');
    const lists = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/v1/blocklist')).map((c) => new URL(c.url, 'http://x').searchParams);
    expect(lists().some((p) => p.get('q') === 'bad' && p.get('pageSize') === '25')).toBe(true);
    expect(document.querySelector('.al-listsearch__count')?.textContent).toBe('2 results');

    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Bad.Release.S01E01' }));
    expect(await screen.findByText(/1 selected/)).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this list' }), { target: { value: 'bad s01e02' } });
    await waitFor(() => expect(lists().at(-1)!.get('q')).toBe('bad s01e02'));
    expect(lists().at(-1)!.get('page')).toBe('1');
    await waitFor(() => expect(screen.queryByText(/1 selected/)).toBeNull());
  });

  it('builds a movie body with a movieId and the default reason', () => {
    const body = blocklistBody({ kind: 'movie', mediaId: 7, sourceTitle: ' Heat.1995.mkv ', indexer: '', protocol: 'torrent', qualityId: 0, message: '' });
    expect(body).toMatchObject({ mediaType: 'movie', movieId: 7, sourceTitle: 'Heat.1995.mkv', indexer: null, message: 'Added manually' });
    expect(blocklistBody({ kind: 'movie', mediaId: 7, sourceTitle: '  ', indexer: '', protocol: 'torrent', qualityId: 0, message: '' })).toBe('Enter the source title.');
  });
});
