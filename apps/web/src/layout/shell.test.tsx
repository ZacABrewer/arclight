import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import type { DiscoverItem, HealthResponse, VpnStatus } from '@arclight/shared';
import { GlobalSearchOverlay } from '../arclight/index.js';
import { ToastProvider } from '../components/toast.js';
import { createToastStore } from '../lib/toast.js';
import { activeMobileTab, activeRailCode, activeTab, mobileTabsFor, railFor, sectionTabs } from '../nav.js';
import { createQueryClient } from '../query-client.js';
import { crumbsFor } from '../pages/setup/path-crumbs.js';
import { buildCommandGroups, buildSearchGroups, buildTaskGroups, settingsPages, type Target } from './search-groups.js';
import { Palette } from './shell-overlays.js';
import { healthIssueCount, statusCluster, vpnLocationOf } from './status-cluster.js';
import { initialsOf } from './user-menu.js';

const vpn = (over: Partial<VpnStatus> = {}): VpnStatus => ({ enabled: true, connected: true, lastChecked: null, lastChanged: null, ...over });
const health = (statuses: Array<'ok' | 'warning' | 'error'>): HealthResponse => ({
  status: 'ok',
  checks: statuses.map((status, i) => ({ source: `Check${i}`, status, message: `message ${i}` })),
});
const tmdb = (over: Partial<DiscoverItem>): DiscoverItem => ({
  mediaType: 'series',
  tmdbId: 1,
  title: 'Title',
  overview: '',
  mediaStatus: 'unknown',
  mediaStatus4k: 'unknown',
  ...over,
});

describe('rail and navigation', () => {
  it('maps the 11 rail codes to nav entries for admins, each with a route', () => {
    const rail = railFor(true);
    expect(rail.map((r) => r.code)).toEqual(['DB', 'LB', 'DS', 'RQ', 'CL', 'WN', 'AC', 'SB', 'IX', 'ST', 'SY']);
    expect(rail.find((r) => r.code === 'IX')?.href).toBe('/indexers');
    expect(rail.find((r) => r.code === 'ST')?.href).toBe('/settings/mediamanagement');
  });

  it('hides admin-only rail codes for role user', () => {
    expect(railFor(false).map((r) => r.code)).toEqual(['DB', 'LB', 'DS', 'RQ', 'CL', 'WN']);
  });

  it('lights the rail code that owns a path, and none for 404 or profile', () => {
    expect(activeRailCode('/')).toBe('DB');
    expect(activeRailCode('/library/series/7')).toBe('LB');
    expect(activeRailCode('/issues/4')).toBe('RQ');
    expect(activeRailCode('/watchlist')).toBe('RQ');
    expect(activeRailCode('/search')).toBe('IX');
    expect(activeRailCode('/system/logs')).toBe('SY');
    expect(activeRailCode('/does/not/exist')).toBeNull();
    expect(activeRailCode('/profile')).toBeNull();
  });

  it('builds section tabs from every section under the active code', () => {
    expect(sectionTabs('/issues', true).map((t) => t.label)).toEqual(['All requests', 'My requests', 'Issues', 'Watchlist']);
    expect(sectionTabs('/indexers/stats', true).map((t) => t.to)).toEqual(['/indexers', '/indexers/stats', '/search']);
    expect(sectionTabs('/system/status', true).map((t) => t.label)).toContain('Updates');
    // Settings draws its own sub-nav; the dashboard is a single page.
    expect(sectionTabs('/settings/general', true)).toEqual([]);
    expect(sectionTabs('/', true)).toEqual([]);
  });

  it('picks the longest matching tab so detail pages keep theirs lit', () => {
    const tabs = sectionTabs('/discover/movies', true);
    expect(activeTab('/discover/movies', tabs)?.label).toBe('Movies');
    expect(activeTab('/discover', tabs)?.label).toBe('Home');
    expect(activeTab('/discover/person/3', tabs)?.label).toBe('Home');
  });

  it('gives role user a Requests tab instead of Activity on the mobile bar', () => {
    expect(mobileTabsFor(true).map((t) => t.label)).toEqual(['Home', 'Library', 'Discover', 'Activity', 'More']);
    expect(mobileTabsFor(false).map((t) => t.label)).toEqual(['Home', 'Library', 'Discover', 'Requests', 'More']);
    expect(activeMobileTab('/activity/history', true)).toBe('activity');
    expect(activeMobileTab('/requests/mine', false)).toBe('requests');
    expect(activeMobileTab('/calendar', true)).toBe('more');
  });
});

describe('status cluster', () => {
  it('reports the live connection as Connected / Connecting… / Reconnecting…', () => {
    expect(statusCluster({ connection: 'open', isAdmin: true })).toMatchObject({ connected: true });
    expect(statusCluster({ connection: 'connecting', isAdmin: true })).toMatchObject({ connected: false, disconnectedLabel: 'Connecting…' });
    expect(statusCluster({ connection: 'reconnecting', isAdmin: true })).toMatchObject({ connected: false, disconnectedLabel: 'Reconnecting…' });
  });

  it('names the VPN exit country, or VPN off / down', () => {
    expect(vpnLocationOf(undefined)).toBeUndefined();
    expect(vpnLocationOf(vpn({ enabled: false }))).toBeNull();
    expect(vpnLocationOf(vpn({ connected: false }))).toBe('down');
    expect(vpnLocationOf(vpn({ country: 'Switzerland', city: 'Zürich' }))).toBe('Switzerland');
  });

  it('counts pending requests and health issues for admins only', () => {
    const requests = { total: 9, movie: 3, series: 6, pending: 4, approved: 0, declined: 0, failed: 0, processing: 0, available: 0, completed: 0 };
    const admin = statusCluster({ connection: 'open', isAdmin: true, requests, health: health(['ok', 'warning', 'error']), vpn: vpn({ country: 'Sweden' }) });
    expect(admin).toMatchObject({ requestCount: 4, issueCount: 2, vpnLocation: 'Sweden', issuesHref: '/system/health' });
    const user = statusCluster({ connection: 'open', isAdmin: false, requests, health: health(['error']), openIssues: 1, vpn: vpn() });
    expect(user).toMatchObject({ requestCount: undefined, issueCount: 1, vpnLocation: undefined, issuesHref: '/issues' });
    expect(healthIssueCount(health(['ok', 'ok']))).toBe(0);
  });
});

describe('global search groups', () => {
  const go = vi.fn<(t: Target) => void>();
  const series = [
    { id: 7, title: 'Severance', year: 2022 },
    { id: 8, title: 'The Bear', year: 2022 },
  ];
  const movies = [{ id: 9, title: 'Severance: The Movie', year: 2026 }];

  beforeEach(() => go.mockReset());

  it('orders groups Series, Movies, People, Settings, then the indexer search row', () => {
    const groups = buildSearchGroups({ query: 'sever', series, movies, isAdmin: true, go });
    expect(groups.map((g) => g.label)).toEqual(['Series', 'Movies', 'People', 'Indexers']);
    expect(groups[0]!.items.map((i) => i.label)).toEqual(['Severance']);
    expect(groups[1]!.items.map((i) => i.label)).toEqual(['Severance: The Movie']);
    expect(buildSearchGroups({ query: '  ', series, movies, isAdmin: true, go })).toEqual([]);
  });

  it('lists library matches before TMDB titles and does not repeat a title already in the library', () => {
    const discover = [tmdb({ tmdbId: 1, title: 'Severance', libraryId: 7 }), tmdb({ tmdbId: 2, title: 'Severed', year: 2019 }), tmdb({ mediaType: 'movie', tmdbId: 3, title: 'Severance Movie' })];
    const [seriesGroup, movieGroup] = buildSearchGroups({ query: 'sever', series, movies: [], discover, isAdmin: true, go });
    expect(seriesGroup!.items.map((i) => [i.label, i.meta])).toEqual([
      ['Severance', '2022 · In library'],
      ['Severed', '2019 · TMDB'],
    ]);
    seriesGroup!.items[1]!.onSelect();
    expect(go).toHaveBeenLastCalledWith({ to: '/discover/tv/$tmdbId', params: { tmdbId: '2' } });
    movieGroup!.items[0]!.onSelect();
    expect(go).toHaveBeenLastCalledWith({ to: '/discover/movie/$tmdbId', params: { tmdbId: '3' } });
  });

  it('matches Settings and System pages by section and name, and hides them and indexers from users', () => {
    const groups = buildSearchGroups({ query: 'download clients', series: [], movies: [], isAdmin: true, go });
    const settings = groups.find((g) => g.label === 'Settings')!;
    expect(settings.items.map((i) => i.label)).toEqual(['Download Clients']);
    settings.items[0]!.onSelect();
    expect(go).toHaveBeenLastCalledWith({ to: '/settings/downloadclients' });
    expect(settingsPages(false)).toEqual([]);
    const userGroups = buildSearchGroups({ query: 'logs', series: [], movies: [], isAdmin: false, go });
    expect(userGroups.map((g) => g.label)).toEqual(['People']);
  });

  it('moves with the arrow keys across groups and opens the row on Enter', () => {
    function Harness() {
      const [q, setQ] = useState('sever');
      return <GlobalSearchOverlay open onClose={() => {}} query={q} onQueryChange={setQ} groups={buildSearchGroups({ query: q, series, movies, isAdmin: true, go })} />;
    }
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Search' });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(go).toHaveBeenCalledWith({ to: '/library/movie/$id', params: { id: '9' } });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(go).toHaveBeenLastCalledWith({ to: '/search', search: { q: 'sever' } });
  });
});

describe('command palette', () => {
  const noop = () => {};

  it('offers add series, add movie, search, run task and navigation to admins', () => {
    const groups = buildCommandGroups({ query: '', isAdmin: true, go: noop, openTasks: noop, openShortcuts: noop });
    expect(groups.map((g) => g.label)).toEqual(['Actions', 'Navigate']);
    expect(groups[0]!.items.map((i) => i.label)).toEqual(['Add series', 'Add movie', 'Search indexers', 'Run task…', 'Import files manually', 'Show keyboard shortcuts']);
    expect(groups[1]!.items.map((i) => i.label)).toContain('System › Logs');
  });

  it('filters by the query while the search action carries it', () => {
    const go = vi.fn();
    const groups = buildCommandGroups({ query: 'logs', isAdmin: true, go, openTasks: noop, openShortcuts: noop });
    expect(groups[0]!.items.map((i) => i.label)).toEqual(['Search indexers for "logs"']);
    expect(groups[1]!.items.map((i) => i.label)).toEqual(['System › Logs']);
    groups[0]!.items[0]!.onSelect();
    expect(go).toHaveBeenCalledWith({ to: '/search', search: { q: 'logs' } });
  });

  it('gives role user no admin actions or admin pages', () => {
    const groups = buildCommandGroups({ query: '', isAdmin: false, go: noop, openTasks: noop, openShortcuts: noop });
    expect(groups[0]!.items.map((i) => i.label)).toEqual(['Request a title', 'Show keyboard shortcuts']);
    expect(groups[1]!.items.some((i) => String(i.label).startsWith('System'))).toBe(false);
  });

  it('lists scheduled tasks for "Run task…" and filters them', () => {
    const run = vi.fn();
    const jobs = [
      { name: 'housekeeping', interval: 'PT1H', lastRun: null, nextRun: null, enabled: true },
      { name: 'rss-sync', interval: 'PT15M', lastRun: null, nextRun: null, enabled: false },
    ];
    const [group] = buildTaskGroups('rss', jobs, run);
    expect(group!.items.map((i) => [i.label, i.meta])).toEqual([['rss-sync', 'Disabled']]);
    group!.items[0]!.onSelect();
    expect(run).toHaveBeenCalledWith('rss-sync');
    expect(buildTaskGroups('zzz', jobs, run)).toEqual([]);
  });

  describe('Palette component', () => {
    let calls: Array<{ url: string; method: string; body: unknown }>;
    beforeEach(() => {
      calls = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
          if (url === '/api/v1/jobs/scheduled') return new Response(JSON.stringify([{ name: 'housekeeping', interval: 'PT1H', lastRun: null, nextRun: null, enabled: true }]));
          if (url === '/api/v1/jobs/run') {
            return new Response(JSON.stringify({ id: 3, name: 'housekeeping', status: 'queued', trigger: 'manual', message: null, queuedAt: '2026-10-25T10:00:00.000Z', startedAt: null, endedAt: null, durationMs: null }));
          }
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it('keeps the palette open on "Run task…", then runs the picked task', async () => {
      const onClose = vi.fn();
      const toasts = createToastStore();
      const root = createRootRoute({ component: () => <Palette open onClose={onClose} isAdmin onShortcuts={() => {}} /> });
      const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
      render(
        <QueryClientProvider client={createQueryClient(toasts)}>
          <ToastProvider store={toasts}>
            <RouterProvider router={router} />
          </ToastProvider>
        </QueryClientProvider>,
      );
      const palette = await screen.findByRole('dialog', { name: 'Command palette' });
      fireEvent.click(within(palette).getByRole('option', { name: /Run task/ }));
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(await within(palette).findByRole('option', { name: /housekeeping/ }));
      await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/jobs/run')?.body).toEqual({ name: 'housekeeping' }));
      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe('small helpers', () => {
  it('derives square-avatar initials', () => {
    expect(initialsOf('Sam Kade')).toBe('SK');
    expect(initialsOf('admin')).toBe('AD');
    expect(initialsOf('vee.lopez')).toBe('VL');
  });

  it('builds folder breadcrumbs for POSIX, drive and UNC paths', () => {
    expect(crumbsFor('/media/tv').map((c) => c.path)).toEqual(['/', '/media', '/media/tv']);
    expect(crumbsFor('D:\\Media\\TV').map((c) => c.label)).toEqual(['D:', 'Media', 'TV']);
    expect(crumbsFor('\\\\nas\\share\\tv').map((c) => c.label)).toEqual(['\\\\nas\\share', 'tv']);
  });
});
