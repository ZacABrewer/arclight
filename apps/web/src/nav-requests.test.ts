import { describe, expect, it } from 'vitest';
import { Permission, type AuthStatus } from '@arclight/shared';
import { resolveAuthRedirect } from './auth/guard.js';
import { NAV, visibleNav } from './nav.js';
import { user } from './features/requests/test-utils.js';

describe('requests navigation', () => {
  it('gives a portal-only user no app sections: only the way back to the portal', () => {
    const nav = visibleNav(false);
    expect(nav.map((s) => s.to)).toEqual(['/portal']);
  });

  it('shows request and issue management to users an admin gave those permissions', () => {
    const nav = visibleNav({ admin: false, areas: [], permissions: Permission.REQUEST_VIEW | Permission.VIEW_ISSUES });
    const labels = nav.map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(['Requests', 'Issues']));
    expect(labels).not.toContain('Settings');
    expect(labels).not.toContain('Discover');
    expect(nav.find((s) => s.label === 'Requests')?.children?.map((c) => c.to)).toEqual(['/requests', '/requests/mine']);
  });

  it('gives admins Settings → Requests and Users, with no Phase 4 placeholders left', () => {
    const settings = visibleNav(true).find((s) => s.label === 'Settings');
    expect(settings?.children?.map((c) => c.to)).toEqual(expect.arrayContaining(['/settings/requests', '/settings/users']));
    expect(visibleNav(true).some((s) => s.to === '/portal')).toBe(false);
    const phases = NAV.flatMap((s) => [s.phase, ...(s.children ?? []).map((c) => c.phase)]);
    expect(phases).not.toContain('Phase 4');
  });

  it('sends a portal user from every app page to its portal twin', () => {
    const status: AuthStatus = { needsSetup: false, adminExists: true, authMethod: 'forms', authenticated: true, session: { user: user(), via: 'session', isAdmin: false } };
    expect(resolveAuthRedirect(status, '/discover')).toBe('/portal');
    expect(resolveAuthRedirect(status, '/discover/movie/603')).toBe('/portal/movie/603');
    expect(resolveAuthRedirect(status, '/requests/mine')).toBe('/portal/requests');
    expect(resolveAuthRedirect(status, '/issues/4')).toBe('/portal/issues/4');
    expect(resolveAuthRedirect(status, '/profile')).toBe('/portal/profile');
    for (const path of ['/', '/requests', '/watchlist', '/library/tv', '/calendar', '/settings/requests', '/settings/users', '/system/status']) {
      expect([path, resolveAuthRedirect(status, path)]).toEqual([path, '/portal']);
    }
    for (const path of ['/portal', '/portal/requests', '/portal/issues/4', '/portal/profile']) {
      expect(resolveAuthRedirect(status, path)).toBeNull();
    }
  });
});
