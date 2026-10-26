import {
  DownloadClientImplementationSchema,
  DownloadClientResource,
  DownloadClientTestAllResult,
  DownloadClientTestResult,
  RemotePathMapping,
  type DownloadClientInput,
  type DownloadClientTestRequest,
  type RemotePathMappingInput,
} from '@media-tron/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/download-clients/routes.ts. The queue lives in queue.ts.

export const downloadClientsApi = {
  list: () => request('/downloadclient', DownloadClientResource.array()),
  get: (id: number) => request(`/downloadclient/${id}`, DownloadClientResource),
  schema: () => request('/downloadclient/schema', DownloadClientImplementationSchema.array()),
  create: (body: DownloadClientInput) => request('/downloadclient', DownloadClientResource, { method: 'POST', json: body }),
  update: (id: number, body: DownloadClientInput) =>
    request(`/downloadclient/${id}`, DownloadClientResource, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/downloadclient/${id}`, null, { method: 'DELETE' }),
  test: (body: DownloadClientTestRequest) =>
    request('/downloadclient/test', DownloadClientTestResult, { method: 'POST', json: body }),
  testAll: () => request('/downloadclient/testall', DownloadClientTestAllResult, { method: 'POST' }),
};

export const remotePathMappingsApi = {
  list: () => request('/remotepathmapping', RemotePathMapping.array()),
  create: (body: RemotePathMappingInput) =>
    request('/remotepathmapping', RemotePathMapping, { method: 'POST', json: body }),
  update: (id: number, body: RemotePathMappingInput) =>
    request(`/remotepathmapping/${id}`, RemotePathMapping, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/remotepathmapping/${id}`, null, { method: 'DELETE' }),
};
