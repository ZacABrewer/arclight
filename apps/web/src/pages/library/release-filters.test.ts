import { describe, expect, it } from 'vitest';
import { QUALITIES, type QualityName, type ReleaseDecision } from '@arclight/shared';
import {
  DEFAULT_RELEASE_FILTERS,
  activeReleaseFilterCount,
  filterReleases,
  formatSizeGb,
  normalizeTitle,
  parseSizeGb,
  releaseFilterChoices,
  type ReleaseFilters,
} from './release-filters.js';

const GB = 1024 ** 3;

type Row = Pick<ReleaseDecision, 'title' | 'quality' | 'indexerId' | 'indexerName' | 'protocol' | 'size' | 'seeders' | 'approved'>;

function row(title: string, q: QualityName, over: Partial<Row> = {}): Row {
  const def = QUALITIES[q];
  return {
    title,
    quality: { quality: { ...def, mediaTypes: [...def.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } },
    indexerId: 1,
    indexerName: 'Alpha',
    protocol: 'torrent',
    size: 4 * GB,
    seeders: 50,
    approved: true,
    ...over,
  };
}

const rows: Row[] = [
  row('Dune.Part.Two.2024.2160p.WEB-DL.x265-GRP', 'WEBDL-2160p', { size: 20 * GB }),
  row('Dune.Part.Two.2024.1080p.BluRay.x264-GRP', 'Bluray-1080p', { indexerId: 2, indexerName: 'Beta', size: 10 * GB, seeders: 3 }),
  row('Dune Part Two 2024 1080p WEB-DL', 'WEBDL-1080p', { protocol: 'usenet', seeders: undefined, indexerId: 3, indexerName: 'News', approved: false }),
  row('Dune_Part_Two_2024_720p_HDTV', 'HDTV-720p', { size: 1.5 * GB, seeders: undefined, approved: false }),
];

const titles = (f: Partial<ReleaseFilters>) => filterReleases(rows, { ...DEFAULT_RELEASE_FILTERS, ...f }).map((r) => r.title);

describe('release filters', () => {
  it('passes everything with the defaults', () => {
    expect(titles({})).toHaveLength(4);
    expect(activeReleaseFilterCount(DEFAULT_RELEASE_FILTERS)).toBe(0);
  });

  it('matches every title word, ignoring case and separators', () => {
    expect(normalizeTitle('Dune.Part_Two-2024')).toBe('dune part two 2024');
    expect(titles({ title: 'part two 1080p' })).toEqual([rows[1]!.title, rows[2]!.title]);
    expect(titles({ title: 'DUNE.PART.TWO 720P' })).toEqual([rows[3]!.title]);
    expect(titles({ title: 'x265 bluray' })).toEqual([]);
    expect(titles({ title: '   ' })).toHaveLength(4);
  });

  it('filters by qualities and indexers (any of the chosen ones)', () => {
    const webdl1080 = QUALITIES['WEBDL-1080p'].id;
    const bluray1080 = QUALITIES['Bluray-1080p'].id;
    expect(titles({ qualities: [webdl1080, bluray1080] })).toEqual([rows[1]!.title, rows[2]!.title]);
    expect(titles({ indexers: [1] })).toEqual([rows[0]!.title, rows[3]!.title]);
    expect(titles({ indexers: [2, 3], qualities: [bluray1080] })).toEqual([rows[1]!.title]);
  });

  it('filters by protocol and decision', () => {
    expect(titles({ protocol: 'usenet' })).toEqual([rows[2]!.title]);
    expect(titles({ protocol: 'torrent' })).toHaveLength(3);
    expect(titles({ decision: 'approved' })).toEqual([rows[0]!.title, rows[1]!.title]);
    expect(titles({ decision: 'rejected' })).toEqual([rows[2]!.title, rows[3]!.title]);
  });

  it('bounds the size on both ends (inclusive)', () => {
    expect(titles({ minSize: 10 * GB })).toEqual([rows[0]!.title, rows[1]!.title]);
    expect(titles({ maxSize: 4 * GB })).toEqual([rows[2]!.title, rows[3]!.title]);
    expect(titles({ minSize: 2 * GB, maxSize: 10 * GB })).toEqual([rows[1]!.title, rows[2]!.title]);
  });

  it('hides torrents below the minimum seeders (unknown counts as none); usenet passes', () => {
    expect(titles({ minSeeders: 10 })).toEqual([rows[0]!.title, rows[2]!.title]);
    expect(titles({ minSeeders: 3 })).toEqual([rows[0]!.title, rows[1]!.title, rows[2]!.title]);
    expect(titles({ minSeeders: 0 })).toHaveLength(4);
  });

  it('counts active filters, a size range as one', () => {
    const f: ReleaseFilters = { ...DEFAULT_RELEASE_FILTERS, title: 'dune', qualities: [1], minSize: GB, maxSize: 2 * GB, minSeeders: 0, decision: 'approved' };
    expect(activeReleaseFilterCount(f)).toBe(4);
    expect(activeReleaseFilterCount({ ...DEFAULT_RELEASE_FILTERS, indexers: [1], protocol: 'usenet', minSeeders: 5 })).toBe(3);
  });

  it('offers the qualities (best first) and indexers present in the results', () => {
    const choices = releaseFilterChoices(rows);
    expect(choices.qualities.map((q) => q.label)).toEqual(['WEBDL-2160p', 'Bluray-1080p', 'WEBDL-1080p', 'HDTV-720p']);
    expect(choices.indexers).toEqual([
      { value: 1, label: 'Alpha' },
      { value: 2, label: 'Beta' },
      { value: 3, label: 'News' },
    ]);
    expect(choices).toMatchObject({ mixedProtocols: true, hasTorrents: true });
    expect(releaseFilterChoices([rows[2]!])).toMatchObject({ mixedProtocols: false, hasTorrents: false });
  });

  it('reads and writes the GB size fields', () => {
    expect(parseSizeGb('1.5')).toBe(1.5 * GB);
    expect(parseSizeGb('2,5')).toBe(2.5 * GB);
    expect(parseSizeGb('')).toBeNull();
    expect(parseSizeGb('abc')).toBeNull();
    expect(parseSizeGb('-1')).toBeNull();
    expect(formatSizeGb(1.5 * GB)).toBe('1.5');
    expect(formatSizeGb(null)).toBe('');
  });
});
