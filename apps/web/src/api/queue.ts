import {
  DownloadTimeline,
  QueueItem,
  QueuePage,
  QueueReannounceResult,
  QueueRemoveResult,
  QueueReplaceResult,
  QueueStatus,
  QueueSummaryItem,
  type QueueBulkRemoveRequest,
  type QueueItemLimitsRequest,
  type QueueMove,
  type QueueQueryInput,
  type QueueRemoveOptions,
  type QueueReplaceRequestInput,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// Paths mirror the queue block of apps/api/src/modules/download-clients/routes.ts.

const QueueSummaryList = QueueSummaryItem.array();

export const queueApi = {
  list: (query: Partial<QueueQueryInput> = {}) => request('/queue', QueuePage, { query: query as QueryParams }),
  status: () => request('/queue/status', QueueStatus),
  /** Compact state of every library-linked download (library badges). */
  summary: () => request('/queue/summary', QueueSummaryList),
  get: (id: number) => request(`/queue/${id}`, QueueItem),
  /** What happened to a download, oldest first (also after it left the queue). */
  timeline: (id: number) => request(`/queue/${id}/timeline`, DownloadTimeline),
  /** Options travel as the query string on the single-item route. */
  remove: (id: number, options: QueueRemoveOptions) =>
    request(`/queue/${id}`, QueueRemoveResult, { method: 'DELETE', query: { ...options } }),
  /** The bulk route takes a JSON body on DELETE. */
  removeBulk: (body: QueueBulkRemoveRequest) =>
    request('/queue/bulk', QueueRemoveResult, { method: 'DELETE', json: body }),
  /** Retry sending a pending (delayed / failed-to-send / held for disk space) release to its client. */
  grab: (id: number) => request(`/queue/grab/${id}`, QueueItem, { method: 'POST' }),
  /** Speed limits of one download in bytes/s (0 = unlimited); omitted keys keep their value. */
  limits: (id: number, body: QueueItemLimitsRequest) => request(`/queue/${id}/limits`, QueueItem, { method: 'POST', json: body }),
  /** Reorder the client's download queue. */
  move: (id: number, move: QueueMove) => request(`/queue/${id}/move`, QueueItem, { method: 'POST', json: { move } }),
  /** Run past the active-download limit (or stop forcing it). */
  forceStart: (id: number, enabled: boolean) => request(`/queue/${id}/forcestart`, QueueItem, { method: 'POST', json: { enabled } }),
  /** "Try another release": remove (and blocklist) the download and search for another release. */
  replace: (id: number, options: QueueReplaceRequestInput) =>
    request(`/queue/${id}/replace`, QueueReplaceResult, { method: 'POST', json: options }),
  /** Ask the download client for fresh peers. */
  reannounce: (id: number) => request(`/queue/${id}/reannounce`, QueueReannounceResult, { method: 'POST' }),
};
