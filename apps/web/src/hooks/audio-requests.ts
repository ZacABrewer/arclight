import { useQuery, type QueryKey } from '@tanstack/react-query';
import type { AudibleRegion, AudioRequestDefaults, AudioRequestListQuery, CreateAudioRequest } from '@arclight/shared';
import { audioDiscoverApi, audioRequestDefaultsApi, audioRequestsApi, type AudioDomain } from '../api/audio-requests.js';
import { useFeatures } from './music.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Music and audiobook requests and their Discover pages. Keys sit under the request and
// discover families (hooks/request-keys.ts), so live `request` events and every request
// mutation refresh them too.

export const audioKeys = {
  requests: {
    all: ['requests', 'audio'] as const,
    list: (query: AudioRequestListQuery) => ['requests', 'audio', 'list', query] as const,
    count: ['requests', 'audio', 'count'] as const,
    defaults: ['requests', 'audio', 'defaults'] as const,
  },
  discover: {
    all: ['discover', 'audio'] as const,
    home: (domain: AudioDomain) => ['discover', 'audio', 'home', domain] as const,
    search: (domain: AudioDomain, query: string) => ['discover', 'audio', 'search', domain, query] as const,
    // Detail pages show request status, so they live under ['discover', 'title'] like TMDB titles.
    detail: (kind: string, id: string, region?: string | null) => ['discover', 'title', 'audio', kind, id, region ?? null] as const,
  },
};

/** Everything an audio request change can move: lists, counts, card and page badges. */
const AUDIO_AFFECTS: readonly QueryKey[] = [audioKeys.requests.all, audioKeys.discover.all, ['discover', 'title', 'audio']];

/** Whether the feature flag of a domain is on (false while the flags load). */
export function useAudioFeature(domain: AudioDomain): { enabled: boolean; ready: boolean } {
  const features = useFeatures();
  return { enabled: domain === 'music' ? features.music : features.audiobooks, ready: features.ready };
}

export function useAudioDiscoverHome(domain: AudioDomain, enabled = true) {
  return useQuery({ queryKey: audioKeys.discover.home(domain), queryFn: () => audioDiscoverApi.home(domain), enabled, staleTime: 60_000 });
}

export function useAudioDiscoverSearch(domain: AudioDomain, query: string, enabled = true) {
  return useQuery({
    queryKey: audioKeys.discover.search(domain, query),
    queryFn: () => audioDiscoverApi.search(domain, query),
    enabled: enabled && query.length > 0,
    staleTime: 60_000,
  });
}

export function useAudioAlbum(mbid: string, enabled = true) {
  return useQuery({ queryKey: audioKeys.discover.detail('album', mbid), queryFn: () => audioDiscoverApi.album(mbid), enabled: enabled && mbid !== '' });
}

export function useAudioArtist(mbid: string, enabled = true) {
  return useQuery({ queryKey: audioKeys.discover.detail('artist', mbid), queryFn: () => audioDiscoverApi.artist(mbid), enabled: enabled && mbid !== '' });
}

export function useAudioBook(asin: string, region: AudibleRegion | undefined, enabled = true) {
  return useQuery({ queryKey: audioKeys.discover.detail('book', asin, region), queryFn: () => audioDiscoverApi.book(asin, region), enabled: enabled && asin !== '' });
}

export function useAudioAuthor(asin: string, region: AudibleRegion | undefined, enabled = true) {
  return useQuery({ queryKey: audioKeys.discover.detail('author', asin, region), queryFn: () => audioDiscoverApi.author(asin, region), enabled: enabled && asin !== '' });
}

export function useAudioRequests(query: AudioRequestListQuery, enabled = true) {
  return useQuery({ queryKey: audioKeys.requests.list(query), queryFn: () => audioRequestsApi.list(query), enabled });
}

export function useAudioRequestCount(enabled = true) {
  return useQuery({ queryKey: audioKeys.requests.count, queryFn: audioRequestsApi.count, enabled, retry: false });
}

export function useCreateAudioRequest() {
  return useInvalidatingMutation((body: CreateAudioRequest) => audioRequestsApi.create(body), AUDIO_AFFECTS, { errorTitle: t('hooks.audioRequests.couldNotRequest') });
}

export function useApproveAudioRequest() {
  return useInvalidatingMutation((id: number) => audioRequestsApi.approve(id), AUDIO_AFFECTS, { errorTitle: t('hooks.requests.couldNotApproveTheRequest') });
}

export function useDeclineAudioRequest() {
  return useInvalidatingMutation(({ id, reason }: { id: number; reason?: string }) => audioRequestsApi.decline(id, reason), AUDIO_AFFECTS, {
    errorTitle: t('hooks.requests.couldNotDeclineTheRequest'),
  });
}

export function useRetryAudioRequest() {
  return useInvalidatingMutation((id: number) => audioRequestsApi.retry(id), AUDIO_AFFECTS, { errorTitle: t('hooks.requests.retryFailed') });
}

export function useDeleteAudioRequest() {
  return useInvalidatingMutation((id: number) => audioRequestsApi.remove(id), AUDIO_AFFECTS, { errorTitle: t('hooks.requests.couldNotDeleteTheRequest') });
}

/** Default root folder and quality profile for new music and audiobook requests. */
export function useAudioRequestDefaults(enabled = true) {
  return useQuery({ queryKey: audioKeys.requests.defaults, queryFn: audioRequestDefaultsApi.get, staleTime: 60_000, enabled });
}

export function useSaveAudioRequestDefaults() {
  return useInvalidatingMutation((body: AudioRequestDefaults) => audioRequestDefaultsApi.update(body), [audioKeys.requests.defaults], { silent: true });
}
