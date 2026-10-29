import { useQuery } from '@tanstack/react-query';
import type { CommunityCatalogueSettings, DefinitionFeedSettings, IndexerCreate, IndexerDefinitionListQuery, IndexerGlobalSettings, IndexerProxyCreate, IndexerUpdate } from '@arclight/shared';
import { indexersApi } from '../api/indexers.js';
import { settingsKeys, useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

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
    options.silent ? { silent: true } : { errorTitle: t('hooks.indexers.couldNotUpdateIndexer') },
  );
}

export function useDeleteIndexer() {
  return useInvalidatingMutation((id: number) => indexersApi.remove(id), [settingsKeys.indexers], {
    errorTitle: t('hooks.indexers.couldNotDeleteIndexer'),
  });
}

export function useTestAllIndexers() {
  return useInvalidatingMutation(() => indexersApi.testAll(), [settingsKeys.indexers], { errorTitle: t('hooks.indexers.testAllFailed') });
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
    errorTitle: t('hooks.indexers.couldNotReloadDefinitions'),
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
    errorTitle: t('hooks.indexers.couldNotDeleteProxy'),
  });
}

export function useIndexerStats(days: number) {
  return useQuery({ queryKey: settingsKeys.indexerStats(days), queryFn: () => indexersApi.stats(days) });
}

export function useIndexerHealth(days: number) {
  return useQuery({ queryKey: settingsKeys.indexerHealth(days), queryFn: () => indexersApi.health(days) });
}

export function useIndexerOptions() {
  return useQuery({ queryKey: settingsKeys.indexerOptions, queryFn: indexersApi.settings.get });
}

export function useSaveIndexerOptions() {
  return useInvalidatingMutation((body: IndexerGlobalSettings) => indexersApi.settings.save(body), [settingsKeys.indexerOptions], {
    errorTitle: t('hooks.indexers.couldNotSaveIndexerOptions'),
  });
}

// ---- definition feed -------------------------------------------------------------------

export const definitionFeedKeys = {
  status: ['indexers', 'definitionfeed', 'status'] as const,
  settings: ['settings', 'indexers', 'definitionfeed'] as const,
};

export function useDefinitionFeedStatus() {
  return useQuery({ queryKey: definitionFeedKeys.status, queryFn: indexersApi.definitions.feed.status, retry: false });
}

export function useDefinitionFeedSettings() {
  return useQuery({ queryKey: definitionFeedKeys.settings, queryFn: indexersApi.definitions.feed.settings.get, retry: false });
}

export function useSaveDefinitionFeedSettings() {
  return useInvalidatingMutation(
    (body: DefinitionFeedSettings) => indexersApi.definitions.feed.settings.save(body),
    [definitionFeedKeys.settings, definitionFeedKeys.status, ['feeds']],
    { errorTitle: t('hooks.indexers.couldNotSaveDefinitionFeed') },
  );
}

export function useSyncDefinitionFeed() {
  return useInvalidatingMutation(() => indexersApi.definitions.feed.sync(), [definitionFeedKeys.status, ['indexers', 'definitions'], ['feeds']], {
    errorTitle: t('hooks.indexers.definitionFeedSyncFailed'),
  });
}

export function useRollbackDefinition() {
  return useInvalidatingMutation((id: string) => indexersApi.definitions.feed.rollback(id), [definitionFeedKeys.status, ['indexers', 'definitions']], {
    errorTitle: t('hooks.indexers.couldNotRollBackThe'),
  });
}

// ---- add-indexer catalogue and the community catalogue -------------------------------

export function useIndexerCatalogue(enabled = true) {
  return useQuery({ queryKey: settingsKeys.indexerCatalogue, queryFn: indexersApi.catalogue.list, staleTime: 60_000, enabled });
}

export function useCatalogueEntry(key: string | undefined) {
  return useQuery({
    queryKey: settingsKeys.indexerCatalogueEntry(key ?? ''),
    queryFn: () => indexersApi.catalogue.entry(key!),
    enabled: !!key,
    staleTime: 60_000,
  });
}

export function useCommunityCatalogueStatus() {
  return useQuery({ queryKey: settingsKeys.communityCatalogue, queryFn: indexersApi.catalogue.community.status, retry: false });
}

export function useSyncCommunityCatalogue() {
  return useInvalidatingMutation(() => indexersApi.catalogue.community.sync(), [['indexers', 'definitions'], ['feeds']], {
    errorTitle: t('hooks.indexers.communityCatalogueSyncFailed'),
  });
}

export function useRollbackCommunityCatalogue() {
  return useInvalidatingMutation(() => indexersApi.catalogue.community.rollback(), [['indexers', 'definitions'], ['feeds']], {
    errorTitle: t('hooks.indexers.couldNotRollBackCommunityCatalogue'),
  });
}

export function useSaveCommunityCatalogueSettings() {
  return useInvalidatingMutation(
    (body: CommunityCatalogueSettings) => indexersApi.catalogue.community.settings.save(body),
    [['indexers', 'definitions'], ['feeds']],
    { errorTitle: t('hooks.indexers.couldNotSaveCommunityCatalogue') },
  );
}
