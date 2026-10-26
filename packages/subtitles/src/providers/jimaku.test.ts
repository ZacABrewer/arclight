import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JimakuProvider, guessJimakuLanguages } from './jimaku.js';
import { ProviderError, type SubtitleQuery } from '../types.js';

const fx = (n: string) => readFileSync(new URL(`../../fixtures/jimaku/${n}`, import.meta.url), 'utf8');

interface Seen {
  url: string;
  auth: string | null;
}
function fakeFetch(routes: Array<[string, () => Response]>, seen: Seen[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    for (const [k, v] of routes) if (url.includes(k)) return v();
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
}
const json = (s: string) => () => new Response(s, { status: 200 });
const ctx = (f: typeof fetch) => ({ fetch: f, sleep: async () => {} });

const query = (over: Partial<SubtitleQuery> = {}): SubtitleQuery => ({
  mediaType: 'episode',
  title: 'Frieren',
  season: 1,
  episode: 5,
  anilistId: 154587,
  languages: [{ tag: 'ja', forced: false, hi: 'normal' }],
  ...over,
});

const routes: Array<[string, () => Response]> = [
  ['entries/search?anilist_id=154587', json(fx('search-anilist.json'))],
  ['entries/77/files?episode=5', json(fx('files-ep5.json'))],
];

describe('guessJimakuLanguages', () => {
  it('reads the token before the extension', () => {
    expect(guessJimakuLanguages('Show.S01E01.ja.srt')).toEqual(['ja']);
    expect(guessJimakuLanguages('Show.S01E01.jp.ass')).toEqual(['ja']);
    expect(guessJimakuLanguages('Show.S01E01.ass')).toEqual([]);
    expect(guessJimakuLanguages('Show.jpsc.ass')).toEqual(['ja', 'zh']);
    expect(guessJimakuLanguages('Show.xx.ass')).toEqual(['zu']);
    expect(guessJimakuLanguages('Show.subtitles.ass')).toEqual([]);
  });
});

describe('JimakuProvider', () => {
  it('requires an API key', () => {
    expect(() => new JimakuProvider({ apiKey: ' ' })).toThrow(ProviderError);
  });

  it('serves Japanese only and refuses other languages', () => {
    const p = new JimakuProvider({ apiKey: 'k' }, ctx(fakeFetch([])));
    expect(p.supports(query({ languages: [{ tag: 'en', forced: false, hi: 'normal' }] })).ok).toBe(false);
    expect(p.supports(query()).ok).toBe(true);
  });

  it('searches by AniList id with the raw key and filters files', async () => {
    const seen: Seen[] = [];
    const p = new JimakuProvider({ apiKey: 'secret' }, ctx(fakeFetch(routes, seen)));
    const res = await p.search(query());
    expect(seen[0]!.auth).toBe('secret');
    // 7z dropped, AI dropped, tiny dropped, multi-language dropped; zip kept since archives allowed.
    expect(res.map((c) => c.releaseInfo)).toEqual(['Frieren.S01E05.ja.srt', 'Frieren.S01E05.ass', 'Frieren.S01.zip']);
    expect(res.every((c) => c.language === 'ja')).toBe(true);
    expect([...res[0]!.matches].sort()).toEqual(['episode', 'season', 'series']);
    expect(res[2]!.isPack).toBe(true);
  });

  it('drops archives when disabled and plain files exist; allows AI when enabled', async () => {
    const p = new JimakuProvider({ apiKey: 'k', archives: false, aiSubs: true }, ctx(fakeFetch(routes)));
    const res = await p.search(query());
    expect(res.map((c) => c.releaseInfo)).toEqual([
      'Frieren.S01E05.ja.srt',
      'Frieren.S01E05.ass',
      'Frieren.S01E05.whisper.srt',
    ]);
  });

  it('falls back to a name search without anime restriction for movies', async () => {
    const seen: Seen[] = [];
    const p = new JimakuProvider(
      { apiKey: 'k' },
      ctx(
        fakeFetch(
          [
            ['anime=false', json('[{"id": 9, "name": "Kimi", "flags": {"movie": true}}]')],
            ['entries/search?query=', json('[]')],
            ['entries/9/files', json('[{"url": "https://x/9/Kimi.ja.srt", "name": "Kimi.ja.srt", "size": 9000}]')],
          ],
          seen,
        ),
      ),
    );
    const res = await p.search(query({ mediaType: 'movie', anilistId: undefined, title: 'Kimi', season: undefined, episode: undefined }));
    expect(seen.map((s) => s.url)).toEqual([
      'https://jimaku.cc/api/entries/search?query=kimi',
      'https://jimaku.cc/api/entries/search?query=kimi&anime=false',
      'https://jimaku.cc/api/entries/9/files',
    ]);
    expect(res).toHaveLength(1);
    expect([...res[0]!.matches]).toEqual(['title']);
  });

  it('retries 429 three times then raises api-throttled', async () => {
    let calls = 0;
    const p = new JimakuProvider(
      { apiKey: 'k' },
      ctx((async () => {
        calls++;
        return new Response('', { status: 429 });
      }) as typeof fetch),
    );
    await expect(p.search(query())).rejects.toMatchObject({ code: 'api-throttled' });
    expect(calls).toBe(3);
  });

  it('maps 401 to auth and an error body to unreachable', async () => {
    const p1 = new JimakuProvider({ apiKey: 'k' }, ctx(fakeFetch([['', () => new Response('', { status: 401 })]])));
    await expect(p1.search(query())).rejects.toMatchObject({ code: 'auth' });
    const p2 = new JimakuProvider({ apiKey: 'k' }, ctx(fakeFetch([['', json('{"error": "maintenance", "code": 503}')]])));
    await expect(p2.search(query())).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('downloads the file with the key', async () => {
    const seen: Seen[] = [];
    const p = new JimakuProvider(
      { apiKey: 'k' },
      ctx(fakeFetch([...routes, ['download/Frieren.S01E05.ja.srt', () => new Response('1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n')]], seen)),
    );
    const [first] = await p.search(query());
    const file = await p.download(first!);
    expect(file.format).toBe('srt');
    expect(seen.at(-1)!.auth).toBe('k');
  });
});
