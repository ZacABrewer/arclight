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
  SupportResult,
} from '../types.js';
import { BaseProvider } from './base.js';

// Gestdown (spec 2.5): a JSON mirror of Addic7ed keyed by TheTVDB series ids. Episodes only.

export interface GestdownConfig {
  baseUrl?: string | undefined;
}

/** Base tag -> Addic7ed-style English language name used in Gestdown URLs. */
export const GESTDOWN_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  sq: 'Albanian', ar: 'Arabic', hy: 'Armenian', az: 'Azerbaijani', eu: 'Euskera', be: 'Belarusian', bn: 'Bengali',
  bs: 'Bosnian', bg: 'Bulgarian', ca: 'Català', zh: 'Chinese (Simplified)', hr: 'Croatian', cs: 'Czech', da: 'Danish',
  nl: 'Dutch', en: 'English', et: 'Estonian', fa: 'Persian', fi: 'Finnish', fr: 'French', gl: 'Galego', de: 'German',
  el: 'Greek', he: 'Hebrew', hi: 'Hindi', hu: 'Hungarian', is: 'Icelandic', id: 'Indonesian', it: 'Italian',
  ja: 'Japanese', kn: 'Kannada', ko: 'Korean', lv: 'Latvian', lt: 'Lithuanian', mk: 'Macedonian', ms: 'Malay',
  no: 'Norwegian', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sr: 'Serbian (Latin)', sk: 'Slovak',
  sl: 'Slovenian', es: 'Spanish', sv: 'Swedish', ta: 'Tamil', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese',
};

interface GestdownShow {
  id: string;
  name?: string;
  tvDbId?: number;
}
interface GestdownSubtitle {
  subtitleId: string;
  version?: string;
  completed?: boolean;
  hearingImpaired?: boolean;
  qualities?: string[];
  downloadUri?: string;
  language?: string;
  downloadCount?: number;
}

export class GestdownProvider extends BaseProvider {
  readonly kind = 'gestdown' as const;
  readonly needsAuth = false;
  readonly rateLimit: RateLimit = { minIntervalMs: 250, requestTimeoutMs: 30_000 };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode'],
    inputs: ['tvdb', 'season-episode'],
    languages: new Set(Object.keys(GESTDOWN_LANGUAGE_NAMES)),
    forced: false,
    hi: true,
    hashVerifiable: false,
    hiVerifiable: true,
  };

  private readonly base: string;

  constructor(config: GestdownConfig = {}, ctx: ProviderContext = {}) {
    super({ userAgent: 'Arclight', ...ctx });
    this.base = (config.baseUrl ?? 'https://api.gestdown.info').replace(/\/+$/, '');
  }

  override supports(query: SubtitleQuery): SupportResult {
    if (query.mediaType === 'episode' && query.seriesTvdbId === undefined) {
      return { ok: false, reason: 'gestdown needs the series tvdb id' };
    }
    return super.supports(query);
  }

  async test(): Promise<void> {
    const res = await this.request(`${this.base}/shows/external/tvdb/121361`);
    if (!res.ok && res.status !== 404) throw this.statusError(res, 'test');
  }

  private async shows(tvdbId: number): Promise<GestdownShow[]> {
    const res = await this.request(`${this.base}/shows/external/tvdb/${tvdbId}`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return [];
    if (!res.ok) throw this.statusError(res, 'show lookup');
    try {
      const body = JSON.parse(await res.text()) as { shows?: GestdownShow[] };
      return Array.isArray(body.shows) ? body.shows.filter((s) => s && s.id) : [];
    } catch {
      return [];
    }
  }

  /** Episode listing; 423 (still fetching upstream) retried 3x with 30 s pauses, then empty. */
  private async subtitles(showId: string, season: number, episode: number, language: string): Promise<GestdownSubtitle[]> {
    const url = `${this.base}/subtitles/get/${encodeURIComponent(showId)}/${season}/${episode}/${encodeURIComponent(language)}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.request(url, { headers: { Accept: 'application/json' } });
      if (res.status === 423) {
        if (attempt >= 2) return [];
        await this.sleep(30_000);
        continue;
      }
      if (res.status === 404) return [];
      if (!res.ok) throw this.statusError(res, 'episode subtitles');
      try {
        const body = JSON.parse(await res.text()) as { matchingSubtitles?: GestdownSubtitle[] };
        return Array.isArray(body.matchingSubtitles) ? body.matchingSubtitles : [];
      } catch {
        return [];
      }
    }
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    if (!this.supports(query).ok) return [];
    const tvdb = query.seriesTvdbId!;
    const season = query.season!;
    const episode = query.episode!;
    const wanted = this.wantedLanguages(query).filter((w) => !w.forced);
    const tags = [...new Set(wanted.map((w) => w.tag))];
    const shows = await this.shows(tvdb);
    const out: SubtitleCandidate[] = [];
    const seen = new Set<string>();
    for (const tag of tags) {
      const name = GESTDOWN_LANGUAGE_NAMES[baseTag(tag) as LanguageTag];
      if (!name) continue;
      for (const show of shows) {
        const subs = await this.subtitles(show.id, season, episode, name);
        for (const s of subs) {
          if (!s.completed || !s.downloadUri || seen.has(s.subtitleId)) continue;
          seen.add(s.subtitleId);
          const matches = new Set<MatchKey>(['title', 'series', 'season', 'episode', 'tvdb_id']);
          if (show.tvDbId === tvdb) matches.add('year');
          if (query.resolution && (s.qualities ?? []).some((q) => q.toLowerCase().includes(query.resolution!.toLowerCase()))) {
            matches.add('resolution');
          }
          out.push(
            this.candidate({
              id: s.subtitleId,
              language: tag,
              forced: false,
              hi: Boolean(s.hearingImpaired),
              releaseInfo: (s.version ?? '').split(',').map((v) => v.trim()).filter(Boolean).join('\n'),
              matches,
              downloadUrl: new URL(s.downloadUri, this.base + '/').toString(),
              downloads: s.downloadCount,
              season,
              episode,
            }),
          );
        }
      }
    }
    return out;
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    const url = candidate.downloadUrl ?? `${this.base}/subtitles/download/${candidate.id}`;
    const bytes = await this.getBytes(url);
    return this.file(bytes, `${candidate.id}.srt`);
  }
}
