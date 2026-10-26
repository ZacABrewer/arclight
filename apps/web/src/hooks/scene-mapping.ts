import { useQuery } from '@tanstack/react-query';
import type { SceneMappingInput } from '@arclight/shared';
import { sceneMappingApi } from '../api/scene-mapping.js';
import { feedKeys } from './guides.js';
import { libraryKeys } from './library-keys.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Scene numbering rules of a series, plus the community feed status.
export const sceneMappingKeys = {
  series: (seriesId: number) => ['series', 'detail', seriesId, 'scenemapping'] as const,
  feed: ['feeds', 'scenemapping'] as const,
};

export function useSceneMappings(seriesId: number) {
  return useQuery({ queryKey: sceneMappingKeys.series(seriesId), queryFn: () => sceneMappingApi.list(seriesId), retry: false });
}

export interface SaveSceneMappingVars {
  /** Undefined creates a new manual rule. */
  mappingId?: number | undefined;
  body: SceneMappingInput;
}

export function useSaveSceneMapping(seriesId: number) {
  return useInvalidatingMutation(
    ({ mappingId, body }: SaveSceneMappingVars) =>
      mappingId === undefined ? sceneMappingApi.create(seriesId, body) : sceneMappingApi.update(seriesId, mappingId, body),
    [sceneMappingKeys.series(seriesId)],
    // The dialog shows the error inline.
    { silent: true },
  );
}

export function useDeleteSceneMapping(seriesId: number) {
  return useInvalidatingMutation((mappingId: number) => sceneMappingApi.remove(seriesId, mappingId), [sceneMappingKeys.series(seriesId)], {
    errorTitle: t('hooks.sceneMapping.couldNotDeleteRule'),
  });
}

/** Re-map the series's files: episodes, files and history change. */
export function useApplySceneMappings(seriesId: number) {
  return useInvalidatingMutation(() => sceneMappingApi.apply(seriesId), [libraryKeys.series.detail(seriesId), ['history']], {
    errorTitle: t('hooks.sceneMapping.couldNotApplyRules'),
  });
}

export function useSceneMappingFeed() {
  return useQuery({ queryKey: sceneMappingKeys.feed, queryFn: sceneMappingApi.feed.status, retry: false });
}

export function useSyncSceneMappingFeed() {
  return useInvalidatingMutation(() => sceneMappingApi.feed.sync(), [feedKeys.all, ['series']], {
    errorTitle: t('hooks.sceneMapping.couldNotSyncTheFeed'),
  });
}
