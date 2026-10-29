import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AddArtistRequestInput,
  Album,
  AlbumDetails,
  AlbumTypeProfileInput,
  Artist,
  ArtistDetails,
  AudioImportSettings,
  BulkArtistUpdateRequest,
  FeatureSettings,
  MusicCommandName,
  MusicMetadataSettingsUpdate,
  UpdateAlbumRequest,
  UpdateArtistRequest,
} from '@arclight/shared';
import type { DeleteMediaOptions } from '../api/library.js';
import { ApiError } from '../api/client.js';
import { musicApi } from '../api/music.js';
import { publicPortalApi } from '../api/requests.js';
import { profilesApi } from '../api/profiles.js';
import { useToast } from '../components/toast.js';
import { upsertJob } from '../live.js';
import { patchQueries } from './library.js';
import { libraryKeys } from './library-keys.js';
import { musicKeys } from './music-keys.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// ---------------------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------------------

export const FEATURES_OFF: FeatureSettings = { music: false, audiobooks: false };

/**
 * GET /settings/features. Off until the answer arrives, and off when it fails (an older api,
 * or a person who may not read settings), so music never shows by accident.
 */
export function useFeatureSettings() {
  return useQuery({ queryKey: musicKeys.features, queryFn: loadFeatures, retry: false, staleTime: 60_000 });
}

/** Signed out (portal visitors), the flags come from the public portal answer instead. */
async function loadFeatures(): Promise<FeatureSettings> {
  try {
    return await musicApi.settings.features.get();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    return (await publicPortalApi.get()).features ?? FEATURES_OFF;
  }
}

/** The flags as plain values (`FEATURES_OFF` while loading or on error). */
export function useFeatures(): FeatureSettings & { ready: boolean } {
  const q = useFeatureSettings();
  return { ...(q.data ?? FEATURES_OFF), ready: !q.isPending };
}

export function useSaveFeatures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FeatureSettings) => musicApi.settings.features.update(body),
    meta: { errorTitle: t('music.settings.couldNotSaveFeatures') },
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: musicKeys.features });
      const before = qc.getQueryData<FeatureSettings>(musicKeys.features);
      qc.setQueryData(musicKeys.features, body);
      return before;
    },
    onError: (_e, _v, before) => qc.setQueryData(musicKeys.features, before),
    onSuccess: (saved) => qc.setQueryData(musicKeys.features, saved),
  });
}

// ---------------------------------------------------------------------------------------
// Artists and albums
// ---------------------------------------------------------------------------------------

export function useArtistList(enabled = true) {
  return useQuery({ queryKey: musicKeys.artists.list(), queryFn: musicApi.artists.list, enabled });
}

/**
 * An artist just added has no albums until the ArtistAdd job has read MusicBrainz: true while
 * the artist was never refreshed and has no albums yet.
 */
export function isLoadingAlbums(a: Pick<ArtistDetails, 'albums' | 'lastRefreshed'> | undefined): boolean {
  return a !== undefined && a.albums.length === 0 && !a.lastRefreshed;
}

/** How often the details page polls while albums are still loading. */
export const LOADING_ALBUMS_POLL_MS = 3_000;

export function useArtist(id: number) {
  return useQuery({
    queryKey: musicKeys.artists.detail(id),
    queryFn: () => musicApi.artists.get(id),
    enabled: Number.isInteger(id) && id > 0,
    // Albums arrive through a background job: poll until they are there (a finished job also
    // invalidates ['music'] through live.ts).
    refetchInterval: (query) => (isLoadingAlbums(query.state.data) ? LOADING_ALBUMS_POLL_MS : false),
  });
}

export function useAlbum(id: number) {
  return useQuery({
    queryKey: musicKeys.albums.detail(id),
    queryFn: () => musicApi.albums.get(id),
    enabled: Number.isInteger(id) && id > 0,
  });
}

/** GET /album?artistId=: the artist's albums without tracks (cheap title lookups). */
export function useArtistAlbums(artistId: number | null | undefined, enabled = true) {
  return useQuery({
    queryKey: musicKeys.albums.list(artistId ?? 0),
    queryFn: () => musicApi.albums.list(artistId!),
    enabled: enabled && artistId != null && artistId > 0,
    staleTime: 60_000,
  });
}

export function useArtistLookup(term: string) {
  const trimmed = term.trim();
  return useQuery({
    queryKey: musicKeys.lookup(trimmed),
    queryFn: () => musicApi.artists.lookup(trimmed),
    enabled: trimmed.length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useMusicQualityProfiles(enabled = true) {
  return useQuery({ queryKey: musicKeys.qualityProfiles, queryFn: () => profilesApi.quality.list('music'), staleTime: 60_000, enabled });
}

export function useAlbumTypeProfiles(enabled = true) {
  return useQuery({ queryKey: musicKeys.albumTypeProfiles, queryFn: musicApi.albumTypeProfiles.list, staleTime: 60_000, enabled });
}

export function useWantedAlbums(mode: 'missing' | 'cutoff', page: number, pageSize = 50, enabled = true) {
  return useQuery({
    enabled,
    queryKey: musicKeys.wanted(mode, page, pageSize),
    queryFn: () => (mode === 'missing' ? musicApi.wanted.missing({ page, pageSize }) : musicApi.wanted.cutoff({ page, pageSize })),
    placeholderData: keepPreviousData,
  });
}

function storeArtist(qc: QueryClient, artist: Artist) {
  // The details entry keeps its albums; the list entry is replaced.
  qc.setQueryData<ArtistDetails>(musicKeys.artists.detail(artist.id), (prev) => (prev ? { ...prev, ...artist, albums: prev.albums } : prev));
  qc.setQueryData<Artist[]>(musicKeys.artists.list(), (prev) => prev?.map((a) => (a.id === artist.id ? artist : a)));
}

export function useAddArtist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddArtistRequestInput) => musicApi.artists.add(body),
    meta: { silent: true },
    onSuccess: (artist) => {
      // Seed the details page: the albums arrive later (ArtistAdd job), polled by useArtist.
      qc.setQueryData<ArtistDetails>(musicKeys.artists.detail(artist.id), { ...artist, albums: [] });
      void qc.invalidateQueries({ queryKey: musicKeys.artists.list() });
      void qc.invalidateQueries({ queryKey: ['musicLookup'] });
    },
  });
}

export function useSetArtistMonitored() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, monitored }: { id: number; monitored: boolean }) => musicApi.artists.update(id, { monitored }),
    meta: { errorTitle: t('hooks.library.couldNotChangeMonitoring') },
    onMutate: async ({ id, monitored }) => {
      const a = await patchQueries<ArtistDetails>(qc, musicKeys.artists.detail(id), (x) => ({ ...x, monitored }));
      const b = await patchQueries<Artist[]>(qc, musicKeys.artists.list(), (list) => list.map((x) => (x.id === id ? { ...x, monitored } : x)));
      return [...a, ...b];
    },
    onError: (_e, _v, snapshot) => {
      for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
    },
    onSuccess: (artist) => storeArtist(qc, artist),
  });
}

export function useUpdateArtist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateArtistRequest }) => musicApi.artists.update(id, body),
    meta: { errorTitle: t('music.hooks.couldNotSaveArtist') },
    onSuccess: (artist, { body }) => {
      storeArtist(qc, artist);
      // Re-applied monitoring changes every album of the artist.
      if (body.monitorOption !== undefined) void qc.invalidateQueries({ queryKey: musicKeys.artists.detail(artist.id) });
    },
  });
}

export function useBulkUpdateArtists() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkArtistUpdateRequest) => musicApi.artists.bulk(body),
    meta: { errorTitle: t('music.hooks.couldNotUpdateArtists') },
    onSettled: () => void qc.invalidateQueries({ queryKey: musicKeys.artists.all }),
  });
}

export function useDeleteArtist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...opts }: { id: number } & DeleteMediaOptions) => musicApi.artists.remove(id, opts),
    meta: { errorTitle: t('music.hooks.couldNotDeleteArtist') },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: musicKeys.all });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

/** Pure helper for the optimistic album toggles (exported for tests). */
export function withAlbumsMonitored<T extends { albums: Album[] }>(artist: T, ids: readonly number[], monitored: boolean): T {
  const set = new Set(ids);
  return { ...artist, albums: artist.albums.map((a) => (set.has(a.id) ? { ...a, monitored } : a)) };
}

/** One album (PUT /album/:id) or several (PUT /album/monitor), from the artist page. */
export function useSetAlbumsMonitored() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ albumIds, monitored }: { artistId: number; albumIds: number[]; monitored: boolean }) => {
      if (albumIds.length === 1) await musicApi.albums.update(albumIds[0]!, { monitored });
      else await musicApi.albums.monitor({ albumIds, monitored });
    },
    meta: { errorTitle: t('music.hooks.couldNotChangeAlbumMonitoring') },
    onMutate: async ({ artistId, albumIds, monitored }) => {
      const a = await patchQueries<ArtistDetails>(qc, musicKeys.artists.detail(artistId), (x) => withAlbumsMonitored(x, albumIds, monitored));
      const b: Array<[readonly unknown[], unknown]> = [];
      for (const id of albumIds) b.push(...(await patchQueries<AlbumDetails>(qc, musicKeys.albums.detail(id), (x) => ({ ...x, monitored }))));
      return [...a, ...b];
    },
    onError: (_e, _v, snapshot) => {
      for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
    },
    onSettled: (_r, _e, { artistId }) => {
      void qc.invalidateQueries({ queryKey: musicKeys.artists.detail(artistId) });
      void qc.invalidateQueries({ queryKey: musicKeys.artists.list() });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

/** PUT /album/:id: monitored, anyReleaseOk or the edition (`selectedReleaseId`). */
export function useUpdateAlbum() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateAlbumRequest }) => musicApi.albums.update(id, body),
    meta: { errorTitle: t('music.hooks.couldNotSaveAlbum') },
    onMutate: ({ id, body }) =>
      patchQueries<AlbumDetails>(qc, musicKeys.albums.detail(id), (x) => ({
        ...x,
        ...(body.monitored !== undefined ? { monitored: body.monitored } : {}),
        ...(body.anyReleaseOk !== undefined ? { anyReleaseOk: body.anyReleaseOk } : {}),
        ...(body.selectedReleaseId !== undefined ? { selectedReleaseId: body.selectedReleaseId } : {}),
      })),
    onError: (_e, _v, snapshot) => {
      for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
    },
    onSettled: (album, _e, { id }) => {
      // A new edition re-fetches tracks: reload the whole album, and the artist's counts.
      void qc.invalidateQueries({ queryKey: musicKeys.albums.detail(id) });
      if (album) void qc.invalidateQueries({ queryKey: musicKeys.artists.detail(album.artistId) });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

/** RefreshArtist / RescanArtist through POST /command: a "started" toast, then the job's events. */
export function useMusicCommand() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ name, artistId }: { name: Exclude<MusicCommandName, 'AlbumSearch'>; artistId: number }) =>
      musicApi.command({ name, artistIds: [artistId] }),
    meta: { errorTitle: t('hooks.library.couldNotStartRefresh') },
    onSuccess: (job, { name, artistId }) => {
      toast.push({
        tone: 'ok',
        title: name === 'RescanArtist' ? t('music.hooks.rescanStarted') : t('hooks.library.refreshStarted'),
        message: t('hooks.library.runIdIsStatus', { id: job.id, status: job.status }),
        durationMs: 4_000,
      });
      upsertJob(qc, job);
      void qc.invalidateQueries({ queryKey: musicKeys.artists.detail(artistId) });
    },
  });
}

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

export function useMusicMetadataSettings(enabled = true) {
  return useQuery({ queryKey: musicKeys.metadata, queryFn: musicApi.settings.metadata.get, retry: false, enabled });
}

export function useSaveMusicMetadataSettings() {
  return useInvalidatingMutation((body: MusicMetadataSettingsUpdate) => musicApi.settings.metadata.update(body), [musicKeys.metadata], {
    errorTitle: t('music.settings.couldNotSaveMetadata'),
  });
}

export function useAudioImportSettings(enabled = true) {
  return useQuery({ queryKey: musicKeys.audio, queryFn: musicApi.settings.audio.get, retry: false, enabled });
}

export function useSaveAudioImportSettings() {
  return useInvalidatingMutation((body: AudioImportSettings) => musicApi.settings.audio.update(body), [musicKeys.audio], {
    errorTitle: t('music.settings.couldNotSaveAudio'),
  });
}

export function useSaveAlbumTypeProfile() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: AlbumTypeProfileInput }) =>
      id ? musicApi.albumTypeProfiles.update(id, body) : musicApi.albumTypeProfiles.create(body),
    [musicKeys.albumTypeProfiles],
    { silent: true },
  );
}

export function useDeleteAlbumTypeProfile() {
  return useInvalidatingMutation((id: number) => musicApi.albumTypeProfiles.remove(id), [musicKeys.albumTypeProfiles], { silent: true });
}
