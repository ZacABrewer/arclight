import {
  buildMusicBrainzUserAgent,
  coverArtReleaseGroupFrontUrl,
  createFanartClient,
  createLastfmClient,
  createListenBrainzClient,
  createMusicBrainzClient,
  createWikidataClient,
  defaultRateLimiter,
  type FanartClient,
  type FetchLike,
  type LastfmClient,
  type ListenBrainzClient,
  type MbLink,
  type RateLimiter,
  type RequestPriority,
  type WikidataClient,
} from '@arclight/metadata';
import type { AlbumTypeProfile, EditionPreference, MusicImage, MusicMetadataSettings } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { VERSION } from '../../version.js';
import { getSection } from '../settings/service.js';
import { createMetadataCacheStore, withPersistentCache, type CachedMusicBrainzClient, type MetadataCacheStore } from './cache.js';

// Music metadata clients built from the `musicMetadata` settings section: MusicBrainz behind
// the persistent cache, artist images from Fanart.tv (when a key is set) or Wikidata/Commons,
// album covers as Cover Art Archive URLs, ListenBrainz charts for music Discover. Clients are
// rebuilt when the settings they depend on change; the process-wide rate limiter keeps the
// 1 req/s budget across rebuilds.

export const PROJECT_URL = 'https://github.com/ZacABrewer/arclight';

/** Test seams: no live network in tests. */
export interface MusicProviderOverrides {
  fetchImpl?: FetchLike;
  rateLimiter?: RateLimiter;
  now?: () => Date;
}

/** `Arclight/<version> ( <project url> [contact email] )`. */
export function musicUserAgent(contactEmail?: string): string {
  return buildMusicBrainzUserAgent({
    app: 'Arclight',
    version: VERSION,
    contact: contactEmail ? `${PROJECT_URL} ${contactEmail}` : PROJECT_URL,
  });
}

/** The album cover (Cover Art Archive; the browser shows a placeholder on 404). */
export function albumCoverImages(mbReleaseGroupId: string): MusicImage[] {
  const url = coverArtReleaseGroupFrontUrl(mbReleaseGroupId, 500);
  return [{ coverType: 'cover', url, remoteUrl: url }];
}

export class MusicMetadataService {
  readonly store: MetadataCacheStore;
  private client: { key: string; value: CachedMusicBrainzClient } | null = null;
  private wikidata: { key: string; value: WikidataClient } | null = null;
  private fanart: { key: string; value: FanartClient } | null = null;
  private listen: { key: string; value: ListenBrainzClient } | null = null;
  private lastfm: { key: string; value: LastfmClient } | null = null;

  constructor(
    private readonly deps: { db: Db; log: Logger; overrides?: MusicProviderOverrides },
  ) {
    this.store = createMetadataCacheStore(deps.db, deps.overrides?.now);
  }

  settings(): MusicMetadataSettings {
    return getSection(this.deps.db, 'musicMetadata');
  }

  /** The MusicBrainz client for the current settings (entity calls cached in `metadata_cache`). */
  musicBrainz(): CachedMusicBrainzClient {
    const s = this.settings();
    const key = JSON.stringify([s.baseUrl, s.rateLimitPerSecond, s.contactEmail ?? '']);
    if (this.client?.key === key) return this.client.value;
    const o = this.deps.overrides ?? {};
    const inner = createMusicBrainzClient({
      userAgent: musicUserAgent(s.contactEmail),
      baseUrl: s.baseUrl,
      requestsPerSecond: s.rateLimitPerSecond,
      rateLimiter: o.rateLimiter ?? defaultRateLimiter,
      // Entity calls are cached by the persistent layer; only searches stay in memory.
      cacheTtls: { artist: 0, releaseGroups: 0, releases: 0, release: 0 },
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    const value = withPersistentCache(inner, this.store);
    this.client = { key, value };
    return value;
  }

  /** ListenBrainz (keyless) for music Discover: fresh releases and sitewide charts. */
  listenBrainz(): ListenBrainzClient {
    const ua = musicUserAgent(this.settings().contactEmail);
    if (this.listen?.key === ua) return this.listen.value;
    const o = this.deps.overrides ?? {};
    const value = createListenBrainzClient({
      userAgent: ua,
      rateLimiter: o.rateLimiter ?? defaultRateLimiter,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    this.listen = { key: ua, value };
    return value;
  }

  /**
   * Release choice preferences: the album-type profile's edition preference, countries and
   * formats where it sets them, else the global music metadata settings.
   */
  releasePreferences(profile?: Pick<AlbumTypeProfile, 'editionPreference' | 'preferredCountries' | 'preferredFormats'>): {
    preferredCountries: string[];
    preferredFormats: string[];
    edition: EditionPreference;
  } {
    const s = this.settings();
    return {
      preferredCountries: profile && profile.preferredCountries.length > 0 ? profile.preferredCountries : s.preferredCountries,
      preferredFormats: profile && profile.preferredFormats.length > 0 ? profile.preferredFormats : s.preferredFormats,
      edition: profile?.editionPreference ?? 'any',
    };
  }

  /**
   * Artist pictures: Fanart.tv when a key is set (thumb, background, logo, banner), else the
   * Wikidata P18 image found through the MusicBrainz url-rels. Best effort: failures log and
   * yield no images.
   */
  async artistImages(mbArtistId: string, links: readonly MbLink[], priority: RequestPriority): Promise<MusicImage[]> {
    const s = this.settings();
    const o = this.deps.overrides ?? {};
    const common = {
      rateLimiter: o.rateLimiter ?? defaultRateLimiter,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.now ? { now: o.now } : {}),
    };
    try {
      if (s.fanartApiKey) {
        if (this.fanart?.key !== s.fanartApiKey) {
          this.fanart = { key: s.fanartApiKey, value: createFanartClient({ apiKey: s.fanartApiKey, ...common }) };
        }
        const found = await this.fanart.value.getArtistImages(mbArtistId, { priority });
        if (found) {
          const images: MusicImage[] = [];
          const pick = (list: readonly { url: string }[], coverType: MusicImage['coverType']) => {
            const first = list[0];
            if (first) images.push({ coverType, url: first.url, remoteUrl: first.url });
          };
          pick(found.thumbs, 'poster');
          pick(found.backgrounds, 'fanart');
          pick(found.logos, 'logo');
          pick(found.banners, 'banner');
          if (images.length > 0) return images;
        }
      }
      const image = await this.wikidataClient().resolveArtistImage(links, { priority });
      return image ? [{ coverType: 'poster', url: image.url, remoteUrl: image.url }] : [];
    } catch (err) {
      this.deps.log.debug({ err, mbArtistId }, 'artist images unavailable');
      return [];
    }
  }

  private wikidataClient(): WikidataClient {
    const o = this.deps.overrides ?? {};
    const ua = musicUserAgent(this.settings().contactEmail);
    if (this.wikidata?.key !== ua) {
      this.wikidata = {
        key: ua,
        value: createWikidataClient({
          userAgent: ua,
          rateLimiter: o.rateLimiter ?? defaultRateLimiter,
          ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
          ...(o.now ? { now: o.now } : {}),
        }),
      };
    }
    return this.wikidata.value;
  }

  /**
   * Artist biography text (MusicBrainz has none): the Wikipedia summary found through the
   * artist's url-rels (keyless), else the Last.fm biography when a Last.fm API key is set (in the
   * music playlist settings). Best effort: undefined when neither has one or both fail.
   */
  async artistOverview(artist: { mbid: string; name: string }, links: readonly MbLink[], priority: RequestPriority): Promise<string | undefined> {
    try {
      const wiki = await this.wikidataClient().resolveArtistSummary?.(links, { priority });
      if (wiki?.text) return wiki.text;
    } catch (err) {
      this.deps.log.debug({ err, mbArtistId: artist.mbid }, 'Wikipedia summary unavailable');
    }
    const key = getSection(this.deps.db, 'musicPlaylists').lastfmApiKey ?? '';
    if (!key) return undefined;
    try {
      const o = this.deps.overrides ?? {};
      if (this.lastfm?.key !== key) {
        this.lastfm = {
          key,
          value: createLastfmClient({
            apiKey: key,
            rateLimiter: o.rateLimiter ?? defaultRateLimiter,
            ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
            ...(o.now ? { now: o.now } : {}),
          }),
        };
      }
      const bio = await this.lastfm.value.artistBio({ mbid: artist.mbid, name: artist.name }, { priority });
      return bio?.summary || undefined;
    } catch (err) {
      this.deps.log.debug({ err, mbArtistId: artist.mbid }, 'Last.fm biography unavailable');
      return undefined;
    }
  }
}
