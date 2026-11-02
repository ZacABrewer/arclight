import { z } from 'zod';
import { CollectionPreview, CollectionsSettings, CollectionSyncResult, CollectionSyncState, LeavingSoon, SmartCollection, type SmartCollectionInput } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/collections/routes.ts (smart collections, Leaving Soon,
// the collection sync and the collections settings).

export const CollectionSyncOverview = z.object({
  servers: z.array(z.object({ id: z.string(), name: z.string() })),
  states: z.array(CollectionSyncState.extend({ collectionKey: z.string() })),
});
export type CollectionSyncOverview = z.infer<typeof CollectionSyncOverview>;

export const smartCollectionsApi = {
  list: () => request('/collections/smart', SmartCollection.array()),
  get: (id: number) => request(`/collections/smart/${id}`, SmartCollection),
  create: (body: SmartCollectionInput) => request('/collections/smart', SmartCollection, { method: 'POST', json: body }),
  update: (id: number, body: SmartCollectionInput) => request(`/collections/smart/${id}`, SmartCollection, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/collections/smart/${id}`, null, { method: 'DELETE' }),
  items: (id: number, limit?: number) => request(`/collections/smart/${id}/items`, CollectionPreview, { query: { limit } }),
  preview: (body: SmartCollectionInput, limit?: number) => request('/collections/smart/preview', CollectionPreview, { method: 'POST', json: body, query: { limit } }),
  leavingSoon: () => request('/collections/leavingsoon', LeavingSoon),
  syncStatus: () => request('/collections/sync', CollectionSyncOverview),
  syncNow: () => request('/collections/sync', CollectionSyncResult, { method: 'POST' }),
  settings: () => request('/settings/collections', CollectionsSettings),
  saveSettings: (body: CollectionsSettings) => request('/settings/collections', CollectionsSettings, { method: 'PUT', json: body }),
};
