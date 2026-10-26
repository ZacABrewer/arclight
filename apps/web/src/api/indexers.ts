import {
  Indexer,
  IndexerCapabilitiesResource,
  IndexerCategory,
  IndexerDefinitionDetail,
  IndexerDefinitionReloadResult,
  IndexerDefinitionSummary,
  IndexerGlobalSettings,
  IndexerProxy,
  IndexerProxyTestResult,
  IndexerStats,
  IndexerStatus,
  IndexerTemplate,
  IndexerTestAllItem,
  IndexerTestResult,
  SearchGrabResponse,
  type IndexerCreate,
  type IndexerDefinitionListQuery,
  type IndexerProxyCreate,
  type IndexerProxyTestRequest,
  type IndexerProxyUpdate,
  type IndexerUpdate,
  type SearchGrabRequest,
  ReleaseResource,
  type ManualSearchRequest,
} from '@arclight/shared';
import { buildUrl, request, type QueryParams } from './client.js';

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
  /** Cross-indexer search (GET /search). Id lists travel comma separated. */
  search: (query: Partial<ManualSearchRequest>, signal?: AbortSignal) => {
    const { categories, indexerIds, ...rest } = query;
    const params: QueryParams = { ...(rest as QueryParams) };
    if (categories?.length) params['categories'] = categories.join(',');
    if (indexerIds?.length) params['indexerIds'] = indexerIds.join(',');
    return request('/search', ReleaseResource.array(), { query: params, ...(signal ? { signal } : {}) });
  },
  /** Grab a search result by guid; 409 NO_MATCH unless `force`. */
  searchGrab: (body: SearchGrabRequest) => request('/search/grab', SearchGrabResponse, { method: 'POST', json: body }),
  stats: (days = 30) => request('/indexer/stats', IndexerStats, { query: { days } }),

  definitions: {
    list: (query: Partial<IndexerDefinitionListQuery> = {}) =>
      request('/indexer/definition', IndexerDefinitionSummary.array(), { query: query as QueryParams }),
    get: (id: string) => request(`/indexer/definition/${encodeURIComponent(id)}`, IndexerDefinitionDetail),
    upload: (yaml: string) => request('/indexer/definition', IndexerDefinitionDetail, { method: 'POST', json: { yaml } }),
    remove: (id: string) => request(`/indexer/definition/${encodeURIComponent(id)}`, null, { method: 'DELETE' }),
    reload: () => request('/indexer/definition/reload', IndexerDefinitionReloadResult, { method: 'POST' }),
  },

  proxies: {
    list: () => request('/indexerproxy', IndexerProxy.array()),
    create: (body: IndexerProxyCreate) => request('/indexerproxy', IndexerProxy, { method: 'POST', json: body }),
    update: (id: number, body: IndexerProxyUpdate) => request(`/indexerproxy/${id}`, IndexerProxy, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/indexerproxy/${id}`, null, { method: 'DELETE' }),
    test: (body: IndexerProxyTestRequest) => request('/indexerproxy/test', IndexerProxyTestResult, { method: 'POST', json: body }),
  },

  settings: {
    get: () => request('/settings/indexers', IndexerGlobalSettings),
    save: (body: IndexerGlobalSettings) => request('/settings/indexers', IndexerGlobalSettings, { method: 'PUT', json: body }),
  },
};

/**
 * Same-origin link that downloads a release through its indexer (cookies/login apply there):
 * the api streams the .torrent/.nzb or redirects to a magnet. Plain navigation carries the
 * session cookie, so it works as an <a href>.
 */
export function releaseDownloadHref(indexerId: number, url: string): string {
  return buildUrl(`/indexer/${indexerId}/download`, { url });
}
