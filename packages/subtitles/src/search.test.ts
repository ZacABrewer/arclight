import { describe, expect, it } from 'vitest';
import { writeZip } from './archive.js';
import { buildQuery } from './query.js';
import { SubtitleSearcher, prepareSubtitle } from './search.js';
import { ThrottleTracker, nextUtcTime } from './throttle.js';
import {
  ProviderError,
  type ProviderCapabilities,
  type ProviderKind,
  type RateLimit,
  type SubtitleCandidate,
  type SubtitleFile,
  type SubtitleProvider,
  type SubtitleQuery,
} from './types.js';

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
const enc = (s: string) => new TextEncoder().encode(s);

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

function candidate(kind: ProviderKind, id: string, over: Partial<SubtitleCandidate> = {}): SubtitleCandidate {
  return {
    provider: kind,
    id,
    language: 'en',
    forced: false,
    hi: false,
    releaseInfo: 'Show.S01E02.720p.HDTV.x264-LOL',
    matches: new Set(),
    score: 0,
    scoreWithoutHash: 0,
    hashVerifiable: false,
    hiVerifiable: true,
    ...over,
  };
}

class FakeProvider implements SubtitleProvider {
  readonly needsAuth = false;
  readonly rateLimit: RateLimit;
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['title'],
    languages: 'any',
    forced: true,
    hi: true,
    hashVerifiable: false,
    hiVerifiable: true,
  };
  searches = 0;
  downloads: string[] = [];
  constructor(
    readonly kind: ProviderKind,
    private readonly results: SubtitleCandidate[] | (() => Promise<SubtitleCandidate[]>),
    private readonly files: Record<string, SubtitleFile | Error> = {},
    rateLimit: Partial<RateLimit> = {},
  ) {
    this.rateLimit = { minIntervalMs: 0, requestTimeoutMs: 1000, ...rateLimit };
  }
  supports(q: SubtitleQuery) {
    return q.mediaType === 'movie' && this.kind === 'gestdown' ? { ok: false as const, reason: 'episodes only' } : { ok: true as const };
  }
  async search(): Promise<SubtitleCandidate[]> {
    this.searches++;
    return typeof this.results === 'function' ? this.results() : this.results;
  }
  async download(c: SubtitleCandidate): Promise<SubtitleFile> {
    this.downloads.push(c.id);
    const f = this.files[c.id];
    if (f instanceof Error) throw f;
    return f ?? { bytes: enc(SRT), format: 'srt', encoding: 'utf-8' };
  }
  async test() {}
}

function clock(start = Date.UTC(2026, 9, 25, 12, 0, 0)) {
  const c = { t: start, now: () => c.t, sleeps: [] as number[], sleep: async (ms: number) => void c.sleeps.push(ms) };
  return c;
}

describe('ThrottleTracker', () => {
  it('throttles counted errors only on the fifth strike within 120 s (R17.5)', () => {
    const c = clock();
    const t = new ThrottleTracker({ now: c.now });
    const err = new ProviderError('rate-limited', 'slow down');
    for (let i = 0; i < 4; i++) expect(t.recordError('subdl', err).action).toBe('strike');
    const r = t.recordError('subdl', err);
    expect(r.action).toBe('throttled');
    expect(t.isThrottled('subdl')).toBe(true);
    if (r.action === 'throttled') expect(Date.parse(r.entry.until) - c.t).toBe(3600_000);
  });
  it('strikes older than the window do not count', () => {
    const c = clock();
    const t = new ThrottleTracker({ now: c.now });
    const err = new ProviderError('unreachable', 'down');
    for (let i = 0; i < 4; i++) t.recordError('subdl', err);
    c.t += 121_000;
    expect(t.recordError('subdl', err).action).toBe('strike');
  });
  it('auth throttles at once for 12 h and reset(onlyAuth) clears it', () => {
    const c = clock();
    const t = new ThrottleTracker({ now: c.now });
    t.recordError('opensubtitlescom', new ProviderError('auth', 'bad login'));
    t.recordError('subdl', new ProviderError('bad-response', 'garbage'));
    expect(t.get('opensubtitlescom')?.until).toBe(new Date(c.t + 12 * 3600_000).toISOString());
    t.reset(true);
    expect(t.isThrottled('opensubtitlescom')).toBe(false);
    expect(t.isThrottled('subdl')).toBe(true);
  });
  it('daily limit lasts until midnight UTC, or a provider override', () => {
    const c = clock();
    const t = new ThrottleTracker({ now: c.now, overrides: { subdl: { 'daily-limit': { kind: 'until-utc', hour: 0, minute: 15 } } } });
    t.recordError('addic7ed', new ProviderError('daily-limit', 'quota'));
    t.recordError('subdl', new ProviderError('daily-limit', 'quota'));
    expect(t.get('addic7ed')?.until).toBe('2026-10-26T00:00:00.000Z');
    expect(t.get('subdl')?.until).toBe('2026-10-26T00:15:00.000Z');
    expect(nextUtcTime(Date.UTC(2026, 0, 1, 0, 0, 0), 0, 0)).toBe(Date.UTC(2026, 0, 2));
  });
  it('backs off exponentially on consecutive throttles and resets on success', () => {
    const c = clock();
    const t = new ThrottleTracker({ now: c.now });
    const err = new Error('boom');
    t.recordError('podnapisi', err);
    expect(Date.parse(t.get('podnapisi')!.until) - c.t).toBe(10 * 60_000);
    c.t += 11 * 60_000;
    t.recordError('podnapisi', err);
    expect(Date.parse(t.get('podnapisi')!.until) - c.t).toBe(20 * 60_000);
    c.t += 21 * 60_000;
    t.recordSuccess('podnapisi');
    t.recordError('podnapisi', err);
    expect(Date.parse(t.get('podnapisi')!.until) - c.t).toBe(10 * 60_000);
  });
  it('uses server reset times and lifts expired entries; ignores not-found', () => {
    const c = clock();
    const t = new ThrottleTracker({ now: c.now });
    t.recordError('opensubtitlescom', new ProviderError('daily-limit', 'q', { resetAt: c.t + 5000 }));
    expect(t.isThrottled('opensubtitlescom')).toBe(true);
    c.t += 5001;
    expect(t.isThrottled('opensubtitlescom')).toBe(false);
    expect(t.recordError('subdl', new ProviderError('not-found', 'nothing')).action).toBe('ignored');
  });
  it('restores persisted entries', () => {
    const c = clock();
    const t = new ThrottleTracker({ now: c.now, initial: [{ provider: 'jimaku', code: 'auth', description: 'x', until: new Date(c.t + 1000).toISOString() }] });
    expect(t.list()).toHaveLength(1);
  });
});

describe('SubtitleSearcher', () => {
  it('merges providers concurrently, dedupes, scores and sorts', async () => {
    const a = new FakeProvider('opensubtitlescom', [candidate('opensubtitlescom', '1'), candidate('opensubtitlescom', '1')]);
    const b = new FakeProvider('subdl', [candidate('subdl', '2', { releaseInfo: 'Show.S01E02.WEB' }), candidate('subdl', '3', { language: 'de' })]);
    const s = new SubtitleSearcher({ providers: [a, b] });
    const out = await s.search(query);
    expect(out.candidates.map((c) => `${c.provider}:${c.id}`)).toEqual(['opensubtitlescom:1', 'subdl:2']);
    expect(out.candidates[0]!.score).toBeGreaterThan(out.candidates[1]!.score);
  });
  it('applies blacklist and release filters', async () => {
    const a = new FakeProvider('subdl', [candidate('subdl', 'bad'), candidate('subdl', 'ok', { releaseInfo: 'Show.S01E02.720p.HDTV.x264-DIMENSION' })]);
    const s = new SubtitleSearcher({ providers: [a], isBlacklisted: (_p, id) => id === 'bad', mustNotContain: ['killers'] });
    expect((await s.search(query)).candidates.map((c) => c.id)).toEqual(['ok']);
  });
  it('skips unsupported providers with a reason and reports all throttled', async () => {
    const g = new FakeProvider('gestdown', []);
    const s = new SubtitleSearcher({ providers: [g] });
    const movie = { ...query, mediaType: 'movie' as const };
    expect((await s.search(movie)).skipped).toEqual([{ provider: 'gestdown', reason: 'episodes only' }]);
    s.throttle.recordError('gestdown', new ProviderError('auth', 'x'));
    const out = await s.search(query);
    expect(out.allThrottled).toBe(true);
    expect(g.searches).toBe(0);
  });
  it('retries a provider after a counted strike, sleeping 5 s', async () => {
    const c = clock();
    let calls = 0;
    const p = new FakeProvider('subdl', async () => {
      calls++;
      if (calls === 1) throw new ProviderError('rate-limited', 'slow');
      return [candidate('subdl', 'x')];
    });
    const s = new SubtitleSearcher({ providers: [p], now: c.now, sleep: c.sleep });
    const out = await s.search(query);
    expect(out.candidates).toHaveLength(1);
    expect(c.sleeps).toEqual([5000]);
  });
  it('throttles on a hard error and keeps other providers results', async () => {
    const bad = new FakeProvider('addic7ed', async () => {
      throw new ProviderError('captcha', 'recaptcha');
    });
    const good = new FakeProvider('subdl', [candidate('subdl', 'x')]);
    const throttled: string[] = [];
    const s = new SubtitleSearcher({ providers: [bad, good], onThrottle: (e) => throttled.push(`${e.provider}:${e.code}`) });
    const out = await s.search(query);
    expect(out.candidates).toHaveLength(1);
    expect(out.errors[0]!.provider).toBe('addic7ed');
    expect(throttled).toEqual(['addic7ed:captcha']);
  });
  it('downloads the best candidate per language, unpacking zips and converting to UTF-8', async () => {
    const latin1 = new Uint8Array([...enc('1\n00:00:01,000 --> 00:00:02,000\nCaf'), 0xe9, 0x0d, 0x0a]);
    const zip = writeZip([{ name: 'Show.S01E02.fr.srt', data: latin1 }]);
    const p = new FakeProvider('subdl', [candidate('subdl', 'en1'), candidate('subdl', 'fr1', { language: 'fr' })], {
      fr1: { bytes: zip, format: 'unknown', encoding: 'unknown' },
    });
    const s = new SubtitleSearcher({ providers: [p] });
    const { results } = await s.searchAndDownload(query);
    expect(results.map((r) => r.candidate?.id)).toEqual(['en1', 'fr1']);
    expect(results[1]!.subtitle!.text).toBe('1\n00:00:01,000 --> 00:00:02,000\nCafé\n');
    expect(results[1]!.subtitle!.file.encoding).toBe('utf-8');
    expect(results[0]!.percent).toBeGreaterThan(90);
  });
  it('falls through to the next candidate on bad content and on rar archives', async () => {
    const p = new FakeProvider(
      'subdl',
      [
        candidate('subdl', 'html'),
        candidate('subdl', 'rar'),
        candidate('subdl', 'good', { releaseInfo: 'Show.S01E02.720p.HDTV-LOL' }),
      ],
      {
        html: { bytes: enc('<html>quota</html>'), format: 'unknown', encoding: 'unknown' },
        rar: { bytes: enc('Rar!\x1a\x07\x00xxx'), format: 'unknown', encoding: 'unknown' },
      },
    );
    const s = new SubtitleSearcher({ providers: [p] });
    const { results } = await s.searchAndDownload({ ...query, languages: [query.languages[0]!] });
    expect(results[0]!.candidate?.id).toBe('good');
    expect(results[0]!.failures.map((f) => f.id)).toEqual(['html', 'rar']);
  });
  it('retries downloads on connection errors with 6 s pauses, max 3 tries', async () => {
    const c = clock();
    let n = 0;
    const p = new FakeProvider('subdl', [candidate('subdl', 'x')]);
    p.download = async () => {
      n++;
      if (n < 3) throw new ProviderError('unreachable', 'reset');
      return { bytes: enc(SRT), format: 'srt', encoding: 'utf-8' };
    };
    const s = new SubtitleSearcher({ providers: [p], now: c.now, sleep: c.sleep });
    const file = await s.download(candidate('subdl', 'x'));
    expect(file.format).toBe('srt');
    expect(c.sleeps).toEqual([6000, 6000]);
  });
  it('reports must-blacklist candidates and moves on without throttling', async () => {
    const blacklisted: string[] = [];
    const p = new FakeProvider('embeddedsubtitles', [candidate('embeddedsubtitles', 'a'), candidate('embeddedsubtitles', 'b')], {
      a: new ProviderError('must-blacklist', 'extraction failed'),
    });
    const s = new SubtitleSearcher({ providers: [p], onBlacklist: (c) => blacklisted.push(c.id) });
    const { results } = await s.searchAndDownload({ ...query, languages: [query.languages[0]!] });
    expect(blacklisted).toEqual(['a']);
    expect(results[0]!.candidate?.id).toBe('b');
    expect(s.throttle.isThrottled('embeddedsubtitles')).toBe(false);
  });
  it('discards a provider after an auth failure on download', async () => {
    const p = new FakeProvider('opensubtitlescom', [candidate('opensubtitlescom', 'a'), candidate('opensubtitlescom', 'b')], {
      a: new ProviderError('daily-limit', 'quota'),
    });
    const s = new SubtitleSearcher({ providers: [p] });
    const { results } = await s.searchAndDownload({ ...query, languages: [query.languages[0]!] });
    expect(results[0]!.candidate).toBeUndefined();
    expect(p.downloads).toEqual(['a']);
    expect(s.throttle.isThrottled('opensubtitlescom')).toBe(true);
  });
  it('below-minimum candidates are not downloaded but appear in manual search', async () => {
    const p = new FakeProvider('subdl', [candidate('subdl', 'weak', { releaseInfo: 'Show.S01E02' })]);
    const s = new SubtitleSearcher({ providers: [p], minScorePercent: { episode: 95 } });
    const { results } = await s.searchAndDownload({ ...query, languages: [query.languages[0]!] });
    expect(results[0]!.candidate).toBeUndefined();
    const manual = await s.manualSearch(query);
    expect(manual.rows.map((r) => r.candidate.id)).toEqual(['weak']);
    expect(manual.rows[0]!.percent).toBeLessThan(95);
  });
  it('keeps ASS when original format is on, converts otherwise', () => {
    const ass = enc('[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi\n');
    expect(prepareSubtitle({ bytes: ass, format: 'ass', encoding: 'utf-8' }, { convertToSrt: false }).file.format).toBe('ass');
    expect(prepareSubtitle({ bytes: ass, format: 'ass', encoding: 'utf-8' }).text).toBe('1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  });
  it('flags HI by content heuristic', async () => {
    const p = new FakeProvider('subdl', [candidate('subdl', 'x')], {
      x: { bytes: enc('1\n00:00:01,000 --> 00:00:02,000\n[laughs]\n'), format: 'srt', encoding: 'utf-8' },
    });
    const { results } = await new SubtitleSearcher({ providers: [p] }).searchAndDownload({ ...query, languages: [query.languages[0]!] });
    expect(results[0]!.hi).toBe(true);
  });
});

describe('buildQuery', () => {
  it('layers file name, scene name, quality and media info', () => {
    const q = buildQuery({
      mediaType: 'episode',
      title: 'The Office (2005)',
      year: 2005,
      season: 3,
      episode: 5,
      seriesImdbId: 'tt0386676',
      file: {
        path: '/tv/The Office/Season 3/The Office - S03E05 - Initiation.mkv',
        sizeBytes: 500_000_000,
        sceneName: 'The.Office.US.S03E05.720p.HDTV.x264-LOL',
        mediaInfo: { videoCodec: 'h264', audioCodec: 'AC3', audioLanguages: ['eng'] },
      },
      languages: [{ tag: 'en', forced: false, hi: 'normal' }],
    });
    expect(q).toMatchObject({
      title: 'The Office',
      year: 2005,
      releaseGroup: 'LOL',
      source: 'HDTV',
      resolution: '720p',
      videoCodec: 'H.264',
      audioCodec: 'AC3',
      audioLanguages: ['en'],
      fileName: 'The Office - S03E05 - Initiation.mkv',
    });
  });
});
