import { DEFAULT_HISTORY_FILTER, HISTORY_EVENT_TYPES, type HistoryEventType, type HistoryFilter } from '../../api/history.js';

/**
 * /activity/history search params: deep links from elsewhere (e.g. the decision log's
 * "View grab in History") open the page filtered to one item and event type.
 */
export interface HistorySearch {
  eventType?: HistoryEventType;
  seriesId?: number;
  episodeId?: number;
  movieId?: number;
}

const positiveInt = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export function parseHistorySearch(search: Record<string, unknown>): HistorySearch {
  const out: HistorySearch = {};
  const type = search['eventType'];
  if (typeof type === 'string' && (HISTORY_EVENT_TYPES as readonly string[]).includes(type)) out.eventType = type as HistoryEventType;
  for (const key of ['seriesId', 'episodeId', 'movieId'] as const) {
    const id = positiveInt(search[key]);
    if (id !== undefined) out[key] = id;
  }
  return out;
}

/** The page's starting filter for a deep link. */
export function historyFilterFromSearch(search: HistorySearch): HistoryFilter {
  return {
    ...DEFAULT_HISTORY_FILTER,
    eventTypes: search.eventType ? [search.eventType] : [],
    ...(search.seriesId !== undefined ? { seriesId: search.seriesId } : {}),
    ...(search.episodeId !== undefined ? { episodeId: search.episodeId } : {}),
    ...(search.movieId !== undefined ? { movieId: search.movieId } : {}),
  };
}
