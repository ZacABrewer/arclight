import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import { isNetworkProxy } from '@arclight/indexers';
import type { NotificationEvent } from '@arclight/notifications';
import {
  feedUrlHasCredentials,
  redactFeedUrl,
  redactUrlsInText,
  type AddPodcastRequest,
  type CalendarPodcastEpisodeItem,
  type Podcast,
  type PodcastEnclosure,
  type PodcastEpisode,
  type PodcastEpisodeBulkAction,
  type PodcastEpisodePage,
  type PodcastEpisodeQuery,
  type PodcastEpisodeRow,
  type PodcastEpisodeStatus,
  type PodcastOpmlImportRequest,
  type PodcastOpmlImportResult,
  type PodcastPreview,
  type PodcastSearchResult,
  type PodcastSearchSource,
  type PodcastSettings,
  type PodcastStatistics,
  type PodcastSubscriptionSettings,
  type UpdatePodcastRequest,
  PodcastEpisodeQuery as EpisodeQuerySchema,
  PodcastSubscriptionSettings as SubscriptionSchema,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { likeContains } from '../../db/like-contains.js';
import type { EventBus } from '../../events.js';
import { ProxiesService } from '../indexers/proxies.js';
import { getSection } from '../settings/service.js';
import { applePodcastsId, lookupItunes, searchDirectory, type DirectoryOptions } from './directory.js';
import { chooseEnclosure, FeedParseError, parseFeed, type ParsedEpisode, type ParsedFeed } from './feed.js';
import { downloadFile, fetchBytes, fetchFeed, fetchText, lanFeedHost, PodcastHttpError, transportFor, type Transport, type TransportPolicy } from './http.js';
import { enclosureExtension, episodePath, podcastFolder, stem } from './naming.js';
import { buildOpml, parseOpml } from './opml.js';
import { podcastEpisodes, podcasts, podcastSuggestions, type PodcastEpisodeRowDb, type PodcastRow } from './schema.js';
import type { Chapter, Tagger } from './tagger.js';

// Podcasts (docs/using/podcasts.md): subscriptions, feed polling, episode downloads, tags,
// retention and played state. Feeds are polled with conditional GETs and the feed's <ttl>;
// a permanent redirect or <itunes:new-feed-url> moves the subscription, 410 retires it. New
// episodes are queued for the downloader when the podcast auto-downloads. Feed URLs may hold
// credentials (private / premium feeds): they are stored as given and masked everywhere else.

export type PodcastsErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'NO_ROOT_FOLDER' | 'FEED' | 'FORBIDDEN';

export class PodcastsError extends Error {
  constructor(
    readonly code: PodcastsErrorCode,
    message: string,
  ) {
    super(redactUrlsInText(message));
    this.name = 'PodcastsError';
  }
}

export const PODCASTS_ERROR_STATUS: Record<PodcastsErrorCode, number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  NO_ROOT_FOLDER: 422,
  FEED: 422,
  FORBIDDEN: 403,
};

/** Failed downloads are retried by the downloader up to this many attempts. */
export const MAX_DOWNLOAD_ATTEMPTS = 3;
/** New-episode notifications list at most this many titles. */
const NOTIFY_ITEMS = 10;
/** An episode "new" in a poll is only auto-downloaded when it is no older than this before the newest known one. */
const NEW_EPISODE_GRACE_MS = 2 * 24 * 60 * 60_000;

export interface PodcastsServiceOptions {
  db: Db;
  bus?: EventBus;
  log?: Logger;
  now?: () => Date;
  /** Test seam: the transport for a podcast's tags (default: indexer proxy resolution). */
  transport?: (tags: readonly number[], policy?: TransportPolicy) => Transport;
  tagger?: Tagger;
  notify?: (event: NotificationEvent) => Promise<unknown>;
  /** Ask media servers (Jellyfin/Emby/Audiobookshelf/Plex) to rescan a podcast folder. */
  refreshMediaServers?: (path: string, updateType: 'Created' | 'Modified' | 'Deleted') => Promise<unknown>;
  /** Episode files below the root a media server user finished, with when. */
  playedPaths?: (root: string) => Promise<Map<string, string | null>>;
  /** Called when episodes became wanted (the module kicks the downloader). */
  onWanted?: () => void;
}

interface FetchOutcome {
  url: string;
  moved: boolean;
  notModified: boolean;
  feed: ParsedFeed | null;
  etag: string | null;
  lastModified: string | null;
}

function sortTitleOf(title: string): string {
  return title.replace(/^(the|a|an)\s+/i, '').toLowerCase();
}

function maskEnclosure(e: PodcastEnclosure | null): PodcastEnclosure | null {
  return e ? { ...e, url: redactFeedUrl(e.url) } : null;
}

export function toEpisode(row: PodcastEpisodeRowDb): PodcastEpisode {
  return {
    id: row.id,
    podcastId: row.podcastId,
    guid: row.guid,
    title: row.title,
    description: row.description,
    publishedAt: row.publishedAt,
    durationSeconds: row.durationSeconds,
    season: row.season,
    episodeNumber: row.episodeNumber,
    episodeType: row.episodeType,
    explicit: row.explicit,
    imageUrl: row.imageUrl,
    link: row.link,
    enclosure: maskEnclosure(row.enclosure ?? null),
    alternateEnclosures: row.alternateEnclosures.map((e) => maskEnclosure(e)!),
    chaptersUrl: row.chaptersUrl,
    transcripts: row.transcripts.map((t) => ({ ...t, url: redactFeedUrl(t.url) })),
    persons: row.persons,
    status: row.status,
    path: row.path,
    sizeBytes: row.sizeBytes,
    downloadedAt: row.downloadedAt,
    hasChapters: row.hasChapters,
    transcriptFiles: row.transcriptFiles,
    played: row.played,
    playedAt: row.playedAt,
    playedSource: row.playedSource ?? null,
    error: row.error,
    attempts: row.attempts,
    added: row.added,
  };
}

const EMPTY_STATS: PodcastStatistics = { episodeCount: 0, downloadedCount: 0, playedCount: 0, wantedCount: 0, sizeOnDisk: 0, lastEpisodeAt: null };

export function podcastStatistics(db: Db, ids?: readonly number[]): Map<number, PodcastStatistics> {
  const rows = db
    .select({
      podcastId: podcastEpisodes.podcastId,
      episodeCount: sql<number>`count(*)`,
      downloadedCount: sql<number>`sum(case when ${podcastEpisodes.status} = 'downloaded' then 1 else 0 end)`,
      playedCount: sql<number>`sum(case when ${podcastEpisodes.played} = 1 then 1 else 0 end)`,
      wantedCount: sql<number>`sum(case when ${podcastEpisodes.status} in ('wanted', 'downloading') then 1 else 0 end)`,
      sizeOnDisk: sql<number>`coalesce(sum(case when ${podcastEpisodes.status} = 'downloaded' then ${podcastEpisodes.sizeBytes} else 0 end), 0)`,
      lastEpisodeAt: sql<string | null>`max(${podcastEpisodes.publishedAt})`,
    })
    .from(podcastEpisodes)
    .where(ids ? inArray(podcastEpisodes.podcastId, [...ids]) : undefined)
    .groupBy(podcastEpisodes.podcastId)
    .all();
  return new Map(
    rows.map((r) => [
      r.podcastId,
      {
        episodeCount: Number(r.episodeCount),
        downloadedCount: Number(r.downloadedCount ?? 0),
        playedCount: Number(r.playedCount ?? 0),
        wantedCount: Number(r.wantedCount ?? 0),
        sizeOnDisk: Number(r.sizeOnDisk ?? 0),
        lastEpisodeAt: r.lastEpisodeAt ?? null,
      },
    ]),
  );
}

export function toPodcast(row: PodcastRow, stats: PodcastStatistics = EMPTY_STATS): Podcast {
  return {
    id: row.id,
    title: row.title,
    sortTitle: row.sortTitle,
    author: row.author,
    description: row.description,
    feedUrl: redactFeedUrl(row.feedUrl),
    privateFeed: feedUrlHasCredentials(row.feedUrl),
    link: row.link,
    imageUrl: row.imageUrl,
    language: row.language,
    categories: row.categories,
    explicit: row.explicit,
    feedType: row.feedType,
    podcastGuid: row.podcastGuid,
    itunesId: row.itunesId,
    podcastIndexId: row.podcastIndexId,
    funding: row.funding,
    path: row.path,
    monitored: row.monitored,
    status: row.status,
    lastError: row.lastError,
    settings: SubscriptionSchema.parse(row.settings ?? {}),
    tags: row.tags,
    added: row.added,
    lastRefreshed: row.lastRefreshed,
    nextRefreshAt: row.nextRefreshAt,
    ttlMinutes: row.ttlMinutes,
    statistics: stats,
  };
}

/** Same feed? Scheme, trailing slash and host case do not matter. */
export function sameFeedUrl(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s);
      return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    } catch {
      return s;
    }
  };
  return norm(a) === norm(b);
}

/** Keep the user info of the old URL when a feed moves within the same host (premium feeds). */
export function carryCredentials(oldUrl: string, newUrl: string): string {
  try {
    const o = new URL(oldUrl);
    const n = new URL(newUrl);
    if ((o.username || o.password) && !n.username && !n.password && o.host === n.host) {
      n.username = o.username;
      n.password = o.password;
      return n.toString();
    }
    return newUrl;
  } catch {
    return newUrl;
  }
}

function errMessage(err: unknown): string {
  return redactUrlsInText(err instanceof Error ? err.message : String(err));
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c !== p && c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Podcasting 2.0 chapters JSON → chapters (toc:false entries are not navigation points). */
export function parseChapters(body: string): Chapter[] | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const list = (json as { chapters?: unknown })?.chapters;
  if (!Array.isArray(list)) return null;
  return list.flatMap((c: unknown) => {
    if (!c || typeof c !== 'object') return [];
    const o = c as Record<string, unknown>;
    const start = typeof o.startTime === 'number' ? o.startTime : Number(o.startTime);
    if (!Number.isFinite(start) || o.toc === false) return [];
    const end = typeof o.endTime === 'number' && Number.isFinite(o.endTime) ? o.endTime : null;
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : `Chapter`;
    return [{ startSeconds: start, endSeconds: end, title }];
  });
}

const TRANSCRIPT_EXT: Record<string, string> = {
  'text/vtt': 'vtt',
  'application/x-subrip': 'srt',
  'application/srt': 'srt',
  'text/srt': 'srt',
  'application/json': 'json',
  'text/html': 'html',
  'text/plain': 'txt',
};

export function transcriptExtension(type: string): string | null {
  return TRANSCRIPT_EXT[type.split(';')[0]!.trim().toLowerCase()] ?? null;
}

export class PodcastsService {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly active = new Set<number>();
  /** Target paths of downloads in flight (not in the database until they finish). */
  private readonly reserved = new Map<number, string>();

  constructor(private readonly opts: PodcastsServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Where a subscribed podcast's fetches may go: public hosts, plus the feed's own host when
   * that is a LAN name or address and the podcast did not come from a suggestion.
   */
  private podcastPolicy(row: PodcastRow): TransportPolicy {
    const host = lanFeedHost(row.feedUrl);
    if (!host) return {};
    const suggested = this.db.select({ id: podcastSuggestions.id }).from(podcastSuggestions).where(eq(podcastSuggestions.podcastId, row.id)).get();
    return suggested ? {} : { trustedHost: host };
  }

  settings(): PodcastSettings {
    return getSection(this.db, 'podcasts');
  }

  private publish(action: 'added' | 'updated' | 'deleted' | 'episodes' | 'suggestion', id: number): void {
    this.opts.bus?.publish({ type: 'podcast', action, id });
  }

  /** The HTTP transport for a podcast: a proxy sharing its tags, else the settings' proxy, else direct. */
  transport(tags: readonly number[] = [], policy: TransportPolicy = {}): Transport {
    if (this.opts.transport) return this.opts.transport(tags, policy);
    const proxies = new ProxiesService({ db: this.db });
    const byTags = tags.length > 0 ? proxies.resolve({ proxyId: null, tags }) : undefined;
    const fromTags = byTags?.find(isNetworkProxy);
    const proxyId = this.settings().proxyId;
    const fallback = !fromTags && proxyId ? proxies.resolve({ proxyId, tags: [] })?.find(isNetworkProxy) : undefined;
    return transportFor(fromTags ?? fallback, undefined, policy);
  }

  private directory(): DirectoryOptions {
    const s = this.settings();
    return { transport: this.transport(), country: s.itunesCountry, podcastIndexKey: s.podcastIndexKey, podcastIndexSecret: s.podcastIndexSecret };
  }

  // ---- reads ------------------------------------------------------------------------------

  private row(id: number): PodcastRow {
    const row = this.db.select().from(podcasts).where(eq(podcasts.id, id)).get();
    if (!row) throw new PodcastsError('NOT_FOUND', `podcast ${id} not found`);
    return row;
  }

  private episodeRow(id: number): PodcastEpisodeRowDb {
    const row = this.db.select().from(podcastEpisodes).where(eq(podcastEpisodes.id, id)).get();
    if (!row) throw new PodcastsError('NOT_FOUND', `podcast episode ${id} not found`);
    return row;
  }

  list(): Podcast[] {
    const stats = podcastStatistics(this.db);
    return this.db
      .select()
      .from(podcasts)
      .orderBy(asc(podcasts.sortTitle))
      .all()
      .map((r) => toPodcast(r, stats.get(r.id)));
  }

  get(id: number): Podcast {
    const row = this.row(id);
    return toPodcast(row, podcastStatistics(this.db, [id]).get(id));
  }

  /** The stored (unmasked) URL of a podcast, for the OPML export with private feeds. */
  private findByFeed(url: string, guid?: string | null): PodcastRow | undefined {
    const all = this.db.select().from(podcasts).all();
    return all.find((p) => sameFeedUrl(p.feedUrl, url) || (guid != null && p.podcastGuid === guid));
  }

  episodes(input: PodcastEpisodeQuery): PodcastEpisodePage {
    const q = EpisodeQuerySchema.parse(input);
    const conds: SQL[] = [];
    if (q.podcastId) conds.push(eq(podcastEpisodes.podcastId, q.podcastId));
    if (q.status) conds.push(eq(podcastEpisodes.status, q.status));
    if (q.played !== undefined) conds.push(eq(podcastEpisodes.played, q.played));
    if (q.term) conds.push(likeContains(podcastEpisodes.title, q.term));
    const where = conds.length > 0 ? and(...conds) : undefined;
    const total = this.db.select({ n: sql<number>`count(*)` }).from(podcastEpisodes).where(where).get()?.n ?? 0;
    const col = {
      publishedAt: podcastEpisodes.publishedAt,
      title: podcastEpisodes.title,
      status: podcastEpisodes.status,
      downloadedAt: podcastEpisodes.downloadedAt,
    }[q.sortKey];
    const dir = q.sortDirection === 'asc' ? asc : desc;
    const rows = this.db
      .select({ ep: podcastEpisodes, title: podcasts.title, image: podcasts.imageUrl })
      .from(podcastEpisodes)
      .innerJoin(podcasts, eq(podcastEpisodes.podcastId, podcasts.id))
      .where(where)
      .orderBy(dir(col), dir(podcastEpisodes.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .all();
    const records: PodcastEpisodeRow[] = rows.map((r) => ({ ...toEpisode(r.ep), podcastTitle: r.title, podcastImageUrl: r.image }));
    return { page: q.page, pageSize: q.pageSize, totalRecords: Number(total), records };
  }

  getEpisode(id: number): PodcastEpisode {
    return toEpisode(this.episodeRow(id));
  }

  // ---- fetching ---------------------------------------------------------------------------

  /** Apple Podcasts page URL → the feed URL behind it; anything else unchanged. */
  private async resolveFeedUrl(raw: string): Promise<{ url: string; itunesId: number | null }> {
    const id = applePodcastsId(raw);
    if (id === null) return { url: raw, itunesId: null };
    const hit = await lookupItunes(this.directory(), id).catch((err: unknown) => {
      throw new PodcastsError('FEED', `could not look up the Apple Podcasts link: ${errMessage(err)}`);
    });
    if (!hit) throw new PodcastsError('FEED', 'Apple Podcasts does not list a feed for that link');
    return { url: hit.feedUrl, itunesId: id };
  }

  /**
   * Fetch and parse a feed. Follows `<itunes:new-feed-url>` once (when the new feed parses);
   * `moved` is true for that and for a permanent redirect chain.
   */
  private async fetchFeed(
    url: string,
    tags: readonly number[],
    cond: { etag?: string | null; lastModified?: string | null } = {},
    signal?: AbortSignal,
    policy: TransportPolicy = {},
  ): Promise<FetchOutcome> {
    const transport = this.transport(tags, policy);
    const res = await fetchFeed(transport, url, cond, signal);
    let current = res.permanent ? carryCredentials(url, res.url) : url;
    if (res.status === 'notModified') return { url: current, moved: res.permanent, notModified: true, feed: null, etag: null, lastModified: null };
    let feed = parseFeed(res.body);
    let etag = res.etag;
    let lastModified = res.lastModified;
    let moved = res.permanent;
    const newFeedUrl = feed.newFeedUrl;
    if (newFeedUrl && !sameFeedUrl(newFeedUrl, current) && !sameFeedUrl(newFeedUrl, res.url)) {
      try {
        const next = await fetchFeed(transport, carryCredentials(current, newFeedUrl), {}, signal);
        if (next.status === 'ok') {
          feed = parseFeed(next.body);
          current = carryCredentials(current, next.url);
          etag = next.etag;
          lastModified = next.lastModified;
          moved = true;
        }
      } catch (err) {
        this.log?.warn({ feed: redactFeedUrl(newFeedUrl), err: errMessage(err) }, 'podcast new-feed-url could not be read; keeping the old feed');
      }
    }
    return { url: current, moved, notModified: false, feed, etag, lastModified };
  }

  private async fetchForUser(url: string, tags: readonly number[] = [], policy: TransportPolicy = {}): Promise<FetchOutcome & { feed: ParsedFeed }> {
    try {
      const out = await this.fetchFeed(url, tags, {}, undefined, policy);
      return out as FetchOutcome & { feed: ParsedFeed };
    } catch (err) {
      if (err instanceof FeedParseError || err instanceof PodcastHttpError) throw new PodcastsError('FEED', err.message);
      throw err;
    }
  }

  /**
   * Fetch a feed for a preview. `trusted` (an admin adding a feed) lets a feed on a LAN host
   * through; anyone else, and suggestions, reach public hosts only (DATA-06).
   */
  async preview(feedUrl: string, opts: AddOptions = {}): Promise<PodcastPreview> {
    const { url } = await this.resolveFeedUrl(feedUrl);
    const out = await this.fetchForUser(url, [], trustPolicy(url, opts));
    const feed = out.feed;
    const existing = this.findByFeed(out.url, feed.podcastGuid) ?? this.findByFeed(url);
    const latest = [...feed.episodes].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')).slice(0, 5);
    return {
      title: feed.title,
      author: feed.author,
      description: feed.description,
      imageUrl: feed.imageUrl,
      link: feed.link,
      feedUrl: redactFeedUrl(out.url),
      episodeCount: feed.episodes.length,
      latestEpisodes: latest.map((e) => ({ title: e.title, publishedAt: e.publishedAt, durationSeconds: e.durationSeconds })),
      podcastId: existing?.id ?? null,
    };
  }

  // ---- subscribe / update / delete --------------------------------------------------------

  async add(req: AddPodcastRequest, opts: AddOptions = {}): Promise<Podcast> {
    const s = this.settings();
    if (!s.rootFolder) throw new PodcastsError('NO_ROOT_FOLDER', 'set a podcast root folder first (Settings → Podcasts)');
    const resolved = await this.resolveFeedUrl(req.feedUrl);
    if (this.findByFeed(resolved.url)) throw new PodcastsError('CONFLICT', 'that podcast is already in the library');
    const tags = req.tags ?? [];
    const out = await this.fetchForUser(resolved.url, tags, trustPolicy(resolved.url, opts));
    const feed = out.feed;
    if (this.findByFeed(out.url, feed.podcastGuid)) throw new PodcastsError('CONFLICT', 'that podcast is already in the library');

    const settings = SubscriptionSchema.parse({ ...s.defaults, ...(req.settings ?? {}) });
    const monitored = req.monitored ?? true;
    const basePath = podcastFolder(s.rootFolder, s.folderFormat, { podcastTitle: feed.title, podcastAuthor: feed.author });
    const now = this.now();
    const row = this.db
      .insert(podcasts)
      .values({
        title: feed.title,
        sortTitle: sortTitleOf(feed.title),
        author: feed.author,
        description: feed.description,
        feedUrl: out.url,
        link: feed.link,
        imageUrl: feed.imageUrl,
        language: feed.language,
        categories: feed.categories,
        explicit: feed.explicit,
        feedType: feed.feedType,
        podcastGuid: feed.podcastGuid,
        itunesId: req.itunesId ?? resolved.itunesId ?? null,
        podcastIndexId: req.podcastIndexId ?? null,
        funding: feed.funding,
        path: this.uniquePath(basePath),
        monitored,
        status: 'active',
        settings,
        tags,
        etag: out.etag,
        lastModified: out.lastModified,
        ttlMinutes: feed.ttlMinutes,
        added: now.toISOString(),
        lastRefreshed: now.toISOString(),
        nextRefreshAt: this.nextRefresh(now, feed.ttlMinutes),
      })
      .returning()
      .get();

    // Every episode in the feed is known; the newest `backlog` ones are downloaded.
    const newest = [...feed.episodes].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    const wanted = new Set(monitored ? newest.slice(0, settings.backlog).map((e) => e.guid) : []);
    this.insertEpisodes(row.id, feed.episodes, (e) => (wanted.has(e.guid) ? 'wanted' : 'available'));
    this.log?.info({ podcastId: row.id, feed: redactFeedUrl(out.url), episodes: feed.episodes.length, wanted: wanted.size }, 'podcast added');
    this.publish('added', row.id);
    if (wanted.size > 0) this.opts.onWanted?.();
    return this.get(row.id);
  }

  private uniquePath(base: string): string {
    const taken = new Set(this.db.select({ p: podcasts.path }).from(podcasts).all().map((r) => resolve(r.p).toLowerCase()));
    let candidate = base;
    for (let n = 2; taken.has(resolve(candidate).toLowerCase()); n += 1) candidate = `${base} (${n})`;
    return candidate;
  }

  private nextRefresh(from: Date, ttlMinutes: number | null): string {
    const s = this.settings();
    const minutes = Math.max(s.refreshIntervalMinutes, s.respectTtl && ttlMinutes ? Math.min(ttlMinutes, 7 * 24 * 60) : 0);
    return new Date(from.getTime() + minutes * 60_000).toISOString();
  }

  private insertEpisodes(podcastId: number, episodes: readonly ParsedEpisode[], statusOf: (e: ParsedEpisode) => PodcastEpisodeStatus): number {
    if (episodes.length === 0) return 0;
    const added = this.now().toISOString();
    let n = 0;
    this.db.transaction((tx) => {
      for (const e of episodes) {
        const res = tx
          .insert(podcastEpisodes)
          .values({ podcastId, ...episodeValues(e), status: statusOf(e), transcriptFiles: [], added })
          .onConflictDoNothing()
          .run();
        n += res.changes;
      }
    });
    return n;
  }

  update(id: number, req: UpdatePodcastRequest): Podcast {
    const row = this.row(id);
    const patch: Partial<typeof podcasts.$inferInsert> = {};
    if (req.feedUrl !== undefined && !req.feedUrl.includes('********') && req.feedUrl !== row.feedUrl) {
      const other = this.findByFeed(req.feedUrl);
      if (other && other.id !== id) throw new PodcastsError('CONFLICT', 'another podcast already uses that feed');
      patch.feedUrl = req.feedUrl;
      patch.etag = null;
      patch.lastModified = null;
      patch.status = 'active';
      patch.nextRefreshAt = this.now().toISOString();
    }
    if (req.settings) patch.settings = SubscriptionSchema.parse({ ...row.settings, ...req.settings });
    if (req.tags) patch.tags = req.tags;
    if (req.monitored !== undefined) {
      patch.monitored = req.monitored;
      // Following again: poll soon; a retired feed gets another chance.
      if (req.monitored && !row.monitored) patch.nextRefreshAt = this.now().toISOString();
    }
    if (Object.keys(patch).length > 0) this.db.update(podcasts).set(patch).where(eq(podcasts.id, id)).run();
    this.publish('updated', id);
    return this.get(id);
  }

  async remove(id: number, deleteFiles: boolean): Promise<void> {
    const row = this.row(id);
    if (deleteFiles) {
      const root = this.settings().rootFolder;
      if (root && isInside(row.path, root)) {
        await rm(row.path, { recursive: true, force: true });
      } else {
        // Never remove a folder outside the podcast root: delete the episode files one by one.
        for (const ep of this.db.select().from(podcastEpisodes).where(eq(podcastEpisodes.podcastId, id)).all()) await this.removeFiles(ep);
      }
    }
    this.db.delete(podcasts).where(eq(podcasts.id, id)).run();
    this.publish('deleted', id);
    if (deleteFiles) void this.opts.refreshMediaServers?.(row.path, 'Deleted')?.catch?.(() => undefined);
  }

  // ---- polling ----------------------------------------------------------------------------

  /** Poll one feed. Returns the number of new episodes. */
  async refresh(id: number, signal?: AbortSignal): Promise<number> {
    const row = this.row(id);
    const now = this.now();
    let out: FetchOutcome;
    try {
      out = await this.fetchFeed(row.feedUrl, row.tags, { etag: row.etag, lastModified: row.lastModified }, signal, this.podcastPolicy(row));
    } catch (err) {
      const gone = err instanceof PodcastHttpError && err.gone;
      const message = errMessage(err);
      this.db
        .update(podcasts)
        .set({ status: gone ? 'gone' : 'error', lastError: message, lastRefreshed: now.toISOString(), nextRefreshAt: this.nextRefresh(now, row.ttlMinutes) })
        .where(eq(podcasts.id, id))
        .run();
      this.log?.warn({ podcastId: id, feed: redactFeedUrl(row.feedUrl), err: message }, gone ? 'podcast feed is gone (410)' : 'podcast refresh failed');
      this.publish('updated', id);
      return 0;
    }

    const moved = out.moved && !sameFeedUrl(out.url, row.feedUrl) ? this.moveTarget(id, out.url) : null;
    if (moved) this.log?.info({ podcastId: id, from: redactFeedUrl(row.feedUrl), to: redactFeedUrl(moved) }, 'podcast feed moved');

    if (out.notModified || !out.feed) {
      this.db
        .update(podcasts)
        .set({ status: 'active', lastError: null, lastRefreshed: now.toISOString(), nextRefreshAt: this.nextRefresh(now, row.ttlMinutes), ...(moved ? { feedUrl: moved } : {}) })
        .where(eq(podcasts.id, id))
        .run();
      this.publish('updated', id);
      return 0;
    }

    const feed = out.feed;
    const settings = SubscriptionSchema.parse(row.settings ?? {});
    const known = new Map(
      this.db
        .select({ id: podcastEpisodes.id, guid: podcastEpisodes.guid, publishedAt: podcastEpisodes.publishedAt })
        .from(podcastEpisodes)
        .where(eq(podcastEpisodes.podcastId, id))
        .all()
        .map((e) => [e.guid, e]),
    );
    const newestKnown = [...known.values()].reduce<string | null>((m, e) => (e.publishedAt && (!m || e.publishedAt > m) ? e.publishedAt : m), null);
    const cutoff = newestKnown ? new Date(newestKnown).getTime() - NEW_EPISODE_GRACE_MS : null;
    const fresh = feed.episodes.filter((e) => !known.has(e.guid));
    const autoDownload = row.monitored && settings.autoDownload;
    const isRecent = (e: ParsedEpisode) => cutoff === null || e.publishedAt === null || new Date(e.publishedAt).getTime() >= cutoff;
    // A first poll with nothing known behaves like subscribing (backlog only).
    const backlog = new Set(
      known.size === 0
        ? [...fresh].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')).slice(0, settings.backlog).map((e) => e.guid)
        : [],
    );
    const inserted = this.insertEpisodes(id, fresh, (e) =>
      row.monitored && (known.size === 0 ? backlog.has(e.guid) : autoDownload && isRecent(e)) ? 'wanted' : 'available',
    );

    // Metadata of known episodes follows the feed (titles get fixed, enclosures re-hosted).
    this.db.transaction((tx) => {
      for (const e of feed.episodes) {
        const k = known.get(e.guid);
        if (k) tx.update(podcastEpisodes).set(episodeValues(e)).where(eq(podcastEpisodes.id, k.id)).run();
      }
      tx.update(podcasts)
        .set({
          title: feed.title,
          sortTitle: sortTitleOf(feed.title),
          author: feed.author,
          description: feed.description,
          link: feed.link,
          imageUrl: feed.imageUrl ?? row.imageUrl,
          language: feed.language,
          categories: feed.categories,
          explicit: feed.explicit,
          feedType: feed.feedType,
          podcastGuid: feed.podcastGuid ?? row.podcastGuid,
          funding: feed.funding,
          status: 'active',
          lastError: null,
          etag: out.etag,
          lastModified: out.lastModified,
          ttlMinutes: feed.ttlMinutes,
          lastRefreshed: now.toISOString(),
          nextRefreshAt: this.nextRefresh(now, feed.ttlMinutes),
          ...(moved ? { feedUrl: moved } : {}),
        })
        .where(eq(podcasts.id, id))
        .run();
    });

    if (inserted > 0) {
      this.publish('episodes', id);
      if (known.size > 0) await this.notifyNew(row, fresh);
      if (this.db.select({ n: sql<number>`count(*)` }).from(podcastEpisodes).where(and(eq(podcastEpisodes.podcastId, id), eq(podcastEpisodes.status, 'wanted'))).get()?.n) {
        this.opts.onWanted?.();
      }
    } else {
      this.publish('updated', id);
    }
    return inserted;
  }

  /** The URL a moved feed should be stored under, or null when another podcast has it. */
  private moveTarget(id: number, url: string): string | null {
    const other = this.findByFeed(url);
    if (other && other.id !== id) {
      this.log?.warn({ podcastId: id, other: other.id }, 'podcast feed moved to a feed another podcast already follows');
      return null;
    }
    return url;
  }

  private async notifyNew(row: PodcastRow, fresh: readonly ParsedEpisode[]): Promise<void> {
    if (!this.opts.notify || fresh.length === 0) return;
    const sorted = [...fresh].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    const ids = new Map(
      this.db
        .select({ id: podcastEpisodes.id, guid: podcastEpisodes.guid })
        .from(podcastEpisodes)
        .where(eq(podcastEpisodes.podcastId, row.id))
        .all()
        .map((r) => [r.guid, r.id]),
    );
    await this.opts
      .notify({
        type: 'podcastEpisodes',
        instanceName: 'Arclight',
        timestamp: this.now().toISOString(),
        podcast: { id: row.id, title: row.title, ...(row.author ? { author: row.author } : {}), ...(row.imageUrl ? { imageUrl: row.imageUrl } : {}) },
        items: sorted.slice(0, NOTIFY_ITEMS).map((e) => ({
          id: ids.get(e.guid) ?? 0,
          title: e.title,
          ...(e.publishedAt ? { publishedAt: e.publishedAt } : {}),
          ...(e.durationSeconds ? { durationSeconds: e.durationSeconds } : {}),
        })),
        total: sorted.length,
      })
      .catch((err: unknown) => this.log?.warn({ err }, 'podcast notification failed'));
  }

  /** Poll every monitored, not retired feed whose next poll is due. */
  async refreshDue(signal?: AbortSignal, all = false): Promise<string> {
    const now = this.now().toISOString();
    const due = this.db
      .select({ id: podcasts.id })
      .from(podcasts)
      .where(
        and(
          eq(podcasts.monitored, true),
          sql`${podcasts.status} != 'gone'`,
          all ? undefined : or(sql`${podcasts.nextRefreshAt} is null`, lte(podcasts.nextRefreshAt, now)),
        ),
      )
      .orderBy(asc(podcasts.nextRefreshAt))
      .all();
    let next = 0;
    let found = 0;
    const worker = async () => {
      while (next < due.length && !signal?.aborted) {
        const item = due[next++]!;
        found += await this.refresh(item.id, signal).catch((err: unknown) => {
          this.log?.warn({ podcastId: item.id, err: errMessage(err) }, 'podcast refresh failed');
          return 0;
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, due.length) }, worker));
    return `${due.length} feed${due.length === 1 ? '' : 's'} checked, ${found} new episode${found === 1 ? '' : 's'}`;
  }

  // ---- episodes: played, download, delete -------------------------------------------------

  setPlayed(id: number, played: boolean): PodcastEpisode {
    const row = this.episodeRow(id);
    this.db
      .update(podcastEpisodes)
      .set({ played, playedAt: played ? (row.playedAt ?? this.now().toISOString()) : null, playedSource: played ? 'manual' : null })
      .where(eq(podcastEpisodes.id, id))
      .run();
    this.publish('episodes', row.podcastId);
    return this.getEpisode(id);
  }

  queueDownload(id: number): PodcastEpisode {
    const row = this.episodeRow(id);
    if (row.status === 'downloading') return toEpisode(row);
    this.db.update(podcastEpisodes).set({ status: 'wanted', attempts: 0, error: null }).where(eq(podcastEpisodes.id, id)).run();
    this.publish('episodes', row.podcastId);
    this.opts.onWanted?.();
    return this.getEpisode(id);
  }

  async deleteFile(id: number): Promise<PodcastEpisode> {
    const row = this.episodeRow(id);
    await this.removeFiles(row);
    this.db
      .update(podcastEpisodes)
      .set({ status: 'deleted', path: null, sizeBytes: null, hasChapters: false, transcriptFiles: [] })
      .where(eq(podcastEpisodes.id, id))
      .run();
    this.publish('episodes', row.podcastId);
    if (row.path) void this.opts.refreshMediaServers?.(dirname(row.path), 'Deleted')?.catch?.(() => undefined);
    return this.getEpisode(id);
  }

  private async removeFiles(row: PodcastEpisodeRowDb): Promise<void> {
    if (!row.path) return;
    const base = stem(row.path);
    const files = [row.path, `${base}.chapters.json`, ...row.transcriptFiles.map((f) => resolve(dirname(row.path!), f))];
    for (const f of files) await rm(f, { force: true }).catch(() => undefined);
  }

  async bulk(ids: readonly number[], action: PodcastEpisodeBulkAction): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const row = this.db.select().from(podcastEpisodes).where(eq(podcastEpisodes.id, id)).get();
      if (!row) continue;
      switch (action) {
        case 'download':
          if (row.status !== 'downloaded' && row.status !== 'downloading') {
            this.db.update(podcastEpisodes).set({ status: 'wanted', attempts: 0, error: null }).where(eq(podcastEpisodes.id, id)).run();
            n += 1;
          }
          break;
        case 'markPlayed':
        case 'markUnplayed': {
          const played = action === 'markPlayed';
          this.db
            .update(podcastEpisodes)
            .set({ played, playedAt: played ? (row.playedAt ?? this.now().toISOString()) : null, playedSource: played ? 'manual' : null })
            .where(eq(podcastEpisodes.id, id))
            .run();
          n += 1;
          break;
        }
        case 'deleteFile':
          if (row.path) {
            await this.deleteFile(id);
            n += 1;
          }
          break;
        case 'skip':
          if (row.status === 'wanted' || row.status === 'failed') {
            this.db.update(podcastEpisodes).set({ status: 'available', error: null }).where(eq(podcastEpisodes.id, id)).run();
            n += 1;
          }
          break;
      }
    }
    for (const pid of new Set(this.db.select({ p: podcastEpisodes.podcastId }).from(podcastEpisodes).where(inArray(podcastEpisodes.id, [...ids])).all().map((r) => r.p))) {
      this.publish('episodes', pid);
    }
    if (action === 'download' && n > 0) this.opts.onWanted?.();
    return n;
  }

  /** Download every wanted episode (and failed ones with attempts left), a few at a time. */
  async downloadWanted(signal?: AbortSignal): Promise<string> {
    // Episodes left "downloading" by a restart start over.
    this.db
      .update(podcastEpisodes)
      .set({ status: 'wanted' })
      .where(and(eq(podcastEpisodes.status, 'downloading'), this.active.size > 0 ? sql`${podcastEpisodes.id} not in (${sql.join([...this.active].map((i) => sql`${i}`), sql`, `)})` : undefined))
      .run();
    await this.applyRetention();
    // Workers take the next queued episode from the database, so episodes queued while this
    // run is going are picked up too. Each episode is tried at most once per run.
    const tried = new Set<number>();
    const nextId = (): number | null => {
      const rows = this.db
        .select({ id: podcastEpisodes.id })
        .from(podcastEpisodes)
        .where(or(eq(podcastEpisodes.status, 'wanted'), and(eq(podcastEpisodes.status, 'failed'), sql`${podcastEpisodes.attempts} < ${MAX_DOWNLOAD_ATTEMPTS}`)))
        .orderBy(desc(podcastEpisodes.publishedAt), asc(podcastEpisodes.id))
        .limit(tried.size + this.active.size + 1)
        .all();
      const hit = rows.find((r) => !tried.has(r.id) && !this.active.has(r.id));
      if (!hit) return null;
      tried.add(hit.id);
      return hit.id;
    };
    let ok = 0;
    let failed = 0;
    const worker = async () => {
      for (let id = nextId(); id !== null && !signal?.aborted; id = signal?.aborted ? null : nextId()) {
        if ((await this.download(id, signal)) === 'downloaded') ok += 1;
        else failed += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.settings().maxConcurrentDownloads) }, worker));
    if (ok > 0) await this.applyRetention();
    return tried.size === 0 ? 'nothing to download' : `${ok} downloaded, ${failed} failed`;
  }

  /** Download one episode now. */
  async download(id: number, signal?: AbortSignal): Promise<PodcastEpisodeStatus> {
    if (this.active.has(id)) return 'downloading';
    const ep = this.episodeRow(id);
    const podcast = this.row(ep.podcastId);
    const settings = SubscriptionSchema.parse(podcast.settings ?? {});
    const s = this.settings();
    const enclosure = chooseEnclosure(ep.enclosure ?? null, ep.alternateEnclosures, settings.enclosure);
    if (!enclosure) {
      this.db.update(podcastEpisodes).set({ status: 'failed', attempts: MAX_DOWNLOAD_ATTEMPTS, error: 'the episode has no downloadable file' }).where(eq(podcastEpisodes.id, id)).run();
      return 'failed';
    }
    this.active.add(id);
    this.db.update(podcastEpisodes).set({ status: 'downloading', error: null }).where(eq(podcastEpisodes.id, id)).run();
    this.publish('episodes', podcast.id);
    const transport = this.transport(podcast.tags, this.podcastPolicy(podcast));
    const ext = enclosureExtension(enclosure.url, enclosure.type);
    const target = this.uniqueEpisodePath(
      episodePath(
        podcast.path,
        s.episodeFormat,
        { podcastTitle: podcast.title, podcastAuthor: podcast.author, episodeTitle: ep.title, publishedAt: ep.publishedAt, season: ep.season, episodeNumber: ep.episodeNumber },
        ext,
      ),
      id,
      ep.guid,
    );
    const partial = `${target}.partial`;
    this.reserved.set(id, target);
    try {
      await mkdir(dirname(target), { recursive: true });
      await downloadFile(transport, enclosure.url, partial, signal);
      await rename(partial, target);

      const cover = settings.embedCover ? await this.ensureFolderCover(podcast, transport, signal) : null;
      let chapters: Chapter[] = [];
      let hasChapters = false;
      if (settings.keepChapters && ep.chaptersUrl) {
        try {
          const { body } = await fetchText(transport, ep.chaptersUrl, { ...(signal ? { signal } : {}), maxBytes: 2 * 1024 * 1024 });
          const parsed = parseChapters(body);
          if (parsed) {
            await writeFile(`${stem(target)}.chapters.json`, body, 'utf8');
            chapters = parsed;
            hasChapters = true;
          }
        } catch (err) {
          this.log?.warn({ episodeId: id, err: errMessage(err) }, 'podcast chapters could not be fetched');
        }
      }
      const transcriptFiles = settings.keepTranscripts ? await this.saveTranscripts(ep, target, transport, signal) : [];

      if (settings.writeTags && this.opts.tagger) {
        let episodeCover: string | null = null;
        try {
          if (settings.embedCover && ep.imageUrl && ep.imageUrl !== podcast.imageUrl) {
            const img = await fetchBytes(transport, ep.imageUrl, signal);
            episodeCover = `${stem(target)}.cover${/png/i.test(img.contentType ?? '') ? '.png' : '.jpg'}`;
            await writeFile(episodeCover, img.data);
          }
        } catch {
          episodeCover = null;
        }
        try {
          await this.opts.tagger.tag({
            file: target,
            tags: {
              title: ep.title,
              podcast: podcast.title,
              author: podcast.author,
              date: ep.publishedAt,
              description: ep.description,
              episodeNumber: ep.episodeNumber,
              season: ep.season,
              link: ep.link,
            },
            coverFile: episodeCover ?? cover,
            chapters,
            durationSeconds: ep.durationSeconds,
          });
        } catch (err) {
          this.log?.warn({ episodeId: id, err: errMessage(err) }, 'podcast tags could not be written; the file is kept untagged');
        } finally {
          if (episodeCover) await rm(episodeCover, { force: true }).catch(() => undefined);
        }
      }

      const size = (await stat(target)).size;
      const now = this.now().toISOString();
      this.db
        .update(podcastEpisodes)
        .set({ status: 'downloaded', path: target, sizeBytes: size, downloadedAt: now, hasChapters, transcriptFiles, error: null, attempts: 0 })
        .where(eq(podcastEpisodes.id, id))
        .run();
      this.log?.info({ episodeId: id, podcastId: podcast.id, bytes: size }, 'podcast episode downloaded');
      this.publish('episodes', podcast.id);
      void this.opts.refreshMediaServers?.(podcast.path, 'Created')?.catch?.(() => undefined);
      await this.opts
        .notify?.({
          type: 'podcastDownload',
          instanceName: 'Arclight',
          timestamp: now,
          podcast: { id: podcast.id, title: podcast.title, ...(podcast.author ? { author: podcast.author } : {}), ...(podcast.imageUrl ? { imageUrl: podcast.imageUrl } : {}) },
          item: {
            id,
            title: ep.title,
            ...(ep.publishedAt ? { publishedAt: ep.publishedAt } : {}),
            ...(ep.durationSeconds ? { durationSeconds: ep.durationSeconds } : {}),
          },
          path: target,
          sizeBytes: size,
        })
        ?.catch((err: unknown) => this.log?.warn({ err }, 'podcast notification failed'));
      return 'downloaded';
    } catch (err) {
      await rm(partial, { force: true }).catch(() => undefined);
      const aborted = signal?.aborted === true;
      const message = errMessage(err);
      this.db
        .update(podcastEpisodes)
        .set(aborted ? { status: 'wanted' } : { status: 'failed', attempts: ep.attempts + 1, error: message })
        .where(eq(podcastEpisodes.id, id))
        .run();
      if (!aborted) this.log?.warn({ episodeId: id, podcastId: podcast.id, err: message }, 'podcast episode download failed');
      this.publish('episodes', podcast.id);
      return aborted ? 'wanted' : 'failed';
    } finally {
      this.active.delete(id);
      this.reserved.delete(id);
    }
  }

  /** Two episodes with the same date and title get the guid's hash appended. */
  private uniqueEpisodePath(path: string, id: number, guid: string): string {
    const clash = this.db
      .select({ id: podcastEpisodes.id })
      .from(podcastEpisodes)
      .where(and(eq(podcastEpisodes.path, path), sql`${podcastEpisodes.id} != ${id}`))
      .get();
    const key = (p: string) => resolve(p).toLowerCase();
    const inFlight = [...this.reserved].some(([other, p]) => other !== id && key(p) === key(path));
    if (!clash && !inFlight) return path;
    const ext = path.slice(stem(path).length);
    return `${stem(path)} [${createHash('sha1').update(guid).digest('hex').slice(0, 8)}]${ext}`;
  }

  /** `cover.jpg` (or .png) in the podcast folder; downloaded once. */
  private async ensureFolderCover(podcast: PodcastRow, transport: Transport, signal?: AbortSignal): Promise<string | null> {
    if (!podcast.imageUrl) return null;
    for (const name of ['cover.jpg', 'cover.png']) {
      const f = resolve(podcast.path, name);
      if (await stat(f).then(() => true, () => false)) return f;
    }
    try {
      const img = await fetchBytes(transport, podcast.imageUrl, signal);
      const f = resolve(podcast.path, /png/i.test(img.contentType ?? '') ? 'cover.png' : 'cover.jpg');
      await mkdir(podcast.path, { recursive: true });
      await writeFile(f, img.data);
      return f;
    } catch (err) {
      this.log?.warn({ podcastId: podcast.id, err: errMessage(err) }, 'podcast cover could not be fetched');
      return null;
    }
  }

  private async saveTranscripts(ep: PodcastEpisodeRowDb, target: string, transport: Transport, signal?: AbortSignal): Promise<string[]> {
    const saved: string[] = [];
    const seen = new Set<string>();
    for (const t of ep.transcripts) {
      const ext = transcriptExtension(t.type);
      if (!ext) continue;
      const lang = t.language ? `.${t.language.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 12)}` : '';
      const name = `${stem(target)}${lang}.${ext}`;
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        const { body } = await fetchText(transport, t.url, { ...(signal ? { signal } : {}), maxBytes: 5 * 1024 * 1024 });
        await writeFile(name, body, 'utf8');
        saved.push(name.slice(dirname(target).length + 1));
      } catch (err) {
        this.log?.warn({ episodeId: ep.id, err: errMessage(err) }, 'podcast transcript could not be fetched');
      }
    }
    return saved;
  }

  // ---- retention and played state ---------------------------------------------------------

  /**
   * Per podcast: keep the newest `keepLast` (downloaded + queued) episodes, delete files played
   * more than `deletePlayedAfterDays` ago. Queued episodes past the limit are unqueued.
   */
  async applyRetention(): Promise<string> {
    let deleted = 0;
    let unqueued = 0;
    const nowMs = this.now().getTime();
    for (const p of this.db.select().from(podcasts).all()) {
      const settings = SubscriptionSchema.parse(p.settings ?? {});
      if (settings.keepLast === null && settings.deletePlayedAfterDays === null) continue;
      const eps = this.db
        .select()
        .from(podcastEpisodes)
        .where(and(eq(podcastEpisodes.podcastId, p.id), inArray(podcastEpisodes.status, ['downloaded', 'wanted'])))
        .orderBy(desc(podcastEpisodes.publishedAt), desc(podcastEpisodes.id))
        .all();
      const drop = new Set<number>();
      if (settings.keepLast !== null) eps.slice(settings.keepLast).forEach((e) => drop.add(e.id));
      if (settings.deletePlayedAfterDays !== null) {
        const limit = settings.deletePlayedAfterDays * 24 * 60 * 60_000;
        for (const e of eps) {
          if (e.status === 'downloaded' && e.played && nowMs - new Date(e.playedAt ?? e.downloadedAt ?? 0).getTime() >= limit) drop.add(e.id);
        }
      }
      for (const e of eps) {
        if (!drop.has(e.id)) continue;
        if (e.status === 'wanted') {
          this.db.update(podcastEpisodes).set({ status: 'available' }).where(eq(podcastEpisodes.id, e.id)).run();
          unqueued += 1;
        } else {
          await this.removeFiles(e);
          this.db
            .update(podcastEpisodes)
            .set({ status: 'deleted', path: null, sizeBytes: null, hasChapters: false, transcriptFiles: [] })
            .where(eq(podcastEpisodes.id, e.id))
            .run();
          deleted += 1;
        }
      }
      if (drop.size > 0) {
        this.publish('episodes', p.id);
        if (deleted > 0) void this.opts.refreshMediaServers?.(p.path, 'Deleted')?.catch?.(() => undefined);
      }
    }
    return `${deleted} file${deleted === 1 ? '' : 's'} removed, ${unqueued} unqueued`;
  }

  /** Mark episodes played that a media server user finished. */
  async syncPlayed(): Promise<string> {
    const root = this.settings().rootFolder;
    if (!root || !this.opts.playedPaths) return 'no media server to read from';
    const played = await this.opts.playedPaths(root);
    if (played.size === 0) return '0 episodes marked played';
    const key = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
    const byPath = new Map([...played].map(([p, at]) => [key(p), at]));
    let n = 0;
    const touched = new Set<number>();
    const rows = this.db
      .select()
      .from(podcastEpisodes)
      .where(and(isNotNull(podcastEpisodes.path), eq(podcastEpisodes.played, false)))
      .all();
    for (const r of rows) {
      if (!byPath.has(key(r.path!))) continue;
      this.db
        .update(podcastEpisodes)
        .set({ played: true, playedAt: byPath.get(key(r.path!)) ?? this.now().toISOString(), playedSource: 'mediaServer' })
        .where(eq(podcastEpisodes.id, r.id))
        .run();
      n += 1;
      touched.add(r.podcastId);
    }
    for (const id of touched) this.publish('episodes', id);
    return `${n} episode${n === 1 ? '' : 's'} marked played`;
  }

  // ---- directory, OPML --------------------------------------------------------------------

  async lookup(term: string, source?: PodcastSearchSource): Promise<PodcastSearchResult[]> {
    let hits;
    try {
      hits = await searchDirectory(this.directory(), term, source);
    } catch (err) {
      throw new PodcastsError('FEED', `podcast search failed: ${errMessage(err)}`);
    }
    const subs = this.db.select().from(podcasts).all();
    return hits.map((h) => {
      const match = subs.find(
        (p) => sameFeedUrl(p.feedUrl, h.feedUrl) || (h.itunesId !== null && p.itunesId === h.itunesId) || (h.podcastIndexId !== null && p.podcastIndexId === h.podcastIndexId),
      );
      return { ...h, podcastId: match?.id ?? null };
    });
  }

  async importOpml(req: PodcastOpmlImportRequest, opts: AddOptions = {}): Promise<PodcastOpmlImportResult> {
    let feeds;
    try {
      feeds = parseOpml(req.opml);
    } catch (err) {
      throw new PodcastsError('VALIDATION', `OPML: ${errMessage(err)}`);
    }
    const result: PodcastOpmlImportResult = { added: [], existing: [], failed: [] };
    let next = 0;
    const worker = async () => {
      while (next < feeds.length) {
        const f = feeds[next++]!;
        const existing = this.findByFeed(f.feedUrl);
        if (existing) {
          result.existing.push({ id: existing.id, title: existing.title });
          continue;
        }
        try {
          const p = await this.add({ feedUrl: f.feedUrl, ...(req.settings ? { settings: req.settings } : {}), tags: req.tags ?? [] }, opts);
          result.added.push({ id: p.id, title: p.title });
        } catch (err) {
          if (err instanceof PodcastsError && err.code === 'CONFLICT') {
            const dup = this.findByFeed(f.feedUrl);
            if (dup) result.existing.push({ id: dup.id, title: dup.title });
            else result.failed.push({ feedUrl: redactFeedUrl(f.feedUrl), title: f.title, error: err.message });
          } else if (err instanceof PodcastsError && err.code === 'NO_ROOT_FOLDER') {
            throw err;
          } else {
            result.failed.push({ feedUrl: redactFeedUrl(f.feedUrl), title: f.title, error: errMessage(err) });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, feeds.length) }, worker));
    return result;
  }

  /** OPML of every subscription. Private feeds are left out unless `includePrivate`. */
  exportOpml(includePrivate: boolean): string {
    const rows = this.db.select().from(podcasts).orderBy(asc(podcasts.sortTitle)).all();
    return buildOpml(
      rows.filter((r) => includePrivate || !feedUrlHasCredentials(r.feedUrl)).map((r) => ({ title: r.title, feedUrl: r.feedUrl, link: r.link })),
      this.now(),
    );
  }

  // ---- calendar ---------------------------------------------------------------------------

  calendar(start: Date, end: Date, opts: { unmonitored?: boolean; tags?: readonly number[] } = {}): CalendarPodcastEpisodeItem[] {
    return podcastCalendarItems(this.db, start, end, opts);
  }

}

/** Episodes published inside [start, end], for the calendar (monitored podcasts unless `unmonitored`). */
export function podcastCalendarItems(
  db: Db,
  start: Date,
  end: Date,
  opts: { unmonitored?: boolean; tags?: readonly number[] } = {},
): CalendarPodcastEpisodeItem[] {
    const rows = db
      .select({ ep: podcastEpisodes, p: podcasts })
      .from(podcastEpisodes)
      .innerJoin(podcasts, eq(podcastEpisodes.podcastId, podcasts.id))
      .where(
        and(
          isNotNull(podcastEpisodes.publishedAt),
          gte(podcastEpisodes.publishedAt, start.toISOString()),
          lte(podcastEpisodes.publishedAt, end.toISOString()),
          opts.unmonitored ? undefined : eq(podcasts.monitored, true),
        ),
      )
      .orderBy(asc(podcastEpisodes.publishedAt))
      .limit(2000)
      .all()
      .filter((r) => !opts.tags || opts.tags.length === 0 || r.p.tags.some((t) => opts.tags!.includes(t)));
    return rows.map((r) => ({
      type: 'podcastEpisode' as const,
      date: r.ep.publishedAt!,
      podcastId: r.p.id,
      podcastTitle: r.p.title,
      podcastImageUrl: r.p.imageUrl,
      episode: toEpisode(r.ep),
    }));
  }

function episodeValues(e: ParsedEpisode) {
  return {
    guid: e.guid,
    title: e.title,
    description: e.description,
    publishedAt: e.publishedAt,
    durationSeconds: e.durationSeconds,
    season: e.season,
    episodeNumber: e.episodeNumber,
    episodeType: e.episodeType,
    explicit: e.explicit,
    imageUrl: e.imageUrl,
    link: e.link,
    enclosure: e.enclosure,
    alternateEnclosures: e.alternateEnclosures,
    chaptersUrl: e.chaptersUrl,
    transcripts: e.transcripts,
    persons: e.persons,
  };
}

export type { PodcastSubscriptionSettings };

/** Who is adding a feed: `trusted` is an admin, whose LAN feed hosts are allowed. */
export interface AddOptions {
  trusted?: boolean;
}

function trustPolicy(url: string, opts: AddOptions): TransportPolicy {
  if (!opts.trusted) return {};
  const host = lanFeedHost(url);
  return host ? { trustedHost: host } : {};
}
