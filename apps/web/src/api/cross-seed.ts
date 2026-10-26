import { CrossSeedResource, CrossSeedSearchResult, CrossSeedSettings, type CrossSeedListQuery, type CrossSeedSearchRequest } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror docs/API.md "cross-seed" (contract: packages/shared/src/cross-seed.ts).

export const crossSeedApi = {
  settings: {
    get: () => request('/settings/crossseed', CrossSeedSettings),
    update: (body: CrossSeedSettings) => request('/settings/crossseed', CrossSeedSettings, { method: 'PUT', json: body }),
  },
  list: (query: CrossSeedListQuery = {}) =>
    request('/crossseed', CrossSeedResource.array(), { query: { mediaFileId: query.mediaFileId, state: query.state } }),
  search: (body: CrossSeedSearchRequest) => request('/crossseed/search', CrossSeedSearchResult, { method: 'POST', json: body }),
};
