import { useQuery } from '@tanstack/react-query';
import type { GuidesSettings } from '@arclight/shared';
import { feedsApi } from '../api/feeds.js';
import { guidesApi } from '../api/guides.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Guides sync (Settings → Guides) and the feeds registry (System → Feeds). ['settings'] is
// refetched by live.ts on settings events.
export const guidesKeys = {
  all: ['guides'] as const,
  status: ['guides', 'status'] as const,
  diff: ['guides', 'diff'] as const,
  profiles: ['guides', 'profiles'] as const,
  settings: ['settings', 'guides'] as const,
};

export const feedKeys = { all: ['feeds'] as const };

export function useGuidesSettings() {
  return useQuery({ queryKey: guidesKeys.settings, queryFn: guidesApi.settings.get, retry: false });
}

export function useGuidesStatus() {
  return useQuery({ queryKey: guidesKeys.status, queryFn: guidesApi.status, retry: false });
}

export function useGuidesDiff() {
  return useQuery({ queryKey: guidesKeys.diff, queryFn: guidesApi.diff, retry: false });
}

export function useGuideProfiles(enabled = true) {
  return useQuery({ queryKey: guidesKeys.profiles, queryFn: () => guidesApi.profiles(), retry: false, enabled, staleTime: 60_000 });
}

export function useSaveGuidesSettings() {
  return useInvalidatingMutation((body: GuidesSettings) => guidesApi.settings.save(body), [guidesKeys.settings, guidesKeys.all, feedKeys.all], {
    errorTitle: t('hooks.guides.couldNotSaveGuideSettings'),
  });
}

export function useSyncGuides() {
  return useInvalidatingMutation(() => guidesApi.sync(), [guidesKeys.all, feedKeys.all, ['settings', 'customformats'], ['settings', 'qualityprofiles']], {
    errorTitle: t('hooks.guides.guideSyncFailed'),
  });
}

export function useApplyGuides() {
  return useInvalidatingMutation((ids: readonly string[] | undefined) => guidesApi.apply(ids), [guidesKeys.all, feedKeys.all, ['settings', 'customformats'], ['settings', 'qualityprofiles']], {
    errorTitle: t('hooks.guides.couldNotApplyGuideChanges'),
  });
}

export function useFeeds() {
  return useQuery({ queryKey: feedKeys.all, queryFn: feedsApi.list, retry: false, refetchInterval: 60_000 });
}
