import type {
  ProviderCapabilities,
  ProviderContext,
  RateLimit,
  SubtitleCandidate,
  SubtitleFile,
  SubtitleQuery,
} from '../types.js';
import { BaseProvider, languageSet } from './base.js';

// Jimaku: Japanese anime subtitles keyed by AniList.

export interface JimakuConfig {
  apiKey: string;
  /** Search by name when the video has no AniList id. */
  nameSearchFallback?: boolean | undefined;
  /** Allow archive files (zip/rar) when plain files exist. */
  archives?: boolean | undefined;
  /** Allow AI-generated (Whisper) subtitles. */
  aiSubs?: boolean | undefined;
  baseUrl?: string | undefined;
}

interface JimakuEntry {
  id: number;
  name?: string;
  anilist_id?: number | null;
  flags?: { movie?: boolean; unverified?: boolean; anime?: boolean };
}
interface JimakuFile {
  url: string;
  name: string;
  size?: number;
  last_modified?: string;
}

const ARCHIVE = /\.(zip|rar)$/i;
const SEVEN_Z = /\.7z$/i;
const AI_MARK = /whisper|\bai\b|[-_. ]ai[-_. ]/i;

const SHORTCUTS: Record<string, string> = {
  jp: 'ja', jap: 'ja', jpn: 'ja', ja: 'ja', japanese: 'ja',
  chs: 'zh', cht: 'zh', zhi: 'zh', cn: 'zh', zh: 'zh', sc: 'zh', tc: 'zh',
  en: 'en', eng: 'en',
};
const TWO_LETTER = new Set(['ja', 'zh', 'en', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ar', 'th', 'vi', 'id']);

/**
 * Heuristic language guess from a Jimaku file name: the token before the extension, split
 * on separators. Four-letter tokens are two two-letter codes; shortcuts collapse to ja/zh;
 * unknown short alphabetic tokens become 'zu' (sentinel: foreign but unknown). Tokens with
 * digits or five+ letters are not language tokens. Returns [] when nothing looked like one.
 */
export function guessJimakuLanguages(fileName: string): string[] {
  const stem = fileName.replace(/\.[a-z0-9]+$/i, '');
  const lastDot = stem.lastIndexOf('.');
  const token = lastDot >= 0 ? stem.slice(lastDot + 1) : '';
  const found = new Set<string>();
  for (const raw of token.toLowerCase().split(/[-_ ,&+]+/).filter(Boolean)) {
    if (raw === 'ass' || raw === 'srt') continue;
    if (/\d/.test(raw) || raw.length >= 5 || !/^[a-z]+$/.test(raw)) continue;
    const parts = raw.length === 4 && !SHORTCUTS[raw] ? [raw.slice(0, 2), raw.slice(2)] : [raw];
    for (const p of parts) {
      const mapped = SHORTCUTS[p] ?? (TWO_LETTER.has(p) ? p : 'zu');
      found.add(mapped);
    }
  }
  return [...found];
}

export class JimakuProvider extends BaseProvider {
  readonly kind = 'jimaku' as const;
  readonly needsAuth = true;
  readonly rateLimit: RateLimit = { minIntervalMs: 500, requestTimeoutMs: 30000 };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['anilist', 'title'],
    languages: languageSet(['ja']),
    forced: false,
    hi: false,
    hashVerifiable: false,
    hiVerifiable: false,
  };
  private readonly apiKey: string;
  private readonly nameFallback: boolean;
  private readonly allowArchives: boolean;
  private readonly allowAi: boolean;
  private readonly baseUrl: string;

  constructor(config: JimakuConfig, ctx?: ProviderContext) {
    super(ctx);
    if (!config.apiKey?.trim()) throw this.error('config', 'API key is required');
    this.apiKey = config.apiKey.trim();
    this.nameFallback = config.nameSearchFallback ?? true;
    this.allowArchives = config.archives ?? true;
    this.allowAi = config.aiSubs ?? false;
    this.baseUrl = (config.baseUrl ?? 'https://jimaku.cc/api').replace(/\/$/, '');
  }

  override supports(query: SubtitleQuery) {
    const base = super.supports(query);
    if (!base.ok) return base;
    if (query.anilistId === undefined && query.mediaType === 'episode' && !this.nameFallback) {
      return { ok: false as const, reason: 'jimaku needs an AniList id (name fallback is off)' };
    }
    return base;
  }

  /** GET with Authorization, 429 retry (max 3 attempts), error mapping. */
  private async api<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/${path}`;
    for (let attempt = 1; ; attempt++) {
      const res = await this.request(url, { headers: { Authorization: this.apiKey, Accept: 'application/json' } });
      if (res.status === 429) {
        if (attempt >= 3) throw this.error('api-throttled', 'rate limited after 3 attempts');
        await this.sleep(5000);
        continue;
      }
      if (res.status === 401) throw this.error('auth', 'API key rejected');
      if (!res.ok) throw this.statusError(res, path);
      const body = await this.parseJson<unknown>(res);
      if (body && typeof body === 'object' && !Array.isArray(body) && 'error' in body) {
        throw this.error('unreachable', `service error: ${String((body as { error: unknown }).error)}`);
      }
      return body as T;
    }
  }

  private async findEntry(query: SubtitleQuery): Promise<JimakuEntry | undefined> {
    let entries: JimakuEntry[];
    if (query.anilistId !== undefined) {
      entries = await this.api<JimakuEntry[]>(`entries/search?anilist_id=${query.anilistId}`);
      return (entries ?? []).find((e) => e.anilist_id === query.anilistId);
    }
    if (!this.nameFallback && query.mediaType !== 'movie') return undefined;
    let name = query.title.toLowerCase();
    if (query.mediaType === 'episode' && (query.season ?? 1) > 1) name = `${name} ${query.season}`;
    const q = encodeURIComponent(name);
    entries = await this.api<JimakuEntry[]>(`entries/search?query=${q}`);
    if (!entries?.length) entries = await this.api<JimakuEntry[]>(`entries/search?query=${q}&anime=false`);
    return entries?.[0];
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    if (!this.supports(query).ok) return [];
    if (!this.isWanted(query, 'ja', false)) return [];
    const entry = await this.findEntry(query);
    if (!entry) return [];

    let files: JimakuFile[];
    const isEpisode = query.mediaType === 'episode' && !entry.flags?.movie;
    if (isEpisode && query.episode !== undefined) {
      files = await this.api<JimakuFile[]>(`entries/${entry.id}/files?episode=${query.episode}`);
      if (!files?.length) {
        files = await this.api<JimakuFile[]>(`entries/${entry.id}/files`);
        files = (files ?? []).filter((f) => ARCHIVE.test(f.name));
      }
    } else {
      files = await this.api<JimakuFile[]>(`entries/${entry.id}/files`);
    }
    files = (files ?? []).filter((f) => !SEVEN_Z.test(f.name));
    const archives = files.filter((f) => ARCHIVE.test(f.name));
    const plain = files.filter((f) => !ARCHIVE.test(f.name));
    const chosen = plain.length === 0 ? archives : this.allowArchives ? files : plain;

    const out: SubtitleCandidate[] = [];
    for (const f of chosen) {
      if (!this.allowAi && AI_MARK.test(f.name)) continue;
      if (f.size !== undefined && f.size < 500) continue;
      const langs = guessJimakuLanguages(f.name);
      if (langs.length > 1 && langs.includes('ja')) continue; // multi-language file
      const matches: Array<'series' | 'title' | 'year' | 'season' | 'episode'> =
        query.mediaType === 'episode' ? ['series', 'season', 'episode'] : ['title'];
      out.push(
        this.candidate({
          id: f.url,
          language: 'ja',
          forced: false,
          hi: false,
          releaseInfo: f.name,
          downloadUrl: f.url,
          pageUrl: `https://jimaku.cc/entry/${entry.id}`,
          format: /\.srt$/i.test(f.name) ? 'srt' : /\.ass$/i.test(f.name) ? 'ass' : 'unknown',
          isPack: ARCHIVE.test(f.name),
          matches,
        }),
      );
    }
    return out;
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    if (!candidate.downloadUrl) throw this.error('bad-response', 'candidate has no download url');
    const bytes = await this.getBytes(candidate.downloadUrl, { headers: { Authorization: this.apiKey } });
    return this.file(bytes, candidate.releaseInfo);
  }

  async test(): Promise<void> {
    await this.api('entries/search?query=test');
  }
}
