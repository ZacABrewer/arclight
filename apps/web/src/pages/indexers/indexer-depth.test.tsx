import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { IndexerDefinitionSummary, IndexerStats, ReleaseResource } from '@media-tron/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';
import { downloadLink, isNoMatch } from '../search-model.js';
import { ApiError } from '../../api/client.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const yts: IndexerDefinitionSummary = {
  id: 'yts',
  name: 'YTS',
  description: 'Movie torrents',
  language: 'en-US',
  type: 'public',
  privacy: 'public',
  protocol: 'torrent',
  links: ['https://yts.example/'],
  settingsFields: [
    { name: 'sort', type: 'select', label: 'Sort results by', default: 'added', options: [{ value: 'added', label: 'Added' }, { value: 'seeds', label: 'Seeds' }], informational: false },
    { name: 'freeleech', type: 'checkbox', label: 'Only freeleech', default: false, informational: false },
    { name: 'info', type: 'info', label: 'Heads up', default: 'Uses FlareSolverr', informational: true },
  ],
  categories: [{ id: 2000, name: 'Movies' }],
  tested: true,
  source: 'builtin',
};
const tracker: IndexerDefinitionSummary = {
  ...yts,
  id: 'privtracker',
  name: 'PrivTracker',
  description: 'Members only',
  type: 'private',
  privacy: 'private',
  tested: false,
  settingsFields: [{ name: 'cookie', type: 'password', label: 'Cookie', informational: false }],
};

const stats: IndexerStats = {
  days: 30,
  since: '2026-09-25T00:00:00.000Z',
  indexers: [
    {
      indexerId: 1,
      indexerName: 'YTS',
      queries: 40,
      grabs: 8,
      failures: 2,
      avgResponseMs: 320,
      byDay: [
        { date: '2026-10-24', queries: 20, grabs: 4, failures: 1 },
        { date: '2026-10-25', queries: 20, grabs: 4, failures: 1 },
      ],
    },
  ],
  totals: {
    queries: 40,
    grabs: 8,
    failures: 2,
    avgResponseMs: 320,
    byDay: [
      { date: '2026-10-24', queries: 20, grabs: 4, failures: 1 },
      { date: '2026-10-25', queries: 20, grabs: 4, failures: 1 },
    ],
  },
};

const release: ReleaseResource = {
  guid: 'g1',
  title: 'Some.Movie.2024.1080p',
  size: 1_000_000,
  publishDate: '2026-10-20T00:00:00Z',
  downloadUrl: 'https://yts.example/dl/1.torrent',
  categories: [2000],
  indexerId: 1,
  indexerName: 'YTS',
  indexerPriority: 25,
  protocol: 'torrent',
  seeders: 10,
  leechers: 1,
  age: 5,
  ageHours: 120,
  ageMinutes: 7200,
  rejections: [],
  approved: false,
};

const options = {
  minimumAgeMinutes: 0,
  retentionDays: 0,
  maximumSizeMb: 0,
  rssSyncIntervalMinutes: 15,
  allowHardcodedSubs: false,
  whitelistedHardcodedSubs: ['ENG'],
  preferIndexerFlags: false,
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let handler: (url: string, method: string, body: unknown) => Response | undefined = () => undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const responses: Record<string, unknown> = {
  '/api/v1/indexer': [],
  '/api/v1/indexer/schema': [],
  '/api/v1/indexer/categories': [],
  '/api/v1/indexer/definition': [yts, tracker],
  '/api/v1/indexerproxy': [{ id: 7, name: 'Flare', type: 'flaresolverr', host: 'http://flare', port: 8191, tags: [] }],
  '/api/v1/indexer/stats?days=30': stats,
  '/api/v1/settings/indexers': options,
  '/api/v1/tag': [],
};

beforeEach(() => {
  calls = [];
  handler = () => undefined;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      const custom = handler(url, method, body);
      if (custom) return custom;
      if (method === 'PUT' && url === '/api/v1/settings/indexers') return json(body);
      const found = responses[url];
      return found === undefined ? json({ error: 'not found' }, 404) : json(found);
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
  return router;
}

describe('indexer catalogue', () => {
  it('lists definitions with badges, filters them and opens the editor from settingsFields', async () => {
    renderAt('/settings/indexers');
    fireEvent.click(await screen.findByRole('button', { name: /Add indexer/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add indexer' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Catalogue' }));
    const list = await within(dialog).findByRole('list', { name: 'Definitions' });
    expect(within(list).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Add PrivTracker', 'Add YTS']);
    expect(within(list).getByText('untested')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Privacy'), { target: { value: 'public' } });
    expect(within(list).getAllByRole('button')).toHaveLength(1);

    fireEvent.click(within(list).getByRole('button', { name: 'Add YTS' }));
    const editor = await screen.findByRole('dialog', { name: 'Add YTS' });
    expect(within(editor).getByLabelText('Sort results by')).toBeTruthy();
    expect(within(editor).getByText('Heads up')).toBeTruthy();
    expect(within(editor).getByLabelText('Proxy')).toBeTruthy();
  });

  it('creates a definition indexer with typed field values', async () => {
    handler = (url, method, body) => (url === '/api/v1/indexer' && method === 'POST' ? json({ id: 9, protocol: 'torrent', status: undefined, ...(body as object) }, 201) : undefined);
    renderAt('/settings/indexers');
    fireEvent.click(await screen.findByRole('button', { name: /Add indexer/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add indexer' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Catalogue' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add YTS' }));
    const editor = await screen.findByRole('dialog', { name: 'Add YTS' });
    fireEvent.change(within(editor).getByLabelText('Sort results by'), { target: { value: 'seeds' } });
    await within(editor).findByRole('option', { name: 'Flare (flaresolverr)' });
    fireEvent.change(within(editor).getByLabelText('Proxy'), { target: { value: '7' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/indexer')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/v1/indexer')!;
    expect(post.body).toMatchObject({ implementation: 'definition', proxyId: 7, settings: { definitionId: 'yts', fields: { sort: 'seeds', freeleech: false } } });
  });
});

describe('indexer proxies page', () => {
  it('lists proxies and tests an unsaved one', async () => {
    handler = (url, method) => (url === '/api/v1/indexerproxy/test' && method === 'POST' ? json({ ok: true, message: 'FlareSolverr is ready', durationMs: 12 }) : undefined);
    renderAt('/settings/indexerproxies');
    expect(await screen.findByRole('heading', { level: 1, name: 'Indexer Proxies' })).toBeTruthy();
    expect(await screen.findByText('http://flare:8191')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add proxy/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add indexer proxy' });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Solver' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText(/FlareSolverr is ready/)).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/indexerproxy/test')?.body).toMatchObject({ name: 'Solver', type: 'flaresolverr', port: 8191 });
  });
});

describe('indexer stats page', () => {
  it('renders totals, SVG charts and the per-indexer table', async () => {
    renderAt('/indexers/stats');
    expect(await screen.findByRole('heading', { level: 1, name: 'Indexer Stats' })).toBeTruthy();
    expect(await screen.findByRole('img', { name: 'Queries per indexer' })).toBeTruthy();
    const line = screen.getByRole('img', { name: 'Daily activity' });
    expect(line.querySelectorAll('path')).toHaveLength(3);
    const table = screen.getByRole('table');
    expect(within(table).getByText('320 ms')).toBeTruthy();
    expect(within(table).getByText('4.2%')).toBeTruthy();
  });
});

describe('indexer options page', () => {
  it('loads the options and saves the parsed subtitle tags', async () => {
    renderAt('/settings/indexeroptions');
    const interval = (await screen.findByLabelText('RSS sync interval')) as HTMLInputElement;
    expect(interval.value).toBe('15');
    fireEvent.change(interval, { target: { value: '5' } });
    expect(screen.getByText(/0 \(off\) or 10 to 1440/)).toBeTruthy();
    fireEvent.change(interval, { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Whitelisted subtitle tags'), { target: { value: 'ENG, HC.ENG' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ rssSyncIntervalMinutes: 30, whitelistedHardcodedSubs: ['ENG', 'HC.ENG'] });
  });
});

describe('search page grabs', () => {
  it('links downloads through the indexer and asks before force-grabbing an unmatched result', async () => {
    responses['/api/v1/search?query=Some+Movie&type=search'] = [release];
    handler = (url, method, body) => {
      if (url !== '/api/v1/search/grab' || method !== 'POST') return undefined;
      return (body as { force?: boolean }).force
        ? json({ title: release.title, queueItemId: 4, downloadId: 'abc', downloadClientId: 1, matched: false, rejections: ['Unknown movie'] })
        : json({ error: 'Not matched to a library item', code: 'NO_MATCH' }, 409);
    };
    renderAt('/search?q=Some%20Movie');
    const link = await screen.findByRole('link', { name: `Download ${release.title}` });
    expect(link.getAttribute('href')).toBe(`/api/v1/indexer/1/download?url=${encodeURIComponent(release.downloadUrl)}`);

    fireEvent.click(screen.getByRole('button', { name: `Grab ${release.title}` }));
    const confirm = await screen.findByRole('dialog', { name: 'Force grab?' });
    expect(within(confirm).getByText(/does not match anything in your library/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Force grab' }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/v1/search/grab')).toHaveLength(2));
    expect(calls.filter((c) => c.url === '/api/v1/search/grab').map((c) => (c.body as { force?: boolean }).force)).toEqual([undefined, true]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Force grab?' })).toBeNull());
  });

  it('builds download links and recognises NO_MATCH answers', () => {
    expect(downloadLink({ indexerId: 2, downloadUrl: 'https://x/y?a=1', magnetUrl: undefined })).toBe('/api/v1/indexer/2/download?url=https%3A%2F%2Fx%2Fy%3Fa%3D1');
    expect(downloadLink({ indexerId: 2, downloadUrl: 'magnet:?xt=urn:btih:1' })).toBe('magnet:?xt=urn:btih:1');
    expect(isNoMatch(new ApiError(409, 'no', '/search/grab', 'NO_MATCH'))).toBe(true);
    expect(isNoMatch(new ApiError(409, 'no', '/search/grab', 'CONFLICT'))).toBe(false);
  });
});
