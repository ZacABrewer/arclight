import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  filterRows,
  movieRow,
  normaliseSearch,
  seriesRow,
  sortLibraryRows,
  type LibraryFilters,
} from './library-filters.js';
import { makeMovie, makeSeries } from './test-fixtures.js';

const stats = (have: number, total: number, size = 0) => ({
  seasonCount: 1,
  episodeCount: total,
  episodeFileCount: have,
  totalEpisodeCount: total,
  monitoredEpisodeCount: total,
  sizeOnDisk: size,
  percentOfEpisodes: total ? (have / total) * 100 : 0,
});

const rows = [
  makeSeries({ id: 1, title: 'The Expanse', year: 2015, status: 'ended', statistics: stats(62, 62, 500), added: '2026-03-01T00:00:00Z', tags: [7] }),
  makeSeries({ id: 2, title: 'Andor', year: 2022, monitored: false, statistics: stats(3, 12, 900), added: '2026-05-01T00:00:00Z', qualityProfileId: 2 }),
  makeSeries({ id: 3, title: 'Pokémon', year: 1997, statistics: stats(0, 0, 0), added: '2026-01-01T00:00:00Z' }),
  makeSeries({ id: 4, title: 'Severance', year: 2022, statistics: stats(9, 18, 300), added: '2026-04-01T00:00:00Z', tags: [7, 8] }),
].map(seriesRow);

const f = (over: Partial<LibraryFilters>): LibraryFilters => ({ ...DEFAULT_FILTERS, ...over });
const ids = (list: { id: number }[]) => list.map((r) => r.id);

describe('library rows', () => {
  it('derives series progress and missing from statistics', () => {
    const andor = rows.find((r) => r.id === 2)!;
    expect(andor).toMatchObject({ have: 3, total: 12, missing: true, sizeOnDisk: 900 });
    expect(rows.find((r) => r.id === 1)!.missing).toBe(false);
  });

  it('treats a movie without a file as missing and 0/1 progress', () => {
    const row = movieRow(makeMovie({ id: 9, title: 'Dune', hasFile: false }));
    expect(row).toMatchObject({ kind: 'movie', have: 0, total: 1, missing: true });
  });
});

describe('filterRows', () => {
  it('search-as-you-type matches every term, ignoring case and accents', () => {
    expect(ids(filterRows(rows, f({ search: 'pokemon' })))).toEqual([3]);
    expect(ids(filterRows(rows, f({ search: 'THE exp' })))).toEqual([1]);
    expect(ids(filterRows(rows, f({ search: '2022' })))).toEqual([2, 4]);
  });

  it('filters by monitored state', () => {
    expect(ids(filterRows(rows, f({ monitored: 'unmonitored' })))).toEqual([2]);
    expect(ids(filterRows(rows, f({ monitored: 'monitored' })))).toEqual([1, 3, 4]);
  });

  it('filters to items missing files', () => {
    expect(ids(filterRows(rows, f({ missing: true })))).toEqual([2, 4]);
  });

  it('filters by quality profile, tag and status', () => {
    expect(ids(filterRows(rows, f({ qualityProfileId: 2 })))).toEqual([2]);
    expect(ids(filterRows(rows, f({ tagId: 8 })))).toEqual([4]);
    expect(ids(filterRows(rows, f({ status: 'ended' })))).toEqual([1]);
  });

  it('combines filters with AND and counts the active ones', () => {
    const filters = f({ tagId: 7, missing: true });
    expect(ids(filterRows(rows, filters))).toEqual([4]);
    expect(activeFilterCount(filters)).toBe(2);
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
  });

  it('normalises search text', () => {
    expect(normaliseSearch('  Marvel’s: Agents of S.H.I.E.L.D.  ')).toBe('marvel s agents of s h i e l d');
  });
});

describe('sortLibraryRows', () => {
  it('sorts by sort title, ignoring a leading "The"', () => {
    expect(ids(sortLibraryRows(rows, { key: 'title', direction: 'asc' }))).toEqual([2, 1, 3, 4]);
  });

  it('sorts by date added descending', () => {
    expect(ids(sortLibraryRows(rows, { key: 'added', direction: 'desc' }))).toEqual([2, 4, 1, 3]);
  });

  it('sorts by year and breaks ties by title', () => {
    expect(ids(sortLibraryRows(rows, { key: 'year', direction: 'desc' }))).toEqual([2, 4, 1, 3]);
  });

  it('sorts by size on disk', () => {
    expect(ids(sortLibraryRows(rows, { key: 'size', direction: 'asc' }))).toEqual([3, 4, 1, 2]);
  });

  it('sorts by progress with nothing-expected items below 0%', () => {
    expect(ids(sortLibraryRows(rows, { key: 'progress', direction: 'asc' }))).toEqual([3, 2, 4, 1]);
  });

  it('does not mutate the input', () => {
    const before = ids(rows);
    sortLibraryRows(rows, { key: 'size', direction: 'desc' });
    expect(ids(rows)).toEqual(before);
  });
});
