import { useQuery } from '@tanstack/react-query';
import type { CollectionsSettings, SmartCollectionInput } from '@arclight/shared';
import { smartCollectionsApi } from '../api/smart-collections.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Rules, previews, Leaving Soon and the sync state under ['smartcollections']; the settings
// under ['settings'] (settings events refresh them).
export const smartCollectionKeys = {
  all: ['smartcollections'] as const,
  list: ['smartcollections', 'list'] as const,
  preview: (body: unknown) => ['smartcollections', 'preview', body] as const,
  leavingSoon: ['smartcollections', 'leavingsoon'] as const,
  sync: ['smartcollections', 'sync'] as const,
  settings: ['settings', 'collections'] as const,
};

export function useSmartCollections() {
  return useQuery({ queryKey: smartCollectionKeys.list, queryFn: smartCollectionsApi.list, retry: false });
}

/** Matching titles for a draft rule; `body` null skips the request (e.g. while invalid). */
export function useSmartCollectionPreview(body: SmartCollectionInput | null, limit = 24) {
  return useQuery({
    queryKey: smartCollectionKeys.preview({ body, limit }),
    queryFn: () => smartCollectionsApi.preview(body!, limit),
    enabled: body !== null,
    retry: false,
    placeholderData: (prev) => prev,
  });
}

export function useLeavingSoon() {
  return useQuery({ queryKey: smartCollectionKeys.leavingSoon, queryFn: smartCollectionsApi.leavingSoon, retry: false });
}

export function useCollectionSyncStatus() {
  return useQuery({ queryKey: smartCollectionKeys.sync, queryFn: smartCollectionsApi.syncStatus, retry: false });
}

/** Create (id null) or replace a rule. Errors render inline in the editor. */
export function useSaveSmartCollection() {
  return useInvalidatingMutation(
    ({ id, body }: { id: number | null; body: SmartCollectionInput }) => (id === null ? smartCollectionsApi.create(body) : smartCollectionsApi.update(id, body)),
    [smartCollectionKeys.all],
    { silent: true },
  );
}

export function useDeleteSmartCollection() {
  return useInvalidatingMutation((id: number) => smartCollectionsApi.remove(id), [smartCollectionKeys.all], { errorTitle: t('smartCollections.couldNotDelete') });
}

export function useSyncCollections() {
  return useInvalidatingMutation(() => smartCollectionsApi.syncNow(), [smartCollectionKeys.all], { errorTitle: t('smartCollections.syncFailed') });
}

export function useCollectionsSettings() {
  return useQuery({ queryKey: smartCollectionKeys.settings, queryFn: smartCollectionsApi.settings, retry: false });
}

export function useSaveCollectionsSettings() {
  return useInvalidatingMutation((body: CollectionsSettings) => smartCollectionsApi.saveSettings(body), [smartCollectionKeys.settings, smartCollectionKeys.leavingSoon]);
}
