import { useQuery } from '@tanstack/react-query';
import type { IndexerCreate, IndexerUpdate } from '@media-tron/shared';
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
