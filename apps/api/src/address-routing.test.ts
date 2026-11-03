import { describe, expect, it } from 'vitest';
import { PublicPlayerAddress, PublicPortalSettings } from '@arclight/shared';
import { spaRoute } from './address-routing.js';

// The page-load decision for the portal and player addresses together.

const portal = PublicPortalSettings.parse({
  enabled: true,
  paths: ['/requests-here'],
  hosts: [
    { hostname: 'requests.example.com', portalOnly: true },
    { hostname: 'family.example.com', portalOnly: false },
  ],
});
const player = PublicPlayerAddress.parse({
  paths: ['/watch', '/tv'],
  hosts: [
    { hostname: 'watch.example.com', playerOnly: true },
    { hostname: 'media.example.com', playerOnly: false },
  ],
});
const route = (host: string, path: string, p = portal) => spaRoute(p, player, host, path);

describe('spaRoute', () => {
  it('maps player paths on any hostname, case-insensitively', () => {
    expect(route('nas.local:7878', '/watch/watch/movies')).toEqual({ kind: 'serve', portal: null, player: { mode: 'path', base: '/watch' } });
    expect(route('nas.local', '/TV')).toEqual({ kind: 'serve', portal: null, player: { mode: 'path', base: '/tv' } });
    expect(route('nas.local', '/player/music')).toEqual({ kind: 'serve', portal: null, player: null });
    expect(route('nas.local', '/library/movies')).toEqual({ kind: 'serve', portal: null, player: null });
  });

  it('keeps portal paths the portal’s', () => {
    expect(route('nas.local', '/requests-here/movie/603')).toEqual({ kind: 'serve', portal: { mode: 'path', base: '/requests-here' }, player: null });
  });

  it('serves the player at the root of a player-only hostname and redirects everything else', () => {
    const host = { kind: 'serve', portal: null, player: { mode: 'host', playerOnly: true } };
    for (const path of ['/', '/watch/movies/12', '/music/album/3', '/link', '/player/books', '/settings']) expect(route('Watch.Example.com:443', path), path).toEqual(host);
    for (const path of ['/login', '/setup']) expect(route('watch.example.com', path), path).toEqual(host);
    for (const path of ['/library/movies', '/requests', '/portal', '/requests-here', '/system/status']) {
      expect(route('watch.example.com', path), path).toEqual({ kind: 'redirect', location: '/' });
    }
  });

  it('shows the app at its other paths on a player hostname without "Player only"', () => {
    expect(route('media.example.com', '/')).toEqual({ kind: 'serve', portal: null, player: { mode: 'host', playerOnly: false } });
    expect(route('media.example.com', '/library/movies')).toEqual({ kind: 'serve', portal: null, player: { mode: 'host', playerOnly: false } });
    expect(route('media.example.com', '/requests-here')).toEqual({ kind: 'serve', portal: { mode: 'path', base: '/requests-here' }, player: { mode: 'host', playerOnly: false } });
  });

  it('keeps portal hostnames the portal’s, next to player hostnames', () => {
    expect(route('requests.example.com', '/')).toEqual({ kind: 'serve', portal: { mode: 'host', portalOnly: true }, player: null });
    expect(route('requests.example.com', '/watch')).toEqual({ kind: 'redirect', location: '/' });
    expect(route('family.example.com', '/tv/music')).toEqual({ kind: 'serve', portal: { mode: 'host', portalOnly: false }, player: { mode: 'path', base: '/tv' } });
  });

  it('ignores portal hostnames while the portal is off', () => {
    const off = { ...portal, enabled: false };
    expect(route('requests.example.com', '/library/movies', off)).toEqual({ kind: 'serve', portal: null, player: null });
    expect(route('watch.example.com', '/requests-here', off)).toEqual({ kind: 'redirect', location: '/' });
  });

  it('shows the "player is off" page at the player addresses while the player is off', () => {
    const off = (host: string, path: string) => spaRoute(portal, player, host, path, false);
    const toPlayer = { kind: 'redirect', location: '/player' };
    const plain = { kind: 'serve', portal: null, player: null };
    // Player-only hostname: /player (the off page), sign-in and setup; the rest goes there.
    for (const path of ['/', '/watch/movies/12', '/music', '/library/movies', '/settings']) expect(off('watch.example.com', path), path).toEqual(toPlayer);
    for (const path of ['/player', '/player/music', '/login', '/setup']) expect(off('watch.example.com', path), path).toEqual(plain);
    // A hostname without "Player only": its root goes to the off page, the app answers elsewhere.
    expect(off('media.example.com', '/')).toEqual(toPlayer);
    expect(off('media.example.com', '/library/movies')).toEqual(plain);
    expect(off('media.example.com', '/requests-here')).toEqual({ kind: 'serve', portal: { mode: 'path', base: '/requests-here' }, player: null });
    // Extra paths on any hostname, and no player mapping anywhere.
    expect(off('nas.example.com', '/watch')).toEqual(toPlayer);
    expect(off('nas.example.com', '/TV/music')).toEqual(toPlayer);
    expect(off('nas.example.com', '/player/music')).toEqual(plain);
    expect(off('family.example.com', '/tv/music')).toEqual(toPlayer);
    expect(off('requests.example.com', '/')).toEqual({ kind: 'serve', portal: { mode: 'host', portalOnly: true }, player: null });
    expect(off('requests.example.com', '/tv')).toEqual({ kind: 'serve', portal: { mode: 'host', portalOnly: true }, player: null });
  });

  it('works with no player address at all', () => {
    expect(spaRoute(portal, PublicPlayerAddress.parse({}), 'nas.local', '/watch')).toEqual({ kind: 'serve', portal: null, player: null });
  });
});
