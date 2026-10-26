import { z } from 'zod';
import { request } from './client.js';

// TODO(contract): packages/shared/src/download-clients.ts is still a stub. Replace these loose
// placeholders with the shared `DownloadClient` and queue schemas when that module lands.
export const DownloadClientStub = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  enable: z.boolean().optional(),
  implementation: z.string().optional(),
});
export type DownloadClientStub = z.infer<typeof DownloadClientStub>;

export const QueueItemStub = z.looseObject({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  status: z.string().optional(),
});
export type QueueItemStub = z.infer<typeof QueueItemStub>;

export const downloadClientsApi = {
  list: () => request('/downloadclient', DownloadClientStub.array()),
  get: (id: number) => request(`/downloadclient/${id}`, DownloadClientStub),
  remove: (id: number) => request(`/downloadclient/${id}`, null, { method: 'DELETE' }),
  queue: () => request('/queue', QueueItemStub.array()),
};
