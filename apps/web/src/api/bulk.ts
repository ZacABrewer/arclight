import { BulkCommandResponse, BulkRenamePreview, RenameResult, type BulkRenameRequest, type BulkSearchCommandInput, type BulkSubtitleSearchCommand } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/bulk/index.ts (the bulk bar on the library and Wanted lists).

export const bulkApi = {
  /** One BulkSearch job over many items; `mode` applies the Wanted lists' missing / cutoff rules. 202. */
  search: (body: BulkSearchCommandInput) => request('/command/bulksearch', BulkCommandResponse, { method: 'POST', json: body }),
  /** Rename preview for many series / movies. */
  renamePreview: (body: BulkRenameRequest) => request('/rename/bulk', BulkRenamePreview, { method: 'POST', json: body }),
  /** Renames the files of many items (`files` limits it to the ticked preview rows). */
  rename: (body: BulkRenameRequest) => request('/command/bulkrename', RenameResult, { method: 'POST', json: body }),
  /** One BulkSubtitleSearch job over many files (or the whole wanted list). 202. */
  subtitleSearch: (body: BulkSubtitleSearchCommand) => request('/command/subtitlesearch/bulk', BulkCommandResponse, { method: 'POST', json: body }),
};
