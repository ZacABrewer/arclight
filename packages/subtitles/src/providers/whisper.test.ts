import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WhisperProvider, buildAudioExtractArgs } from './whisper.js';
import { ProviderError, type SubtitleQuery, type WantedLanguage } from '../types.js';

const fx = (n: string) => readFileSync(new URL(`../../fixtures/whisper/${n}`, import.meta.url), 'utf8');
const PATH = '/tv/Show/Season 01/Show.S01E02.mkv';

const query = (languages: WantedLanguage[], over: Partial<SubtitleQuery> = {}): SubtitleQuery => ({
  mediaType: 'episode',
  title: 'Show',
  season: 1,
  episode: 2,
  filePath: PATH,
  audioLanguages: ['jpn'],
  languages,
  ...over,
});
const w = (tag: string): WantedLanguage => ({ tag, forced: false, hi: 'normal' });

interface Call {
  url: string;
  method: string;
  body: unknown;
}
function setup(opts: { passVideoName?: boolean; asrStatus?: number } = {}) {
  const calls: Call[] = [];
  const ffmpeg: string[][] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    if (url.includes('/detect-language')) return new Response(fx('detect.json'));
    if (url.includes('/asr')) return new Response(fx('asr.srt'), { status: opts.asrStatus ?? 200 });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const p = new WhisperProvider(
    { endpoint: 'http://whisper:9000/', passVideoName: opts.passVideoName },
    {
      extractAudio: async (args) => {
        ffmpeg.push(args);
        return new Uint8Array([1, 2, 3, 4]);
      },
    },
    { fetch: fetchFn, sleep: async () => {} },
  );
  return { p, calls, ffmpeg };
}

describe('buildAudioExtractArgs', () => {
  it('builds mono 16 kHz PCM extraction, by language or first stream', () => {
    expect(buildAudioExtractArgs({ input: 'in.mkv', output: 'pipe:1' })).toEqual([
      'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'in.mkv', '-map', '0:a:0',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
    ]);
    const byLang = buildAudioExtractArgs({ ffmpegPath: 'ff', input: 'x', audioStreamLanguage3: 'jpn', output: 'o', container: 's16le' });
    expect(byLang).toContain('0:a:m:language:jpn?');
    expect(byLang).toContain('s16le');
    expect(byLang[0]).toBe('ff');
  });
});

describe('WhisperProvider', () => {
  it('requires an endpoint and declares a 5 minute connection throttle', () => {
    expect(() => new WhisperProvider({ endpoint: ' ' })).toThrow(ProviderError);
    const p = new WhisperProvider({ endpoint: 'http://x' });
    expect(p.rateLimit.throttle?.unreachable).toEqual({ kind: 'duration', ms: 300000 });
  });

  it('refuses queries without a file and forced-only requests', () => {
    const { p } = setup();
    expect(p.supports(query([w('ja')], { filePath: undefined })).ok).toBe(false);
    expect(p.supports(query([{ tag: 'ja', forced: true, hi: 'normal' }])).ok).toBe(false);
  });

  it('creates transcribe/translate candidates without network calls', async () => {
    const { p, calls } = setup();
    const res = await p.search(query([w('ja'), w('en'), w('fr')]));
    expect(calls).toHaveLength(0);
    expect(res.map((c) => [c.language, c.releaseInfo])).toEqual([
      ['ja', 'transcribe Japanese audio to Japanese SRT'],
      ['en', 'translate Japanese audio to English SRT'],
    ]);
    expect([...res[0]!.matches].sort()).toEqual(['episode', 'season', 'series']);
    expect(new Set(res.map((c) => c.id)).size).toBe(2);
  });

  it('detects the language when tags are missing or ambiguous', async () => {
    for (const audioLanguages of [[], ['und'], ['mul']]) {
      const { p, calls } = setup();
      const res = await p.search(query([w('ja')], { audioLanguages }));
      expect(calls[0]!.url).toContain('http://whisper:9000/detect-language');
      expect(res.map((c) => c.releaseInfo)).toEqual(['transcribe Japanese audio to Japanese SRT']);
    }
  });

  it('movies match only the title', async () => {
    const { p } = setup();
    const [c] = await p.search(query([w('ja')], { mediaType: 'movie', season: undefined, episode: undefined }));
    expect([...c!.matches]).toEqual(['title']);
  });

  it('downloads by extracting audio and posting it to the ASR endpoint', async () => {
    const { p, calls, ffmpeg } = setup({ passVideoName: true });
    const [c] = await p.search(query([w('ja')], { audioLanguages: ['eng', 'jpn'] }));
    const file = await p.download(c!);
    expect(new TextDecoder().decode(file.bytes)).toContain('General Kenobi.');
    expect(file.format).toBe('srt');
    expect(ffmpeg[0]).toContain('0:a:m:language:jpn?');
    const asr = new URL(calls[0]!.url);
    expect(asr.pathname).toBe('/asr');
    expect(Object.fromEntries(asr.searchParams)).toEqual({ task: 'transcribe', language: 'ja', output: 'srt', encode: 'true', video_file: PATH });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBeInstanceOf(FormData);
    expect((calls[0]!.body as FormData).get('audio_file')).toBeInstanceOf(Blob);
  });

  it('maps ASR server errors to unreachable', async () => {
    const { p } = setup({ asrStatus: 500 });
    const [c] = await p.search(query([w('ja')]));
    await expect(p.download(c!)).rejects.toMatchObject({ code: 'unreachable' });
  });
});
