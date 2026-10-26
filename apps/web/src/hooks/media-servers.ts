import { useQuery } from '@tanstack/react-query';
import type { MediaServerInputRaw, MediaServerSettings } from '@arclight/shared';
import { mediaServersApi, signInServerApi } from '../api/media-servers.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Media servers live under ['settings'] so a settings event refreshes them.
export const mediaServerKeys = {
  list: ['settings', 'mediaservers'] as const,
  users: (id: string) => ['settings', 'mediaservers', id, 'users'] as const,
  signIn: ['settings', 'mediaserver'] as const,
  importable: ['settings', 'mediaserver', 'importable'] as const,
};

export function useMediaServers() {
  return useQuery({ queryKey: mediaServerKeys.list, queryFn: mediaServersApi.list, retry: false });
}

export function useSaveMediaServer() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: string | undefined; body: MediaServerInputRaw }) => (id ? mediaServersApi.update(id, body) : mediaServersApi.create(body)),
    [mediaServerKeys.list, mediaServerKeys.signIn],
    { silent: true },
  );
}

export function useDeleteMediaServer() {
  return useInvalidatingMutation((id: string) => mediaServersApi.remove(id), [mediaServerKeys.list, mediaServerKeys.signIn], {
    errorTitle: t('hooks.mediaServers.couldNotDeleteTheMedia'),
  });
}

export function useMediaServerAccounts(id: string | null) {
  return useQuery({ queryKey: mediaServerKeys.users(id ?? ''), queryFn: () => mediaServersApi.users(id ?? ''), enabled: id !== null, retry: false });
}

export function useSignInServer(enabled = true) {
  return useQuery({ queryKey: mediaServerKeys.signIn, queryFn: signInServerApi.get, retry: false, enabled });
}

export function useSaveSignInServer() {
  return useInvalidatingMutation((body: MediaServerSettings) => signInServerApi.update(body), [mediaServerKeys.signIn, mediaServerKeys.list], {
    silent: true,
  });
}

export function useImportableUsers(enabled: boolean) {
  return useQuery({ queryKey: mediaServerKeys.importable, queryFn: signInServerApi.importable, enabled, retry: false });
}
