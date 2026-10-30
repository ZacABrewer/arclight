import { UniversalSearchResponse, type UniversalSearchQueryInput } from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// Paths mirror apps/api/src/modules/search (docs/API.md § search).

export const searchApi = {
  /** GET /search/universal: library, settings entities, activity, requests and issues in one call. */
  universal: (query: UniversalSearchQueryInput) => request('/search/universal', UniversalSearchResponse, { query: query as QueryParams }),
};
