import { ItemSearchStatus, type SearchItemType } from '@arclight/shared';
import { request } from './client.js';

// Search status: path mirrors apps/api/src/modules/releases/routes.ts (docs/API.md "releases").

const ItemSearchStatusList = ItemSearchStatus.array();

export const searchStatusApi = {
  /** Last search and next scheduled search of up to 500 episodes or movies. */
  list: (mediaType: SearchItemType, ids: readonly number[]) =>
    request('/release/searchstatus', ItemSearchStatusList, { query: { mediaType, ids: ids.join(',') } }),
};
