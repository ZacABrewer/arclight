import { describe, expect, it } from 'vitest';
import type { AuthStatus } from '@media-tron/shared';
import { resolveAuthRedirect } from './auth/guard.js';
import { NAV, visibleNav } from './nav.js';
import { user } from './features/requests/test-utils.js';

describe('requests navigation', () => {
  it('shows Discover, Requests, Issues and Watchlist to role user but no settings', () => {
    const nav = visibleNav(false);
    const labels = nav.map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(['Discover', 'Requests', 'Issues', 'Watchlist']));
    expect(labels).not.toContain('Settings');
    expect(nav.find((s) => s.label === 'Requests')?.children?.map((c) => c.to)).toEqual(['/requests', '/requests/mine']);
    expect(nav.find((s) => s.label === 'Discover')?.children?.map((c) => c.to)).toEqual(['/discover', '/discover/movies', '/discover/tv']);
  });

  it('gives admins Settings → Requests and Users, with no Phase 4 placeholders left', () => {
    const settings = visibleNav(true).find((s) => s.label === 'Settings');
    expect(settings?.children?.map((c) => c.to)).toEqual(expect.arrayContaining(['/settings/requests', '/settings/users']));
    const phases = NAV.flatMap((s) => [s.phase, ...(s.children ?? []).map((c) => c.phase)]);
    expect(phases).not.toContain('Phase 4');
  });

  it('lets role user open the user-facing request routes but not request settings', () => {
    const status: AuthStatus = { needsSetup: false, authMethod: 'forms', authenticated: true, session: { user: user(), via: 'session', isAdmin: false } };
    for (const path of ['/discover', '/discover/movie/603', '/requests', '/requests/mine', '/issues/4', '/watchlist', '/profile']) {
      expect(resolveAuthRedirect(status, path)).toBeNull();
    }
    expect(resolveAuthRedirect(status, '/settings/requests')).toBe('/');
    expect(resolveAuthRedirect(status, '/settings/users')).toBe('/');
  });
});
