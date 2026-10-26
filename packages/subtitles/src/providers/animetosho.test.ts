import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AnimetoshoProvider } from './animetosho.js';
import { ProviderError, type SubtitleQuery } from '../types.js';

const fx = (n: string) => readFileSync(new URL(`../../fixtures/animetosho/${n}`, import.meta.url), 'utf8');

function fakeFetch(routes: Record<string, () => Response>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return v();
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
}
const json = (s: string) => () => new Response(s, { status: 200, headers: { 'content-type': 'application/json' } });
const ctx = (f: typeof fetch) => ({ fetch: f, sleep: async () => {} });

const query = (over: Partial<SubtitleQuery> = {}): SubtitleQuery => ({
  mediaType: 'episode',
  title: 'Frieren',
  season: 1,
  episode: 5,
  anidbEpisodeId: 271234,
  languages: [{ tag: 'en', forced: false, hi: 'normal' }],
  ...over,
});

const routes = {
  'eid=271234': json(fx('feed-eid.json')),
  'id=502': json(fx('torrent-502.json')),
  'id=501': json(fx('torrent-501.json')),
};

describe('AnimetoshoProvider', () => {
  it('rejects a missing or zero threshold', () => {
    expect(() => new AnimetoshoProvider({ searchThreshold: 0 })).toThrow(ProviderError);
  });

  it('refuses movies and queries without an anidb episode id', () => {
    const p = new AnimetoshoProvider({ searchThreshold: 2 }, ctx(fakeFetch({})));
    expect(p.supports(query({ anidbEpisodeId: undefined })).ok).toBe(false);
    expect(p.supports(query({ mediaType: 'movie' })).ok).toBe(false);
    expect(p.supports(query()).ok).toBe(true);
  });

  it('inspects the newest complete releases up to the threshold', async () => {
    const seen: string[] = [];
    const p = new AnimetoshoProvider({ searchThreshold: 2 }, ctx(fakeFetch(routes, seen)));
    await p.search(query());
    expect(seen.filter((u) => u.includes('show=torrent'))).toEqual([
      'https://feed.animetosho.org/json?show=torrent&id=502',
      'https://feed.animetosho.org/json?show=torrent&id=501',
    ]);
  });

  it('maps subtitle attachments to candidates with identity matches and storage urls', async () => {
    const p = new AnimetoshoProvider({ searchThreshold: 2 }, ctx(fakeFetch(routes)));
    const res = await p.search(query());
    // 502 English + 501 (no language -> English)
    expect(res).toHaveLength(2);
    const first = res[0]!;
    expect(first.language).toBe('en');
    expect(first.downloadUrl).toBe('https://animetosho.org/storage/attach/0004abb0/306096.xz');
    expect(first.id).toBe('502:https://animetosho.org/storage/attach/0004abb0/306096.xz');
    expect([...first.matches].sort()).toEqual(['episode', 'season', 'series', 'title', 'tvdb_id']);
    expect(first.releaseInfo).toContain('Erai-raws');
    expect(first.hashVerifiable).toBe(false);
  });

  it('honours forced and Brazilian Portuguese detection', async () => {
    const p = new AnimetoshoProvider({ searchThreshold: 1 }, ctx(fakeFetch(routes)));
    const res = await p.search(
      query({ languages: [{ tag: 'en', forced: true, hi: 'normal' }, { tag: 'pt-BR', forced: false, hi: 'normal' }] }),
    );
    expect(res.map((c) => [c.language, c.forced])).toEqual([
      ['pt-BR', false],
      ['en', true],
    ]);
  });

  it('downloads xz payloads unchanged and rejects other archives', async () => {
    const xz = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1, 2, 3]);
    const p = new AnimetoshoProvider(
      { searchThreshold: 2 },
      ctx(
        fakeFetch({
          ...routes,
          '306096.xz': () => new Response(xz),
          '400001.xz': () => new Response('PK\u0003\u0004zip'),
        }),
      ),
    );
    const [a, b] = await p.search(query());
    const file = await p.download(a!);
    expect([...file.bytes]).toEqual([...xz]);
    expect(file.fileName).toBe('306096.xz');
    await expect(p.download(b!)).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('maps a feed outage to unreachable', async () => {
    const p = new AnimetoshoProvider({ searchThreshold: 2 }, ctx(fakeFetch({ 'eid=': () => new Response('', { status: 503 }) })));
    await expect(p.search(query())).rejects.toMatchObject({ code: 'unreachable' });
  });
});
