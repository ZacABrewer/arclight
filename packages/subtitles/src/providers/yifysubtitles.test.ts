import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SubtitleCandidate, SubtitleQuery } from '../types.js';
import { YifySubtitlesProvider, yifyLanguageFromName } from './yifysubtitles.js';

const fx = (name: string) => readFileSync(new URL(`../../fixtures/yifysubtitles/${name}`, import.meta.url), 'utf8');

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
const make = (routes: Route[]) => {
  const f = fakeFetch(routes);
  return { p: new YifySubtitlesProvider({}, { fetch: f.fn, sleep: async () => {} }), calls: f.calls };
};

const movie: SubtitleQuery = {
  mediaType: 'movie',
  title: 'Inception',
  year: 2010,
  imdbId: 'tt1375666',
  languages: [
    { tag: 'en', forced: false, hi: 'normal' },
    { tag: 'pt-BR', forced: false, hi: 'normal' },
  ],
};

describe('yifysubtitles', () => {
  it('serves movies with an imdb id only', () => {
    const { p } = make([]);
    expect(p.supports(movie).ok).toBe(true);
    expect(p.supports({ ...movie, imdbId: undefined }).ok).toBe(false);
    expect(p.supports({ ...movie, mediaType: 'episode', season: 1, episode: 1, seriesImdbId: 'tt1' }).ok).toBe(false);
  });

  it('maps YIFY language names', () => {
    expect(yifyLanguageFromName('Brazilian Portuguese')).toBe('pt-BR');
    expect(yifyLanguageFromName('Farsi/Persian')).toBe('fa');
    expect(yifyLanguageFromName('Serbian')).toBe('sr');
    expect(yifyLanguageFromName('Klingon')).toBeUndefined();
  });

  it('parses the table, strips "subtitle", joins multi-line releases and sorts by rating', async () => {
    const { p, calls } = make([[/movie-imdb\/tt1375666/, () => new Response(fx('movie.html'))]]);
    const res = await p.search(movie);
    expect(res.map((c) => c.id)).toEqual([
      'inception-2010-english-yify-102',
      'inception-2010-english-yify-101',
      'inception-2010-brazilian-portuguese-yify-103',
    ]);
    expect(res[0]!.releaseInfo).toBe('Inception.2010.1080p.BluRay.x264-SPARKS, Inception.2010.1080p.BluRay.DTS-FGT');
    expect(res[0]!.hi).toBe(true);
    expect(res[0]!.rating).toBe(7);
    expect(res[0]!.uploader).toBe('bob');
    expect(res[1]!.hi).toBe(false);
    expect(res[2]!.language).toBe('pt-BR');
    expect([...res[0]!.matches]).toEqual(['imdb_id']);
    expect(calls[0]!.init?.redirect).toBe('manual');
  });

  it('treats redirects and 404 as no subtitles', async () => {
    const redirect = make([[/movie-imdb/, () => new Response('', { status: 301, headers: { location: '/' } })]]);
    expect(await redirect.p.search(movie)).toEqual([]);
    const missing = make([[/movie-imdb/, () => new Response('', { status: 404 })]]);
    expect(await missing.p.search(movie)).toEqual([]);
  });

  it('maps server errors to unreachable', async () => {
    const { p } = make([[/movie-imdb/, () => new Response('', { status: 503 })]]);
    await expect(p.search(movie)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('downloads the zip via the subtitle page', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const { p, calls } = make([
      [/movie-imdb/, () => new Response(fx('movie.html'))],
      [/\.zip$/, () => new Response(zip)],
      [/subtitles\/inception-2010-english-yify-102$/, () => new Response(fx('subtitle.html'))],
    ]);
    const [best] = await p.search(movie);
    const file = await p.download(best!);
    expect([...file.bytes]).toEqual([...zip]);
    expect(file.fileName).toBe('inception-2010-english-yify-102.zip');
    expect(calls.at(-1)!.url).toBe('https://yifysubtitles.ch/subtitle/inception-2010-english-yify-102.zip');
  });

  it('rejects non-zip downloads and pages without a link', async () => {
    const cand = { pageUrl: 'https://yifysubtitles.ch/subtitles/x' } as SubtitleCandidate;
    const noLink = make([[/subtitles\/x/, () => new Response('<html></html>')]]);
    await expect(noLink.p.download(cand)).rejects.toMatchObject({ code: 'bad-response' });
    const html = make([
      [/subtitles\/x/, () => new Response(fx('subtitle.html'))],
      [/\.zip$/, () => new Response('<html>oops</html>')],
    ]);
    await expect(html.p.download(cand)).rejects.toMatchObject({ code: 'bad-response' });
  });
});
