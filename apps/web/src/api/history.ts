import { z } from 'zod';
import { request } from './client.js';

// TODO(contract): packages/shared/src/history.ts is still a stub and the /history routes are
// being built in parallel. These loose schemas follow docs/spec/history-and-blocklist.md
// (row shape 1.1, event types 1.2, paged list 1.5, mark-as-failed 3.5). Replace them with the
// shared exports when the history module lands; the pages only rely on the fields named here.

export const HISTORY_EVENT_TYPES = ['grabbed', 'imported', 'failed', 'fileDeleted', 'fileRenamed', 'ignored'] as const;
export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];

export const HISTORY_EVENT_LABELS: Record<HistoryEventType, string> = {
  grabbed: 'Grabbed',
  imported: 'Imported',
  failed: 'Failed',
  fileDeleted: 'File deleted',
  fileRenamed: 'File renamed',
  ignored: 'Ignored',
};

export const HistoryRecord = z.looseObject({
  id: z.number().int(),
  eventType: z.string(),
  sourceTitle: z.string(),
  date: z.string(),
  downloadId: z.string().nullish(),
  mediaType: z.enum(['series', 'movie']).nullish(),
  seriesId: z.number().int().nullish(),
  episodeId: z.number().int().nullish(),
  movieId: z.number().int().nullish(),
  quality: z.looseObject({ quality: z.looseObject({ name: z.string() }).optional() }).nullish(),
  languages: z.array(z.string()).nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
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
  return q;
}

export const historyApi = {
  list: (filter: HistoryFilter) => request('/history', HistoryPage, { query: historyQuery(filter) }),
  /** Spec 3.5: mark a grabbed row's download as failed (blocklists and may redownload). */
  markFailed: (id: number) => request(`/history/failed/${id}`, null, { method: 'POST' }),
};
