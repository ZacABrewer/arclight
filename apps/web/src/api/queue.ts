import {
  DownloadTimeline,
  QueueItem,
  QueuePage,
  QueueRemoveResult,
  QueueStatus,
  type QueueBulkRemoveRequest,
  type QueueQueryInput,
  type QueueRemoveOptions,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// Paths mirror the queue block of apps/api/src/modules/download-clients/routes.ts.

export const queueApi = {
  list: (query: Partial<QueueQueryInput> = {}) => request('/queue', QueuePage, { query: query as QueryParams }),
  status: () => request('/queue/status', QueueStatus),
  get: (id: number) => request(`/queue/${id}`, QueueItem),
  /** What happened to a download, oldest first (also after it left the queue). */
  timeline: (id: number) => request(`/queue/${id}/timeline`, DownloadTimeline),
  /** Options travel as the query string on the single-item route. */
  remove: (id: number, options: QueueRemoveOptions) =>
    request(`/queue/${id}`, QueueRemoveResult, { method: 'DELETE', query: { ...options } }),
  /** The bulk route takes a JSON body on DELETE. */
  removeBulk: (body: QueueBulkRemoveRequest) =>
    request('/queue/bulk', QueueRemoveResult, { method: 'DELETE', json: body }),
  /** Retry sending a pending (delayed / failed-to-send) release to its client. */
  grab: (id: number) => request(`/queue/grab/${id}`, QueueItem, { method: 'POST' }),
};
