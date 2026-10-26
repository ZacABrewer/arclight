import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SubtitleCandidate, SubtitleQuery } from '../types.js';
import { PodnapisiProvider, podnapisiLanguage } from './podnapisi.js';

const fx = (name: string) => readFileSync(new URL(`../../fixtures/podnapisi/${name}`, import.meta.url), 'utf8');

interface Call {
  url: URL;
  headers: Record<string, string>;
}
function make(route: (c: Call) => Response) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: new URL(String(input)), headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return route(c);
  }) as typeof fetch;
  return { p: new PodnapisiProvider({}, { fetch: impl, sleep: async () => {} }), calls };
}
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });

const movie: SubtitleQuery = {
  mediaType: 'movie',
  title: 'Some Movie',
  year: 2020,
  languages: [{ tag: 'en', forced: false, hi: 'normal' }],
};
const movieRoute = (c: Call) => json(fx(c.url.searchParams.get('page') === '2' ? 'search-movie-p2.json' : 'search-movie-p1.json'));

describe('PodnapisiProvider', () => {
  it('maps language codes', () => {
    expect(podnapisiLanguage('pt-BR')).toBe('pt-br');
    expect(podnapisiLanguage('sl')).toBe('sl');
  });

  it('refuses unsupported languages and episodes without numbers', () => {
    const { p } = make(() => json('{}'));
    expect(p.supports({ ...movie, languages: [{ tag: 'tlh', forced: false, hi: 'normal' }] }).ok).toBe(false);
    expect(p.supports({ mediaType: 'episode', title: 'X', languages: movie.languages }).ok).toBe(false);
    expect(p.supports(movie).ok).toBe(true);
  });

  it('sends JSON search with keywords, year, language and movie type; follows pages', async () => {
    const { p, calls } = make(movieRoute);
    await p.search(movie);
    expect(calls).toHaveLength(2);
    const q = calls[0]!.url.searchParams;
    expect(calls[0]!.url.pathname).toBe('/subtitles/search/advanced');
    expect(q.get('keywords')).toBe('Some Movie');
    expect(q.get('year')).toBe('2020');
    expect(q.get('language')).toBe('en');
    expect(q.get('movie_type')).toBe('movie');
    expect(calls[0]!.headers.Accept).toBe('application/json');
    expect(calls[1]!.url.searchParams.get('page')).toBe('2');
  });

  it('maps results: HI flag, forced filtered, de-duplicated, text matches', async () => {
    const { p } = make(movieRoute);
    const res = await p.search(movie);
    expect(res.map((c) => c.id)).toEqual(['aBcD', 'eFgH', 'mNoP']);
    const a = res[0]!;
    expect([...a.matches].sort()).toEqual(['title', 'year']);
    expect(a.releaseInfo).toBe('Some.Movie.2020.1080p.BluRay.x264-SPARKS\nSome.Movie.2020.720p.BluRay.x264-SPARKS');
    expect(a.downloadUrl).toBe('https://www.podnapisi.net/subtitles/aBcD/download');
    expect(a.uploader).toBe('frank');
    expect(a.downloads).toBe(4200);
    expect(res[1]!.hi).toBe(true);
    expect(res[2]!.matches.has('year')).toBe(false);
  });

  it('returns forced only when forced is wanted', async () => {
    const { p } = make(movieRoute);
    const res = await p.search({ ...movie, languages: [{ tag: 'en', forced: true, hi: 'normal' }] });
    expect(res.map((c) => c.id)).toEqual(['iJkL']);
    expect(res[0]!.forced).toBe(true);
  });

  it('episode search filters other episodes and asserts season/episode', async () => {
    const { p, calls } = make(() => json(fx('search-episode.json')));
    const res = await p.search({
      mediaType: 'episode', title: 'The Show', season: 2, episode: 5,
      languages: [{ tag: 'sl', forced: false, hi: 'normal' }],
    });
    expect(calls[0]!.url.searchParams.get('movie_type')).toBe('tv-series');
    expect(calls[0]!.url.searchParams.get('seasons')).toBe('2');
    expect(calls[0]!.url.searchParams.get('episodes')).toBe('5');
    expect(res.map((c) => c.id)).toEqual(['ep5']);
    expect([...res[0]!.matches].sort()).toEqual(['episode', 'season', 'series']);
  });

  it('rejects a response without a data list and maps HTTP errors', async () => {
    await expect(make(() => json('{"oops":1}')).p.search(movie)).rejects.toMatchObject({ code: 'bad-response' });
    await expect(make(() => json('x', 503)).p.search(movie)).rejects.toMatchObject({ code: 'unreachable' });
    await expect(make(() => json('x', 429)).p.search(movie)).rejects.toMatchObject({ code: 'rate-limited' });
  });

  it('downloads the zip', async () => {
    const { p, calls } = make(() => new Response(new Uint8Array([0x50, 0x4b, 3, 4])));
    const f = await p.download({ id: 'aBcD', downloadUrl: 'https://www.podnapisi.net/subtitles/aBcD/download' } as SubtitleCandidate);
    expect(calls[0]!.url.toString()).toBe('https://www.podnapisi.net/subtitles/aBcD/download');
    expect(f.fileName).toBe('aBcD.zip');
    expect(f.bytes.length).toBe(4);
  });
});
