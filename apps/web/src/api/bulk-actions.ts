import { BulkActionResult, type BulkActionRequest } from '@arclight/shared';
import { request } from './client.js';

/** POST /bulk: one action over many rows of a settings, activity or system list. */
export const bulkActionsApi = {
  run: (body: BulkActionRequest) => request('/bulk', BulkActionResult, { method: 'POST', json: body }),
};
