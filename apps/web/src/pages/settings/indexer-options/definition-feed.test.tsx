import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import type { DefinitionFeedStatus, IndexerDefinitionSummary } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { CatalogueList, DefinitionRow, SOURCE_BADGES } from '../indexers/catalogue.js';
import { feedSyncSummary, validateFeedSettings } from './definition-feed-panel.js';

afterEach(() => vi.unstubAllGlobals());

const feedStatus: DefinitionFeedStatus = {
  settings: { enabled: true, url: 'https://raw.githubusercontent.com/arclight/definitions/main/', intervalHours: 12, mode: 'auto' },
  lastSyncAt: '2026-10-26T00:00:00Z',
  lastSuccessAt: '2026-10-26T00:00:00Z',
  lastError: null,
  schemaVersion: 1,
  installed: [
    { id: 'yts', version: '3', sha256: 'a'.repeat(64), installedAt: '2026-10-25T00:00:00Z', previousVersion: '2', active: true },
    { id: 'nyaa', version: '5', sha256: 'b'.repeat(64), installedAt: '2026-10-25T00:00:00Z', previousVersion: null, active: false },
  ],
  rejected: [{ id: 'eztv', version: '7', reason: 'sha256 mismatch' }],
};

const options = {
  minimumAgeMinutes: 0,
  retentionDays: 0,
  maximumSizeMb: 0,
  rssSyncIntervalMinutes: 15,
  allowHardcodedSubs: false,
  whitelistedHardcodedSubs: [],
  preferIndexerFlags: false,
};

function stubOptions(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/settings/indexers': options,
    '/api/v1/indexer/definition/feed/status': feedStatus,
    'PUT /api/v1/indexer/definition/feed/settings': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown,
    'POST /api/v1/indexer/definition/feed/sync': { notModified: false, added: ['a'], updated: ['yts'], removed: [], unchanged: 40, rejected: [] },
    'POST /api/v1/indexer/definition/feed/rollback/yts': null,
    ...extra,
  });
}

const def = (over: Partial<IndexerDefinitionSummary>): IndexerDefinitionSummary => ({
  id: 'yts',
  name: 'YTS',
  description: 'Movies',
  language: 'en-US',
  type: 'public',
  protocol: 'torrent',
  privacy: 'public',
  links: ['https://yts.mx/'],
  settingsFields: [],
  categories: [],
  tested: true,
  source: 'builtin',
  ...over,
});

function renderWithRouter(node: React.ReactNode) {
  const toasts = createToastStore();
  const root = createRootRoute({ component: () => <>{node}</> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('definition feed helpers', () => {
  it('summarises a sync', () => {
    expect(feedSyncSummary({ notModified: true, added: [], updated: [], removed: [], unchanged: 0, rejected: [] })).toBe('Index unchanged');
    expect(feedSyncSummary({ notModified: false, added: ['a', 'b'], updated: [], removed: ['c'], unchanged: 3, rejected: [{ id: 'x', version: null, reason: 'bad' }] })).toBe(
      '2 added · 1 removed · 3 unchanged · 1 rejected',
    );
  });

  it('validates feed settings', () => {
    expect(validateFeedSettings(feedStatus.settings)).toEqual({});
    expect(validateFeedSettings({ ...feedStatus.settings, url: 'x', intervalHours: 0 })).toEqual({ url: 'Enter a full URL', intervalHours: 'Use 1 to 168 hours' });
  });
});

describe('Settings → Indexer options: definition feed', () => {
  it('shows status, installed definitions and rejected entries', async () => {
    stubOptions();
    renderAt('/settings/indexeroptions');
    const panel = await screen.findByRole('region', { name: 'Definition feed' });
    expect(await within(panel).findByText('v1')).toBeTruthy();
    expect(within(panel).getByText('yts')).toBeTruthy();
    expect(within(panel).getByText('Overridden')).toBeTruthy();
    expect(within(panel).getByText(/sha256 mismatch/)).toBeTruthy();
    // Only entries with a kept previous version can roll back.
    expect(within(panel).getByRole('button', { name: 'Roll back yts to 2' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /Roll back nyaa/ })).toBeNull();
  });

  it('syncs now and rolls back a definition', async () => {
    const api = stubOptions();
    renderAt('/settings/indexeroptions');
    const panel = await screen.findByRole('region', { name: 'Definition feed' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Roll back yts to 2' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/indexer/definition/feed/rollback/yts')).toBe(true));
    fireEvent.click(within(panel).getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('1 added · 1 updated · 40 unchanged')).toBeTruthy();
  });

  it('saves the feed settings', async () => {
    const api = stubOptions();
    renderAt('/settings/indexeroptions');
    const interval = await screen.findByLabelText('Sync interval');
    fireEvent.change(interval, { target: { value: '24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save feed settings' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/indexer/definition/feed/settings')?.body).toEqual({ ...feedStatus.settings, intervalHours: 24, mode: 'manual' }));
  });

  it('shows the last sync error', async () => {
    stubOptions({ '/api/v1/indexer/definition/feed/status': { ...feedStatus, lastError: 'index.json answered 404' } });
    renderAt('/settings/indexeroptions');
    expect(await screen.findByText('Last sync failed: index.json answered 404')).toBeTruthy();
  });
});

describe('definition catalogue', () => {
  it('badges each definition with its source', async () => {
    renderWithRouter(
      <ul>
        <DefinitionRow def={def({ id: 'a', name: 'A', source: 'builtin' })} onPick={() => undefined} />
        <DefinitionRow def={def({ id: 'b', name: 'B', source: 'feed' })} onPick={() => undefined} />
        <DefinitionRow def={def({ id: 'c', name: 'C', source: 'custom' })} onPick={() => undefined} />
      </ul>,
    );
    const a = await screen.findByRole('button', { name: 'Add A' });
    expect(within(a).getByText('Built-in')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: 'Add B' })).getByText('Feed').getAttribute('title')).toBe(SOURCE_BADGES.feed.title);
    expect(within(screen.getByRole('button', { name: 'Add C' })).getByText('Custom')).toBeTruthy();
  });

  it('hints at the solver for definitions behind a challenge when no solver proxy exists', async () => {
    stubApi({
      '/api/v1/indexer/definition': [def({ id: 'x', name: '1337x', requiresFlareSolverr: true }), def({ id: 'y', name: 'YTS' })],
      '/api/v1/indexerproxy': [],
    });
    renderWithRouter(<CatalogueList onPick={() => undefined} />);
    const notes = await screen.findAllByRole('note');
    expect(notes).toHaveLength(1);
    expect(within(notes[0]!).getByRole('link', { name: 'Set up' }).getAttribute('href')).toBe('/settings/solver');
    expect(notes[0]!.closest('li')?.textContent).toContain('1337x');
  });

  it('drops the solver hint once a FlareSolverr proxy exists', async () => {
    stubApi({
      '/api/v1/indexer/definition': [def({ id: 'x', name: '1337x', requiresFlareSolverr: true })],
      '/api/v1/indexerproxy': [{ id: 1, name: 'Built-in solver', type: 'flaresolverr', host: 'http://127.0.0.1', port: 7878, tags: [] }],
    });
    renderWithRouter(<CatalogueList onPick={() => undefined} />);
    await screen.findByRole('button', { name: 'Add 1337x' });
    await waitFor(() => expect(screen.queryByRole('note')).toBeNull());
  });
});
