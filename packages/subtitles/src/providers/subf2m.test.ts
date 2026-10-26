import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProviderError, type SubtitleQuery } from '../types.js';
import { Subf2mProvider, parseEpisodeInfo, seasonOrdinal, similarity, subf2mLanguageSlug } from './subf2m.js';

const fx = (name: string) => readFileSync(new URL(`../../fixtures/subf2m/${name}`, import.meta.url), 'utf8');

type Route = [RegExp, (url: string, init?: RequestInit) => Response];
function fakeFetch(routes: Route[]) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [re, h] of routes) if (re.test(url)) return h(url, init);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0';
const make = (routes: Route[]) => {
  const f = fakeFetch(routes);
  return { p: new Subf2mProvider({ userAgent: UA }, { fetch: f.fn, sleep: async () => {} }), calls: f.calls };
};

const movie: SubtitleQuery = {
  mediaType: 'movie',
  title: 'The Matrix',
  year: 1999,
  imdbId: 'tt0133093',
  languages: [{ tag: 'en', forced: false, hi: 'normal' }],
};
const episode: SubtitleQuery = {
  mediaType: 'episode',
  title: 'The Expanse',
  year: 2015,
  season: 1,
  episode: 3,
  seriesImdbId: 'tt3230854',
  languages: [{ tag: 'en', forced: false, hi: 'normal' }],
};

describe('subf2m', () => {
  it('requires a user agent', () => {
    expect(() => new Subf2mProvider({ userAgent: '  ' })).toThrow(ProviderError);
  });

  it('has helpers for slugs, ordinals, similarity and episode markers', () => {
    expect(subf2mLanguageSlug('pt-BR')).toBe('brazillian-portuguese');
    expect(subf2mLanguageSlug('fa')).toBe('farsi_persian');
    expect(subf2mLanguageSlug('zh')).toBeUndefined();
    expect(seasonOrdinal(1)).toBe('first');
    expect(seasonOrdinal(20)).toBe('twentieth');
    expect(seasonOrdinal(21)).toBeUndefined();
    expect(similarity('The Matrix', 'the matrix')).toBe(1);
    expect(similarity('The Matrix', 'Matrix')).toBeLessThan(1);
    expect(parseEpisodeInfo('Show.S01E03.720p')).toMatchObject({ season: 1, episode: 3 });
    expect(parseEpisodeInfo('Show.S02.1080p')).toEqual({ completeSeries: false, season: 2 });
    expect(parseEpisodeInfo('Show Season 1-3 pack').seasonRange).toEqual([1, 3]);
    expect(parseEpisodeInfo('Show Complete Series').completeSeries).toBe(true);
  });

  it('refuses languages it does not offer', () => {
    const { p } = make([]);
    expect(p.supports({ ...movie, languages: [{ tag: 'zh', forced: false, hi: 'normal' }] }).ok).toBe(false);
    expect(p.supports(movie).ok).toBe(true);
  });

  it('searches movies: year filter, similarity ranking, imdb verified', async () => {
    const { p, calls } = make([
      [/searchbytitle/, () => new Response(fx('search-movie.html'))],
      [/\/subtitles\/the-matrix\/english$/, () => new Response(fx('list-movie.html'))],
    ]);
    const res = await p.search(movie);
    expect(res.map((c) => c.id)).toEqual(['/subtitles/the-matrix/english/1001', '/subtitles/the-matrix/english/1002']);
    expect(res[0]!.releaseInfo).toBe(
      'The.Matrix.1999.1080p.BluRay.x264-AMIABLE\nThe.Matrix.1999.1080p.BluRay.DTS-FGT\nSynced and corrected',
    );
    expect(res[0]!.uploader).toBe('neo');
    expect([...res[0]!.matches].sort()).toEqual(['imdb_id', 'title', 'year']);
    expect(res[0]!.hiVerifiable).toBe(false);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(UA);
    expect(headers['Sec-Fetch-Mode']).toBe('navigate');
  });

  it('skips a title page whose imdb id differs and tries the next path', async () => {
    const { p } = make([
      [/searchbytitle/, () => new Response(fx('search-movie.html'))],
      [/\/subtitles\/the-matrix\/english$/, () => new Response(fx('list-wrong-imdb.html'))],
      [/\/subtitles\/matrix-1999-tv\/english$/, () => new Response(fx('list-wrong-imdb.html'))],
    ]);
    expect(await p.search(movie)).toEqual([]);
  });

  it('searches episodes with ordinal seasons and recognises packs', async () => {
    const { p, calls } = make([
      [/searchbytitle/, () => new Response(fx('search-series.html'))],
      [/the-expanse-first-season\/english$/, () => new Response(fx('list-episode.html'))],
    ]);
    const res = await p.search(episode);
    expect(res.map((c) => [c.id, c.isPack])).toEqual([
      ['/subtitles/the-expanse-first-season/english/2001', false],
      ['/subtitles/the-expanse-first-season/english/2003', true],
    ]);
    expect([...res[0]!.matches].sort()).toEqual(['episode', 'season', 'series', 'series_imdb_id', 'year']);
    expect(res[1]!.episode).toBe(3);
    expect(calls.some((c) => c.url.includes('second-season'))).toBe(false);
  });

  it('downloads via the download button', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 3, 4, 9]);
    const { p } = make([
      [/english\/1001$/, () => new Response(fx('subtitle.html'))],
      [/1001\/download$/, () => new Response(zip)],
    ]);
    const cand = { pageUrl: 'https://subf2m.co/subtitles/the-matrix/english/1001' } as Parameters<Subf2mProvider['download']>[0];
    const file = await p.download(cand);
    expect([...file.bytes]).toEqual([...zip]);
  });

  it('maps a missing download button and bad archive to api-throttled', async () => {
    const cand = { pageUrl: 'https://subf2m.co/subtitles/x/english/1' } as Parameters<Subf2mProvider['download']>[0];
    const noButton = make([[/english\/1$/, () => new Response('<html></html>')]]);
    await expect(noButton.p.download(cand)).rejects.toMatchObject({ code: 'api-throttled' });
    const bad = make([
      [/english\/1$/, () => new Response('<a id="downloadButton" href="/subtitles/x/english/1/download">d</a>')],
      [/download$/, () => new Response('<html>nope</html>')],
    ]);
    await expect(bad.p.download(cand)).rejects.toMatchObject({ code: 'api-throttled' });
  });

  it('reports captcha for challenge pages and empty for a plain 403', async () => {
    const challenge = make([[/searchbytitle/, () => new Response(fx('challenge.html'), { status: 403 })]]);
    await expect(challenge.p.search(movie)).rejects.toMatchObject({ code: 'captcha' });
    const blocked = make([[/searchbytitle/, () => new Response('Forbidden', { status: 403 })]]);
    expect(await blocked.p.search(movie)).toEqual([]);
  });

  it('retries 503 three times then raises unreachable', async () => {
    let n = 0;
    const { p } = make([[/searchbytitle/, () => (n++, new Response('', { status: 503 }))]]);
    await expect(p.search(movie)).rejects.toMatchObject({ code: 'unreachable' });
    expect(n).toBe(3);
  });
});
