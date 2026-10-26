import { GuideProfileInfo, GuidesApplyResult, GuidesDiff, GuidesSettings, GuidesStatus, GuidesSyncResult } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror docs/API.md § guides (apps/api/src/modules/guides).

export const guidesApi = {
  status: () => request('/guides/status', GuidesStatus),
  diff: () => request('/guides/diff', GuidesDiff),
  sync: () => request('/guides/sync', GuidesSyncResult, { method: 'POST' }),
  /** Without ids: every pending item except `adoptFormat`. */
  apply: (ids?: readonly string[]) => request('/guides/apply', GuidesApplyResult, { method: 'POST', json: ids ? { ids } : {} }),
  profiles: (refresh = false) => request('/guides/profiles', GuideProfileInfo.array(), { query: refresh ? { refresh } : undefined }),
  settings: {
    get: () => request('/settings/guides', GuidesSettings),
    save: (body: GuidesSettings) => request('/settings/guides', GuidesSettings, { method: 'PUT', json: body }),
  },
};
