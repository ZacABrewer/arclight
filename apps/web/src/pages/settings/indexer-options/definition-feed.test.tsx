import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import type { DefinitionFeedStatus } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { SourceBadge, SOURCE_BADGES } from '../indexers/catalogue.js';
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
  it('badges each source with a label and an explanation', async () => {
    renderWithRouter(
      <div>
        {(['builtin', 'feed', 'custom', 'community', 'preset', 'generic'] as const).map((source) => (
          <SourceBadge key={source} source={source} />
        ))}
      </div>,
    );
    expect(await screen.findByText('Built-in')).toBeTruthy();
    expect(screen.getByText('Feed').getAttribute('title')).toBe(SOURCE_BADGES.feed.title);
    expect(screen.getByText('Custom')).toBeTruthy();
    expect(screen.getByText('Community').getAttribute('title')).toMatch(/community catalogue/);
    expect(screen.getByText('Preset')).toBeTruthy();
    expect(screen.getByText('Endpoint')).toBeTruthy();
  });
});
