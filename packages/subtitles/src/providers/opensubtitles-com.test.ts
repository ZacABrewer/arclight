import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProviderError, type SubtitleQuery } from '../types.js';
import { OpenSubtitlesComProvider, oscImdbNumber, oscWireLanguage } from './opensubtitles-com.js';

const fx = (name: string) => readFileSync(new URL(`../../fixtures/opensubtitlescom/${name}`, import.meta.url), 'utf8');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}
type Route = (call: Call) => Response | undefined;

function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    for (const r of routes) {
      const res = r(call);
      if (res) return res;
    }
    return new Response('no route', { status: 599 });
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: string | object, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const loginRoute: Route = (c) => (c.url.endsWith('/login') ? json(fx('login.json')) : undefined);

const config = { username: 'u', password: 'p', apiKey: 'KEY' };
const make = (routes: Route[]) => {
  const f = fakeFetch([loginRoute, ...routes]);
  const p = new OpenSubtitlesComProvider(config, { fetch: f.impl, sleep: async () => {} });
  return { p, calls: f.calls };
};

const episode: SubtitleQuery = {
  mediaType: 'episode',
  title: 'The Show',
  year: 2021,
  season: 2,
  episode: 5,
  seriesImdbId: 'tt1234567',
  hashes: { opensubtitles: '8e245d9679d31e12' },
  languages: [
    { tag: 'en', forced: false, hi: 'normal' },
    { tag: 'pt', forced: false, hi: 'normal' },
  ],
};

describe('OpenSubtitlesComProvider', () => {
  it('validates config up front', () => {
    expect(() => new OpenSubtitlesComProvider({ username: 'u', password: 'p', apiKey: '' })).toThrow(ProviderError);
    try {
      new OpenSubtitlesComProvider({ username: '', password: '', apiKey: 'k' });
    } catch (e) {
      expect((e as ProviderError).code).toBe('config');
    }
  });

  it('maps wire languages and imdb numbers', () => {
    expect(oscWireLanguage('pt')).toBe('pt-pt');
    expect(oscWireLanguage('zh')).toBe('zh-cn');
    expect(oscWireLanguage('es-MX')).toBe('ea');
    expect(oscWireLanguage('pt-BR')).toBe('pt-br');
    expect(oscImdbNumber('tt0012345')).toBe('12345');
  });

  it('refuses queries without usable inputs or languages', () => {
    const { p } = make([]);
    expect(p.supports({ ...episode, languages: [{ tag: 'tlh', forced: false, hi: 'normal' }] }).ok).toBe(false);
    expect(p.supports({ ...episode, season: undefined }).ok).toBe(false);
    expect(p.supports(episode).ok).toBe(true);
  });

  it('builds sorted search params with hash, parent imdb and episode numbers', async () => {
    const { p, calls } = make([(c) => (c.url.includes('/subtitles?') ? json(fx('search-episode.json')) : undefined)]);
    await p.search(episode);
    const search = calls.find((c) => c.url.includes('/subtitles?'))!;
    const url = new URL(search.url);
    expect([...url.searchParams.keys()]).toEqual([
      'ai_translated', 'episode_number', 'languages', 'moviehash', 'parent_imdb_id', 'season_number',
    ]);
    expect(url.searchParams.get('languages')).toBe('en,pt-pt');
    expect(url.searchParams.get('parent_imdb_id')).toBe('1234567');
    expect(search.headers['Api-Key']).toBe('KEY');
    // non-VIP host: no bearer on API calls
    expect(search.headers.Authorization).toBeUndefined();
  });

  it('maps search results: hash match, HI, forced filter, AI exclusion, language mapping', async () => {
    const { p } = make([(c) => (c.url.includes('/subtitles?') ? json(fx('search-episode.json')) : undefined)]);
    const res = await p.search(episode);
    expect(res.map((c) => c.id)).toEqual(['9001', '9002', '9005']);
    const first = res[0]!;
    expect(first.language).toBe('en');
    expect(first.hi).toBe(false);
    expect([...first.matches].sort()).toEqual(['episode', 'hash', 'season', 'series', 'series_imdb_id', 'year']);
    expect(first.releaseInfo).toBe('The.Show.S02E05.1080p.WEB.H264-GROUP');
    expect(first.uploader).toBe('alice');
    expect(first.downloads).toBe(1520);
    expect(first.hashVerifiable).toBe(true);
    expect(res[1]!.hi).toBe(true);
    const pt = res[2]!;
    expect(pt.language).toBe('pt');
    expect(pt.matches.has('episode')).toBe(false);
  });

  it('keeps only real forced when every wanted language is forced', async () => {
    const { p } = make([(c) => (c.url.includes('/subtitles?') ? json(fx('search-episode.json')) : undefined)]);
    const res = await p.search({ ...episode, languages: [{ tag: 'en', forced: true, hi: 'normal' }] });
    expect(res.map((c) => c.id)).toEqual(['9003']);
    expect(res[0]!.forced).toBe(true);
  });

  it('uses query fallback for movies without ids', async () => {
    const { p, calls } = make([(c) => (c.url.includes('/subtitles?') ? json({ data: [] }) : undefined)]);
    await p.search({ mediaType: 'movie', title: 'Some Movie', year: 2020, languages: [{ tag: 'en', forced: false, hi: 'normal' }] });
    const url = new URL(calls.find((c) => c.url.includes('/subtitles?'))!.url);
    expect(url.searchParams.get('query')).toBe('some movie');
    expect(url.searchParams.get('year')).toBe('2020');
  });

  it('downloads via link and records quota', async () => {
    const { p, calls } = make([
      (c) => (c.url.endsWith('/download') ? json(fx('download.json')) : undefined),
      (c) => (c.url.includes('/subfile/') ? new Response('1\n00:00:01,000 --> 00:00:02,000\nHi\n') : undefined),
    ]);
    const file = await p.download({
      provider: 'opensubtitlescom', id: '9001', language: 'en', forced: false, hi: false, releaseInfo: '',
      matches: new Set(), score: 0, scoreWithoutHash: 0, hashVerifiable: true, hiVerifiable: true, token: { fileId: 9001 },
    });
    expect(file.format).toBe('srt');
    expect(p.lastQuota).toEqual({ requests: 3, remaining: 17, resetAt: Date.parse('2026-10-26T00:00:00.000Z') });
    const dl = calls.find((c) => c.url.endsWith('/download'))!;
    expect(JSON.parse(dl.body!)).toEqual({ file_id: 9001, sub_format: 'srt' });
    expect(dl.headers.Authorization).toMatch(/^Bearer /);
  });

  it('maps 406 to daily-limit with reset time', async () => {
    const { p } = make([(c) => (c.url.endsWith('/download') ? json(fx('quota-exceeded.json'), 406) : undefined)]);
    const err = await p
      .download({
        provider: 'opensubtitlescom', id: '1', language: 'en', forced: false, hi: false, releaseInfo: '',
        matches: new Set(), score: 0, scoreWithoutHash: 0, hashVerifiable: true, hiVerifiable: true,
      })
      .then(() => undefined as unknown as ProviderError, (e: unknown) => e as ProviderError);
    expect(err.code).toBe('daily-limit');
    expect(err.resetAt).toBe(Date.parse('2026-10-26T04:00:00.000Z'));
  });

  it('re-logs in once on 401 and returns the retried response', async () => {
    let n = 0;
    const { p, calls } = make([
      (c) => {
        if (!c.url.includes('/subtitles?')) return undefined;
        n++;
        return n === 1 ? json({ message: 'expired' }, 401) : json(fx('search-episode.json'));
      },
    ]);
    const res = await p.search(episode);
    expect(res.length).toBe(3);
    expect(calls.filter((c) => c.url.endsWith('/login')).length).toBe(2);
  });

  it('maps 429, 502 and 400', async () => {
    const run = async (status: number) => {
      const { p } = make([(c) => (c.url.includes('/subtitles?') ? json({ message: 'x' }, status) : undefined)]);
      return p.search(episode).catch((e: unknown) => (e as ProviderError).code);
    };
    expect(await run(429)).toBe('rate-limited');
    expect(await run(502)).toBe('api-throttled');
    expect(await run(400)).toBe('config');
    expect(await run(503)).toBe('unreachable');
  });

  it('uses VIP host and bearer for API calls', async () => {
    const f = fakeFetch([
      (c) => (c.url.endsWith('/login') ? json({ token: 't', base_url: 'vip-api.opensubtitles.com' }) : undefined),
      (c) => (c.url.startsWith('https://vip-api.opensubtitles.com/api/v1/subtitles') ? json({ data: [] }) : undefined),
    ]);
    const p = new OpenSubtitlesComProvider(config, { fetch: f.impl, sleep: async () => {} });
    await p.search(episode);
    const s = f.calls.find((c) => c.url.includes('/subtitles?'))!;
    expect(s.headers.Authorization).toBe('Bearer t');
    expect(p.ping()).toBe(true);
  });

  it('fails with bad-response when data is missing', async () => {
    const { p } = make([(c) => (c.url.includes('/subtitles?') ? json({ nothing: true }) : undefined)]);
    await expect(p.search(episode)).rejects.toMatchObject({ code: 'bad-response' });
  });
});
