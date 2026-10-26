import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SceneMappingFeedStatus, type FeedSummary } from '@arclight/shared';
import { renderAt, stubApi } from '../../test/route-harness.js';
import { feedInterval, feedStateLabel, sortFeeds } from './feeds.js';
import { sceneFeedState } from './scene-mapping-feed.js';

afterEach(() => vi.unstubAllGlobals());

const feed = (over: Partial<FeedSummary>): FeedSummary => ({
  id: 'guides',
  name: 'Guides',
  registered: true,
  enabled: true,
  state: 'ok',
  intervalMs: 86_400_000,
  staleAfterMs: 259_200_000,
  lastSyncAt: '2026-10-26T00:00:00Z',
  lastSuccessAt: '2026-10-26T00:00:00Z',
  lastError: null,
  pending: 3,
  detail: '12 synced formats',
  ...over,
});

describe('feeds helpers', () => {
  it('labels states, with the cause on failures', () => {
    expect(feedStateLabel({ state: 'ok', lastError: null })).toBe('Up to date');
    expect(feedStateLabel({ state: 'stale', lastError: 'x' })).toBe('Stale');
    expect(feedStateLabel({ state: 'error', lastError: '502 from upstream' })).toBe('Failed · 502 from upstream');
    expect(feedStateLabel({ state: 'error', lastError: null })).toBe('Failed');
  });

  it('formats intervals and puts feeds needing attention first', () => {
    expect(feedInterval(null)).toBe('on demand');
    expect(feedInterval(43_200_000)).toMatch(/^every /);
    const sorted = sortFeeds([feed({ id: 'a', name: 'B', state: 'ok' }), feed({ id: 'b', name: 'A', state: 'disabled' }), feed({ id: 'c', name: 'C', state: 'stale' })]);
    expect(sorted.map((f) => f.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('System → Feeds', () => {
  it('lists feeds with stale markers and the health docs link', async () => {
    stubApi({
      '/api/v1/system/feeds': {
        feeds: [
          feed({}),
          feed({ id: 'definitions', name: 'Indexer definitions', state: 'stale', lastSuccessAt: '2026-10-01T00:00:00Z', pending: null, detail: '480 definitions' }),
          feed({ id: 'updates', name: 'Updates', registered: false, enabled: false, state: 'unregistered', intervalMs: null, lastSyncAt: null, lastSuccessAt: null, pending: null, detail: null }),
        ],
      },
    });
    renderAt('/system/feeds');
    const table = await screen.findByRole('table', { name: 'Data feeds' });
    expect(await within(table).findByText('480 definitions')).toBeTruthy();
    expect(within(table).getByText('Stale')).toBeTruthy();
    expect(within(table).getByText('Not available')).toBeTruthy();
    expect(within(table).getByText('on demand')).toBeTruthy();
    const fix = within(table).getByRole('link', { name: 'Why Indexer definitions is stale' });
    expect(fix.getAttribute('href')).toBe('/docs/system/health#feed-stale');
    expect(within(table).getByRole('link', { name: 'Guides' }).getAttribute('href')).toBe('/settings/guides');
    expect(screen.getByText(/1 feed has not synced for three intervals/)).toBeTruthy();
    // The stale feed sorts first.
    const rows = within(table).getAllByRole('row');
    expect(rows[1]?.textContent).toContain('Indexer definitions');
  });

  it('shows an error block when the registry fails', async () => {
    stubApi({ '/api/v1/system/feeds': new Response(JSON.stringify({ error: 'boom' }), { status: 500 }) });
    renderAt('/system/feeds');
    expect(await screen.findByText("Couldn't load the feeds")).toBeTruthy();
  });
});

describe('System → Feeds: scene mappings feed', () => {
  const status = (over: Partial<SceneMappingFeedStatus> = {}): SceneMappingFeedStatus =>
    SceneMappingFeedStatus.parse({
      url: 'https://raw.example/feeds/scene-mappings.json',
      lastSyncAt: '2026-10-26T00:00:00Z',
      lastSuccessAt: '2026-10-26T00:00:00Z',
      lastError: null,
      notPublished: false,
      feedSeries: 40,
      matchedSeries: 3,
      mappings: 11,
      rejected: 1,
      ...over,
    });

  it('labels the feed state: not published is info, failures carry the cause', () => {
    expect(sceneFeedState(status({ notPublished: true, lastError: 'x' }))).toEqual({ label: 'Not published yet', tone: 'neutral' });
    expect(sceneFeedState(status({ lastError: '502 from upstream' })).label).toBe('Failed · 502 from upstream');
    expect(sceneFeedState(status()).tone).toBe('accent');
    expect(sceneFeedState(status({ lastSuccessAt: null, lastSyncAt: null })).label).toBe('Not synced yet');
  });

  it('shows the feed status and syncs on demand', async () => {
    const api = stubApi({
      '/api/v1/system/feeds': { feeds: [feed({ id: 'sceneMappings', name: 'Scene mappings', detail: '11 rules' })] },
      '/api/v1/scenemapping/feed': status(),
      'POST /api/v1/scenemapping/feed/sync': status({ mappings: 12 }),
    });
    renderAt('/system/feeds');
    const pane = await screen.findByRole('region', { name: 'Scene mappings feed' });
    expect(await within(pane).findByText('https://raw.example/feeds/scene-mappings.json')).toBeTruthy();
    expect(within(pane).getByText('11')).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/scenemapping/feed/sync')).toBe(true));
  });
});
