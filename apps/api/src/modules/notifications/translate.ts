import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  EpisodeInfo,
  HealthCheck,
  MediaFileInfo,
  MediaImage as NotificationImage,
  MediaInfo,
  NotificationEvent,
  ReleaseInfo,
} from '@arclight/notifications';
import type { MediaInfo as LibraryStreamInfo, ServerEvent } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { downloadClients, episodes, mediaFiles, movies, series, tags, trackedDownloads } from '../../db/schema.js';

// Turns the thin bus events (ids and titles) into the rich NotificationEvents agents consume,
// by loading the referenced library rows. Synchronous: every read is a local SQLite query.
//
// Deleted rows cannot be loaded after the fact, so every series/movie this translator has
// seen is remembered (bounded) and used for `library deleted` / `fileDeleted`. Modules that
// know more (the file that was deleted, whether files were removed, the full release) should
// build the event themselves and call `notificationsServiceFor(ctx).dispatch(event)`.

type SeriesRow = typeof series.$inferSelect;
type MovieRow = typeof movies.$inferSelect;
type EpisodeRow = typeof episodes.$inferSelect;
type MediaFileRow = typeof mediaFiles.$inferSelect;

export interface TranslatorOptions {
  db: Db;
  log?: Logger;
  now?: () => Date;
  instanceName?: string;
  applicationUrl?: string;
  /** Health notifications are suppressed until this instant (startup grace period). */
  healthGraceUntil?: Date;
  /** How many series/movies to remember for deletion events. */
  cacheSize?: number;
  /**
   * Translate `import imported` bus events into `import` notifications (default true). Set to
   * false when the imports module dispatches richer import/upgrade events itself (app wiring).
   */
  translateImported?: boolean;
}

const COVER_TYPES = new Set<NotificationImage['coverType']>(['poster', 'fanart', 'banner', 'clearlogo']);

/** `{ [key]: value }` when value is present, `{}` otherwise (exactOptionalPropertyTypes). */
function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export class EventTranslator {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly instanceName: string;
  private readonly applicationUrl: string | undefined;
  private readonly healthGraceUntil: Date | undefined;
  private readonly cacheSize: number;
  private readonly translateImported: boolean;
  private readonly mediaCache = new Map<string, MediaInfo>();
  /** Non-ok health checks as of the last health event, keyed by source. */
  private knownIssues = new Map<string, HealthCheck>();

  constructor(options: TranslatorOptions) {
    this.db = options.db;
    this.log = options.log;
    this.now = options.now ?? (() => new Date());
    this.instanceName = options.instanceName ?? 'Arclight';
    this.applicationUrl = options.applicationUrl;
    this.healthGraceUntil = options.healthGraceUntil;
    this.cacheSize = options.cacheSize ?? 500;
    this.translateImported = options.translateImported ?? true;
  }

  translate(event: ServerEvent): NotificationEvent[] {
    switch (event.type) {
      case 'health':
        return this.health(event.health.checks);
      case 'release':
        return event.action === 'grabbed' ? this.grab(event.title, event.mediaType, event.mediaId) : [];
      case 'import':
        if (event.action === 'imported') return this.translateImported ? this.imported(event.mediaType, event.mediaId) : [];
        if (event.action === 'manualRequired') return this.manual(event.title, event.mediaType, event.mediaId, event.message);
        return [];
      case 'library':
        return this.library(event.action, event.mediaType, event.id);
      default:
        return [];
    }
  }

  // ---- health ----------------------------------------------------------------------------

  private health(checks: HealthCheck[]): NotificationEvent[] {
    const now = this.now();
    // Inside the grace period nothing is recorded either, so problems that outlive it are
    // reported by the first health event afterwards (they look new then).
    if (this.healthGraceUntil && now < this.healthGraceUntil) return [];
    const current = new Map(checks.filter((c) => c.status !== 'ok').map((c) => [c.source, c]));
    const out: NotificationEvent[] = [];
    for (const [source, check] of current) {
      if (!this.knownIssues.has(source)) out.push({ ...this.base(), type: 'healthIssue', health: check });
    }
    for (const [source, previous] of this.knownIssues) {
      if (!current.has(source)) out.push({ ...this.base(), type: 'healthRestored', health: previous });
    }
    this.knownIssues = current;
    return out;
  }

  // ---- releases and imports ---------------------------------------------------------------

  private grab(title: string, mediaType: 'series' | 'movie' | undefined, mediaId: number | undefined): NotificationEvent[] {
    const tracked = this.db
      .select({ row: trackedDownloads, clientName: downloadClients.name, clientType: downloadClients.implementation })
      .from(trackedDownloads)
      .leftJoin(downloadClients, eq(trackedDownloads.clientId, downloadClients.id))
      .where(eq(trackedDownloads.title, title))
      .orderBy(desc(trackedDownloads.id))
      .get();
    const type = mediaType ?? tracked?.row.mediaType ?? undefined;
    const id = mediaId ?? (type === 'movie' ? tracked?.row.movieId : tracked?.row.seriesId) ?? undefined;
    if (!type || id === undefined) {
      this.log?.debug({ title }, 'grab event without media; not notifying');
      return [];
    }
    const media = this.media(type, id);
    if (!media) return [];
    const episodeIds = tracked?.row.episodeIds ?? [];
    return [
      {
        ...this.base(),
        type: 'grab',
        media,
        ...(type === 'series' ? { episodes: this.episodesByIds(episodeIds) } : {}),
        release: releaseFrom(title, tracked?.row.grabbedRelease, tracked?.row.size),
        ...opt('downloadClient', tracked?.clientName),
        ...opt('downloadClientType', tracked?.clientType),
        ...opt('downloadId', tracked?.row.downloadId),
      },
    ];
  }

  private imported(mediaType: 'series' | 'movie' | undefined, mediaId: number | undefined): NotificationEvent[] {
    if (!mediaType || mediaId === undefined) return [];
    const media = this.media(mediaType, mediaId);
    if (!media) return [];
    const fileRow = this.latestFile(mediaType, mediaId);
    if (!fileRow) {
      this.log?.debug({ mediaType, mediaId }, 'import event but no media file found; not notifying');
      return [];
    }
    const eps =
      mediaType === 'series'
        ? this.db.select().from(episodes).where(eq(episodes.episodeFileId, fileRow.id)).all().map(toEpisodeInfo)
        : undefined;
    return [{ ...this.base(), type: 'import', media, ...opt('episodes', eps), file: toFileInfo(fileRow) }];
  }

  private manual(
    title: string,
    mediaType: 'series' | 'movie' | undefined,
    mediaId: number | undefined,
    message: string | undefined,
  ): NotificationEvent[] {
    const media = mediaType && mediaId !== undefined ? this.media(mediaType, mediaId) : null;
    return [
      {
        ...this.base(),
        type: 'manualInteractionRequired',
        ...opt('media', media),
        downloadTitle: title,
        downloadStatus: 'warning',
        statusMessages: message ? [{ title, messages: [message] }] : [],
      },
    ];
  }

  // ---- library ------------------------------------------------------------------------------

  private library(
    action: 'added' | 'updated' | 'deleted' | 'fileAdded' | 'fileDeleted' | 'refreshed',
    mediaType: 'series' | 'movie',
    id: number,
  ): NotificationEvent[] {
    switch (action) {
      case 'added': {
        const media = this.media(mediaType, id);
        return media ? [{ ...this.base(), type: 'mediaAdded', media, addMethod: 'manual' }] : [];
      }
      case 'deleted': {
        const media = this.media(mediaType, id);
        if (!media) {
          this.log?.debug({ mediaType, id }, 'deleted media not known; not notifying');
          return [];
        }
        this.mediaCache.delete(cacheKey(mediaType, id));
        return [{ ...this.base(), type: 'mediaDeleted', media, deletedFiles: false }];
      }
      case 'fileDeleted': {
        const media = this.media(mediaType, id);
        if (!media) return [];
        // The bus event does not say which file went; describe the media folder instead.
        const file: MediaFileInfo = {
          id: 0,
          path: media.path,
          relativePath: '',
          quality: 'Unknown',
          qualityVersion: 1,
          size: 0,
          dateAdded: this.now().toISOString(),
          languages: [],
        };
        return [{ ...this.base(), type: 'fileDeleted', media, file, reason: 'manual' }];
      }
      default:
        // updated / refreshed / fileAdded: nothing to send, but remember the media so a later
        // deletion can still be described.
        this.media(mediaType, id);
        return [];
    }
  }

  // ---- loaders --------------------------------------------------------------------------------

  /** Load (and remember) a series or movie; falls back to the cache for deleted rows. */
  media(mediaType: 'series' | 'movie', id: number): MediaInfo | null {
    const key = cacheKey(mediaType, id);
    const row =
      mediaType === 'series'
        ? this.db.select().from(series).where(eq(series.id, id)).get()
        : this.db.select().from(movies).where(eq(movies.id, id)).get();
    if (!row) return this.mediaCache.get(key) ?? null;
    const info = toMediaInfo(mediaType, row, this.tagLabels(row.tags));
    this.mediaCache.delete(key);
    this.mediaCache.set(key, info);
    if (this.mediaCache.size > this.cacheSize) {
      const oldest = this.mediaCache.keys().next().value;
      if (oldest !== undefined) this.mediaCache.delete(oldest);
    }
    return info;
  }

  private tagLabels(ids: number[]): string[] {
    if (ids.length === 0) return [];
    const rows = this.db.select().from(tags).where(inArray(tags.id, ids)).all();
    const byId = new Map(rows.map((r) => [r.id, r.label]));
    return ids.flatMap((id) => {
      const label = byId.get(id);
      return label === undefined ? [] : [label];
    });
  }

  private episodesByIds(ids: number[]): EpisodeInfo[] {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(episodes)
      .where(inArray(episodes.id, ids))
      .orderBy(episodes.seasonNumber, episodes.episodeNumber)
      .all()
      .map(toEpisodeInfo);
  }

  private latestFile(mediaType: 'series' | 'movie', id: number): MediaFileRow | undefined {
    if (mediaType === 'movie') {
      const movie = this.db.select({ fileId: movies.movieFileId }).from(movies).where(eq(movies.id, id)).get();
      if (movie?.fileId) {
        const row = this.db.select().from(mediaFiles).where(eq(mediaFiles.id, movie.fileId)).get();
        if (row) return row;
      }
    }
    const column = mediaType === 'movie' ? mediaFiles.movieId : mediaFiles.seriesId;
    return this.db
      .select()
      .from(mediaFiles)
      .where(and(eq(column, id), eq(mediaFiles.mediaType, mediaType)))
      .orderBy(desc(mediaFiles.dateAdded), desc(mediaFiles.id))
      .get();
  }

  private base() {
    return {
      instanceName: this.instanceName,
      timestamp: this.now().toISOString(),
      ...opt('applicationUrl', this.applicationUrl),
    };
  }
}

function cacheKey(mediaType: 'series' | 'movie', id: number): string {
  return `${mediaType}:${id}`;
}

export function toMediaInfo(mediaType: 'series' | 'movie', row: SeriesRow | MovieRow, tagLabels: string[]): MediaInfo {
  const images: NotificationImage[] = row.images.flatMap((img) => {
    if (!COVER_TYPES.has(img.coverType as NotificationImage['coverType'])) return [];
    const url = /^https?:\/\//.test(img.url) ? img.url : (img.remoteUrl ?? undefined);
    return url ? [{ coverType: img.coverType as NotificationImage['coverType'], url }] : [];
  });
  const rating = row.ratings['tmdb']?.value ?? row.ratings['imdb']?.value;
  return {
    id: row.id,
    mediaType,
    title: row.title,
    year: row.year,
    tmdbId: row.tmdbId,
    ...opt('imdbId', row.imdbId),
    ...('tvdbId' in row ? opt('tvdbId', row.tvdbId) : {}),
    path: row.path,
    ...opt('overview', row.overview === '' ? undefined : row.overview),
    genres: row.genres,
    tags: tagLabels,
    ...opt('rating', rating),
    images,
  };
}

export function toEpisodeInfo(row: EpisodeRow): EpisodeInfo {
  return {
    id: row.id,
    seasonNumber: row.seasonNumber,
    episodeNumber: row.episodeNumber,
    ...opt('absoluteEpisodeNumber', row.absoluteEpisodeNumber),
    title: row.title,
    ...opt('overview', row.overview === '' ? undefined : row.overview),
    ...opt('airDate', row.airDate),
  };
}

export function toFileInfo(row: MediaFileRow): MediaFileInfo {
  return {
    id: row.id,
    path: row.path,
    relativePath: row.relativePath,
    quality: row.quality.quality.name,
    qualityVersion: row.quality.revision.version,
    ...opt('releaseGroup', row.releaseGroup),
    ...opt('sceneName', row.sceneName),
    size: row.sizeBytes,
    dateAdded: row.dateAdded,
    languages: row.languages,
    ...opt('mediaInfo', row.mediaInfo ? toStreamInfo(row.mediaInfo) : undefined),
  };
}

function toStreamInfo(info: LibraryStreamInfo) {
  const [width, height] = (info.resolution ?? '').split('x').map((n) => Number(n));
  return {
    ...opt('videoCodec', info.videoCodec),
    ...opt('videoDynamicRange', info.videoDynamicRange),
    ...opt('width', Number.isFinite(width) && width ? width : undefined),
    ...opt('height', Number.isFinite(height) && height ? height : undefined),
    ...opt('audioCodec', info.audioCodec),
    ...opt('audioChannels', info.audioChannels),
    audioLanguages: info.audioLanguages ?? [],
    subtitleLanguages: info.subtitles ?? [],
  };
}

/** Best-effort release description from the opaque snapshot the pipeline stored at grab time. */
export function releaseFrom(title: string, snapshot: unknown, size: number | undefined): ReleaseInfo {
  const s = typeof snapshot === 'object' && snapshot !== null ? (snapshot as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const quality = s['quality'];
  let qualityName = str(quality);
  let qualityVersion = 1;
  if (typeof quality === 'object' && quality !== null) {
    const q = quality as { quality?: { name?: unknown }; revision?: { version?: unknown } };
    qualityName = str(q.quality?.name);
    qualityVersion = num(q.revision?.version) ?? 1;
  }
  const customFormats = Array.isArray(s['customFormats'])
    ? s['customFormats'].flatMap((cf) => {
        const name = typeof cf === 'string' ? cf : str((cf as { name?: unknown } | null)?.name);
        return name ? [name] : [];
      })
    : [];
  return {
    title: str(s['title']) ?? title,
    quality: qualityName ?? 'Unknown',
    qualityVersion,
    ...opt('indexer', str(s['indexer'])),
    size: num(s['size']) ?? size ?? 0,
    ...opt('releaseGroup', str(s['releaseGroup'])),
    customFormats,
    customFormatScore: num(s['customFormatScore']) ?? 0,
  };
}
