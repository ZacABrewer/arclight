import type {
  BlocklistRecord,
  HistoryEventType,
  HistoryRecord,
  Job,
  QueueItem,
  QueueItemClientStatus,
  ReleaseDecision,
  TrackedDownloadState,
} from '@arclight/shared';
import { compact, timeSpan, type Json } from './common.js';
import { v3Languages, v3QualityModel } from './quality.js';

// Queue, history, blocklist, release decisions and commands in the upstream shapes.

// ---- queue -------------------------------------------------------------------------------

/**
 * Sonarr lists one queue record per episode. Multi-episode downloads expand to several records;
 * record ids encode (tracked id, episode index) so DELETE /queue/:id can find the download.
 */
const QUEUE_INDEX_SHIFT = 2 ** 24;
const MAX_EXPANDED = 127;

export function queueRecordId(trackedId: number, index: number): number {
  return index === 0 ? trackedId : trackedId + Math.min(index, MAX_EXPANDED) * QUEUE_INDEX_SHIFT;
}

export function trackedIdFromQueueId(id: number): number {
  return id % QUEUE_INDEX_SHIFT;
}

const QUEUE_STATUS: Record<QueueItemClientStatus, string> = {
  queued: 'queued',
  downloading: 'downloading',
  paused: 'paused',
  completed: 'completed',
  seeding: 'completed',
  failed: 'failed',
  warning: 'warning',
  unknown: 'unknown',
};

const TRACKED_STATE: Record<TrackedDownloadState, string> = {
  pending: 'downloading',
  downloading: 'downloading',
  importPending: 'importPending',
  importing: 'importing',
  imported: 'imported',
  failedPending: 'failedPending',
  failed: 'failed',
  ignored: 'ignored',
};

export interface QueueExtras {
  /** From the grab's history row: quality, languages, indexer. */
  grabbed?: HistoryRecord | null | undefined;
  /** Embedded series / movie / per-episode resources when include* was asked. */
  series?: Json | undefined;
  movie?: Json | undefined;
  episodes?: Map<number, Json> | undefined;
}

export function toV3QueueRecords(item: QueueItem, extras: QueueExtras = {}): Json[] {
  const grabbed = extras.grabbed ?? null;
  const flavor = item.mediaType === 'movie' ? 'radarr' : 'sonarr';
  const etaMs = item.eta;
  const pending = item.trackedState === 'pending';
  const base: Json = compact({
    title: item.title,
    size: item.sizeBytes,
    sizeleft: item.sizeLeftBytes,
    sizeLeft: item.sizeLeftBytes,
    timeleft: timeSpan(etaMs),
    timeLeft: timeSpan(etaMs),
    estimatedCompletionTime: etaMs !== undefined ? new Date(Date.now() + etaMs).toISOString() : undefined,
    added: item.added,
    status: pending ? 'delay' : QUEUE_STATUS[item.status],
    trackedDownloadStatus: item.trackedStatus,
    trackedDownloadState: TRACKED_STATE[item.trackedState],
    statusMessages: item.statusMessages,
    errorMessage: item.trackedStatus === 'error' ? item.statusMessages[0]?.messages[0] : undefined,
    downloadId: item.downloadId.startsWith('pending:') ? undefined : item.downloadId,
    protocol: item.protocol,
    downloadClient: item.downloadClientName ?? undefined,
    downloadClientHasPostImportCategory: false,
    indexer: grabbed?.data['indexer'] ?? '',
    outputPath: item.outputPath,
    languages: v3Languages(grabbed?.languages ?? []),
    quality: v3QualityModel(grabbed?.quality, flavor),
    customFormats: [],
    customFormatScore: grabbed?.customFormatScore ?? 0,
    episodeHasFile: false,
  });

  if (item.mediaType === 'movie' && item.movieId !== undefined) {
    return [compact({ ...base, id: item.id, movieId: item.movieId, movie: extras.movie })];
  }
  const episodeIds = item.episodeIds ?? [];
  if (item.seriesId === undefined || episodeIds.length === 0) {
    return [compact({ ...base, id: item.id, seriesId: item.seriesId, series: extras.series })];
  }
  return episodeIds.slice(0, MAX_EXPANDED + 1).map((episodeId, index) => {
    const episode = extras.episodes?.get(episodeId);
    return compact({
      ...base,
      id: queueRecordId(item.id, index),
      seriesId: item.seriesId,
      episodeId,
      seasonNumber: typeof episode?.['seasonNumber'] === 'number' ? episode['seasonNumber'] : undefined,
      episodeHasFile: episode?.['hasFile'] === true,
      series: extras.series,
      episode,
    });
  });
}

// ---- history -----------------------------------------------------------------------------

const SONARR_EVENT: Record<HistoryEventType, string> = {
  unknown: 'unknown',
  grabbed: 'grabbed',
  downloadFolderImported: 'downloadFolderImported',
  downloadFailed: 'downloadFailed',
  fileDeleted: 'episodeFileDeleted',
  fileRenamed: 'episodeFileRenamed',
  downloadIgnored: 'downloadIgnored',
};

const RADARR_EVENT: Record<HistoryEventType, string> = {
  ...SONARR_EVENT,
  fileDeleted: 'movieFileDeleted',
  fileRenamed: 'movieFileRenamed',
};

/** Sonarr's numeric EpisodeHistoryEventType (query filter `eventType=1`). */
export const HISTORY_EVENT_BY_INT: Record<number, HistoryEventType> = {
  0: 'unknown',
  1: 'grabbed',
  3: 'downloadFolderImported',
  4: 'downloadFailed',
  5: 'fileDeleted',
  6: 'fileRenamed',
  7: 'downloadIgnored',
};

const HISTORY_EVENT_BY_NAME: Record<string, HistoryEventType> = Object.fromEntries([
  ...Object.entries(SONARR_EVENT).map(([ours, theirs]) => [theirs.toLowerCase(), ours as HistoryEventType]),
  ...Object.entries(RADARR_EVENT).map(([ours, theirs]) => [theirs.toLowerCase(), ours as HistoryEventType]),
]);

/** `1`, `grabbed`, `episodeFileDeleted` ... -> our event type. */
export function parseHistoryEventType(raw: unknown): HistoryEventType | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return HISTORY_EVENT_BY_INT[Number(s)];
  return HISTORY_EVENT_BY_NAME[s.toLowerCase()];
}

export function toV3History(r: HistoryRecord, embeds: { series?: Json | undefined; episode?: Json | undefined; movie?: Json | undefined } = {}): Json {
  const movie = r.mediaType === 'movie';
  return compact({
    id: r.id,
    // Sonarr-only clients expect non-null episode/series ids, so movie rows carry 0.
    episodeId: r.episodeId ?? 0,
    seriesId: r.seriesId ?? 0,
    movieId: r.movieId ?? undefined,
    sourceTitle: r.sourceTitle,
    languages: v3Languages(r.languages),
    quality: v3QualityModel(r.quality, movie ? 'radarr' : 'sonarr'),
    customFormats: r.customFormats,
    customFormatScore: r.customFormatScore,
    qualityCutoffNotMet: false,
    date: r.date,
    downloadId: r.downloadId,
    eventType: movie ? RADARR_EVENT[r.eventType] : SONARR_EVENT[r.eventType],
    data: r.data,
    episode: embeds.episode,
    series: embeds.series,
    movie: embeds.movie,
  });
}

// ---- blocklist ---------------------------------------------------------------------------

export function toV3Blocklist(b: BlocklistRecord, embeds: { series?: Json | undefined; movie?: Json | undefined } = {}): Json {
  const movie = b.mediaType === 'movie';
  return compact({
    id: b.id,
    seriesId: b.seriesId ?? (movie ? 0 : undefined),
    episodeIds: b.episodeIds,
    movieId: b.movieId ?? undefined,
    sourceTitle: b.sourceTitle,
    languages: v3Languages(b.languages),
    quality: v3QualityModel(b.quality, movie ? 'radarr' : 'sonarr'),
    customFormats: b.customFormats,
    date: b.date,
    protocol: b.protocol,
    indexer: b.indexer ?? undefined,
    message: b.message ?? undefined,
    series: embeds.series,
    movie: embeds.movie,
  });
}

// ---- release decisions -------------------------------------------------------------------

export function toV3Release(d: ReleaseDecision): Json {
  const movie = d.mediaType === 'movie';
  return compact({
    guid: d.guid,
    quality: v3QualityModel(d.quality, movie ? 'radarr' : 'sonarr'),
    qualityWeight: d.quality.quality.weight,
    age: d.age,
    ageHours: d.ageHours,
    ageMinutes: d.ageMinutes,
    size: d.size,
    indexerId: d.indexerId,
    indexer: d.indexerName,
    releaseGroup: d.releaseGroup,
    title: d.title,
    fullSeason: d.fullSeason,
    sceneSource: false,
    seasonNumber: d.mappedSeasonNumber,
    languages: v3Languages(d.languages),
    seriesTitle: d.seriesTitle,
    movieTitles: d.movieTitle ? [d.movieTitle] : undefined,
    episodeNumbers: d.mappedEpisodeNumbers ?? [],
    absoluteEpisodeNumbers: d.mappedAbsoluteEpisodeNumbers ?? [],
    mappedSeasonNumber: d.mappedSeasonNumber,
    mappedEpisodeNumbers: d.mappedEpisodeNumbers,
    mappedAbsoluteEpisodeNumbers: d.mappedAbsoluteEpisodeNumbers,
    mappedSeriesId: d.seriesId,
    mappedMovieId: d.movieId,
    approved: d.approved,
    temporarilyRejected: d.temporarilyRejected,
    rejected: !d.approved,
    tvdbId: d.tvdbId ?? 0,
    tmdbId: d.tmdbId ?? 0,
    imdbId: d.imdbId,
    rejections: d.rejections.map((r) => r.message),
    publishDate: d.publishDate,
    commentUrl: d.infoUrl,
    downloadUrl: d.downloadUrl,
    infoUrl: d.infoUrl,
    downloadAllowed: d.downloadAllowed,
    releaseWeight: 0,
    customFormats: d.customFormats,
    customFormatScore: d.customFormatScore,
    magnetUrl: d.magnetUrl,
    infoHash: d.infoHash,
    seeders: d.seeders,
    leechers: d.leechers,
    protocol: d.protocol,
    indexerFlags: 0,
    isDaily: false,
    isAbsoluteNumbering: false,
    isPossibleSpecialEpisode: false,
    special: false,
    seriesId: d.seriesId,
    episodeId: d.episodeIds?.[0],
    episodeIds: d.episodeIds,
    movieId: d.movieId,
  });
}

// ---- commands ----------------------------------------------------------------------------

const COMMAND_STATUS: Record<Job['status'], string> = {
  queued: 'queued',
  running: 'started',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** `MissingEpisodeSearch` -> `Missing Episode Search`. */
export function humanizeCommand(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** A jobs-table row as a CommandResource; `requested` is the name and body the client sent. */
export function toV3Command(job: Job, requested?: { name: string; body: Json }): Json {
  const name = requested?.name ?? job.name;
  const stateChangeTime = job.endedAt ?? job.startedAt ?? job.queuedAt;
  return compact({
    id: job.id,
    name,
    commandName: humanizeCommand(name),
    message: job.message ?? undefined,
    body: {
      ...(requested?.body ?? {}),
      sendUpdatesToClient: true,
      updateScheduledTask: true,
      completionMessage: 'Completed',
      requiresDiskAccess: false,
      isExclusive: false,
      isTypeExclusive: false,
      isLongRunning: false,
      name,
      trigger: job.trigger === 'scheduled' ? 'scheduled' : 'manual',
      suppressMessages: false,
    },
    priority: 'normal',
    status: COMMAND_STATUS[job.status],
    result: job.status === 'completed' ? 'successful' : job.status === 'failed' ? 'unsuccessful' : 'unknown',
    queued: job.queuedAt,
    started: job.startedAt ?? undefined,
    ended: job.endedAt ?? undefined,
    duration: timeSpan(job.durationMs),
    exception: job.status === 'failed' ? (job.message ?? undefined) : undefined,
    trigger: job.trigger === 'scheduled' ? 'scheduled' : 'manual',
    stateChangeTime,
    sendUpdatesToClient: true,
    updateScheduledTask: true,
    lastExecutionTime: job.startedAt ?? undefined,
  });
}
