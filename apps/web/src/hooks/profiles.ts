import { useQuery } from '@tanstack/react-query';
import type {
  CustomFormatInput,
  DelayProfileInput,
  DelayProfileReorderRequest,
  QualityDefinitionLimits,
  QualityProfileInput,
  ReleaseProfileInput,
} from '@media-tron/shared';
import { profilesApi } from '../api/profiles.js';
import { settingsKeys, useInvalidatingMutation } from './settings-keys.js';

export function useQualityProfileList() {
  return useQuery({ queryKey: settingsKeys.qualityProfiles, queryFn: profilesApi.quality.list });
}

export function useQualityProfileSchema() {
  return useQuery({ queryKey: [...settingsKeys.qualityProfiles, 'schema'], queryFn: profilesApi.quality.schema, staleTime: Infinity });
}

export function useSaveQualityProfile() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: QualityProfileInput }) =>
      id ? profilesApi.quality.update(id, body) : profilesApi.quality.create(body),
    [settingsKeys.qualityProfiles],
    { silent: true },
  );
}

/** Silent: the 409 "in use" answer is shown inside the confirm dialog. */
export function useDeleteQualityProfile() {
  return useInvalidatingMutation((id: number) => profilesApi.quality.remove(id), [settingsKeys.qualityProfiles], {
    silent: true,
  });
}

export function useCustomFormatList() {
  return useQuery({ queryKey: settingsKeys.customFormats, queryFn: profilesApi.customFormats.list });
}

export function useCustomFormatSchema() {
  return useQuery({ queryKey: settingsKeys.customFormatSchema, queryFn: profilesApi.customFormats.schema, staleTime: Infinity });
}

export function useSaveCustomFormat() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: CustomFormatInput }) =>
      id ? profilesApi.customFormats.update(id, body) : profilesApi.customFormats.create(body),
    [settingsKeys.customFormats, settingsKeys.qualityProfiles],
    { silent: true },
  );
}

export function useDeleteCustomFormat() {
  return useInvalidatingMutation(
    (id: number) => profilesApi.customFormats.remove(id),
    [settingsKeys.customFormats, settingsKeys.qualityProfiles],
    { silent: true },
  );
}

export function useTestCustomFormat() {
  return useInvalidatingMutation(profilesApi.customFormats.test, [], { silent: true });
}

export function useDelayProfileList() {
  return useQuery({ queryKey: settingsKeys.delayProfiles, queryFn: profilesApi.delay.list });
}

export function useSaveDelayProfile() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: DelayProfileInput }) =>
      id ? profilesApi.delay.update(id, body) : profilesApi.delay.create(body),
    [settingsKeys.delayProfiles],
    { silent: true },
  );
}

export function useDeleteDelayProfile() {
  return useInvalidatingMutation((id: number) => profilesApi.delay.remove(id), [settingsKeys.delayProfiles], {
    errorTitle: 'Could not delete delay profile',
  });
}

export function useReorderDelayProfile() {
  return useInvalidatingMutation((body: DelayProfileReorderRequest) => profilesApi.delay.reorder(body), [settingsKeys.delayProfiles], {
    errorTitle: 'Could not reorder delay profiles',
  });
}

export function useReleaseProfileList() {
  return useQuery({ queryKey: settingsKeys.releaseProfiles, queryFn: profilesApi.release.list });
}

export function useSaveReleaseProfile() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: ReleaseProfileInput }) =>
      id ? profilesApi.release.update(id, body) : profilesApi.release.create(body),
    [settingsKeys.releaseProfiles],
    { silent: true },
  );
}

export function useDeleteReleaseProfile() {
  return useInvalidatingMutation((id: number) => profilesApi.release.remove(id), [settingsKeys.releaseProfiles], {
    errorTitle: 'Could not delete release profile',
  });
}

export function useQualityDefinitions() {
  return useQuery({ queryKey: settingsKeys.qualityDefinitions, queryFn: profilesApi.qualityDefinitions.list });
}

/** Saves several definitions; the route is per quality so they go out in parallel. */
export function useSaveQualityDefinitions() {
  return useInvalidatingMutation(
    (changes: Array<{ qualityId: number; limits: QualityDefinitionLimits }>) =>
      Promise.all(changes.map((c) => profilesApi.qualityDefinitions.update(c.qualityId, c.limits))),
    [settingsKeys.qualityDefinitions],
    { errorTitle: 'Could not save quality definitions' },
  );
}
