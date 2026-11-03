import { TagSyncPreview, TagSyncStatus } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/tag-sync/routes.ts (docs/API.md).

const base = (id: string) => `/mediaserver/${encodeURIComponent(id)}/tag-sync`;

export const tagSyncApi = {
  status: (id: string) => request(base(id), TagSyncStatus),
  preview: (id: string) => request(`${base(id)}/preview`, TagSyncPreview, { method: 'POST', json: {} }),
  run: (id: string) => request(`${base(id)}/run`, null, { method: 'POST', json: {} }),
  /** Sync turned off, Keep: the tags stay on the server. */
  forget: (id: string) => request(`${base(id)}/forget`, null, { method: 'POST', json: {} }),
  /** Sync turned off, Remove: the tags Arclight added come off the server. */
  removeAll: (id: string) => request(`${base(id)}/remove-all`, null, { method: 'POST', json: {} }),
};
