import { z } from 'zod';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AudiobookHome,
  MusicHome,
  PlayerAlbumDetails,
  PlayerAlbumPage,
  PlayerArtistDetails,
  PlayerArtistPage,
  PlayerAudiobookDetails,
  PlayerAudiobookPage,
  PlayerSearchResponse,
  ProgressListResponse,
  UserPlaylistDetails,
  UserPlaylistSummary,
  type BrowseSort,
  type PlaybackProgress,
  type ProgressUpdate,
  type UserPlaylistInput,
} from '@arclight/shared';
import { request, type QueryParams } from '../../../api/client.js';

// Browse and playlist calls for the player (packages/shared/src/playback.ts). Paths:
//   GET  /playback/music/home | /music/albums | /music/albums/:id | /music/artists | /music/artists/:id
//   GET  /playback/audiobooks/home | /audiobooks | /audiobooks/:id
//   GET  /playback/search?q=
//   GET  /playback/progress?itemKeys=   PATCH /playback/progress/:itemKey
//   GET/POST /playback/playlists        GET/PUT/DELETE /playback/playlists/:id
// Playlist track edits (add, remove, reorder) send the whole ordered trackIds list with PUT.

/** The browse filters a page sends (BrowseQuery without the paging fields). */
export interface BrowseFilters {
  search?: string | undefined;
  sort?: BrowseSort | undefined;
  desc?: boolean | undefined;
  genre?: string | undefined;
  letter?: string | undefined;
}

export const PAGE_SIZE = 60;

/** GET /playback/playlists answers a list; accept a bare array or `{ items }`. */
const PlaylistList = z
  .union([z.array(UserPlaylistSummary), z.object({ items: z.array(UserPlaylistSummary) })])
  .transform((v) => (Array.isArray(v) ? v : v.items));

function filterQuery(f: BrowseFilters, page: number): QueryParams {
  return {
    search: f.search?.trim() || undefined,
    sort: f.sort,
    desc: f.desc ? true : undefined,
    genre: f.genre || undefined,
    letter: f.letter || undefined,
    page,
    pageSize: PAGE_SIZE,
  };
}

export const playerBrowseApi = {
  musicHome: () => request('/playback/music/home', MusicHome),
  albums: (f: BrowseFilters, page: number) => request('/playback/music/albums', PlayerAlbumPage, { query: filterQuery(f, page) }),
  album: (id: number) => request(`/playback/music/albums/${id}`, PlayerAlbumDetails),
  artists: (f: BrowseFilters, page: number) => request('/playback/music/artists', PlayerArtistPage, { query: filterQuery(f, page) }),
  artist: (id: number) => request(`/playback/music/artists/${id}`, PlayerArtistDetails),
  audiobookHome: () => request('/playback/audiobooks/home', AudiobookHome),
  audiobooks: (f: BrowseFilters, page: number) => request('/playback/audiobooks', PlayerAudiobookPage, { query: filterQuery(f, page) }),
  audiobook: (id: number) => request(`/playback/audiobooks/${id}`, PlayerAudiobookDetails),
  search: (q: string) => request('/playback/search', PlayerSearchResponse, { query: { q } }),
  progress: (itemKeys: readonly string[]) => request('/playback/progress', ProgressListResponse, { query: { itemKeys: itemKeys.join(',') } }),
  updateProgress: (itemKey: string, body: ProgressUpdate) =>
    request(`/playback/progress/${encodeURIComponent(itemKey)}`, null, { method: 'PATCH', json: body }),
  playlists: () => request('/playback/playlists', PlaylistList),
  playlist: (id: number) => request(`/playback/playlists/${id}`, UserPlaylistDetails),
  createPlaylist: (body: UserPlaylistInput) => request('/playback/playlists', UserPlaylistSummary, { method: 'POST', json: body }),
  updatePlaylist: (id: number, body: UserPlaylistInput) => request(`/playback/playlists/${id}`, UserPlaylistSummary, { method: 'PUT', json: body }),
  deletePlaylist: (id: number) => request(`/playback/playlists/${id}`, null, { method: 'DELETE' }),
};

export const browseKeys = {
  all: ['player-browse'] as const,
  musicHome: () => ['player-browse', 'music-home'] as const,
  albums: (f: BrowseFilters) => ['player-browse', 'albums', f] as const,
  album: (id: number) => ['player-browse', 'album', id] as const,
  artists: (f: BrowseFilters) => ['player-browse', 'artists', f] as const,
  artist: (id: number) => ['player-browse', 'artist', id] as const,
  audiobookHome: () => ['player-browse', 'audiobook-home'] as const,
  audiobooks: (f: BrowseFilters) => ['player-browse', 'audiobooks', f] as const,
  audiobook: (id: number) => ['player-browse', 'audiobook', id] as const,
  search: (q: string) => ['player-browse', 'search', q] as const,
  progress: (keys: readonly string[]) => ['player-browse', 'progress', keys.join(',')] as const,
  playlists: () => ['player-browse', 'playlists'] as const,
  playlist: (id: number) => ['player-browse', 'playlist', id] as const,
};

const nextPage = (last: { page: number; pageSize: number; total: number }) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined);

export function useMusicHome() {
  return useQuery({ queryKey: browseKeys.musicHome(), queryFn: playerBrowseApi.musicHome });
}

export function useAlbums(filters: BrowseFilters) {
  return useInfiniteQuery({
    queryKey: browseKeys.albums(filters),
    queryFn: ({ pageParam }) => playerBrowseApi.albums(filters, pageParam),
    initialPageParam: 1,
    getNextPageParam: nextPage,
  });
}

export function useAlbum(id: number) {
  return useQuery({ queryKey: browseKeys.album(id), queryFn: () => playerBrowseApi.album(id), enabled: Number.isFinite(id) && id > 0 });
}

export function useArtists(filters: BrowseFilters) {
  return useInfiniteQuery({
    queryKey: browseKeys.artists(filters),
    queryFn: ({ pageParam }) => playerBrowseApi.artists(filters, pageParam),
    initialPageParam: 1,
    getNextPageParam: nextPage,
  });
}

export function useArtist(id: number) {
  return useQuery({ queryKey: browseKeys.artist(id), queryFn: () => playerBrowseApi.artist(id), enabled: Number.isFinite(id) && id > 0 });
}

export function useAudiobookHome() {
  return useQuery({ queryKey: browseKeys.audiobookHome(), queryFn: playerBrowseApi.audiobookHome });
}

export function useAudiobooks(filters: BrowseFilters) {
  return useInfiniteQuery({
    queryKey: browseKeys.audiobooks(filters),
    queryFn: ({ pageParam }) => playerBrowseApi.audiobooks(filters, pageParam),
    initialPageParam: 1,
    getNextPageParam: nextPage,
  });
}

export function useAudiobook(id: number) {
  return useQuery({ queryKey: browseKeys.audiobook(id), queryFn: () => playerBrowseApi.audiobook(id), enabled: Number.isFinite(id) && id > 0 });
}

export function usePlayerSearch(q: string) {
  const term = q.trim();
  return useQuery({ queryKey: browseKeys.search(term), queryFn: () => playerBrowseApi.search(term), enabled: term.length > 0 });
}

/** The api takes at most 200 keys per call. */
const PROGRESS_CHUNK = 200;

/** Effective progress for these items, by item key (missing: never started). */
export function useProgress(itemKeys: readonly string[]) {
  return useQuery({
    queryKey: browseKeys.progress(itemKeys),
    enabled: itemKeys.length > 0,
    queryFn: async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < itemKeys.length; i += PROGRESS_CHUNK) chunks.push(itemKeys.slice(i, i + PROGRESS_CHUNK));
      const answers = await Promise.all(chunks.map((c) => playerBrowseApi.progress(c)));
      const out = new Map<string, PlaybackProgress>();
      for (const a of answers) for (const p of a.items) out.set(p.itemKey, p);
      return out;
    },
  });
}

/** Mark an item finished or unfinished (PATCH progress), then refresh the shelves. */
export function useMarkPlayed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemKey, played }: { itemKey: string; played: boolean }) => playerBrowseApi.updateProgress(itemKey, { played }),
    onSuccess: () => qc.invalidateQueries({ queryKey: browseKeys.all }),
  });
}

export function usePlaylists() {
  return useQuery({ queryKey: browseKeys.playlists(), queryFn: playerBrowseApi.playlists });
}

export function usePlaylist(id: number) {
  return useQuery({ queryKey: browseKeys.playlist(id), queryFn: () => playerBrowseApi.playlist(id), enabled: Number.isFinite(id) && id > 0 });
}

function invalidatePlaylists(qc: QueryClient, id?: number) {
  void qc.invalidateQueries({ queryKey: browseKeys.playlists() });
  void qc.invalidateQueries({ queryKey: browseKeys.musicHome() });
  if (id !== undefined) void qc.invalidateQueries({ queryKey: browseKeys.playlist(id) });
}

export function useCreatePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UserPlaylistInput) => playerBrowseApi.createPlaylist(body),
    onSuccess: () => invalidatePlaylists(qc),
  });
}

export function useRenamePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    // PUT needs the name; trackIds are left out so the order stays as it is.
    mutationFn: ({ id, name, description }: { id: number; name: string; description?: string | null }) =>
      playerBrowseApi.updatePlaylist(id, { name, ...(description !== undefined ? { description } : {}) }),
    onSuccess: (_d, v) => invalidatePlaylists(qc, v.id),
  });
}

export function useDeletePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => playerBrowseApi.deletePlaylist(id),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: browseKeys.playlist(id) });
      invalidatePlaylists(qc);
    },
  });
}

/** Replace a playlist's tracks (reorder, remove): the whole ordered list of track ids. */
export function useSetPlaylistTracks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, trackIds }: { id: number; name: string; trackIds: number[] }) => playerBrowseApi.updatePlaylist(id, { name, trackIds }),
    onMutate: ({ id, trackIds }) => {
      // Reorders feel instant: move the cached rows now, the refetch confirms.
      const prev = qc.getQueryData<UserPlaylistDetails>(browseKeys.playlist(id));
      if (prev) {
        const pool = new Map<number, UserPlaylistDetails['tracks']>();
        for (const tr of prev.tracks) pool.set(tr.id, [...(pool.get(tr.id) ?? []), tr]);
        const tracks = trackIds.flatMap((tid) => {
          const list = pool.get(tid);
          const tr = list?.shift();
          return tr ? [tr] : [];
        });
        qc.setQueryData<UserPlaylistDetails>(browseKeys.playlist(id), { ...prev, tracks, trackCount: tracks.length });
      }
      return { prev };
    },
    onError: (_e, { id }, ctx) => {
      if (ctx?.prev) qc.setQueryData(browseKeys.playlist(id), ctx.prev);
    },
    onSettled: (_d, _e, v) => invalidatePlaylists(qc, v.id),
  });
}

/** Append tracks to a playlist: reads its current tracks, then PUTs the longer list. */
export function useAddToPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, trackIds }: { id: number; trackIds: number[] }) => {
      const current = await qc.fetchQuery({ queryKey: browseKeys.playlist(id), queryFn: () => playerBrowseApi.playlist(id), staleTime: 0 });
      return playerBrowseApi.updatePlaylist(id, { name: current.name, trackIds: [...current.tracks.map((tr) => tr.id), ...trackIds] });
    },
    onSuccess: (_d, v) => invalidatePlaylists(qc, v.id),
  });
}
