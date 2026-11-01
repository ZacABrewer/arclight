import { describe, expect, it } from 'vitest';
import { discoverSearchPath, isSafePath, routeNotification, shareQuery } from './routing.js';
import { DEFAULT_SETTINGS, shouldLockOnResume } from './settings.js';

const servers = [
  { id: 'a', name: 'A', url: 'https://a.example.com', addedAt: '' },
  { id: 'b', name: 'B', url: 'http://nas:7878', addedAt: '' },
];

describe('routeNotification', () => {
  it('opens the path on the server named in the payload', () => {
    expect(routeNotification({ url: '/requests/12', server: 'http://nas:7878/' }, servers, servers[0]!)).toEqual({ server: servers[1], url: 'http://nas:7878/requests/12' });
  });
  it('falls back to the current/selected server without data.server', () => {
    expect(routeNotification({ url: '/activity/queue' }, servers, servers[0]!)?.url).toBe('https://a.example.com/activity/queue');
  });
  it('never opens unknown servers or unsafe paths', () => {
    expect(routeNotification({ url: '/x', server: 'https://evil.example.com' }, servers, servers[0]!)).toBeNull();
    expect(routeNotification({ url: '//evil.example.com/x' }, servers, servers[0]!)?.url).toBe('https://a.example.com/');
    expect(routeNotification({ url: 'https://evil.example.com' }, servers, servers[0]!)?.url).toBe('https://a.example.com/');
    expect(routeNotification(null, servers, servers[0]!)).toBeNull();
    expect(routeNotification({ url: '/x' }, servers, null)).toBeNull();
  });
  it('isSafePath', () => {
    expect(isSafePath('/requests/1?action=approve')).toBe(true);
    for (const bad of ['', 'requests', '//x', '/\\x', 'javascript:x', 5, null]) expect(isSafePath(bad)).toBe(false);
  });
});

describe('shareQuery', () => {
  it('uses the title from IMDb / TMDB shares', () => {
    expect(shareQuery('', ['Dune: Part Two (2024) ⭐ 8.5 | Action, Adventure\nhttps://www.imdb.com/title/tt15239678/'])).toBe('Dune: Part Two');
    expect(shareQuery('Arrival (2016) - IMDb', ['https://m.imdb.com/title/tt2543164/'])).toBe('Arrival');
    expect(shareQuery(null, ['Severance — The Movie Database (TMDB) https://www.themoviedb.org/tv/95396-severance'])).toBe('Severance');
  });
  it('falls back to the id / slug of a bare link', () => {
    expect(shareQuery('', ['https://www.imdb.com/title/tt2543164/?ref_=x'])).toBe('tt2543164');
    expect(shareQuery('', ['https://www.themoviedb.org/movie/329865-arrival'])).toBe('arrival');
    expect(shareQuery('', ['https://www.themoviedb.org/movie/329865'])).toBe('tmdb:movie/329865');
    expect(shareQuery('', ['https://example.com/'])).toBeNull();
  });
  it('plain text', () => {
    expect(shareQuery(undefined, ['  The   Expanse  '])).toBe('The Expanse');
    expect(discoverSearchPath('Dune: Part Two')).toBe('/discover/search?q=Dune%3A%20Part%20Two');
  });
});

describe('shouldLockOnResume', () => {
  const on = { ...DEFAULT_SETTINGS, biometricLock: true, lockAfterMinutes: 5 };
  it('locks after the configured time only when enabled', () => {
    expect(shouldLockOnResume(on, 0, 5 * 60_000)).toBe(true);
    expect(shouldLockOnResume(on, 0, 4 * 60_000)).toBe(false);
    expect(shouldLockOnResume({ ...on, lockAfterMinutes: 0 }, 1000, 1000)).toBe(true);
    expect(shouldLockOnResume(DEFAULT_SETTINGS, 0, 10 ** 9)).toBe(false);
    expect(shouldLockOnResume(on, null, 10 ** 9)).toBe(false);
  });
});
