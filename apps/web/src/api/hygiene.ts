import { HygieneDeleteResult, HygieneListResponse, HygieneMapResult, Job, type HygieneListQuery, type HygieneMapRequestInput } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/library-hygiene/routes.ts (docs/API.md § library-hygiene).

export const hygieneApi = {
  list: (query: Partial<HygieneListQuery> = {}) => request('/library/hygiene', HygieneListResponse, { query }),
  /** Starts an OrphanScan job (202). */
  scan: () => request('/library/hygiene/scan', Job, { method: 'POST' }),
  map: (id: number, body: HygieneMapRequestInput) => request(`/library/hygiene/${id}/map`, HygieneMapResult, { method: 'POST', json: body }),
  remove: (id: number) => request(`/library/hygiene/${id}`, HygieneDeleteResult, { method: 'DELETE' }),
};
