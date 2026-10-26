import { z } from 'zod';
import { request } from './client.js';

// TODO(contract): the /blocklist routes are being built in parallel with the history module
// (docs/spec/history-and-blocklist.md section 2). Loose placeholders until the shared
// contract exists; only the fields named here are relied on.

export const BlocklistItem = z.looseObject({
  id: z.number().int(),
  sourceTitle: z.string(),
  date: z.string(),
  protocol: z.string().nullish(),
  indexer: z.string().nullish(),
  message: z.string().nullish(),
  mediaType: z.enum(['series', 'movie']).nullish(),
  seriesId: z.number().int().nullish(),
  movieId: z.number().int().nullish(),
  quality: z.looseObject({ quality: z.looseObject({ name: z.string() }).optional() }).nullish(),
});
export type BlocklistItem = z.infer<typeof BlocklistItem>;

export const BlocklistPage = z.looseObject({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(BlocklistItem),
});
export type BlocklistPage = z.infer<typeof BlocklistPage>;

export const blocklistApi = {
  list: (page: number, pageSize: number) =>
    request('/blocklist', BlocklistPage, { query: { page, pageSize, sortKey: 'date', sortDirection: 'desc' } }),
  remove: (id: number) => request(`/blocklist/${id}`, null, { method: 'DELETE' }),
  removeBulk: (ids: number[]) => request('/blocklist/bulk', null, { method: 'DELETE', json: { ids } }),
};
