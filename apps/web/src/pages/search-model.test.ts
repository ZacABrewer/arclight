import { describe, expect, it } from 'vitest';
import type { IndexerCategory, ReleaseResource } from '@arclight/shared';
import { libraryMatches } from '../layout/search-matches.js';
import { toPushRequest } from '../api/releases.js';
import { categoryNameMap, categoryOptions, downloadLink, EMPTY_SEARCH, filterResults, formatAge, peersLabel, toSearchRequest } from './search-model.js';

const release = (over: Partial<ReleaseResource> = {}): ReleaseResource => ({
  guid: 'g1',
  title: 'Show.S01E01.1080p.WEB-DL-GRP',
  size: 1_000_000,
  publishDate: '2026-10-20T00:00:00Z',
  downloadUrl: 'https://indexer/dl/1',
  categories: [5040],
  indexerId: 1,
  indexerName: 'Idx',
  indexerPriority: 25,
  protocol: 'torrent',
  seeders: 12,
  leechers: 3,
  age: 5,
  ageHours: 120,
  ageMinutes: 7200,
  rejections: [],
  approved: false,
  ...over,
});

const cats: IndexerCategory[] = [
  { id: 2000, name: 'Movies', subCategories: [{ id: 2040, name: 'Movies/HD' }] },
  { id: 5000, name: 'TV', subCategories: [{ id: 5040, name: 'HD' }] },
];

describe('search page filters', () => {
  it('maps the form to the GET /search query', () => {
    expect(toSearchRequest({ ...EMPTY_SEARCH, query: '   ' })).toBeNull();
    expect(toSearchRequest({ query: ' dune ', kind: 'movie', categories: [2040, 2000], indexerIds: [3] })).toEqual({
      query: 'dune',
      type: 'movie',
      categories: [2000, 2040],
      indexerIds: [3],
    });
    expect(toSearchRequest({ ...EMPTY_SEARCH, query: 'x', kind: 'series' })).toEqual({ query: 'x', type: 'tv' });
    expect(toSearchRequest({ ...EMPTY_SEARCH, query: 'x' })?.type).toBe('search');
  });

  it('narrows category options to the chosen type and names sub-categories', () => {
    expect(categoryOptions(cats, 'series').map((o) => o.value)).toEqual([5000, 5040]);
    expect(categoryOptions(cats).filter((o) => o.child).map((o) => o.value)).toEqual([2040, 5040]);
    const names = categoryNameMap(cats);
    expect(names.get(5040)).toBe('TV/HD');
    expect(names.get(2040)).toBe('Movies/HD');
  });

  it('refines results by protocol and title words', () => {
    const results = [release(), release({ guid: 'g2', title: 'Show.S01E02.720p.HDTV', protocol: 'usenet' }), release({ guid: 'g3', title: 'Other.Show.2160p' })];
    expect(filterResults(results, { protocol: 'all', text: 'show 1080p' }).map((r) => r.guid)).toEqual(['g1']);
    expect(filterResults(results, { protocol: 'usenet', text: '' }).map((r) => r.guid)).toEqual(['g2']);
  });

  it('formats peers, age and download links, and builds the push fallback body', () => {
    expect(peersLabel(release())).toBe('12 / 3');
    expect(peersLabel(release({ protocol: 'usenet', grabs: 40 }))).toBe('40 grabs');
    expect(formatAge(release({ ageMinutes: 42 }))).toBe('42m');
    expect(formatAge(release({ ageMinutes: 300 }))).toBe('5h');
    expect(formatAge(release())).toBe('5d');
    expect(downloadLink(release({ downloadUrl: '', magnetUrl: 'magnet:?xt=1' }))).toBe('magnet:?xt=1');
    expect(toPushRequest(release())).toMatchObject({ title: 'Show.S01E01.1080p.WEB-DL-GRP', guid: 'g1', indexerId: 1, downloadUrl: 'https://indexer/dl/1', seeders: 12 });
  });

  it('ranks top-bar library matches by prefix then title', () => {
    const series = [
      { id: 1, title: 'The Expanse', year: 2015 },
      { id: 2, title: 'Expats', year: 2024 },
    ];
    const movies = [{ id: 9, title: 'Expanse: The Movie', year: 2030 }];
    expect(libraryMatches('expan', series, movies).map((m) => `${m.kind}:${m.id}`)).toEqual(['movie:9', 'series:1']);
    expect(libraryMatches('  ', series, movies)).toEqual([]);
    expect(libraryMatches('expanse the', series, movies)).toHaveLength(2);
  });
});
