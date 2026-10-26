import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProviderError, type SubtitleCandidate, type SubtitleQuery } from '../types.js';
import { SubdlProvider, nextSubdlReset, subdlLanguageCode } from './subdl.js';

const fx = (name: string) => readFileSync(new URL(`../../fixtures/subdl/${name}`, import.meta.url), 'utf8');

interface Call {
  url: string;
  params: URLSearchParams;
}
type Route = (call: Call) => Response | undefined;

function make(routes: Route[], config = { apiKey: 'KEY' }) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    const call = { url, params: new URL(url).searchParams };
    calls.push(call);
    for (const r of routes) {
      const res = r(call);
      if (res) return res;
    }
    return new Response(fx('not-found.json'), { status: 200 });
  }) as typeof fetch;
  const p = new SubdlProvider(config, { fetch: impl, sleep: async () => {}, now: () => Date.parse('2026-10-25T12:00:00Z') });
  return { p, calls };
}
const json = (body: string | object, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const episode: SubtitleQuery = {
  mediaType: 'episode',
  title: 'The Show',
  year: 2021,
  season: 2,
  episode: 5,
  seriesImdbId: 'tt1234567',
  languages: [
    { tag: 'en', forced: false, hi: 'normal' },
    { tag: 'pt-BR', forced: false, hi: 'normal' },
  ],
};

const exactEpisode: Route = (c) =>
  c.params.get('episode_number') === '5' && c.params.get('season_number') === '2'
    ? json(fx(c.params.get('page') === '2' ? 'episode-page2.json' : 'episode-page1.json'))
    : undefined;

describe('SubdlProvider', () => {
  it('requires an api key', () => {
    expect(() => new SubdlProvider({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('maps language codes', () => {
    expect(subdlLanguageCode('pt-BR')).toBe('BR_PT');
    expect(subdlLanguageCode('en')).toBe('EN');
    expect(subdlLanguageCode('zh-TW')).toBe('ZH_BG');
  });

  it('refuses episodes without season/episode and unsupported languages', () => {
    const { p } = make([]);
    expect(p.supports({ ...episode, episode: undefined }).ok).toBe(false);
    expect(p.supports({ ...episode, languages: [{ tag: 'tlh', forced: false, hi: 'normal' }] }).ok).toBe(false);
    expect(p.supports(episode).ok).toBe(true);
  });

  it('sends the exact episode request with key, languages and flags; caps at 2 pages', async () => {
    const { p, calls } = make([exactEpisode]);
    await p.search(episode);
    const first = calls[0]!;
    expect(first.params.get('api_key')).toBe('KEY');
    expect(first.params.get('imdb_id')).toBe('tt1234567');
    expect(first.params.get('type')).toBe('tv');
    expect(first.params.get('languages')).toBe('BR_PT,EN');
    expect(first.params.get('subs_per_page')).toBe('30');
    expect(first.params.get('releases')).toBe('1');
    const exactCalls = calls.filter((c) => c.params.get('episode_number') === '5' && c.params.get('season_number') === '2');
    expect(exactCalls.map((c) => c.params.get('page'))).toEqual([null, '2']);
    // season-only fallback was also issued
    expect(calls.some((c) => c.params.get('season_number') === '2' && !c.params.has('episode_number'))).toBe(true);
  });

  it('maps candidates: identity matches, HI/forced keywords, packs, download url', async () => {
    const { p } = make([exactEpisode]);
    const res = await p.search(episode);
    const byId = new Map(res.map((c) => [c.id, c]));
    const main = byId.get('/subtitle/3197651-3213944.zip')!;
    expect(main.language).toBe('en');
    expect(main.hi).toBe(false);
    expect([...main.matches].sort()).toEqual(['episode', 'season', 'series', 'series_imdb_id', 'year']);
    expect(main.releaseInfo).toBe('The.Show.S02E05.1080p.WEB.H264-GROUP\nThe.Show.S02E05.720p.WEB.H264-GROUP');
    expect(main.downloadUrl).toBe('https://dl.subdl.com/subtitle/3197651-3213944.zip');
    expect(main.uploader).toBe('carol');
    expect(main.hashVerifiable).toBe(false);
    expect(byId.get('/subtitle/3197652-3213945.zip')!.hi).toBe(true); // "SDH" in comment
    expect(byId.has('/subtitle/3197653-3213946.zip')).toBe(false); // forced, not wanted
    const br = byId.get('/subtitle/3197654-3213947.zip')!;
    expect(br.language).toBe('pt-BR');
    expect(br.hi).toBe(false); // explicit non-HI wins
    const pack = byId.get('/subtitle/3197660-3213960.zip')!;
    expect(pack.isPack).toBe(true);
    expect(pack.episode).toBe(5);
    expect(pack.matches.has('episode')).toBe(true);
  });

  it('keeps forced items when forced is wanted', async () => {
    const { p } = make([exactEpisode]);
    const res = await p.search({ ...episode, languages: [{ tag: 'en', forced: true, hi: 'normal' }] });
    expect(res.map((c) => c.id)).toEqual(['/subtitle/3197653-3213946.zip']);
    expect(res[0]!.forced).toBe(true);
  });

  it('season-only results drop sibling episodes and de-duplicate', async () => {
    const { p } = make([
      (c) => (c.params.has('episode_number') ? json({ status: true, subtitles: [], totalPages: 1 }) : undefined),
      (c) => (c.params.get('season_number') === '2' ? json(fx('season.json')) : undefined),
    ]);
    const res = await p.search({ ...episode, languages: [{ tag: 'en', forced: false, hi: 'normal' }] });
    expect(res.map((c) => c.id)).toEqual(['/subtitle/3197651-3213944.zip']);
  });

  it('movie search by imdb, tmdb fallback, AI exclusion and policy page cap', async () => {
    const { p, calls } = make([(c) => (c.params.get('tmdb_id') === '99' ? json(fx('movie.json')) : undefined)]);
    const movie: SubtitleQuery = {
      mediaType: 'movie', title: 'Some Movie', year: 2020, imdbId: 'tt0100000', tmdbId: 99,
      languages: [{ tag: 'en', forced: false, hi: 'normal' }],
    };
    const res = await p.search(movie);
    expect(calls[0]!.params.get('imdb_id')).toBe('tt0100000');
    expect(calls[1]!.params.get('tmdb_id')).toBe('99');
    expect(res.map((c) => c.id)).toEqual(['/subtitle/4000000-1.zip']);
    expect([...res[0]!.matches].sort()).toEqual(['imdb_id', 'title', 'tmdb_id', 'year']);
  });

  it('maps 429 daily limit to daily-limit with reset at 00:15 UTC', async () => {
    const { p } = make([() => json({ status: false, error: 'Daily limit exceeded' }, 429)]);
    const err = await p.search(episode).then(() => undefined as unknown as ProviderError, (e: unknown) => e as ProviderError);
    expect(err.code).toBe('daily-limit');
    expect(err.resetAt).toBe(Date.parse('2026-10-26T00:15:00Z'));
    expect(nextSubdlReset(Date.parse('2026-10-25T00:10:00Z'))).toBe(Date.parse('2026-10-25T00:15:00Z'));
  });

  it('retries rate limits then raises api-throttled; maps 403', async () => {
    let n = 0;
    const { p } = make([() => (n++, json({ error: 'rate limit' }, 429, { 'retry-after': '2' }))]);
    await expect(p.search(episode)).rejects.toMatchObject({ code: 'api-throttled' });
    expect(n).toBe(6);
    const b = make([() => json({ error: 'invalid api key' }, 403)]);
    await expect(b.p.search(episode)).rejects.toMatchObject({ code: 'auth' });
    const c = make([() => json({ error: 'slow down' }, 403)]);
    await expect(c.p.search(episode)).rejects.toMatchObject({ code: 'api-throttled' });
  });

  it('downloads from the download host', async () => {
    const urls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), { headers: { 'content-type': 'application/zip' } });
    }) as typeof fetch;
    const p = new SubdlProvider({ apiKey: 'K' }, { fetch: impl, sleep: async () => {} });
    const cand = { downloadUrl: 'https://dl.subdl.com/subtitle/1-2.zip', id: '/subtitle/1-2.zip' } as SubtitleCandidate;
    const file = await p.download(cand);
    expect(urls).toEqual(['https://dl.subdl.com/subtitle/1-2.zip']);
    expect(file.bytes[0]).toBe(0x50);
    expect(file.format).toBe('unknown');
  });
});
