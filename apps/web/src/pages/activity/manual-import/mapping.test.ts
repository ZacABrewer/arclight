import { describe, expect, it } from 'vitest';
import { QUALITIES, type ManualImportItem } from '@arclight/shared';
import { initRows, needsManualImport, parseLanguages, rowProblems, rowsReducer, toImportRequest } from './mapping.js';
import { parseManualImportSearch, toManualImportQuery } from './manual-import-page.js';

const quality = { quality: { ...QUALITIES['WEBDL-1080p'], mediaTypes: [...QUALITIES['WEBDL-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };

const item = (over: Partial<ManualImportItem> = {}): ManualImportItem => ({
  path: '/dl/Show.S01E01.mkv',
  relativePath: 'Show.S01E01.mkv',
  name: 'Show.S01E01.mkv',
  sizeBytes: 1000,
  quality,
  languages: ['English'],
  releaseGroup: 'GRP',
  rejections: [],
  ...over,
});

describe('manual import mapping', () => {
  it('pre-selects fully mapped files and leaves the rest for the user', () => {
    const rows = initRows([
      item({ mediaType: 'series', seriesId: 1, seasonNumber: 1, episodeIds: [10] }),
      item({ path: '/dl/unknown.mkv', rejections: [{ reason: 'unknownSeries', message: 'Unknown series', type: 'permanent' }] }),
      item({ path: '/dl/sample.mkv', mediaType: 'movie', movieId: 4, rejections: [{ reason: 'sample', message: 'Sample', type: 'permanent' }] }),
      item({ path: '/dl/movie.mkv', movieId: 5 }),
    ]);
    expect(rows.map((r) => r.selected)).toEqual([true, false, false, true]);
    expect(rows[3]?.mediaType).toBe('movie');
    expect(rowProblems(rows[1]!)).toEqual(['Choose a series']);
  });

  it('clears season and episodes when the series changes, and selects once complete', () => {
    let rows = initRows([item({ mediaType: 'series', seriesId: 1, seasonNumber: 1, episodeIds: [10] })]);
    const path = rows[0]!.path;
    rows = rowsReducer(rows, { type: 'series', path, seriesId: 2 });
    expect(rows[0]).toMatchObject({ seriesId: 2, seasonNumber: null, episodeIds: [], selected: false });
    expect(rowProblems(rows[0]!)).toEqual(['Choose a season']);
    rows = rowsReducer(rows, { type: 'season', path, seasonNumber: 3 });
    expect(rowProblems(rows[0]!)).toEqual(['Choose episodes']);
    rows = rowsReducer(rows, { type: 'episodes', path, episodeIds: [31, 32, 31] });
    expect(rows[0]).toMatchObject({ episodeIds: [31, 32], selected: true });
  });

  it('switching media type resets the mapping; incomplete rows cannot be selected', () => {
    let rows = initRows([item({ mediaType: 'series', seriesId: 1, seasonNumber: 1, episodeIds: [10] })]);
    const path = rows[0]!.path;
    rows = rowsReducer(rows, { type: 'mediaType', path, mediaType: 'movie' });
    expect(rows[0]).toMatchObject({ mediaType: 'movie', seriesId: null, movieId: null, selected: false });
    rows = rowsReducer(rows, { type: 'toggle', path, selected: true });
    expect(rows[0]!.selected).toBe(false);
    rows = rowsReducer(rows, { type: 'movie', path, movieId: 9 });
    expect(rows[0]!.selected).toBe(true);
    rows = rowsReducer(rows, { type: 'toggleAll', selected: false });
    expect(rows[0]!.selected).toBe(false);
  });

  it('builds the import request from selected, complete rows only', () => {
    let rows = initRows([
      item({ mediaType: 'series', seriesId: 1, seasonNumber: 1, episodeIds: [10], downloadId: 'abc' }),
      item({ path: '/dl/other.mkv' }),
      item({ path: '/dl/m.mkv', movieId: 7, releaseGroup: null }),
    ]);
    rows = rowsReducer(rows, { type: 'quality', path: '/dl/m.mkv', qualityId: QUALITIES['Bluray-2160p'].id });
    rows = rowsReducer(rows, { type: 'releaseGroup', path: rows[0]!.path, releaseGroup: '  NEW ' });
    const body = toImportRequest(rows, 'copy');
    expect(body.importMode).toBe('copy');
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ mediaType: 'series', seriesId: 1, seasonNumber: 1, episodeIds: [10], releaseGroup: 'NEW', downloadId: 'abc' });
    expect(body.items[1]).toMatchObject({ mediaType: 'movie', movieId: 7, releaseGroup: null });
    expect(body.items[1]?.quality?.quality.name).toBe('Bluray-2160p');
  });

  it('parses languages, route search and queue eligibility', () => {
    expect(parseLanguages(' English, French ,,')).toEqual(['English', 'French']);
    expect(parseManualImportSearch({ seriesId: '12', folder: '', junk: 1 })).toEqual({ seriesId: 12 });
    expect(toManualImportQuery({ downloadId: 'x', folder: '/a' })).toEqual({ downloadId: 'x' });
    expect(toManualImportQuery({})).toBeNull();
    expect(needsManualImport({ trackedState: 'importPending', trackedStatus: 'warning', progress: 1 })).toBe(true);
    expect(needsManualImport({ trackedState: 'downloading', trackedStatus: 'ok', progress: 0.5 })).toBe(false);
    expect(needsManualImport({ trackedState: 'imported', trackedStatus: 'error', outputPath: '/dl/x', progress: 1 })).toBe(true);
  });
});
