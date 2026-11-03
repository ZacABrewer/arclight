import { afterEach, describe, expect, it } from 'vitest';
import { PLAYER_ROUTE_SEGMENTS } from '@arclight/shared';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { createAppRouter, routeTree } from '../../router.js';
import { isPlayerHostAddress, playerInput, playerOnlyRedirect, playerOutput, playerRewrite, readPlayerDocument } from './player-location.js';

// Player addresses (Settings > Player > Player address): extra paths and player hostnames are
// mapped onto the /player routes and back, like the request portal's addresses.

const path = { mode: 'path', base: '/watch' } as const;
const host = { mode: 'host', playerOnly: true } as const;
const shared = { mode: 'host', playerOnly: false } as const;

describe('player location mapping', () => {
  it('maps an extra path onto /player and back', () => {
    expect(playerInput(path, '/watch')).toBe('/player');
    expect(playerInput(path, '/WATCH/watch/movies/12')).toBe('/player/watch/movies/12');
    expect(playerInput(path, '/watchlist')).toBe('/watchlist');
    expect(playerInput(path, '/player/music')).toBe('/player/music');
    expect(playerInput(path, '/login')).toBe('/login');
    expect(playerOutput(path, '/player')).toBe('/watch');
    expect(playerOutput(path, '/player/music/album/3')).toBe('/watch/music/album/3');
    expect(playerOutput(path, '/library/tv')).toBe('/library/tv');
  });

  it('maps a player hostname root and player routes onto /player and back', () => {
    expect(playerInput(host, '/')).toBe('/player');
    expect(playerInput(host, '/watch/movies/12')).toBe('/player/watch/movies/12');
    expect(playerInput(host, '/link')).toBe('/player/link');
    expect(playerInput(host, '/player/books')).toBe('/player/books');
    expect(playerInput(host, '/login')).toBe('/login');
    expect(playerInput(host, '/library/movies')).toBe('/library/movies');
    expect(playerOutput(host, '/player')).toBe('/');
    expect(playerOutput(host, '/player/watch/shows/4')).toBe('/watch/shows/4');
    expect(playerOutput(host, '/login')).toBe('/login');
    expect(isPlayerHostAddress('/')).toBe(true);
    expect(isPlayerHostAddress('/Music/albums')).toBe(true);
    expect(isPlayerHostAddress('/requests')).toBe(false);
  });

  it('needs no rewrite for the built-in path or a plain page', () => {
    expect(playerRewrite(null)).toBeUndefined();
    expect(playerRewrite({ mode: 'path', base: '/player' })).toBeUndefined();
    expect(playerRewrite(path)).toBeDefined();
  });

  it('sends player-only hostnames back to the player, except sign-in and setup', () => {
    expect(playerOnlyRedirect(host, '/library/movies')).toBe('/player');
    expect(playerOnlyRedirect(host, '/')).toBe('/player');
    expect(playerOnlyRedirect(host, '/player/watch')).toBeNull();
    expect(playerOnlyRedirect(host, '/login')).toBeNull();
    expect(playerOnlyRedirect(host, '/setup')).toBeNull();
    expect(playerOnlyRedirect(shared, '/library/movies')).toBeNull();
    expect(playerOnlyRedirect(path, '/library/movies')).toBeNull();
    expect(playerOnlyRedirect(null, '/library/movies')).toBeNull();
  });

  it('reads the mapping the server wrote into the page', () => {
    const doc = document.implementation.createHTMLDocument('x');
    expect(readPlayerDocument(doc)).toBeNull();
    const meta = doc.createElement('meta');
    meta.name = 'arclight-player';
    meta.content = '{"mode":"host","playerOnly":true}';
    doc.head.append(meta);
    expect(readPlayerDocument(doc)).toEqual(host);
    meta.content = '{"mode":"elsewhere"}';
    expect(readPlayerDocument(doc)).toBeNull();
    meta.content = 'not json';
    expect(readPlayerDocument(doc)).toBeNull();
  });

  it('knows every first segment of the player routes (player hostnames)', () => {
    const paths = Object.keys(createRouter({ routeTree, history: createMemoryHistory(), context: { queryClient: new QueryClient() } }).routesByPath);
    const first = new Set(paths.filter((p) => p.startsWith('/player/')).map((p) => p.split('/')[2] ?? '').filter(Boolean));
    expect(first.size).toBeGreaterThan(3);
    for (const seg of first) expect(PLAYER_ROUTE_SEGMENTS, seg).toContain(seg);
  });
});

/** The address bar for a route path (player routes are registered at run time, so untyped). */
const hrefOf = (router: ReturnType<typeof createAppRouter>, to: string) => router.buildLocation({ to: to as '/' }).publicHref;

describe('router on a player address', () => {
  afterEach(() => window.history.pushState(null, '', '/'));

  it('resolves a player hostname page to the player route and links back without /player', () => {
    window.history.pushState(null, '', '/watch/movies');
    const router = createAppRouter(new QueryClient(), null, '', host);
    expect(router.state.location.pathname).toBe('/player/watch/movies');
    expect(hrefOf(router, '/player/watch/movies/12')).toBe('/watch/movies/12');
    expect(router.buildLocation({ to: '/player' }).publicHref).toBe('/');
  });

  it('resolves an extra path below a base path', () => {
    window.history.pushState(null, '', '/arclight/tv/music');
    const router = createAppRouter(new QueryClient(), null, '/arclight', { mode: 'path', base: '/tv' });
    expect(router.state.location.pathname).toBe('/player/music');
    expect(hrefOf(router, '/player/books')).toBe('/arclight/tv/books');
    expect(router.buildLocation({ to: '/library/tv' }).publicHref).toBe('/arclight/library/tv');
  });

  it('sends other pages on a player-only hostname to the player', async () => {
    window.history.pushState(null, '', '/library/movies');
    const router = createAppRouter(new QueryClient(), null, '', host);
    await router.load();
    expect(router.state.location.pathname).toBe('/player');
  });

  it('keeps the request portal mapping next to the player one', () => {
    window.history.pushState(null, '', '/requests-here/movie/603');
    const router = createAppRouter(new QueryClient(), { mode: 'path', base: '/requests-here' }, '', shared);
    expect(router.state.location.pathname).toBe('/portal/movie/603');
    expect(hrefOf(router, '/player/music')).toBe('/music');
  });
});
