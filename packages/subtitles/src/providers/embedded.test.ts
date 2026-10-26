import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EmbeddedProvider, buildSubtitleExtractArgs, type ProbeResult } from './embedded.js';
import { ProviderError, type SubtitleQuery, type WantedLanguage } from '../types.js';

const probeData = JSON.parse(readFileSync(new URL('../../fixtures/embedded/probe.json', import.meta.url), 'utf8')) as ProbeResult;
const PATH = '/media/Movie (2020)/Movie.2020.1080p.mkv';

const query = (languages: WantedLanguage[], over: Partial<SubtitleQuery> = {}): SubtitleQuery => ({
  mediaType: 'movie',
  title: 'Movie',
  filePath: PATH,
  languages,
  ...over,
});
const en = (hi: WantedLanguage['hi'] = 'normal', forced = false): WantedLanguage => ({ tag: 'en', forced, hi });

function provider(config = {}, runFfmpeg?: (a: string[]) => Promise<Uint8Array>) {
  let probes = 0;
  const p = new EmbeddedProvider(config, {
    probe: async () => {
      probes++;
      return probeData;
    },
    runFfmpeg,
  });
  return { p, probes: () => probes };
}

describe('buildSubtitleExtractArgs', () => {
  it('copies text codecs and converts mov_text', () => {
    expect(buildSubtitleExtractArgs({ input: 'in.mkv', streamIndex: 4, codec: 'ass', output: 'pipe:1' })).toEqual([
      'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', 'in.mkv', '-map', '0:4', '-c:s', 'copy', '-f', 'ass', 'pipe:1',
    ]);
    const mov = buildSubtitleExtractArgs({ ffmpegPath: '/usr/bin/ffmpeg', input: 'a.mp4', streamIndex: 2, codec: 'mov_text', output: 'o.srt' });
    expect(mov[0]).toBe('/usr/bin/ffmpeg');
    expect(mov.slice(-5)).toEqual(['-c:s', 'srt', '-f', 'srt', 'o.srt']);
    expect(buildSubtitleExtractArgs({ input: 'a', streamIndex: 1, codec: 'webvtt', output: 'o' })).toContain('webvtt');
  });
});

describe('EmbeddedProvider', () => {
  it('requires a probe and a supported codec', () => {
    expect(() => new EmbeddedProvider({}, {} as never)).toThrow(ProviderError);
    expect(() => new EmbeddedProvider({ includedCodecs: ['hdmv_pgs_subtitle'] }, { probe: async () => probeData })).toThrow(ProviderError);
  });

  it('refuses queries without a file path', () => {
    const { p } = provider();
    expect(p.supports(query([en()], { filePath: undefined })).ok).toBe(false);
    expect(p.supports(query([en()])).ok).toBe(true);
  });

  it('lists text tracks, excluding bitmap and incomplete ones, probing once', async () => {
    const { p, probes } = provider();
    const tracks = await p.tracks(PATH);
    expect(tracks.map((t) => [t.stream.index, t.tag, t.forced, t.hi])).toEqual([
      [2, 'en', false, false],
      [3, 'en', false, true],
      [4, 'en', true, false],
      [7, 'zh-Hant', false, false],
      [8, 'fr', false, false],
    ]);
    await p.tracks(PATH);
    expect(probes()).toBe(1);
  });

  it('maps tracks to hash-matched candidates honouring HI modes', async () => {
    const { p } = provider();
    const normal = await p.search(query([en()]));
    expect(normal.map((c) => c.id)).toEqual([`${PATH}_2`, `${PATH}_3`]);
    expect(normal[0]!.matches.has('hash')).toBe(true);
    expect(normal[0]!.hashVerifiable).toBe(false);
    expect(normal[0]!.releaseInfo).toBe('Movie.2020.1080p.en.srt');
    expect(normal[1]!.releaseInfo).toBe('Movie.2020.1080p.en.hi.srt');
    expect((await p.search(query([en('required')]))).map((c) => c.id)).toEqual([`${PATH}_3`]);
    expect((await p.search(query([en('excluded')]))).map((c) => c.id)).toEqual([`${PATH}_2`]);
  });

  it('returns only forced tracks when every wanted language is forced', async () => {
    const { p } = provider();
    const res = await p.search(query([en('normal', true)]));
    expect(res.map((c) => [c.id, c.forced, c.format])).toEqual([[`${PATH}_4`, true, 'ass']]);
  });

  it('applies unknown-as-fallback, dropping redundant fallback tracks', async () => {
    const { p } = provider({ unknownAsFallback: true, fallbackLanguage: 'de' });
    const tracks = await p.tracks(PATH);
    expect(tracks.find((t) => t.stream.index === 9)?.tag).toBe('de');
    const { p: p2 } = provider({ unknownAsFallback: true });
    expect((await p2.tracks(PATH)).some((t) => t.stream.index === 9)).toBe(false);
  });

  it('treats a lone HI track as normal with hiFallback', async () => {
    const data: ProbeResult = {
      streams: [{ index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'ger', title: 'SDH' } }],
    };
    const p = new EmbeddedProvider({ hiFallback: true }, { probe: async () => data });
    const res = await p.search(query([{ tag: 'de', forced: false, hi: 'excluded' }]));
    expect(res.map((c) => c.hi)).toEqual([false]);
  });

  it('downloads through the injected ffmpeg runner with stream args', async () => {
    const calls: string[][] = [];
    const { p } = provider({ ffmpegPath: 'ff' }, async (args) => {
      calls.push(args);
      return new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nhi\n');
    });
    const [c] = await p.search(query([{ tag: 'zh-Hant', forced: false, hi: 'normal' }]));
    const file = await p.download(c!);
    expect(file.format).toBe('srt');
    expect(calls[0]).toEqual(['ff', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', PATH, '-map', '0:7', '-c:s', 'srt', '-f', 'srt', 'pipe:1']);
  });

  it('fails download without a runner (config) and on extraction failure (must-blacklist)', async () => {
    const { p } = provider();
    const [c] = await p.search(query([en()]));
    await expect(p.download(c!)).rejects.toMatchObject({ code: 'config' });
    const { p: p2 } = provider({}, async () => {
      throw new Error('exit 1');
    });
    await expect(p2.download(c!)).rejects.toMatchObject({ code: 'must-blacklist' });
  });
});
