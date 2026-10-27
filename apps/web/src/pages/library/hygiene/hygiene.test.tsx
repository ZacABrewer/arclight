import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { HygieneFinding } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { makeEpisode, makeMovie, makeSeries } from '../test-fixtures.js';
import { bestSuggestion, buildMapRequest, bulkDuplicateDeletion, defaultKeep, deletableExcept, episodesBySeason, fileName, folderOf, groupDuplicates, guessLabel, initialMapDraft, suggestionLabel } from './hygiene-model.js';

afterEach(() => vi.unstubAllGlobals());

const finding = (over: Partial<HygieneFinding> & { id: number }): HygieneFinding => ({
  type: 'orphan',
  path: `/data/tv/Severance/Season 1/Severance.S01E0${over.id}.mkv`,
  rootFolderPath: '/data/tv',
  sizeBytes: 1_500_000_000,
  mediaFileId: null,
  seriesId: null,
  movieId: null,
  duplicateReason: null,
  duplicateOf: [],
  parsed: { title: 'Severance', year: 2022, mediaType: 'series', seasonNumber: 1, episodeNumbers: [over.id], quality: 'WEBDL-1080p', releaseGroup: 'NTb' },
  suggestions: [{ mediaType: 'series', seriesId: 1, title: 'Severance', year: 2022, score: 1, episodeIds: [100 + over.id], seasonNumber: 1 }],
  foundAt: '2026-10-26T02:00:00.000Z',
  ...over,
});

const dup = (id: number, path: string, others: string[], mediaFileId: number | null = null): HygieneFinding =>
  finding({ id, type: 'duplicate', path, duplicateOf: others, duplicateReason: 'movie', mediaFileId, parsed: null, suggestions: [], sizeBytes: 4_000_000_000 });

describe('hygiene model', () => {
  it('splits paths with either separator', () => {
    expect(fileName('/data/tv/a/b.mkv')).toBe('b.mkv');
    expect(fileName('D:\\Media\\x.mkv')).toBe('x.mkv');
    expect(folderOf('/data/tv/a/b.mkv')).toBe('/data/tv/a');
  });

  it('formats the parser guess', () => {
    expect(guessLabel(finding({ id: 3 }).parsed)).toBe('Severance (2022) · S01E03 · WEBDL-1080p · NTb');
    expect(guessLabel({ title: 'Show', year: null, mediaType: 'series', seasonNumber: 2, episodeNumbers: [1, 2], quality: null, releaseGroup: null })).toBe('Show · S02E01-E02');
    expect(guessLabel(null)).toBe('No guess');
  });

  it('picks the best suggestion and labels it', () => {
    const f = finding({ id: 1, suggestions: [{ mediaType: 'movie', movieId: 1, title: 'A', year: 2000, score: 0.4 }, { mediaType: 'movie', movieId: 2, title: 'B', year: 2001, score: 0.82 }] });
    expect(bestSuggestion(f)?.title).toBe('B');
    expect(suggestionLabel(bestSuggestion(f)!)).toBe('B (2001) · 82%');
    expect(suggestionLabel(finding({ id: 1 }).suggestions[0]!)).toBe('Severance (2022) · in folder');
  });

  it('prefills the map draft and builds the request', () => {
    const d = initialMapDraft(finding({ id: 2 }));
    expect(d).toEqual({ mediaType: 'series', seriesId: 1, episodeIds: [102], movieId: null, importMode: 'move' });
    expect(buildMapRequest(d)).toEqual({ ok: true, body: { mediaType: 'series', seriesId: 1, episodeIds: [102], importMode: 'move' } });
    expect(buildMapRequest({ ...d, episodeIds: [] })).toEqual({ ok: false, error: 'Pick at least one episode.' });
    expect(buildMapRequest({ ...d, mediaType: 'movie' })).toEqual({ ok: false, error: 'Pick a movie.' });
    expect(initialMapDraft({ suggestions: [], parsed: null }).mediaType).toBe('series');
  });

  it('groups duplicates once per set and picks the library copy to keep', () => {
    const records = [dup(1, '/m/Heat (1995)/Heat.mkv', ['/m/Heat (1995)/Heat.copy.mkv'], 5), dup(2, '/m/Heat (1995)/Heat.copy.mkv', ['/m/Heat (1995)/Heat.mkv']), finding({ id: 3 })];
    const groups = groupDuplicates(records);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((e) => e.path)).toEqual(['/m/Heat (1995)/Heat.copy.mkv', '/m/Heat (1995)/Heat.mkv']);
    expect(defaultKeep(groups[0]!)).toBe('/m/Heat (1995)/Heat.mkv');
    expect(deletableExcept(groups[0]!, '/m/Heat (1995)/Heat.mkv').map((f) => f.id)).toEqual([2]);
  });

  it('keeps a referenced path that has no finding', () => {
    const groups = groupDuplicates([dup(4, '/m/b.mkv', ['/m/a.mkv'])]);
    expect(defaultKeep(groups[0]!)).toBe('/m/a.mkv');
    expect(deletableExcept(groups[0]!, '/m/a.mkv').map((f) => f.id)).toEqual([4]);
  });

  it('bulk-deletes every spare copy but never a path any set keeps', () => {
    const records = [
      dup(1, '/m/Heat/Heat.mkv', ['/m/Heat/Heat.copy.mkv'], 5),
      dup(2, '/m/Heat/Heat.copy.mkv', ['/m/Heat/Heat.mkv']),
      dup(4, '/m/b.mkv', ['/m/a.mkv']),
      // /m/a.mkv is kept by the set above, so this set must not delete it
      dup(6, '/m/c.mkv', ['/m/a.mkv', '/m/b.mkv']),
    ];
    const { findings, sets } = bulkDuplicateDeletion(groupDuplicates(records));
    expect(findings.map((f) => f.id).sort()).toEqual([2, 4, 6]);
    expect(sets).toBe(3);
  });

  it('groups episodes by season', () => {
    const out = episodesBySeason([makeEpisode({ id: 3, seasonNumber: 2, episodeNumber: 1 }), makeEpisode({ id: 2, episodeNumber: 2 }), makeEpisode({ id: 1, episodeNumber: 1 })]);
    expect(out.map((s) => [s.season, s.episodes.map((e) => e.id)])).toEqual([
      [1, [1, 2]],
      [2, [3]],
    ]);
  });
});

function hygieneRoutes(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/library/hygiene': {
      lastScan: '2026-10-26T02:00:00.000Z',
      counts: { orphan: 1, duplicate: 2, empty: 1 },
      records: [
        finding({ id: 1 }),
        dup(2, '/data/movies/Heat (1995)/Heat.mkv', ['/data/movies/Heat (1995)/Heat.1080p.mkv'], 9),
        dup(3, '/data/movies/Heat (1995)/Heat.1080p.mkv', ['/data/movies/Heat (1995)/Heat.mkv']),
        finding({ id: 4, type: 'empty', path: '/data/tv/Old Show', parsed: null, suggestions: [], sizeBytes: 0 }),
      ],
    },
    '/api/v1/series': [makeSeries({ id: 1, title: 'Severance', year: 2022 })],
    '/api/v1/movie': [makeMovie({ id: 7, title: 'Heat', year: 1995 })],
    '/api/v1/episode': [makeEpisode({ id: 101, episodeNumber: 1, title: 'Good News About Hell' }), makeEpisode({ id: 102, episodeNumber: 2, title: 'Half Loop' })],
    ...extra,
  });
}

describe('Library → Hygiene', () => {
  it('lists orphans with their guess and counts on the tabs', async () => {
    hygieneRoutes();
    renderAt('/library/hygiene');
    const table = await screen.findByRole('table', { name: 'Orphan files' });
    expect(within(table).getByText('Severance.S01E01.mkv')).toBeTruthy();
    expect(within(table).getByText('Severance (2022) · S01E01 · WEBDL-1080p · NTb')).toBeTruthy();
    expect(within(table).getByText('Severance (2022) · in folder')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Duplicates/ }).textContent).toContain('2');
  });

  it('maps an orphan onto the suggested episode', async () => {
    const api = hygieneRoutes({ 'POST /api/v1/library/hygiene/1/map': { mediaFileId: 55, destination: '/data/tv/Severance/Season 01/S01E01.mkv' } });
    renderAt('/library/hygiene');
    fireEvent.click(await screen.findByRole('button', { name: 'Map Severance.S01E01.mkv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Map file' });
    const ep = await within(dialog).findByRole('checkbox', { name: 'S01E01 Good News About Hell' });
    expect((ep as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'S01E02 Half Loop' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import file' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/api/v1/library/hygiene/1/map')?.body).toEqual({ mediaType: 'series', seriesId: 1, episodeIds: [101, 102], importMode: 'move' }),
    );
  });

  it('asks for a movie before mapping as one', async () => {
    hygieneRoutes();
    renderAt('/library/hygiene');
    fireEvent.click(await screen.findByRole('button', { name: 'Map Severance.S01E01.mkv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Map file' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Movie' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import file' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Pick a movie.');
  });

  it('deletes an orphan after a confirm that names it', async () => {
    const api = hygieneRoutes({ 'DELETE /api/v1/library/hygiene/1': { recycledTo: '/recycle/x.mkv', removedMediaFileId: null } });
    renderAt('/library/hygiene');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Severance.S01E01.mkv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Severance.S01E01.mkv?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/library/hygiene/1')).toBe(true));
  });

  it('groups duplicates and deletes the copies that are not kept', async () => {
    const api = hygieneRoutes({ 'DELETE /api/v1/library/hygiene/3': { recycledTo: null, removedMediaFileId: null } });
    renderAt('/library/hygiene');
    fireEvent.click(await screen.findByRole('tab', { name: /Duplicates/ }));
    const group = await screen.findByRole('region', { name: /Duplicate set/ });
    expect((within(group).getByRole('radio', { name: 'Keep /data/movies/Heat (1995)/Heat.mkv' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(group).getByRole('button', { name: 'Delete others' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete copy' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/library/hygiene/3')).toBe(true));
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/library/hygiene/2')).toBe(false);
  });

  it('lists empty folders and starts a scan', async () => {
    const api = hygieneRoutes({
      'POST /api/v1/library/hygiene/scan': { id: 1, name: 'OrphanScan', status: 'queued', trigger: 'manual', queuedAt: '2026-10-26T12:00:00.000Z', startedAt: null, endedAt: null, durationMs: null, message: null },
    });
    renderAt('/library/hygiene');
    fireEvent.click(await screen.findByRole('tab', { name: /Empty folders/ }));
    expect(await screen.findByText('/data/tv/Old Show')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/library/hygiene/scan')).toBe(true));
  });
});
