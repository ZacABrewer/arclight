// Podnapisi (podnapisi.net).
//
// STATUS: best-effort and UNVERIFIED. The provider spec (subtitle-providers.md 2.4) records
// that the upstream reference removed this provider, so there is no reference behaviour.
// This client targets the site's JSON search endpoint (/subtitles/search/advanced with
// "Accept: application/json"), using the response shape {data:[...], page, all_pages} as
// observed from the public site. Field names may drift; any shape mismatch surfaces as a
// 'bad-response' error rather than silently returning nothing.

import { baseTag } from '../languages.js';
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
import { BaseProvider } from './base.js';

export interface PodnapisiConfig {
  /** Override the site host (tests, mirrors). */
  baseUrl?: string | undefined;
  /** Pages to read per search (default 3). */
  maxPages?: number | undefined;
}

const PODNAPISI_LANGUAGES = [
  'sq', 'ar', 'hy', 'be', 'bs', 'bg', 'ca', 'zh', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fa', 'fi', 'fr', 'de', 'el',
  'he', 'hi', 'hu', 'is', 'id', 'ga', 'it', 'ja', 'kk', 'ko', 'lv', 'lt', 'mk', 'ms', 'no', 'pl', 'pt', 'pt-BR',
  'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sv', 'th', 'tr', 'uk', 'vi',
];

/** Internal tag -> podnapisi language code. */
export function podnapisiLanguage(tag: LanguageTag): string {
  return tag === 'pt-BR' ? 'pt-br' : baseTag(tag);
}

interface PodnapisiItem {
  id?: string;
  language?: string;
  releases?: string[];
  flags?: string[];
  download?: string;
  url?: string;
  stats?: { downloads?: number; rating?: number };
  contributors?: Array<{ name?: string }>;
  movie?: {
    title?: string;
    year?: number;
    type?: string;
    episode_info?: { season?: number; episode?: number };
  };
}
interface PodnapisiResponse {
  data?: PodnapisiItem[];
  page?: number;
  all_pages?: number;
}

const sanitize = (s: string) =>
  s.toLowerCase().replace(/['’`]/g, '').replace(/[-:().]/g, ' ').replace(/\s+/g, ' ').trim();

export class PodnapisiProvider extends BaseProvider {
  readonly kind = 'podnapisi' as const;
  readonly needsAuth = false;
  readonly rateLimit: RateLimit = { minIntervalMs: 500, requestTimeoutMs: 15_000 };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['title', 'season-episode'],
    languages: new Set(PODNAPISI_LANGUAGES),
    forced: true,
    hi: true,
    hashVerifiable: false,
    hiVerifiable: true,
  };

  private readonly base: string;
  private readonly maxPages: number;

  constructor(config: PodnapisiConfig = {}, ctx: ProviderContext = {}) {
    super(ctx);
    this.base = (config.baseUrl ?? 'https://www.podnapisi.net').replace(/\/+$/, '');
    this.maxPages = Math.max(1, config.maxPages ?? 3);
  }

  async test(): Promise<void> {
    await this.getJson(`${this.base}/subtitles/search/advanced?keywords=test&language=en`);
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    const wanted = this.wantedLanguages(query);
    const out: SubtitleCandidate[] = [];
    const seen = new Set<string>();
    const codes = [...new Set(wanted.map((w) => podnapisiLanguage(w.tag)))];
    for (const code of codes) {
      const tags = wanted.filter((w) => podnapisiLanguage(w.tag) === code);
      for (let page = 1; page <= this.maxPages; page++) {
        const params = new URLSearchParams({ keywords: query.title, language: code });
        if (query.year !== undefined) params.set('year', String(query.year));
        if (query.mediaType === 'episode') {
          params.set('movie_type', 'tv-series');
          if (query.season !== undefined) params.set('seasons', String(query.season));
          if (query.episode !== undefined) params.set('episodes', String(query.episode));
        } else params.set('movie_type', 'movie');
        if (page > 1) params.set('page', String(page));
        const body = await this.getJson<PodnapisiResponse>(`${this.base}/subtitles/search/advanced?${params.toString()}`);
        if (!body || !Array.isArray(body.data)) throw this.error('bad-response', 'search response has no data list');
        for (const item of body.data) {
          if (!item.id || seen.has(item.id)) continue;
          if ((item.language ?? '').toLowerCase() !== code) continue;
          const flags = item.flags ?? [];
          const hi = flags.includes('hearing_impaired');
          const forced = flags.includes('foreign_only');
          const tag = tags.find((w) => w.forced === forced)?.tag;
          if (!tag) continue;
          const m = item.movie ?? {};
          const matches = new Set<MatchKey>();
          const titles = [query.title, query.originalTitle, ...(query.alternativeTitles ?? [])].filter((t): t is string => Boolean(t)).map(sanitize);
          if (m.title && titles.includes(sanitize(m.title))) matches.add(query.mediaType === 'episode' ? 'series' : 'title');
          if (m.year !== undefined && query.year !== undefined && m.year === query.year) matches.add('year');
          if (query.mediaType === 'episode') {
            const ei = m.episode_info ?? {};
            if (ei.season !== undefined && ei.season === query.season) matches.add('season');
            if (ei.episode !== undefined && ei.episode === query.episode) matches.add('episode');
            if (ei.episode !== undefined && query.episode !== undefined && ei.episode !== query.episode) continue;
          }
          seen.add(item.id);
          const download = item.download ?? `/subtitles/${item.id}/download`;
          out.push(
            this.candidate({
              id: item.id,
              language: tag,
              forced,
              hi,
              releaseInfo: (item.releases ?? []).join('\n'),
              matches,
              downloadUrl: new URL(download, this.base).toString(),
              pageUrl: item.url ? new URL(item.url, this.base).toString() : undefined,
              uploader: item.contributors?.[0]?.name,
              rating: item.stats?.rating,
              downloads: item.stats?.downloads,
              season: m.episode_info?.season,
              episode: m.episode_info?.episode,
            }),
          );
        }
        if (!body.all_pages || page >= body.all_pages) break;
      }
    }
    return out;
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    const url = candidate.downloadUrl ?? `${this.base}/subtitles/${candidate.id}/download`;
    const bytes = await this.getBytes(url);
    return this.file(bytes, `${candidate.id}.zip`);
  }
}
