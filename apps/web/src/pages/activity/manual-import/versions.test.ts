import { describe, expect, it } from 'vitest';
import { ManualImportRequest, QUALITIES, type ManualImportItem } from '@arclight/shared';
import { initRows, rowVersionTags, rowsReducer, toImportRequest } from './mapping.js';

const quality = { quality: { ...QUALITIES['WEBDL-2160p'], mediaTypes: [...QUALITIES['WEBDL-2160p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };

const item = (over: Partial<ManualImportItem> = {}): ManualImportItem => ({
  path: '/dl/Dune.2160p.mkv',
  relativePath: 'Dune.2160p.mkv',
  name: 'Dune.2160p.mkv',
  sizeBytes: 1000,
  quality,
  languages: ['English'],
  releaseGroup: 'GRP',
  rejections: [],
  ...over,
});

const series = [{ id: 1, versions: [{ tag: 'Standard' }, { tag: '4K' }] }, { id: 2, versions: null }];
const movies = [{ id: 7, versions: [{ tag: 'Standard' }, { tag: 'Remux' }] }, { id: 8 }];

describe('manual import version picker', () => {
  it('pins the chosen version slot in the import request (contract-valid); best fit omits it', () => {
    let rows = initRows([item({ mediaType: 'movie', movieId: 7 }), item({ path: '/dl/b.mkv', mediaType: 'movie', movieId: 8 })]);
    expect(rows[0]!.versionTag).toBe('');
    rows = rowsReducer(rows, { type: 'version', path: '/dl/Dune.2160p.mkv', versionTag: 'Remux' });
    const body = toImportRequest(rows, 'move');
    expect(body.items[0]).toMatchObject({ movieId: 7, versionTag: 'Remux' });
    expect(body.items[1]).not.toHaveProperty('versionTag');
    expect(ManualImportRequest.parse(body).items[0]?.versionTag).toBe('Remux');
  });

  it('clears the version when the target item changes', () => {
    let rows = initRows([item({ mediaType: 'series', seriesId: 1, seasonNumber: 1, episodeIds: [10] }), item({ path: '/dl/m.mkv', mediaType: 'movie', movieId: 7 })]);
    rows = rowsReducer(rows, { type: 'version', path: rows[0]!.path, versionTag: '4K' });
    rows = rowsReducer(rows, { type: 'version', path: '/dl/m.mkv', versionTag: 'Remux' });
    rows = rowsReducer(rows, { type: 'series', path: rows[0]!.path, seriesId: 2 });
    rows = rowsReducer(rows, { type: 'movie', path: '/dl/m.mkv', movieId: 7 });
    expect(rows[0]!.versionTag).toBe('');
    expect(rows[1]!.versionTag).toBe('Remux');
    rows = rowsReducer(rows, { type: 'movie', path: '/dl/m.mkv', movieId: 8 });
    expect(rows[1]!.versionTag).toBe('');
  });

  it('offers the slots of the chosen series or movie', () => {
    expect(rowVersionTags({ mediaType: 'series', seriesId: 1, movieId: null }, series, movies)).toEqual(['Standard', '4K']);
    expect(rowVersionTags({ mediaType: 'series', seriesId: 2, movieId: null }, series, movies)).toEqual([]);
    expect(rowVersionTags({ mediaType: 'movie', seriesId: null, movieId: 7 }, series, movies)).toEqual(['Standard', 'Remux']);
    expect(rowVersionTags({ mediaType: 'movie', seriesId: null, movieId: 8 }, series, movies)).toEqual([]);
    expect(rowVersionTags({ mediaType: 'movie', seriesId: null, movieId: null }, series, movies)).toEqual([]);
  });
});
