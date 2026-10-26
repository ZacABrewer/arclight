import { parseLanguageTag } from '../languages.js';
import type {
  ProviderCapabilities,
  ProviderContext,
  RateLimit,
  SubtitleCandidate,
  SubtitleFile,
  SubtitleQuery,
} from '../types.js';
import { BaseProvider, languageSet } from './base.js';

// Animetosho: subtitle attachments of anime torrent releases, keyed by AniDB episode id.

export interface AnimetoshoConfig {
  /** How many recent complete releases to inspect (each costs one request). */
  searchThreshold: number;
  feedUrl?: string | undefined;
  storageUrl?: string | undefined;
}

const LANGS = ['en', 'pt', 'pt-BR', 'es', 'fr', 'de', 'it', 'ru', 'ar', 'pl', 'nl', 'id', 'ms', 'vi', 'th', 'tr', 'zh', 'ja'];
const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];

interface FeedEntry {
  id: number;
  title?: string;
  status?: string;
  timestamp?: number;
}
interface Attachment {
  id: number;
  type?: string;
  info?: { lang?: string; name?: string; forced?: boolean | string | number; default?: boolean | string | number };
}
interface TorrentDetail {
  id?: number;
  title?: string;
  files?: Array<{ id?: number; filename?: string; attachments?: Attachment[] }>;
}

const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';

export class AnimetoshoProvider extends BaseProvider {
  readonly kind = 'animetosho' as const;
  readonly needsAuth = false;
  readonly rateLimit: RateLimit = { minIntervalMs: 250, requestTimeoutMs: 30000 };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode'],
    inputs: ['anidb'],
    languages: languageSet(LANGS),
    forced: true,
    hi: false,
    hashVerifiable: false,
    hiVerifiable: false,
  };
  private readonly threshold: number;
  private readonly feedUrl: string;
  private readonly storageUrl: string;

  constructor(config: AnimetoshoConfig, ctx?: ProviderContext) {
    super(ctx);
    if (!Number.isInteger(config.searchThreshold) || config.searchThreshold <= 0) {
      throw this.error('config', 'searchThreshold must be a positive integer');
    }
    this.threshold = config.searchThreshold;
    this.feedUrl = (config.feedUrl ?? 'https://feed.animetosho.org/json').replace(/\/$/, '');
    this.storageUrl = (config.storageUrl ?? 'https://animetosho.org/storage/attach').replace(/\/$/, '');
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    if (!this.supports(query).ok || query.anidbEpisodeId === undefined) return [];
    const entries = await this.getJson<FeedEntry[]>(`${this.feedUrl}?eid=${query.anidbEpisodeId}`);
    if (!Array.isArray(entries)) throw this.error('bad-response', 'feed is not a list');
    const recent = entries
      .filter((e) => e.status === 'complete')
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, this.threshold);
    const out: SubtitleCandidate[] = [];
    for (const entry of recent) {
      const detail = await this.getJson<TorrentDetail>(`${this.feedUrl}?show=torrent&id=${entry.id}`);
      for (const file of detail.files ?? []) {
        for (const att of file.attachments ?? []) {
          if (att.type !== 'subtitle') continue;
          const info = att.info ?? {};
          let tag = info.lang ? parseLanguageTag(info.lang) : 'en';
          if (!tag) continue;
          if (tag === 'pt' && /brazil/i.test(info.name ?? '')) tag = 'pt-BR';
          const forced = truthy(info.forced);
          if (!this.isWanted(query, tag, forced)) continue;
          const url = `${this.storageUrl}/${att.id.toString(16).padStart(8, '0')}/${att.id}.xz`;
          out.push(
            this.candidate({
              id: `${entry.id}:${url}`,
              language: tag,
              forced,
              hi: false,
              releaseInfo: file.filename ?? entry.title ?? '',
              downloadUrl: url,
              pageUrl: url,
              format: 'ass',
              matches: ['title', 'series', 'tvdb_id', 'season', 'episode'],
            }),
          );
        }
      }
    }
    return out;
  }

  async download(candidate: SubtitleCandidate): Promise<SubtitleFile> {
    if (!candidate.downloadUrl) throw this.error('bad-response', 'candidate has no download url');
    const bytes = await this.getBytes(candidate.downloadUrl);
    if (bytes.length < 6 || XZ_MAGIC.some((b, i) => bytes[i] !== b)) {
      throw this.error('bad-response', 'unidentified archive type');
    }
    const name = candidate.downloadUrl.split('/').pop() ?? 'subtitle.xz';
    return { bytes, format: 'unknown', encoding: 'utf-8', fileName: name };
  }

  async test(): Promise<void> {
    await this.getJson(`${this.feedUrl}?q=test`);
  }
}
