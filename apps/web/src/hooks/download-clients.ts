import { useQuery } from '@tanstack/react-query';
import type { DownloadClientInput, RemotePathMappingInput } from '@arclight/shared';
import { downloadClientsApi, remotePathMappingsApi } from '../api/download-clients.js';
import { settingsKeys, useInvalidatingMutation } from './settings-keys.js';

export function useDownloadClientList() {
  return useQuery({ queryKey: settingsKeys.downloadClients, queryFn: downloadClientsApi.list });
}

export function useDownloadClientSchema() {
  return useQuery({ queryKey: settingsKeys.downloadClientSchema, queryFn: downloadClientsApi.schema, staleTime: Infinity });
}

export function useSaveDownloadClient() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: DownloadClientInput }) =>
      id ? downloadClientsApi.update(id, body) : downloadClientsApi.create(body),
    [settingsKeys.downloadClients],
    { silent: true },
  );
}

export function useDeleteDownloadClient() {
  return useInvalidatingMutation((id: number) => downloadClientsApi.remove(id), [settingsKeys.downloadClients], {
    errorTitle: 'Could not delete download client',
  });
}

export function useTestAllDownloadClients() {
  return useInvalidatingMutation(() => downloadClientsApi.testAll(), [], { errorTitle: 'Test all failed' });
}

export function useRemotePathMappings() {
  return useQuery({ queryKey: settingsKeys.remotePathMappings, queryFn: remotePathMappingsApi.list });
}

export function useSaveRemotePathMapping() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: RemotePathMappingInput }) =>
      id ? remotePathMappingsApi.update(id, body) : remotePathMappingsApi.create(body),
    [settingsKeys.remotePathMappings],
    { silent: true },
  );
}

export function useDeleteRemotePathMapping() {
  return useInvalidatingMutation((id: number) => remotePathMappingsApi.remove(id), [settingsKeys.remotePathMappings], {
    errorTitle: 'Could not delete mapping',
  });
}
