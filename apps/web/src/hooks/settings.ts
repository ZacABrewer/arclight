import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AddRootFolderRequest, MetadataSettingsUpdate, NamingConfigInput } from '@media-tron/shared';
import { libraryApi } from '../api/library.js';
import { namingApi } from '../api/naming.js';
import { notificationsApi, type NotificationInput } from '../api/notifications.js';
import { settingsApi, type MediaManagementSettings } from '../api/settings.js';
import { libraryKeys } from './library-keys.js';
import { settingsKeys, useInvalidatingMutation } from './settings-keys.js';

export function useMetadataSettings() {
  return useQuery({ queryKey: settingsKeys.metadata, queryFn: settingsApi.metadata.get });
}

export function useSaveMetadataSettings() {
  return useInvalidatingMutation((body: MetadataSettingsUpdate) => settingsApi.metadata.update(body), [settingsKeys.metadata], {
    errorTitle: 'Could not save metadata settings',
  });
}

/** Pending api route: no retry, so a 404 surfaces at once and the page falls back to defaults. */
export function useMediaManagementSettings() {
  return useQuery({ queryKey: settingsKeys.mediaManagement, queryFn: settingsApi.mediaManagement.get, retry: false });
}

export function useSaveMediaManagementSettings() {
  return useInvalidatingMutation(
    (body: MediaManagementSettings) => settingsApi.mediaManagement.update(body),
    [settingsKeys.mediaManagement],
    { errorTitle: 'Could not save media management settings' },
  );
}

export function useNamingConfig() {
  return useQuery({ queryKey: settingsKeys.naming, queryFn: namingApi.get, retry: false });
}

export function useSaveNamingConfig() {
  return useInvalidatingMutation((body: NamingConfigInput) => namingApi.update(body), [settingsKeys.naming], {
    errorTitle: 'Could not save naming settings',
  });
}

/** Live preview of the draft; the caller debounces `draft`. */
export function useNamingSamples(draft: NamingConfigInput | undefined) {
  return useQuery({
    queryKey: settingsKeys.namingSamples(draft),
    queryFn: () => namingApi.samples(draft),
    enabled: draft !== undefined,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useAddRootFolder() {
  return useInvalidatingMutation((body: AddRootFolderRequest) => libraryApi.rootFolders.add(body), [libraryKeys.library.rootFolders], {
    silent: true,
  });
}

export function useDeleteRootFolder() {
  return useInvalidatingMutation((id: number) => libraryApi.rootFolders.remove(id), [libraryKeys.library.rootFolders], {
    errorTitle: 'Could not remove root folder',
  });
}

export function useNotificationList() {
  return useQuery({ queryKey: settingsKeys.notifications, queryFn: notificationsApi.list, retry: false });
}

export function useNotificationSchema() {
  return useQuery({ queryKey: settingsKeys.notificationSchema, queryFn: notificationsApi.schema, retry: false, staleTime: Infinity });
}

export function useSaveNotification() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: NotificationInput }) =>
      id ? notificationsApi.update(id, body) : notificationsApi.create(body),
    [settingsKeys.notifications],
    { silent: true },
  );
}

export function useDeleteNotification() {
  return useInvalidatingMutation((id: number) => notificationsApi.remove(id), [settingsKeys.notifications], {
    errorTitle: 'Could not delete connection',
  });
}
