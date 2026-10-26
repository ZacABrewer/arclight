import { useQuery } from '@tanstack/react-query';
import type { ImportListCreateInput, ImportListExclusionCreate, ImportListSettings, MediaType } from '@arclight/shared';
import { importListsApi } from '../api/import-lists.js';
import { useInvalidatingMutation } from './settings-keys.js';

// Keys live under ['settings', 'importlists'] so a settings event from the live socket refetches
// them; found-in chips sit under the same root so a sync refreshes them too.
export const importListKeys = {
  all: ['settings', 'importlists'] as const,
  list: ['settings', 'importlists', 'list'] as const,
  schema: ['settings', 'importlists', 'schema'] as const,
  items: (id: number) => ['settings', 'importlists', 'items', id] as const,
  allItems: ['settings', 'importlists', 'items', 'all'] as const,
  foundIn: (mediaType: MediaType, tmdbId: number) => ['settings', 'importlists', 'found', mediaType, tmdbId] as const,
  exclusions: ['settings', 'importlists', 'exclusions'] as const,
  settings: ['settings', 'importlists', 'settings'] as const,
};

export function useImportLists() {
  return useQuery({ queryKey: importListKeys.list, queryFn: importListsApi.list, retry: false });
}

export function useImportListSchema() {
  return useQuery({ queryKey: importListKeys.schema, queryFn: importListsApi.schema, retry: false, staleTime: Infinity });
}

/** Every fetched item across lists (cards derive their item counts from it). */
export function useAllImportListItems() {
  return useQuery({ queryKey: importListKeys.allItems, queryFn: () => importListsApi.foundIn(), retry: false });
}

export function useImportListItems(id: number | null) {
  return useQuery({
    queryKey: importListKeys.items(id ?? 0),
    queryFn: () => importListsApi.items(id ?? 0),
    enabled: id !== null,
    retry: false,
  });
}

export function useFoundInLists(mediaType: MediaType, tmdbId: number | undefined) {
  return useQuery({
    queryKey: importListKeys.foundIn(mediaType, tmdbId ?? 0),
    queryFn: () => importListsApi.foundIn({ mediaType, tmdbId: tmdbId ?? 0 }),
    enabled: tmdbId !== undefined && tmdbId > 0,
    retry: false,
    staleTime: 60_000,
  });
}

export function useSaveImportList() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: ImportListCreateInput }) =>
      id ? importListsApi.update(id, body) : importListsApi.create(body),
    [importListKeys.list],
    { silent: true },
  );
}

export function useDeleteImportList() {
  return useInvalidatingMutation((id: number) => importListsApi.remove(id), [importListKeys.all], {
    errorTitle: 'Could not delete import list',
  });
}

export function useSyncImportLists() {
  return useInvalidatingMutation(() => importListsApi.sync(), [importListKeys.all], { errorTitle: 'Sync failed' });
}

export function useImportListExclusions() {
  return useQuery({ queryKey: importListKeys.exclusions, queryFn: importListsApi.exclusions.list, retry: false });
}

export function useAddImportListExclusion() {
  return useInvalidatingMutation(
    (body: ImportListExclusionCreate) => importListsApi.exclusions.create(body),
    [importListKeys.exclusions, importListKeys.allItems],
    { silent: true },
  );
}

export function useDeleteImportListExclusion() {
  return useInvalidatingMutation((id: number) => importListsApi.exclusions.remove(id), [importListKeys.exclusions], {
    errorTitle: 'Could not remove exclusion',
  });
}

export function useImportListSettings() {
  return useQuery({ queryKey: importListKeys.settings, queryFn: importListsApi.settings.get, retry: false });
}

export function useSaveImportListSettings() {
  return useInvalidatingMutation((body: ImportListSettings) => importListsApi.settings.update(body), [importListKeys.settings], {
    errorTitle: 'Could not save import list settings',
  });
}
