import {
  Indexer,
  IndexerCapabilitiesResource,
  IndexerCategory,
  IndexerStatus,
  IndexerTemplate,
  IndexerTestAllItem,
  IndexerTestResult,
  type IndexerCreate,
  type IndexerUpdate,
} from '@media-tron/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/indexers/routes.ts.

export const indexersApi = {
  list: () => request('/indexer', Indexer.array()),
  get: (id: number) => request(`/indexer/${id}`, Indexer),
  /** Ready-to-fill create bodies, one per implementation. */
  schema: () => request('/indexer/schema', IndexerTemplate.array()),
  categories: () => request('/indexer/categories', IndexerCategory.array()),
  status: () => request('/indexer/status', IndexerStatus.array()),
  caps: (id: number, refresh = false) =>
    request(`/indexer/${id}/caps`, IndexerCapabilitiesResource, { query: refresh ? { refresh } : undefined }),
  create: (body: IndexerCreate) => request('/indexer', Indexer, { method: 'POST', json: body }),
  /** Partial update; `settings` merges field by field. */
  update: (id: number, body: IndexerUpdate) => request(`/indexer/${id}`, Indexer, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/indexer/${id}`, null, { method: 'DELETE' }),
  test: (body: IndexerCreate) => request('/indexer/test', IndexerTestResult, { method: 'POST', json: body }),
  testAll: () => request('/indexer/testall', IndexerTestAllItem.array(), { method: 'POST' }),
};
