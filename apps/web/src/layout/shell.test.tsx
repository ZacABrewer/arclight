import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import type { HealthResponse, VpnStatus } from '@arclight/shared';
import { activeMobileTab, activeRailCode, activeTab, mobileTabsFor, railFor, sectionTabs } from '../nav.js';
import { crumbsFor } from '../pages/setup/path-crumbs.js';
import { healthIssueCount, statusCluster, vpnLocationOf } from './status-cluster.js';
import { initialsOf } from './user-menu.js';
import { SectionNav } from './section-nav.js';

const vpn = (over: Partial<VpnStatus> = {}): VpnStatus => ({ enabled: true, connected: true, lastChecked: null, lastChanged: null, ...over });
const health = (statuses: Array<'ok' | 'warning' | 'error'>): HealthResponse => ({
  status: 'ok',
  checks: statuses.map((status, i) => ({ source: `Check${i}`, status, message: `message ${i}` })),
});

describe('rail and navigation', () => {
  it('maps the 11 rail codes to nav entries for admins, each with a route', () => {
    const rail = railFor(true);
    expect(rail.map((r) => r.code)).toEqual(['DB', 'LB', 'DS', 'RQ', 'CL', 'WN', 'AC', 'SB', 'IX', 'ST', 'SY']);
    expect(rail.find((r) => r.code === 'IX')?.href).toBe('/indexers');
    expect(rail.find((r) => r.code === 'ST')?.href).toBe('/settings/mediamanagement');
  });

  it('gives non-admins only the portal link and the areas an admin granted', () => {
    expect(railFor(false).map((r) => [r.code, r.href])).toEqual([['DS', '/portal']]);
    expect(railFor({ admin: false, areas: ['library', 'calendar'], permissions: 0 }).map((r) => r.code)).toEqual(['LB', 'DS', 'CL']);
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
    expect(sectionTabs('/indexers/stats', true).map((t) => t.to)).toEqual(['/indexers', '/indexers/stats', '/indexers/trackers', '/search']);
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

  it('lights only the matching section tab, not the index tab on its sub-pages', async () => {
    const renderNav = async (path: string) => {
      const root = createRootRoute({ component: () => <SectionNav pathname={path} access /> });
      const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [path] }) });
      const view = render(<RouterProvider router={router} />);
      const nav = await screen.findByRole('navigation', { name: 'Section' });
      const lit = within(nav)
        .getAllByRole('link')
        .filter((a) => a.getAttribute('aria-current') === 'page')
        .map((a) => a.textContent);
      view.unmount();
      return lit;
    };
    expect(await renderNav('/discover/movies')).toEqual(['Movies']);
    expect(await renderNav('/discover')).toEqual(['Home']);
    expect(await renderNav('/discover/person/3')).toEqual(['Home']);
    expect(await renderNav('/requests/mine')).toEqual(['My requests']);
  });

  it('gives non-admins the portal (and Library when granted) on the mobile bar', () => {
    expect(mobileTabsFor(true).map((t) => t.label)).toEqual(['Home', 'Library', 'Discover', 'Activity', 'More']);
    expect(mobileTabsFor(false).map((t) => t.label)).toEqual(['Request portal', 'More']);
    expect(mobileTabsFor({ admin: false, areas: ['library'], permissions: 0 }).map((t) => t.href)).toEqual(['/portal', '/library/tv', null]);
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
    expect(vpnLocationOf(vpn({ country: 'Netherlands', city: 'Amsterdam' }))).toBe('Netherlands');
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
