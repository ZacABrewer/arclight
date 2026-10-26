import { ManualImportItem, ManualImportResult, type ManualImportQueryInput, type ManualImportRequestInput } from '@media-tron/shared';
import { request, type QueryParams } from './client.js';

// Paths mirror the manual import block of apps/api/src/modules/imports/routes.ts.

export const manualImportApi = {
  list: (query: ManualImportQueryInput) =>
    request('/manualimport', ManualImportItem.array(), { query: query as QueryParams }),
  execute: (body: ManualImportRequestInput) => request('/manualimport', ManualImportResult, { method: 'POST', json: body }),
};
