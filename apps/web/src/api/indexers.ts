import { z } from 'zod';
import { request } from './client.js';

// TODO(contract): packages/shared/src/indexers.ts is still a stub. Replace IndexerStub with the
// shared `Indexer` schema (and add search/test/schema endpoints) when the indexers module lands.
// The loose object keeps a list usable meanwhile: id + name are the only fields relied on.
export const IndexerStub = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  enable: z.boolean().optional(),
  protocol: z.string().optional(),
});
export type IndexerStub = z.infer<typeof IndexerStub>;

export const indexersApi = {
  list: () => request('/indexer', IndexerStub.array()),
  get: (id: number) => request(`/indexer/${id}`, IndexerStub),
  remove: (id: number) => request(`/indexer/${id}`, null, { method: 'DELETE' }),
};
