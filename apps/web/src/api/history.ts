import { z } from 'zod';
import { Job, type HistoryMarkFailedRequest } from '@arclight/shared';
import { request } from './client.js';
import { t } from '../i18n/index.js';

// Paths mirror apps/api/src/modules/history/routes.ts. The row schema is a loose reading of
// packages/shared HistoryRecord: the pages only rely on the fields named here, so a new field
// on the server never breaks the parse.

/** The filterable event types (packages/shared HistoryEventType, minus `unknown`). */
export const HISTORY_EVENT_TYPES = [
  'grabbed',
  'downloadFolderImported',
  'downloadFailed',
  'fileDeleted',
  'fileRenamed',
  'downloadIgnored',
  'fileTranscoded',
  'profileChanged',
  'profileReplaced',
  'additionalLanguage',
] as const;
export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];

export const HISTORY_EVENT_LABELS: Record<HistoryEventType, string> = {
  get grabbed() {
    return t('common.grabbed');
  },
  get downloadFolderImported() {
    return t('common.imported');
  },
  get downloadFailed() {
    return t('status.failed');
  },
  get fileDeleted() {
    return t('api.history.fileDeleted');
  },
  get fileRenamed() {
    return t('api.history.fileRenamed');
  },
  get downloadIgnored() {
    return t('api.history.ignored');
  },
  get fileTranscoded() {
    return t('api.history.fileTranscoded');
  },
  get profileChanged() {
    return t('api.history.profileChanged');
  },
  get profileReplaced() {
    return t('api.history.profileReplaced');
  },
  get additionalLanguage() {
    return t('api.history.additionalLanguage');
  },
};

/** Label for any event type string; unknown values are shown as they are. */
export function historyEventLabel(type: string): string {
  if (type === 'unknown') return t('api.history.unknown');
  return HISTORY_EVENT_LABELS[type as HistoryEventType] ?? type;
}

export const HistoryRecord = z.looseObject({
  id: z.number().int(),
  eventType: z.string(),
  sourceTitle: z.string(),
  date: z.string(),
  downloadId: z.string().nullish(),
  mediaType: z.enum(['series', 'movie', 'music', 'audiobook']).nullish(),
  seriesId: z.number().int().nullish(),
  episodeId: z.number().int().nullish(),
  movieId: z.number().int().nullish(),
  /** Music rows: the artist and the album(s) of the grab or import. */
  artistId: z.number().int().nullish(),
  albumId: z.number().int().nullish(),
  albumIds: z.array(z.number().int()).nullish(),
  quality: z.looseObject({ quality: z.looseObject({ name: z.string() }).optional() }).nullish(),
  languages: z.array(z.string()).nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
  /** Present when the request asked for includeEpisode. */
  episode: z.looseObject({ seasonNumber: z.number().int(), episodeNumber: z.number().int(), title: z.string().nullish() }).nullish(),
});
export type HistoryRecord = z.infer<typeof HistoryRecord>;

export const HistoryPage = z.looseObject({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(HistoryRecord),
});
export type HistoryPage = z.infer<typeof HistoryPage>;

export interface HistoryFilter {
  page: number;
  pageSize: number;
  /** Empty = every event type. */
  eventTypes: readonly HistoryEventType[];
  sortDirection: 'asc' | 'desc';
  /** One item only (deep links, e.g. from the decision log). */
  seriesId?: number;
  episodeId?: number;
  movieId?: number;
  /** Text search (release name, titles, indexer, client, message); blank = none. */
  q?: string;
}

export const DEFAULT_HISTORY_FILTER: HistoryFilter = { page: 1, pageSize: 25, eventTypes: [], sortDirection: 'desc' };

/** Query string for GET /history: event types comma-separated (spec 1.5 "event type (multi)"). */
export function historyQuery(filter: HistoryFilter): Record<string, string | number> {
  const q: Record<string, string | number> = {
    page: filter.page,
    pageSize: filter.pageSize,
    sortKey: 'date',
    sortDirection: filter.sortDirection,
  };
  if (filter.eventTypes.length > 0) q.eventType = filter.eventTypes.join(',');
  if (filter.seriesId !== undefined) q.seriesId = filter.seriesId;
  if (filter.episodeId !== undefined) q.episodeId = filter.episodeId;
  if (filter.movieId !== undefined) q.movieId = filter.movieId;
  if (filter.q?.trim()) q.q = filter.q.trim();
  return q;
}

export const historyApi = {
  list: (filter: HistoryFilter) => request('/history', HistoryPage, { query: historyQuery(filter) }),
  /** Every record of one series, newest first, with the episode attached. */
  forSeries: (seriesId: number) => request('/history/series', HistoryRecord.array(), { query: { seriesId, includeEpisode: true } }),
  /** Every record of one movie, newest first. */
  forMovie: (movieId: number) => request('/history/movie', HistoryRecord.array(), { query: { movieId } }),
  /** Spec 3.5: mark a grabbed row's download as failed (blocklists and may redownload). */
  markFailed: (id: number, body: Partial<HistoryMarkFailedRequest> = {}) =>
    request(`/history/failed/${id}`, null, { method: 'POST', json: { skipRedownload: false, ...body } }),
  /** Re-run the search for the record's episode(s) or movie. 202 with the started Job. */
  redownload: (id: number) => request(`/history/${id}/redownload`, Job, { method: 'POST' }),
};
