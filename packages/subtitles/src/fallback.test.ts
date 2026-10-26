import { describe, expect, it } from 'vitest';
import { probeWhisperService } from './providers/whisper.js';
import { SubtitleSearcher } from './search.js';
import type { ProviderCapabilities, ProviderKind, RateLimit, SubtitleCandidate, SubtitleFile, SubtitleProvider, SubtitleQuery } from './types.js';

// onlyWhenNoOtherResult providers (fallbackProviders) and the Whisper service probe.

const query: SubtitleQuery = {
  mediaType: 'episode',
  title: 'Show',
  season: 1,
  episode: 2,
  source: 'HDTV',
  releaseGroup: 'LOL',
  languages: [
    { tag: 'en', forced: false, hi: 'normal' },
    { tag: 'fr', forced: false, hi: 'normal' },
  ],
};

const cand = (provider: ProviderKind, id: string, language: string, releaseInfo = 'Show.S01E02.720p.HDTV.x264-LOL'): SubtitleCandidate => ({
  provider,
  id,
  language,
  forced: false,
  hi: false,
  releaseInfo,
  matches: new Set(),
  score: 0,
  scoreWithoutHash: 0,
  hashVerifiable: false,
  hiVerifiable: true,
});

class Fake implements SubtitleProvider {
  readonly needsAuth = false;
  readonly rateLimit: RateLimit = { minIntervalMs: 0, requestTimeoutMs: 1000 };
  readonly capabilities: ProviderCapabilities = { mediaTypes: ['episode', 'movie'], inputs: ['title'], languages: 'any', forced: true, hi: true, hashVerifiable: false, hiVerifiable: true };
  queries: SubtitleQuery[] = [];
  constructor(
    readonly kind: ProviderKind,
    private readonly results: SubtitleCandidate[],
  ) {}
  supports() {
    return { ok: true as const };
  }
  async search(q: SubtitleQuery) {
    this.queries.push(q);
    return this.results.filter((c) => q.languages.some((l) => l.tag === c.language));
  }
  async download(): Promise<SubtitleFile> {
    return { bytes: new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nHi\n'), format: 'srt', encoding: 'utf-8' };
  }
  async test() {}
}

describe('onlyWhenNoOtherResult', () => {
  it('skips the fallback provider when every language has a good result', async () => {
    const podnapisi = new Fake('podnapisi', [cand('podnapisi', 'p-en', 'en'), cand('podnapisi', 'p-fr', 'fr')]);
    const whisper = new Fake('whisperai', [cand('whisperai', 'w-en', 'en', 'transcribe')]);
    const s = new SubtitleSearcher({ providers: [podnapisi, whisper], fallbackProviders: ['whisperai'] });
    const out = await s.search(query);
    expect(whisper.queries).toHaveLength(0);
    expect(out.candidates.map((c) => c.id).sort()).toEqual(['p-en', 'p-fr']);
    expect(out.skipped).toContainEqual({ provider: 'whisperai', reason: 'other providers have results' });
  });

  it('searches the fallback only for languages without an acceptable result', async () => {
    const podnapisi = new Fake('podnapisi', [cand('podnapisi', 'p-en', 'en')]);
    const whisper = new Fake('whisperai', [cand('whisperai', 'w-en', 'en'), cand('whisperai', 'w-fr', 'fr')]);
    const s = new SubtitleSearcher({ providers: [whisper, podnapisi], fallbackProviders: ['whisperai'] });
    const out = await s.search(query);
    expect(whisper.queries).toHaveLength(1);
    expect(whisper.queries[0]!.languages.map((l) => l.tag)).toEqual(['fr']);
    expect(out.candidates.map((c) => c.id).sort()).toEqual(['p-en', 'w-fr']);
  });

  it('a below-minimum result does not count as a result', async () => {
    const podnapisi = new Fake('podnapisi', [cand('podnapisi', 'weak', 'en', 'Other.Thing.2019')]);
    const whisper = new Fake('whisperai', [cand('whisperai', 'w-en', 'en')]);
    const s = new SubtitleSearcher({ providers: [podnapisi, whisper], fallbackProviders: ['whisperai'] });
    await s.search({ ...query, languages: [{ tag: 'en', forced: false, hi: 'normal' }] });
    expect(whisper.queries).toHaveLength(1);
  });

  it('without the flag every provider is searched together', async () => {
    const podnapisi = new Fake('podnapisi', [cand('podnapisi', 'p-en', 'en'), cand('podnapisi', 'p-fr', 'fr')]);
    const whisper = new Fake('whisperai', [cand('whisperai', 'w-en', 'en')]);
    await new SubtitleSearcher({ providers: [podnapisi, whisper] }).search(query);
    expect(whisper.queries).toHaveLength(1);
  });
});

describe('probeWhisperService', () => {
  const fake = (routes: Record<string, number | 'down'>) => {
    const calls: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method} ${url}`);
      const path = new URL(url).pathname;
      const r = routes[path];
      if (r === 'down' || r === undefined) throw new TypeError('fetch failed');
      return new Response(null, { status: r });
    }) as typeof fetch;
    return { f, calls };
  };

  it('accepts /docs answering 200 with HEAD', async () => {
    const { f, calls } = fake({ '/docs': 200 });
    const r = await probeWhisperService('http://whisper:9000/', { fetch: f });
    expect(r).toMatchObject({ ok: true, via: 'docs' });
    expect(calls).toEqual(['HEAD http://whisper:9000/docs']);
  });

  it('falls back to /asr, where 405 means the route exists', async () => {
    const { f } = fake({ '/docs': 404, '/asr': 405 });
    expect(await probeWhisperService('http://whisper:9000', { fetch: f })).toMatchObject({ ok: true, via: 'asr' });
  });

  it('reports a down service with both reasons', async () => {
    const { f } = fake({ '/docs': 404, '/asr': 404 });
    const r = await probeWhisperService('http://whisper:9000', { fetch: f });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/\/docs HTTP 404, \/asr HTTP 404/);
    const down = await probeWhisperService('http://whisper:9000', { fetch: fake({}).f });
    expect(down.message).toMatch(/fetch failed/);
    expect((await probeWhisperService('  ')).ok).toBe(false);
  });
});
