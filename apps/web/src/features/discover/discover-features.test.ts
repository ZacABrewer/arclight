import { describe, expect, it } from 'vitest';
import { PORTAL_ROUTE_SEGMENTS, RESERVED_PORTAL_SEGMENTS } from '@arclight/shared';
import { discoverPath, titleTarget } from './base.js';
import { activeFilterCount, browseQuery, parseBrowseSearch, patchSearch, sortFor, toggleId } from './filters.js';
import { tmdbImage } from './images.js';
import { portalInput, portalOnlyRedirect, portalOutput, portalRewrite, readPortalDocument } from './portal-location.js';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '../../router.js';

describe('portal location mapping', () => {
  const path = { mode: 'path', base: '/watch' } as const;
  const host = { mode: 'host', portalOnly: true } as const;

  it('maps a portal path onto /portal and back', () => {
    expect(portalInput(path, '/watch')).toBe('/portal');
    expect(portalInput(path, '/WATCH/movie/603')).toBe('/portal/movie/603');
    expect(portalInput(path, '/watchlist')).toBe('/watchlist');
    expect(portalInput(path, '/login')).toBe('/login');
    expect(portalOutput(path, '/portal')).toBe('/watch');
    expect(portalOutput(path, '/portal/tv/1399')).toBe('/watch/tv/1399');
    expect(portalOutput(path, '/library/tv')).toBe('/library/tv');
  });

  it('maps a portal hostname root and portal routes onto /portal and back', () => {
    expect(portalInput(host, '/')).toBe('/portal');
    expect(portalInput(host, '/movie/603')).toBe('/portal/movie/603');
    expect(portalInput(host, '/requests')).toBe('/portal/requests');
    expect(portalInput(host, '/portal/search')).toBe('/portal/search');
    expect(portalInput(host, '/login')).toBe('/login');
    expect(portalInput(host, '/settings')).toBe('/settings');
    expect(portalOutput(host, '/portal')).toBe('/');
    expect(portalOutput(host, '/portal/person/31')).toBe('/person/31');
  });

  it('needs no rewrite for the built-in path or plain pages', () => {
    expect(portalRewrite(null)).toBeUndefined();
    expect(portalRewrite({ mode: 'path', base: '/portal' })).toBeUndefined();
    expect(portalRewrite(path)).toBeDefined();
  });

  it('sends portal-only hostnames back to the portal, except sign-in', () => {
    expect(portalOnlyRedirect(host, '/settings/general')).toBe('/portal');
    expect(portalOnlyRedirect(host, '/')).toBe('/portal');
    expect(portalOnlyRedirect(host, '/portal/movies')).toBeNull();
    expect(portalOnlyRedirect(host, '/login')).toBeNull();
    expect(portalOnlyRedirect({ mode: 'host', portalOnly: false }, '/settings')).toBeNull();
    expect(portalOnlyRedirect(path, '/settings')).toBeNull();
  });

  it('reads the mapping the server wrote into the page', () => {
    const doc = document.implementation.createHTMLDocument('x');
    expect(readPortalDocument(doc)).toBeNull();
    const meta = doc.createElement('meta');
    meta.name = 'arclight-portal';
    meta.content = '{"mode":"path","base":"/watch"}';
    doc.head.append(meta);
    expect(readPortalDocument(doc)).toEqual({ mode: 'path', base: '/watch' });
    meta.content = 'not json';
    expect(readPortalDocument(doc)).toBeNull();
  });

  it('keeps the route tree, the portal segments and the reserved paths in step', () => {
    const paths = Object.keys(collectPaths());
    expect(paths.length).toBeGreaterThan(50);
    expect(paths).toContain('/portal/movie/$tmdbId');
    const first = new Set(paths.map((p) => p.split('/')[1] ?? '').filter(Boolean));
    // Every top-level app page is reserved, so a portal path can never hide it.
    for (const seg of first) expect(RESERVED_PORTAL_SEGMENTS, seg).toContain(seg);
    // Every portal page's first segment is known to the server (portal hostnames).
    const portalFirst = new Set(paths.filter((p) => p.startsWith('/portal/')).map((p) => p.split('/')[2] ?? '').filter(Boolean));
    for (const seg of portalFirst) expect(PORTAL_ROUTE_SEGMENTS, seg).toContain(seg);
  });
});

/** Full paths of every route in the tree. */
function collectPaths(): Record<string, unknown> {
  return createRouter({ routeTree, history: createMemoryHistory(), context: { queryClient: new QueryClient() } }).routesByPath as Record<string, unknown>;
}

describe('browse filters in the URL', () => {
  it('drops invalid values and keeps valid ones', () => {
    expect(parseBrowseSearch({ sort: 'drop table', genres: '1|2,abc', from: '99', ratingMin: '11', cert: 'PG-13', region: 'gb', hideAvailable: '1' })).toEqual({
      genres: '1,2',
      cert: 'PG-13',
      region: 'GB',
      hideAvailable: true,
    });
  });

  it('builds the api query with locks, providers, certifications and a vote floor for rating sorts', () => {
    expect(browseQuery('tv', { sort: 'primary_release_date.desc', providers: '8,9', region: 'GB', cert: 'TV-14' })).toEqual({
      sortBy: 'first_air_date.desc',
      watchProviders: '8|9',
      watchRegion: 'GB',
      certificationLte: 'TV-14',
      certificationCountry: 'GB',
    });
    expect(browseQuery('movie', { sort: 'vote_average.desc' })).toMatchObject({ voteCountGte: 100 });
    expect(browseQuery('movie', { genres: '35,18' }, { genre: '18' })).toMatchObject({ genre: '18,35' });
    expect(browseQuery('movie', {}, { studio: 41077 })).toMatchObject({ studio: 41077 });
  });

  it('swaps sorts between movies and series, counts and toggles filters', () => {
    expect(sortFor('movie', 'first_air_date.asc')).toBe('primary_release_date.asc');
    expect(sortFor('tv', 'revenue.desc')).toBe('popularity.desc');
    expect(toggleId('1,2', 2)).toBe('1');
    expect(toggleId(undefined, 5)).toBe('5');
    expect(toggleId('5', 5)).toBeUndefined();
    expect(patchSearch({ genres: '1' }, { genres: undefined, from: '2001' })).toEqual({ from: '2001' });
    expect(activeFilterCount({ hideRequested: true, keywords: '9' })).toBe(2);
  });
});

describe('discover links and images', () => {
  it('resolves discover targets against the app or the portal', () => {
    expect(discoverPath('/discover', titleTarget('series', 1399))).toBe('/discover/tv/1399');
    expect(discoverPath('/portal', titleTarget('movie', 603))).toBe('/portal/movie/603');
    expect(discoverPath('/portal', { to: '' })).toBe('/portal');
  });

  it('picks TMDB image sizes per slot and leaves other URLs alone', () => {
    expect(tmdbImage('https://image.tmdb.org/t/p/w500/abc.jpg', 'poster')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
    expect(tmdbImage('https://image.tmdb.org/t/p/original/abc.jpg', 'backdrop')).toBe('https://image.tmdb.org/t/p/w1280/abc.jpg');
    expect(tmdbImage('/api/v1/mediacover/1/poster.jpg', 'poster')).toBe('/api/v1/mediacover/1/poster.jpg');
    expect(tmdbImage(null, 'poster')).toBeNull();
  });
});
