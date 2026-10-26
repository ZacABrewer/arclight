import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus } from '@arclight/shared';
import { request, setUnauthorizedHandler } from '../api/client.js';
import { isAbsolutePath, validateAdmin, validateRootFolders, firstIncompleteStep } from '../pages/setup/setup-wizard.js';
import { visibleNav } from '../nav.js';
import { PUBLIC_PATHS, SHELLLESS_PATHS, isPublicPath, resolveAuthRedirect, safeRedirect } from './guard.js';

const user = { id: 1, username: 'amy', role: 'user' as const, permissions: 0, createdAt: '2026-01-01T00:00:00.000Z', settings: {} };
const status = (over: Partial<AuthStatus>): AuthStatus => ({ needsSetup: false, authMethod: 'forms', authenticated: true, session: null, ...over });

describe('resolveAuthRedirect', () => {
  it('sends everything to /setup while setup is pending, except /setup and /login', () => {
    const s = status({ needsSetup: true, authenticated: false });
    expect(resolveAuthRedirect(s, '/library/tv')).toBe('/setup');
    expect(resolveAuthRedirect(s, '/setup')).toBeNull();
    expect(resolveAuthRedirect(s, '/login')).toBeNull();
  });

  it('sends anonymous callers to /login with a return path', () => {
    const s = status({ authenticated: false });
    expect(resolveAuthRedirect(s, '/calendar', '/calendar?view=week')).toBe('/login?redirect=%2Fcalendar%3Fview%3Dweek');
    expect(resolveAuthRedirect(s, '/')).toBe('/login');
    expect(resolveAuthRedirect(s, '/login')).toBeNull();
    expect(resolveAuthRedirect(s, '/setup')).toBe('/');
  });

  it('moves signed-in users off /login to a safe return path', () => {
    const s = status({ session: { user, via: 'session', isAdmin: true } });
    expect(resolveAuthRedirect(s, '/login', '/login', '/wanted/missing')).toBe('/wanted/missing');
    expect(resolveAuthRedirect(s, '/login', '/login', '//evil.example')).toBe('/');
    expect(resolveAuthRedirect(s, '/library/tv')).toBeNull();
  });

  it('keeps plain users out of admin-only sections', () => {
    const s = status({ session: { user, via: 'session', isAdmin: false } });
    expect(resolveAuthRedirect(s, '/settings/security')).toBe('/');
    expect(resolveAuthRedirect(s, '/system/status')).toBe('/');
    expect(resolveAuthRedirect(s, '/calendar')).toBeNull();
  });

  it('lets anyone open the public portal once setup is done, without the app shell', () => {
    expect(resolveAuthRedirect(status({ authenticated: false }), '/portal')).toBeNull();
    expect(resolveAuthRedirect(status({ session: { user, via: 'session', isAdmin: false } }), '/portal')).toBeNull();
    expect(resolveAuthRedirect(status({ session: { user, via: 'session', isAdmin: true } }), '/portal')).toBeNull();
    expect(PUBLIC_PATHS.has('/portal')).toBe(true);
    expect(SHELLLESS_PATHS.has('/portal')).toBe(true);
    expect(isPublicPath('/portal/x')).toBe(false);
  });

  it('sends the portal to /setup while setup is pending, and keeps other pages private', () => {
    expect(resolveAuthRedirect(status({ needsSetup: true, authenticated: false }), '/portal')).toBe('/setup');
    expect(resolveAuthRedirect(status({ authenticated: false }), '/discover')).toBe('/login?redirect=%2Fdiscover');
  });

  it('stays put when the api does not report auth status', () => {
    expect(resolveAuthRedirect(null, '/settings/general')).toBeNull();
  });

  it('accepts only same-origin redirect targets', () => {
    expect(safeRedirect('/setup')).toBe('/setup');
    expect(safeRedirect('https://evil.example')).toBe('/');
    expect(safeRedirect('/login?redirect=/x')).toBe('/');
    expect(safeRedirect(undefined)).toBe('/');
  });
});

describe('admin-only nav', () => {
  it('hides admin sections for role user', () => {
    const labels = visibleNav(false).map((s) => s.label);
    expect(labels).toContain('Library');
    expect(labels).not.toContain('Settings');
    expect(labels).not.toContain('System');
    expect(visibleNav(true).map((s) => s.label)).toContain('Settings');
  });
});

describe('wizard step validation', () => {
  it('validates the admin account', () => {
    expect(validateAdmin({ username: 'a', password: 'short', confirm: 'x', email: 'nope' })).toEqual({
      username: 'At least 2 characters.',
      password: 'At least 8 characters.',
      confirm: 'Passwords do not match.',
      email: 'Not a valid email address.',
    });
    expect(validateAdmin({ username: 'admin', password: 'password1', confirm: 'password1', email: '' })).toEqual({});
  });

  it('validates root folders', () => {
    expect(validateRootFolders({ tv: '', movies: '' }, false)).toEqual({ form: 'Add at least one root folder.' });
    expect(validateRootFolders({ tv: '', movies: '' }, true)).toEqual({});
    expect(validateRootFolders({ tv: 'media/tv', movies: '/m' }, false)).toEqual({ tv: 'Use an absolute path.' });
    expect(validateRootFolders({ tv: '/data', movies: '/data' }, false)).toEqual({ movies: 'TV and movies need different folders.' });
    expect(isAbsolutePath('D:\\Media')).toBe(true);
    expect(isAbsolutePath('\\\\nas\\share')).toBe(true);
  });

  it('resumes at the first incomplete required step', () => {
    const steps = (done: string[]) => ({
      needsSetup: true,
      steps: (['admin', 'tmdb', 'rootFolders', 'downloadClient', 'indexer'] as const).map((id) => ({ id, complete: done.includes(id), optional: id === 'downloadClient' || id === 'indexer' })),
    });
    expect(firstIncompleteStep(steps([]))).toBe('admin');
    expect(firstIncompleteStep(steps(['admin']))).toBe('tmdb');
    expect(firstIncompleteStep(steps(['admin', 'tmdb', 'rootFolders']))).toBe('downloadClient');
  });
});

describe('request() 401 handling', () => {
  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
  });

  it('calls the unauthorized handler for normal endpoints but not for auth endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'authentication required', code: 'UNAUTHORIZED' }), { status: 401 })));
    const seen: string[] = [];
    setUnauthorizedHandler((path) => seen.push(path));
    await expect(request('/series', null)).rejects.toMatchObject({ status: 401 });
    await expect(request('/auth/login', null, { method: 'POST' })).rejects.toMatchObject({ status: 401 });
    expect(seen).toEqual(['/series']);
  });
});
