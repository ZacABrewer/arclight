import { FeedsResponse } from '@arclight/shared';
import { request } from './client.js';

// GET /system/feeds: the self-updating data feeds (guides, indexer definitions, …).
export const feedsApi = {
  list: () => request('/system/feeds', FeedsResponse),
};
