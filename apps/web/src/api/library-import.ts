import {
  LibraryImportMatch,
  LibraryImportScan,
  LibraryImportScanSummary,
  type LibraryImportMediaType,
  type LibraryImportRequestInput,
  type LibraryImportScanRequest,
} from '@arclight/shared';
import { request } from './client.js';

// Library import of existing music / audiobook folders. Paths mirror
// apps/api/src/modules/imports/audio/library-import-routes.ts; shapes come from
// packages/shared/src/library-import.ts.

export const libraryImportApi = {
  /** Starts the scan job; answers with the scan at once (poll `get`). */
  scan: (body: LibraryImportScanRequest) => request('/libraryimport/scan', LibraryImportScan, { method: 'POST', json: body }),
  list: () => request('/libraryimport/scan', LibraryImportScanSummary.array()),
  get: (id: string) => request(`/libraryimport/scan/${encodeURIComponent(id)}`, LibraryImportScan),
  remove: (id: string) => request(`/libraryimport/scan/${encodeURIComponent(id)}`, null, { method: 'DELETE' }),
  lookup: (mediaType: LibraryImportMediaType, term: string) => request('/libraryimport/lookup', LibraryImportMatch.array(), { query: { mediaType, term } }),
  /** Starts the import job for the chosen candidates; answers with the scan. */
  import: (body: LibraryImportRequestInput) => request('/libraryimport/import', LibraryImportScan, { method: 'POST', json: body }),
};
