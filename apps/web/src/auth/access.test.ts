import { describe, expect, it } from 'vitest';
import { Permission, type Session } from '@arclight/shared';
import { flagsFromPermissions, permissionsFromFlags, quotaFromText } from '../features/users/user-defaults.js';
import { appAccessOfDraft, appAccessSummary, promotionNeedsPassword, validateUserDraft, type UserDraft } from '../pages/settings/security/security-page.js';
import { openAppHref } from '../pages/portal/portal-page.js';
import { ADMIN_ACCESS, PORTAL_ACCESS, accessOf, appHomeFor, canOpenAppPath, hasAppPages, portalTargetFor } from './access.js';

const user = { id: 2, username: 'amy', role: 'user' as const, permissions: Permission.REQUEST as number, createdAt: '2026-01-01T00:00:00.000Z', settings: {} };
const session = (over: Partial<typeof user> & { appAccess?: Array<'library' | 'calendar' | 'activity' | 'wanted'> } = {}, isAdmin = false): Session => ({
  user: { ...user, ...over },
  via: 'session',
  isAdmin,
});

describe('access of a session', () => {
  it('is everything for admins (and when nobody is known), nothing but the portal for a plain user', () => {
    expect(accessOf(session({}, true))).toBe(ADMIN_ACCESS);
    expect(accessOf(null)).toBe(ADMIN_ACCESS);
    const plain = accessOf(session());
    expect(plain).toEqual({ admin: false, areas: [], permissions: Permission.REQUEST });
    expect(hasAppPages(plain)).toBe(false);
    expect(appHomeFor(plain)).toBeNull();
  });

  it('never lets permission bits from a stale session make someone admin', () => {
    expect(accessOf(session({ permissions: Permission.ADMIN | Permission.REQUEST })).admin).toBe(false);
    expect(accessOf(session({ permissions: Permission.ADMIN })).permissions & Permission.ADMIN).toBe(0);
  });

  it('opens only the read-only pages of granted areas', () => {
    const a = accessOf(session({ appAccess: ['activity'] }));
    expect(canOpenAppPath(a, '/activity/queue')).toBe(true);
    expect(canOpenAppPath(a, '/activity/history')).toBe(true);
    expect(canOpenAppPath(a, '/activity/manual-import')).toBe(false);
    expect(canOpenAppPath(a, '/activity/pending')).toBe(false);
    expect(canOpenAppPath(a, '/')).toBe(false);
    expect(canOpenAppPath(a, '/profile')).toBe(true);
    expect(appHomeFor(a)).toBe('/activity/queue');
    expect(canOpenAppPath(PORTAL_ACCESS, '/profile')).toBe(false);
  });

  it('maps app pages to their portal twins', () => {
    expect(portalTargetFor('/discover/tv/1396')).toBe('/portal/tv/1396');
    expect(portalTargetFor('/discover')).toBe('/portal');
    expect(portalTargetFor('/issues')).toBe('/portal/issues');
    expect(portalTargetFor('/requests/mine')).toBe('/portal/requests');
    expect(portalTargetFor('/settings/general')).toBe('/portal');
  });

  it('offers "Open Arclight" in the portal only to people with app pages', () => {
    expect(openAppHref(null, ADMIN_ACCESS)).toBe('/');
    expect(openAppHref(null, PORTAL_ACCESS)).toBeNull();
    expect(openAppHref(null, { admin: false, areas: ['calendar'], permissions: 0 })).toBe('/calendar');
    expect(openAppHref({ mode: 'host', base: '/', portalOnly: true } as never, ADMIN_ACCESS)).toBeNull();
  });
});

describe('user editor (app access, promotion)', () => {
  const draft = (over: Partial<UserDraft> = {}): UserDraft => ({ username: 'amy', displayName: '', email: '', role: 'user', password: '', access: 'portal', areas: [], ...over });

  it('stores portal-only as [] and app access as the ticked areas in order; admins store none', () => {
    expect(appAccessOfDraft(draft())).toEqual([]);
    expect(appAccessOfDraft(draft({ access: 'portal', areas: ['library'] }))).toEqual([]);
    expect(appAccessOfDraft(draft({ access: 'app', areas: ['wanted', 'library'] }))).toEqual(['library', 'wanted']);
    expect(appAccessOfDraft(draft({ role: 'admin', access: 'app', areas: ['library'] }))).toEqual([]);
    expect(validateUserDraft(draft({ access: 'app', areas: [] }), false)).toMatch(/at least one area/);
  });

  it('asks for a password before promoting a media-server account to admin', () => {
    const fromJellyfin = { role: 'user' as const, localPassword: false };
    expect(promotionNeedsPassword(fromJellyfin, { role: 'admin' })).toBe(true);
    expect(promotionNeedsPassword({ role: 'user', localPassword: true }, { role: 'admin' })).toBe(false);
    expect(promotionNeedsPassword(fromJellyfin, { role: 'user' })).toBe(false);
    expect(validateUserDraft(draft({ role: 'admin' }), false, fromJellyfin)).toMatch(/Set a password/);
    expect(validateUserDraft(draft({ role: 'admin', password: 'long-enough' }), false, fromJellyfin)).toBeNull();
  });

  it('summarises app access for the users table', () => {
    expect(appAccessSummary({ role: 'admin' })).toBe('Everything');
    expect(appAccessSummary({ role: 'user', appAccess: [] })).toBe('Portal only');
    expect(appAccessSummary({ role: 'user', appAccess: ['library', 'calendar'] })).toBe('Portal + Library, Calendar');
  });
});

describe('user defaults', () => {
  it('maps request permission switches onto the default bitfield and back, never setting ADMIN', () => {
    const base = Permission.REQUEST | Permission.CREATE_ISSUES | Permission.WATCHLIST_VIEW;
    expect(flagsFromPermissions(base)).toEqual({ movies: true, series: true, fourK: false, autoApprove: false, issues: true });
    const moviesOnly = permissionsFromFlags({ movies: true, series: false, fourK: true, autoApprove: false, issues: false }, base | Permission.ADMIN);
    expect(moviesOnly).toBe(Permission.REQUEST_MOVIE | Permission.REQUEST_4K | Permission.WATCHLIST_VIEW);
    expect(flagsFromPermissions(moviesOnly)).toMatchObject({ movies: true, series: false, fourK: true });
  });

  it('reads quotas: empty is unlimited, anything but a whole number is refused', () => {
    expect(quotaFromText({ movieLimit: '5', movieDays: '7', tvLimit: '', tvDays: ' ' })).toEqual({ movieLimit: 5, movieDays: 7, tvLimit: null, tvDays: null });
    expect(quotaFromText({ movieLimit: '-1', movieDays: '', tvLimit: '', tvDays: '' })).toBeNull();
    expect(quotaFromText({ movieLimit: '1.5', movieDays: '', tvLimit: '', tvDays: '' })).toBeNull();
  });
});
