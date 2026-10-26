import { allLanguageTags, parseLanguageTag } from '../languages.js';
import type {
  LanguageTag,
  ProviderCapabilities,
  ProviderContext,
  RateLimit,
  SubtitleCandidate,
  SubtitleFile,
  SubtitleFormat,
  SubtitleQuery,
} from '../types.js';
import { BaseProvider, languageSet } from './base.js';

// Embedded subtitles: text subtitle streams already inside the container, found with an
// injected ffprobe-like probe and extracted with an injected ffmpeg runner.

export interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  tags?: Record<string, string | undefined>;
  disposition?: { forced?: number | boolean; hearing_impaired?: number | boolean; default?: number | boolean };
}
export interface ProbeResult {
  streams: ProbeStream[];
}

export interface EmbeddedConfig {
  includedCodecs?: readonly string[] | undefined;
  hiFallback?: boolean | undefined;
  unknownAsFallback?: boolean | undefined;
  fallbackLanguage?: string | undefined;
  ffmpegPath?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface EmbeddedDeps {
  probe: (path: string) => Promise<ProbeResult>;
  runFfmpeg?: ((args: string[]) => Promise<Uint8Array>) | undefined;
}

export const DEFAULT_EMBEDDED_CODECS = ['ass', 'subrip', 'webvtt', 'mov_text'] as const;
const BITMAP_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext']);
const ALLOWED_CODECS = new Set<string>(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text', 'text']);

export function codecFormat(codec: string): SubtitleFormat {
  switch (codec) {
    case 'ass':
      return 'ass';
    case 'ssa':
      return 'ssa';
    case 'webvtt':
      return 'vtt';
    default:
      return 'srt';
  }
}

export interface ExtractArgsInput {
  ffmpegPath?: string | undefined;
  input: string;
  streamIndex: number;
  /** Source codec name; decides copy vs convert. */
  codec: string;
  output: string;
}

/** ffmpeg argv (argv[0] is the binary) that copies one subtitle stream out of a container. */
export function buildSubtitleExtractArgs(o: ExtractArgsInput): string[] {
  const format = codecFormat(o.codec);
  const convert = o.codec === 'mov_text' || o.codec === 'text';
  const muxer = format === 'srt' ? 'srt' : format === 'vtt' ? 'webvtt' : format;
  return [
    o.ffmpegPath ?? 'ffmpeg',
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', o.input,
    '-map', `0:${o.streamIndex}`,
    '-c:s', convert ? 'srt' : 'copy',
    '-f', muxer,
    o.output,
  ];
}

const on = (v: number | boolean | undefined): boolean => v === true || v === 1;

function chineseVariant(tagLang: string, title: string): LanguageTag {
  const l = tagLang.toLowerCase();
  if (/(hant|tw|hk|mo)\b/.test(l)) return 'zh-Hant';
  if (/(hans|cn|sg)\b/.test(l)) return 'zh-Hans';
  const t = title.toLowerCase();
  if (/big5|traditional|繁|cht|tc\b/.test(t)) return 'zh-Hant';
  if (/simplified|简|chs|sc\b/.test(t)) return 'zh-Hans';
  return 'zh';
}

interface Track {
  stream: ProbeStream;
  tag: LanguageTag;
  forced: boolean;
  hi: boolean;
  fallbackLang: boolean;
  frames: number | undefined;
}

export class EmbeddedProvider extends BaseProvider {
  readonly kind = 'embeddedsubtitles' as const;
  readonly needsAuth = false;
  readonly rateLimit: RateLimit;
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['file'],
    languages: languageSet([...allLanguageTags(), 'zh-TW']),
    forced: true,
    hi: true,
    hashVerifiable: false,
    hiVerifiable: true,
  };
  private readonly codecs: Set<string>;
  private readonly hiFallback: boolean;
  private readonly unknownAsFallback: boolean;
  private readonly fallbackLanguage: LanguageTag;
  private readonly ffmpegPath: string;
  private readonly probeFn: EmbeddedDeps['probe'];
  private readonly runFfmpeg: EmbeddedDeps['runFfmpeg'];
  private readonly probeCache = new Map<string, Promise<ProbeResult>>();
  private readonly failedProbes = new Set<string>();

  constructor(config: EmbeddedConfig, deps: EmbeddedDeps, ctx?: ProviderContext) {
    super(ctx);
    if (typeof deps?.probe !== 'function') throw this.error('config', 'a probe function is required');
    const codecs = config.includedCodecs ?? DEFAULT_EMBEDDED_CODECS;
    this.codecs = new Set(codecs.filter((c) => ALLOWED_CODECS.has(c)));
    if (this.codecs.size === 0) throw this.error('config', 'no supported codecs in includedCodecs');
    const fb = parseLanguageTag(config.fallbackLanguage ?? 'en');
    if (!fb) throw this.error('config', `unknown fallback language ${config.fallbackLanguage}`);
    this.fallbackLanguage = fb;
    this.hiFallback = config.hiFallback ?? false;
    this.unknownAsFallback = config.unknownAsFallback ?? false;
    this.ffmpegPath = config.ffmpegPath ?? 'ffmpeg';
    this.rateLimit = { minIntervalMs: 0, requestTimeoutMs: config.timeoutMs ?? 600000, throttle: undefined };
    this.probeFn = deps.probe;
    this.runFfmpeg = deps.runFfmpeg;
  }

  private probe(path: string): Promise<ProbeResult> {
    let p = this.probeCache.get(path);
    if (!p) {
      p = this.probeFn(path);
      this.probeCache.set(path, p);
    }
    return p;
  }

  /** Text subtitle tracks after codec, language, completeness and HI-fallback rules. */
  async tracks(path: string): Promise<Track[]> {
    let result: ProbeResult;
    try {
      result = await this.probe(path);
    } catch (err) {
      this.failedProbes.add(path);
      this.probeCache.delete(path);
      throw this.error('bad-response', `probe failed: ${(err as Error).message}`, { cause: err });
    }
    let tracks: Track[] = [];
    for (const s of result.streams ?? []) {
      if (s.codec_type !== 'subtitle' || !s.codec_name) continue;
      if (BITMAP_CODECS.has(s.codec_name) || !this.codecs.has(s.codec_name)) continue;
      const tags = s.tags ?? {};
      const rawLang = tags['language'] ?? '';
      const title = tags['title'] ?? '';
      let tag = rawLang && rawLang !== 'und' ? parseLanguageTag(rawLang) : undefined;
      let fallbackLang = false;
      if (!tag) {
        if (!this.unknownAsFallback) continue;
        tag = this.fallbackLanguage;
        fallbackLang = true;
      }
      if (tag.split('-')[0] === 'zh') tag = chineseVariant(rawLang, title);
      const forced = on(s.disposition?.forced) || /forced/i.test(title);
      const hi = !forced && (on(s.disposition?.hearing_impaired) || /\b(sdh|cc|hi)\b/i.test(title));
      const framesRaw = tags['NUMBER_OF_FRAMES'] ?? tags['NUMBER_OF_FRAMES-eng'];
      const frames = framesRaw !== undefined && /^\d+$/.test(framesRaw) ? Number(framesRaw) : undefined;
      tracks.push({ stream: s, tag, forced, hi, fallbackLang, frames });
    }
    // A fallback-language track is redundant when a real one has the same flavour.
    tracks = tracks.filter(
      (t) => !t.fallbackLang || !tracks.some((o) => !o.fallbackLang && o.tag === t.tag && o.forced === t.forced && o.hi === t.hi),
    );
    // Probably incomplete: fewer than a third of the largest frame count (forced exempt).
    const maxFrames = Math.max(0, ...tracks.map((t) => t.frames ?? 0));
    if (maxFrames > 0) tracks = tracks.filter((t) => t.forced || t.frames === undefined || t.frames * 3 >= maxFrames);
    if (this.hiFallback) {
      for (const t of tracks) {
        if (!t.hi) continue;
        const same = tracks.filter((o) => o.tag === t.tag && !o.forced);
        if (same.every((o) => o.hi)) t.hi = false;
      }
    }
    return tracks;
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    const path = query.filePath;
    if (!path || !this.supports(query).ok || this.failedProbes.has(path)) return [];
    const wanted = this.wantedLanguages(query);
    const allForced = wanted.length > 0 && wanted.every((w) => w.forced);
    const base = (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, '');
    const out: SubtitleCandidate[] = [];
    for (const t of await this.tracks(path)) {
      if (allForced && !t.forced) continue;
      const ok = wanted.some(
        (w) => w.tag === t.tag && t.forced === w.forced && !(w.hi === 'excluded' && t.hi) && !(w.hi === 'required' && !t.hi),
      );
      if (!ok) continue;
      const format = codecFormat(t.stream.codec_name!);
      const suffix = `${t.tag}${t.forced ? '.forced' : t.hi ? '.hi' : ''}.${format}`;
      out.push(
        this.candidate({
          id: `${path}_${t.stream.index}`,
          language: t.tag,
          forced: t.forced,
          hi: t.hi,
          releaseInfo: `${base}.${suffix}`,
          format,
          token: { path, streamIndex: t.stream.index, codec: t.stream.codec_name! },
          matches: ['hash'],
        }),
      );
    }
    return out;
  }

  /** ffmpeg argv for a candidate (output to stdout). */
  extractArgs(candidate: SubtitleCandidate): string[] {
    const tok = candidate.token as { path?: string; streamIndex?: number; codec?: string } | undefined;
    if (!tok?.path || tok.streamIndex === undefined || !tok.codec) {
      throw this.error('bad-response', 'candidate lacks stream information');
    }
    return buildSubtitleExtractArgs({ ffmpegPath: this.ffmpegPath, input: tok.path, streamIndex: tok.streamIndex, codec: tok.codec, output: 'pipe:1' });
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    if (!this.runFfmpeg) throw this.error('config', 'no ffmpeg runner configured');
    const args = this.extractArgs(candidate);
    let bytes: Uint8Array;
    try {
      bytes = await this.runFfmpeg(args);
    } catch (err) {
      throw this.error('must-blacklist', `extraction failed: ${(err as Error).message}`, { cause: err });
    }
    if (bytes.length === 0) throw this.error('must-blacklist', 'extraction produced no data');
    return { bytes, format: candidate.format ?? 'srt', encoding: 'utf-8', fileName: candidate.releaseInfo };
  }

  async test(): Promise<void> {
    // Local provider: nothing to reach.
  }
}
