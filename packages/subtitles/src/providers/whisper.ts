import { languageName, parseLanguageTag, toAlpha2, toAlpha3 } from '../languages.js';
import type {
  LanguageTag,
  MatchKey,
  ProviderCapabilities,
  ProviderContext,
  RateLimit,
  SubtitleCandidate,
  SubtitleFile,
  SubtitleQuery,
} from '../types.js';
import { BaseProvider, languageSet } from './base.js';

// Whisper: generate subtitles from the audio with a user-run Whisper ASR web service
// (asr + detect-language endpoints). Provider of last resort.

export interface WhisperConfig {
  endpoint: string;
  responseTimeoutMs?: number | undefined;
  transcribeTimeoutMs?: number | undefined;
  passVideoName?: boolean | undefined;
  ffmpegPath?: string | undefined;
}

export interface WhisperDeps {
  /** Runs ffmpeg with the given argv (argv[0] is the binary) and returns stdout. */
  extractAudio?: ((args: string[]) => Promise<Uint8Array>) | undefined;
}

// Languages Whisper can transcribe (two-letter codes).
const WHISPER_LANGS = (
  'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt ln ha ba jw su'
).split(' ');
const AMBIGUOUS = new Set(['mul', 'und', 'zxx', 'mis', 'sgn', 'qaa', 'art', 'nai', 'sai', 'afa', 'map', 'ine', 'sla', 'gem', 'roa', 'cel']);

export interface AudioArgsInput {
  ffmpegPath?: string | undefined;
  input: string;
  /** ISO 639-2/B code of the audio stream to pick (first match), else the first audio stream. */
  audioStreamLanguage3?: string | undefined;
  output: string;
  /** Raw PCM (s16le) or a WAV container. Default wav. */
  container?: 's16le' | 'wav' | undefined;
}

/** ffmpeg argv extracting mono 16 kHz 16-bit PCM from one audio stream. */
export function buildAudioExtractArgs(o: AudioArgsInput): string[] {
  return [
    o.ffmpegPath ?? 'ffmpeg',
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', o.input,
    '-map', o.audioStreamLanguage3 ? `0:a:m:language:${o.audioStreamLanguage3}?` : '0:a:0',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-f', o.container ?? 'wav',
    o.output,
  ];
}

type Task = 'transcribe' | 'translate';

interface WhisperToken {
  task: Task;
  /** Two-letter language of the audio given to the service. */
  audioLanguage: string;
  /** 639-2/B tag of the stream to pick, when several audio tracks exist. */
  streamLanguage3?: string | undefined;
  path: string;
}

export class WhisperProvider extends BaseProvider {
  readonly kind = 'whisperai' as const;
  readonly needsAuth = false;
  readonly rateLimit: RateLimit;
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['file'],
    languages: languageSet(WHISPER_LANGS),
    forced: false,
    hi: false,
    hashVerifiable: false,
    hiVerifiable: false,
  };
  private readonly endpoint: string;
  private readonly transcribeTimeoutMs: number;
  private readonly passVideoName: boolean;
  private readonly ffmpegPath: string;
  private readonly extractAudio: WhisperDeps['extractAudio'];
  private readonly detected = new Map<string, string | null>();

  constructor(config: WhisperConfig, deps: WhisperDeps = {}, ctx?: ProviderContext) {
    super(ctx);
    const endpoint = config.endpoint?.trim().replace(/\/+$/, '');
    if (!endpoint) throw this.error('config', 'endpoint is required');
    this.endpoint = endpoint;
    this.transcribeTimeoutMs = config.transcribeTimeoutMs ?? 3600000;
    this.passVideoName = config.passVideoName ?? false;
    this.ffmpegPath = config.ffmpegPath ?? 'ffmpeg';
    this.extractAudio = deps.extractAudio;
    this.rateLimit = {
      minIntervalMs: 0,
      requestTimeoutMs: config.responseTimeoutMs ?? 30000,
      throttle: { unreachable: { kind: 'duration', ms: 5 * 60000 } },
    };
  }

  private async audio(path: string, streamLanguage3?: string): Promise<Uint8Array> {
    if (!this.extractAudio) throw this.error('config', 'no audio extractor configured');
    return this.extractAudio(
      buildAudioExtractArgs({ ffmpegPath: this.ffmpegPath, input: path, audioStreamLanguage3: streamLanguage3, output: 'pipe:1' }),
    );
  }

  private form(audio: Uint8Array): FormData {
    const fd = new FormData();
    fd.append('audio_file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'audio.wav');
    return fd;
  }

  /** Detect the spoken language via the service; memoised per file. Null = undetermined. */
  async detectLanguage(path: string): Promise<string | null> {
    if (this.detected.has(path)) return this.detected.get(path)!;
    const audio = await this.audio(path);
    const res = await this.request(`${this.endpoint}/detect-language?encode=true`, { method: 'POST', body: this.form(audio) });
    if (!res.ok) throw this.statusError(res, 'detect-language');
    const body = await this.parseJson<{ detected_language?: string; language_code?: string }>(res);
    const tag = parseLanguageTag(body.language_code ?? body.detected_language ?? '');
    const code = tag && tag !== 'und' ? toAlpha2(tag) : null;
    this.detected.set(path, code);
    return code;
  }

  /** Audio languages (two-letter) from the query tags, mapped; null if detection is needed. */
  private tagLanguages(query: SubtitleQuery): Array<{ code: string; tag3: string | undefined }> | null {
    const raw = query.audioLanguages ?? [];
    if (raw.length === 0) return null;
    const out: Array<{ code: string; tag3: string | undefined }> = [];
    for (const r of raw) {
      const low = r.toLowerCase();
      if (AMBIGUOUS.has(low)) return null;
      if (low === 'gsw') {
        out.push({ code: 'de', tag3: 'gsw' });
        continue;
      }
      const tag = parseLanguageTag(r);
      const code = tag ? toAlpha2(tag) : null;
      if (!code) return null;
      out.push({ code, tag3: toAlpha3(code, 'b') ?? undefined });
    }
    return out;
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    const path = query.filePath;
    if (!path || !this.supports(query).ok) return [];
    let audio = this.tagLanguages(query);
    if (audio === null) {
      const detected = await this.detectLanguage(path);
      if (!detected) return [];
      audio = [{ code: detected, tag3: undefined }];
    }
    const multi = audio.length > 1;
    const name = query.fileName ?? path.split(/[\\/]/).pop() ?? path;
    const out: SubtitleCandidate[] = [];
    for (const w of this.wantedLanguages(query)) {
      const target = toAlpha2(w.tag);
      if (!target || !WHISPER_LANGS.includes(target)) continue;
      const same = audio.find((a) => a.code === target);
      let token: WhisperToken;
      if (same) {
        token = { task: 'transcribe', audioLanguage: same.code, streamLanguage3: multi ? same.tag3 : undefined, path };
      } else if (target === 'en') {
        const first = audio[0]!;
        token = { task: 'translate', audioLanguage: first.code, streamLanguage3: multi ? first.tag3 : undefined, path };
      } else {
        continue; // Whisper only translates into English.
      }
      const matches: MatchKey[] = query.mediaType === 'episode' ? ['series', 'season', 'episode'] : ['title'];
      out.push(
        this.candidate({
          id: `${name}_${token.task}_${w.tag}`,
          language: w.tag as LanguageTag,
          forced: false,
          hi: false,
          releaseInfo: `${token.task} ${languageName(token.audioLanguage)} audio to ${languageName(target)} SRT`,
          format: 'srt',
          encoding: 'utf-8',
          token: { ...token },
          matches,
        }),
      );
    }
    return out;
  }

  /** The ASR request URL for a candidate. */
  asrUrl(candidate: SubtitleCandidate): string {
    const tok = candidate.token as unknown as WhisperToken;
    const params = new URLSearchParams({ task: tok.task, language: tok.audioLanguage, output: 'srt', encode: 'true' });
    if (this.passVideoName) params.set('video_file', tok.path);
    return `${this.endpoint}/asr?${params.toString()}`;
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    const tok = candidate.token as unknown as WhisperToken | undefined;
    if (!tok?.path) throw this.error('bad-response', 'candidate lacks a file path');
    let audio: Uint8Array;
    try {
      audio = await this.audio(tok.path, tok.streamLanguage3);
    } catch (err) {
      if ((err as { code?: string }).code === 'config') throw err;
      // A failed ffmpeg run yields empty content, not a throttle.
      return { bytes: new Uint8Array(), format: 'srt', encoding: 'utf-8' };
    }
    const res = await this.request(this.asrUrl(candidate), { method: 'POST', body: this.form(audio), timeoutMs: this.transcribeTimeoutMs });
    if (!res.ok) throw this.statusError(res, 'asr');
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, format: 'srt', encoding: 'utf-8' };
  }

  async test(): Promise<void> {
    const res = await this.request(`${this.endpoint}/docs`);
    if (!res.ok) throw this.statusError(res, 'docs');
  }
}
