import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractError } from './client.js';
import { subtitlesApi, uploadFormData } from './subtitles.js';

afterEach(() => vi.unstubAllGlobals());

function stub(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('subtitles api', () => {
  it('builds the file query from a scope and parses the contract', async () => {
    const fetch = stub([
      {
        mediaFileId: 1,
        mediaType: 'series',
        seriesId: 3,
        movieId: null,
        episodeIds: [4],
        seasonNumber: 1,
        path: '/tv/a.mkv',
        languageProfileId: 1,
        subtitles: [],
        missing: [{ language: 'en', forced: false, hi: false }],
      },
    ]);
    const files = await subtitlesApi.files({ seriesId: 3 });
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/subtitle/file?seriesId=3');
    expect(files[0]!.missing[0]!.language).toBe('en');
  });

  it('fails loudly when a response drifts from the contract', async () => {
    stub({ page: 1, pageSize: 50, totalRecords: 1, records: [{ nope: true }] });
    await expect(subtitlesApi.wanted('series', 1, 50)).rejects.toBeInstanceOf(ContractError);
  });

  it('omits an empty language from manual search', async () => {
    const fetch = stub({ results: [], errors: [], throttled: [], allThrottled: false });
    await subtitlesApi.manualSearch(7, '');
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/subtitle/search?mediaFileId=7');
  });

  it('serialises upload fields as multipart strings', () => {
    const form = uploadFormData({ mediaFileId: 7, language: 'pt-BR', forced: true, hi: false, file: new Blob(['x']), fileName: 'a.srt' });
    expect([form.get('mediaFileId'), form.get('language'), form.get('forced'), form.get('hi')]).toEqual(['7', 'pt-BR', 'true', 'false']);
    expect((form.get('file') as File).name).toBe('a.srt');
  });
});
