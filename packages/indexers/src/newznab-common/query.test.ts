import { describe, expect, it } from 'vitest';
import newznabCapsXml from '../../fixtures/newznab-caps.xml?raw';
import torznabCapsXml from '../../fixtures/torznab-caps.xml?raw';
import type { IndexerDefinition, SearchRequest } from '../types.js';
import { IndexerError } from '../types.js';
import { defaultCapabilities, parseCaps } from './caps.js';
import { buildCapsUrl, buildSearchUrl, planSearch, type Flavor } from './query.js';
import { parseResponse } from './xml.js';

const parse = (body: string) => parseCaps(parseResponse({ status: 200, body, safeUrl: 'x', hadApiKey: true }));
const torznabCaps = parse(torznabCapsXml);
const newznabCaps = parse(newznabCapsXml);

const torrentDef: IndexerDefinition = {
  name: 'Jackett',
  baseUrl: 'http://jackett:9117/api/v2.0/indexers/all/results/torznab/',
  apiKey: 'secret',
  categories: [2000, 2040, 5000, 5040],
  animeCategories: [5070],
  protocol: 'torrent',
};

const usenetDef: IndexerDefinition = {
  name: 'Usenet',
  baseUrl: 'https://nzb.example.invalid',
  apiKey: 'k3y',
  categories: [2000, 5000],
  protocol: 'usenet',
};

function url(req: SearchRequest, def = torrentDef, flavor: Flavor = 'torznab', caps = torznabCaps): URL {
  return new URL(buildSearchUrl(def, planSearch(def, req, caps, flavor), { limit: 100 }));
}

function expectUnsupported(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable('expected unsupported-search');
  } catch (err) {
    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).code).toBe('unsupported-search');
  }
}

describe('URL building', () => {
  it('builds the caps URL with the default /api path and apikey', () => {
    expect(buildCapsUrl(torrentDef)).toBe(
      'http://jackett:9117/api/v2.0/indexers/all/results/torznab/api?t=caps&apikey=secret',
    );
    expect(buildCapsUrl({ ...usenetDef, apiKey: '  ' })).toBe('https://nzb.example.invalid/api?t=caps');
  });

  it('honours a custom apiPath with or without a leading slash', () => {
    expect(buildCapsUrl({ ...usenetDef, apiPath: 'nzbapi/' })).toBe(
      'https://nzb.example.invalid/nzbapi?t=caps&apikey=k3y',
    );
  });

  it('builds an RSS query with all categories, extended=1 and a limit', () => {
    const u = url({ kind: 'rss' });
    expect(u.searchParams.get('t')).toBe('search');
    expect(u.searchParams.has('q')).toBe(false);
    expect(u.searchParams.get('cat')).toBe('2000,2040,5000,5040,5070');
    expect(u.searchParams.get('extended')).toBe('1');
    expect(u.searchParams.get('limit')).toBe('100');
    expect(u.searchParams.get('apikey')).toBe('secret');
    expect(u.search).toContain('cat=2000,2040,5000,5040,5070');
  });

  it('encodes free-text queries with %20 and escapes reserved characters', () => {
    const raw = buildSearchUrl(torrentDef, planSearch(torrentDef, { kind: 'search', query: ' Tom & Jerry+1 ' }, torznabCaps, 'torznab'));
    expect(raw).toContain('q=Tom%20%26%20Jerry%2B1');
    expect(new URL(raw).searchParams.get('q')).toBe('Tom & Jerry+1');
  });

  it('appends additionalParameters and puts the apikey last; adds offset only when > 0', () => {
    const def = { ...torrentDef, additionalParameters: '&attrs=poster&foo=bar' };
    const plan = planSearch(def, { kind: 'rss' }, torznabCaps, 'torznab');
    const first = buildSearchUrl(def, plan, { limit: 50, offset: 0 });
    const second = buildSearchUrl(def, plan, { limit: 50, offset: 50 });
    expect(first).not.toContain('offset=');
    expect(second).toContain('&offset=50');
    expect(first.endsWith('&attrs=poster&foo=bar&apikey=secret')).toBe(true);
  });
});

describe('tv search planning', () => {
  it('uses tvsearch with tvdbid, season and ep and leaves q out when ids are used', () => {
    const u = url({ kind: 'tv', query: 'Show Name', tvdbId: 123456, season: 1, episode: 2 });
    expect(u.searchParams.get('t')).toBe('tvsearch');
    expect(u.searchParams.get('tvdbid')).toBe('123456');
    expect(u.searchParams.get('season')).toBe('1');
    expect(u.searchParams.get('ep')).toBe('2');
    expect(u.searchParams.has('q')).toBe(false);
    // movie ids are dropped from TV searches, anime categories added
    expect(u.searchParams.get('cat')).toBe('5000,5040,5070');
  });

  it('uses q with season when no supported id is given', () => {
    const u = url({ kind: 'tv', query: 'Show Name', tmdbId: 99, season: 3 });
    expect(u.searchParams.get('t')).toBe('tvsearch');
    expect(u.searchParams.get('q')).toBe('Show Name');
    expect(u.searchParams.has('tmdbid')).toBe(false);
    expect(u.searchParams.get('season')).toBe('3');
    expect(u.searchParams.has('ep')).toBe(false);
  });

  it('formats imdb ids per flavour', () => {
    expect(url({ kind: 'tv', imdbId: '944947' }).searchParams.get('imdbid')).toBe('tt0944947');
    const movie = { ...newznabCaps, searching: { ...newznabCaps.searching, movieSearch: { available: true, supportedParams: ['imdbid' as const] } } };
    expect(url({ kind: 'movie', imdbId: 'tt0137523' }, usenetDef, 'newznab', movie).searchParams.get('imdbid')).toBe('0137523');
  });

  it('sends daily air dates as season=YYYY and ep=MM/DD', () => {
    const u = url({ kind: 'tv', tvdbId: 1, airDate: '2026-10-24' });
    expect(u.searchParams.get('season')).toBe('2026');
    expect(u.searchParams.get('ep')).toBe('10/24');
    expect(u.search).toContain('ep=10/24');
  });

  it('falls back to t=search with an SxxEyy query when tv-search is unavailable', () => {
    const caps = defaultCapabilities();
    const u = url({ kind: 'tv', query: 'Show Name', tvdbId: 1, season: 1, episode: 2 }, torrentDef, 'torznab', caps);
    expect(u.searchParams.get('t')).toBe('search');
    expect(u.searchParams.get('q')).toBe('Show Name S01E02');
    expect(u.searchParams.has('tvdbid')).toBe(false);
  });

  it('rejects a TV search with no usable id and no query', () => {
    expectUnsupported(() => planSearch(torrentDef, { kind: 'tv', tmdbId: 5 }, torznabCaps, 'torznab'));
    expectUnsupported(() => planSearch(torrentDef, { kind: 'tv', tvdbId: 1, airDate: '24/10/2026' }, torznabCaps, 'torznab'));
  });
});

describe('movie and basic search planning', () => {
  it('uses t=movie with imdbid and tmdbid, omitting unsupported year and non-movie categories', () => {
    const u = url({ kind: 'movie', query: 'Fight Club', imdbId: 'tt0137523', tmdbId: 550, year: 1999 });
    expect(u.searchParams.get('t')).toBe('movie');
    expect(u.searchParams.get('imdbid')).toBe('tt0137523');
    expect(u.searchParams.get('tmdbid')).toBe('550');
    expect(u.searchParams.has('year')).toBe(false);
    expect(u.searchParams.has('q')).toBe(false);
    expect(u.searchParams.get('cat')).toBe('2000,2040');
  });

  it('uses q on a q-only movie-search indexer', () => {
    const u = url({ kind: 'movie', query: 'Fight Club', imdbId: 'tt0137523' }, usenetDef, 'newznab', newznabCaps);
    expect(u.searchParams.get('t')).toBe('movie');
    expect(u.searchParams.get('q')).toBe('Fight Club');
    expect(u.searchParams.has('imdbid')).toBe(false);
    expect(u.searchParams.get('cat')).toBe('2000');
  });

  it('adds year when supported and falls back to "title year" text search otherwise', () => {
    const withYear = { ...torznabCaps, searching: { ...torznabCaps.searching, movieSearch: { available: true, supportedParams: ['q' as const, 'year' as const] } } };
    expect(url({ kind: 'movie', query: 'Dune', year: 2021 }, torrentDef, 'torznab', withYear).searchParams.get('year')).toBe('2021');
    const u = url({ kind: 'movie', query: 'Dune', year: 2021 }, torrentDef, 'torznab', defaultCapabilities());
    expect(u.searchParams.get('t')).toBe('search');
    expect(u.searchParams.get('q')).toBe('Dune 2021');
  });

  it('rejects empty free-text searches and searches on indexers without search', () => {
    expectUnsupported(() => planSearch(torrentDef, { kind: 'search', query: '   ' }, torznabCaps, 'torznab'));
    const noSearch = { ...defaultCapabilities(), searching: { ...defaultCapabilities().searching, search: { available: false, supportedParams: [] } } };
    expectUnsupported(() => planSearch(torrentDef, { kind: 'search', query: 'x' }, noSearch, 'torznab'));
  });
});
