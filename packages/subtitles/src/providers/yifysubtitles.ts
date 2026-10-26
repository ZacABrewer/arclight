import { parseLanguageTag } from '../languages.js';
import type {
  LanguageTag,
  ProviderCapabilities,
  ProviderContext,
  RateLimit,
  SubtitleCandidate,
  SubtitleFile,
  SubtitleQuery,
} from '../types.js';
import { BaseProvider } from './base.js';
import { absoluteUrl, anchors, byClass, findElements, getAttr, textContent } from './html.js';

// YIFY Subtitles: movies only, looked up by imdb id; HTML table scrape, zip downloads.

const NAMES = [
  'Albanian', 'Arabic', 'Bengali', 'Bosnian', 'Brazilian Portuguese', 'Bulgarian', 'Chinese', 'Croatian',
  'Czech', 'Danish', 'Dutch', 'English', 'Estonian', 'Farsi/Persian', 'Finnish', 'French', 'German',
  'Greek', 'Hebrew', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Korean', 'Lithuanian',
  'Macedonian', 'Malay', 'Norwegian', 'Polish', 'Portuguese', 'Romanian', 'Russian', 'Serbian',
  'Slovenian', 'Spanish', 'Swedish', 'Thai', 'Turkish', 'Ukrainian', 'Urdu', 'Vietnamese',
];

/** YIFY language name to tag. */
export function yifyLanguageFromName(name: string): LanguageTag | undefined {
  const n = name.trim().toLowerCase();
  if (n === 'farsi/persian') return 'fa';
  return parseLanguageTag(n);
}

const LANGS: ReadonlySet<LanguageTag> = new Set(NAMES.map((n) => yifyLanguageFromName(n)!).filter(Boolean));

export interface YifySubtitlesConfig {
  baseUrl?: string | undefined;
}

export class YifySubtitlesProvider extends BaseProvider {
  readonly kind = 'yifysubtitles' as const;
  readonly needsAuth = false;
  readonly rateLimit: RateLimit = { minIntervalMs: 1000, requestTimeoutMs: 10_000 };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['movie'],
    inputs: ['imdb'],
    languages: LANGS,
    forced: false,
    hi: true,
    hashVerifiable: false,
    hiVerifiable: true,
  };
  private readonly base: string;

  constructor(config: YifySubtitlesConfig = {}, ctx?: ProviderContext) {
    super(ctx);
    this.base = (config.baseUrl ?? 'https://yifysubtitles.ch').replace(/\/+$/, '');
    try {
      new URL(this.base);
    } catch {
      throw this.error('config', `invalid base URL ${this.base}`);
    }
  }

  private browserHeaders(): Record<string, string> {
    return {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      DNT: '1',
      Referer: `${this.base}/`,
    };
  }

  async test(): Promise<void> {
    const res = await this.request(`${this.base}/`, { headers: this.browserHeaders() });
    if (!res.ok) throw this.statusError(res, 'home page');
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    if (!this.supports(query).ok || !query.imdbId) return [];
    const res = await this.request(`${this.base}/movie-imdb/${query.imdbId}`, {
      headers: this.browserHeaders(),
      redirect: 'manual',
    });
    if (res.status !== 200) {
      if (res.status >= 500) throw this.statusError(res, 'movie page');
      return [];
    }
    const html = await res.text();
    const out: SubtitleCandidate[] = [];
    const table = byClass(html, 'table', 'other-subs')[0]?.inner ?? html;
    for (const row of findElements(table, 'tr')) {
      try {
        const cells = findElements(row.inner, 'td');
        if (cells.length < 4) continue;
        const ratingText = textContent(byClass(row.inner, 'td', 'rating-cell')[0]?.inner ?? cells[0]!.inner);
        const langName = textContent(byClass(row.inner, 'span', 'sub-lang')[0]?.inner ?? cells[1]!.inner);
        const tag = yifyLanguageFromName(langName);
        if (!tag || !this.isWanted(query, tag, false)) continue;
        const link = anchors(row.inner).find((a) => /^\/?subtitles\//.test(a.href));
        if (!link) continue;
        const release = link.text
          .replace(/^subtitle\s*/i, '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join(', ');
        const hi = /hi-subtitle|hearing impaired/i.test(row.inner);
        const uploaderCell = byClass(row.inner, 'td', 'uploader-cell')[0];
        const uploader = uploaderCell ? textContent(uploaderCell.inner) || undefined : undefined;
        const rating = Number(ratingText);
        out.push(
          this.candidate({
            id: link.href.replace(/^\/?subtitles\//, ''),
            language: tag,
            forced: false,
            hi,
            releaseInfo: release,
            pageUrl: absoluteUrl(link.href, this.base),
            uploader,
            rating: Number.isFinite(rating) ? rating : undefined,
            matches: ['imdb_id'],
          }),
        );
      } catch {
        // A malformed row is skipped; the rest of the table is still usable.
        continue;
      }
    }
    return out.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    if (!candidate.pageUrl) throw this.error('bad-response', 'candidate has no page link');
    const page = await this.getText(candidate.pageUrl, { headers: this.browserHeaders() });
    const link = findElements(page, 'a', (o) => {
      const href = getAttr(o, 'href') ?? '';
      return /download-subtitle/.test(getAttr(o, 'class') ?? '') || /\.zip$/i.test(href);
    })[0];
    const href = link ? getAttr(link.open, 'href') : undefined;
    if (!href) throw this.error('bad-response', 'download link not found on subtitle page');
    const bytes = await this.getBytes(absoluteUrl(href, this.base), {
      headers: { ...this.browserHeaders(), Referer: candidate.pageUrl },
    });
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw this.error('bad-response', 'download is not a zip archive');
    return this.file(bytes, href.split('/').pop());
  }
}
