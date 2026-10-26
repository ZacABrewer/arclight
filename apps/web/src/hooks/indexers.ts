import { useQuery } from '@tanstack/react-query';
import type { IndexerCreate, IndexerDefinitionListQuery, IndexerGlobalSettings, IndexerProxyCreate, IndexerUpdate } from '@media-tron/shared';
import { indexersApi } from '../api/indexers.js';
import { settingsKeys, useInvalidatingMutation } from './settings-keys.js';

export function useIndexerList() {
  return useQuery({ queryKey: settingsKeys.indexers, queryFn: indexersApi.list });
}

export function useIndexerTemplates() {
  return useQuery({ queryKey: settingsKeys.indexerSchema, queryFn: indexersApi.schema, staleTime: Infinity });
}

export function useIndexerCategories() {
  return useQuery({ queryKey: settingsKeys.indexerCategories, queryFn: indexersApi.categories, staleTime: Infinity });
}

export function useCreateIndexer() {
  return useInvalidatingMutation((body: IndexerCreate) => indexersApi.create(body), [settingsKeys.indexers], { silent: true });
}

export function useUpdateIndexer(options: { silent?: boolean } = {}) {
  return useInvalidatingMutation(
    ({ id, body }: { id: number; body: IndexerUpdate }) => indexersApi.update(id, body),
    [settingsKeys.indexers],
    options.silent ? { silent: true } : { errorTitle: 'Could not update indexer' },
  );
}

export function useDeleteIndexer() {
  return useInvalidatingMutation((id: number) => indexersApi.remove(id), [settingsKeys.indexers], {
    errorTitle: 'Could not delete indexer',
  });
}

export function useTestAllIndexers() {
  return useInvalidatingMutation(() => indexersApi.testAll(), [settingsKeys.indexers], { errorTitle: 'Test all failed' });
}

// ---- definitions catalogue, proxies, stats, global options -------------------------

export function useIndexerDefinitions(query: Partial<IndexerDefinitionListQuery> = {}) {
  return useQuery({ queryKey: settingsKeys.indexerDefinitions(query), queryFn: () => indexersApi.definitions.list(query), staleTime: 60_000 });
}

export function useIndexerDefinition(id: string | undefined) {
  return useQuery({
    queryKey: settingsKeys.indexerDefinition(id ?? ''),
    queryFn: () => indexersApi.definitions.get(id!),
    enabled: !!id,
    staleTime: 60_000,
  });
}

export function useReloadDefinitions() {
  return useInvalidatingMutation(() => indexersApi.definitions.reload(), [['indexers', 'definitions']], {
    errorTitle: 'Could not reload definitions',
  });
}

export function useUploadDefinition() {
  return useInvalidatingMutation((yaml: string) => indexersApi.definitions.upload(yaml), [['indexers', 'definitions']], { silent: true });
}

export function useIndexerProxies() {
  return useQuery({ queryKey: settingsKeys.indexerProxies, queryFn: indexersApi.proxies.list });
}

export function useSaveIndexerProxy() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: IndexerProxyCreate }) =>
      id === undefined ? indexersApi.proxies.create(body) : indexersApi.proxies.update(id, body),
    [settingsKeys.indexerProxies, settingsKeys.indexers],
    { silent: true },
  );
}

export function useDeleteIndexerProxy() {
  return useInvalidatingMutation((id: number) => indexersApi.proxies.remove(id), [settingsKeys.indexerProxies, settingsKeys.indexers], {
    errorTitle: 'Could not delete proxy',
  });
}

export function useIndexerStats(days: number) {
  return useQuery({ queryKey: settingsKeys.indexerStats(days), queryFn: () => indexersApi.stats(days) });
}

export function useIndexerOptions() {
  return useQuery({ queryKey: settingsKeys.indexerOptions, queryFn: indexersApi.settings.get });
}

export function useSaveIndexerOptions() {
  return useInvalidatingMutation((body: IndexerGlobalSettings) => indexersApi.settings.save(body), [settingsKeys.indexerOptions], {
    errorTitle: 'Could not save indexer options',
  });
}
