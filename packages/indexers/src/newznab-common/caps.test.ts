import { describe, expect, it } from 'vitest';
import newznabCaps from '../../fixtures/newznab-caps.xml?raw';
import torznabCaps from '../../fixtures/torznab-caps.xml?raw';
import { IndexerError } from '../types.js';
import { parseCaps } from './caps.js';
import { parseResponse } from './xml.js';

function caps(body: string) {
  return parseCaps(parseResponse({ status: 200, body, safeUrl: 'x', hadApiKey: true }));
}

describe('parseCaps', () => {
  it('reads Torznab limits, server and search modes', () => {
    const c = caps(torznabCaps);
    expect(c.serverTitle).toBe('Jackett');
    expect(c.limits).toEqual({ max: 100, default: 50 });
    expect(c.searching.search).toEqual({ available: true, supportedParams: ['q'] });
    expect(c.searching.tvSearch.supportedParams).toEqual(['q', 'season', 'ep', 'imdbid', 'tvdbid']);
    expect(c.searching.movieSearch.supportedParams).toEqual(['q', 'imdbid', 'tmdbid']);
  });

  it('reads the Torznab category tree including tracker-specific ids', () => {
    const c = caps(torznabCaps);
    expect(c.categories.map((x) => x.id)).toEqual([2000, 5000, 100001, 100002]);
    const movies = c.categories[0];
    expect(movies?.name).toBe('Movies');
    expect(movies?.subcats).toEqual([
      { id: 2040, name: 'Movies/HD' },
      { id: 2045, name: 'Movies/UHD' },
      { id: 100001, name: 'Movies/HD 1080p' },
    ]);
    expect(c.categories[2]?.subcats).toEqual([]);
  });

  it('reads Newznab caps and defaults supportedParams to q', () => {
    const c = caps(newznabCaps);
    expect(c.serverTitle).toBe('Example Usenet');
    expect(c.limits).toEqual({ max: 200, default: 75 });
    expect(c.searching.tvSearch.supportedParams).toEqual(['q', 'rid', 'tvdbid', 'season', 'ep']);
    expect(c.searching.movieSearch).toEqual({ available: true, supportedParams: ['q'] });
    expect(c.categories.find((x) => x.id === 5000)?.subcats.map((s) => s.id)).toEqual([5030, 5040, 5070]);
  });

  it('marks modes with available="no" or missing as unavailable', () => {
    const c = caps(
      '<caps><searching><search available="yes"/><tv-search available="no" supportedParams="q"/></searching></caps>',
    );
    expect(c.searching.tvSearch).toEqual({ available: false, supportedParams: [] });
    expect(c.searching.movieSearch.available).toBe(false);
  });

  it('falls back to defaults when sections are missing', () => {
    const c = caps('<caps><limits default="25"/></caps>');
    expect(c.limits).toEqual({ max: 25, default: 25 });
    expect(c.searching.search).toEqual({ available: true, supportedParams: ['q'] });
    expect(c.categories).toEqual([]);
  });

  it('rejects documents without a caps root', () => {
    expect(() => caps('<rss><channel/></rss>')).toThrowError(IndexerError);
    try {
      caps('<rss><channel/></rss>');
    } catch (err) {
      expect((err as IndexerError).code).toBe('caps-failed');
    }
  });
});
