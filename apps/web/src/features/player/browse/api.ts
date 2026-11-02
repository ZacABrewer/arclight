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
  type PlaylistTrackMove,
  type PlaylistTracksAdd,
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
//   POST /playback/playlists/:id/tracks  PATCH/DELETE /playback/playlists/:id/tracks/:entryId
// Track edits go one entry at a time (by entry id), so two tabs editing the same playlist do
// not undo each other and tracks without a file yet are never dropped by a rewrite.

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
  addPlaylistTracks: (id: number, body: PlaylistTracksAdd) => request(`/playback/playlists/${id}/tracks`, UserPlaylistDetails, { method: 'POST', json: body }),
  removePlaylistEntry: (id: number, entryId: number) => request(`/playback/playlists/${id}/tracks/${entryId}`, UserPlaylistDetails, { method: 'DELETE' }),
  movePlaylistEntry: (id: number, entryId: number, body: PlaylistTrackMove) =>
    request(`/playback/playlists/${id}/tracks/${entryId}`, UserPlaylistDetails, { method: 'PATCH', json: body }),
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

/** Show a playlist edit now; the server's answer (the whole playlist) replaces it. */
function optimisticEntries(qc: QueryClient, id: number, edit: (entryIds: number[]) => number[]) {
  const prev = qc.getQueryData<UserPlaylistDetails>(browseKeys.playlist(id));
  if (prev) {
    const byEntry = new Map(prev.entryIds.map((e, i) => [e, prev.tracks[i]!]));
    const entryIds = edit([...prev.entryIds]);
    const tracks = entryIds.map((e) => byEntry.get(e)!);
    qc.setQueryData<UserPlaylistDetails>(browseKeys.playlist(id), { ...prev, tracks, entryIds, trackCount: tracks.length });
  }
  return { prev };
}

function usePlaylistEdit<V extends { id: number }>(send: (v: V) => Promise<UserPlaylistDetails>, preview?: (entryIds: number[], v: V) => number[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: send,
    onMutate: (v: V) => (preview ? optimisticEntries(qc, v.id, (e) => preview(e, v)) : { prev: undefined }),
    onError: (_e, v, ctx) => {
      if (ctx?.prev) qc.setQueryData(browseKeys.playlist(v.id), ctx.prev);
    },
    onSuccess: (data, v) => qc.setQueryData(browseKeys.playlist(v.id), data),
    onSettled: (_d, _e, v) => invalidatePlaylists(qc, v.id),
  });
}

/** Remove one entry (by entry id; a track can be in a playlist more than once). */
export function useRemovePlaylistEntry() {
  return usePlaylistEdit(
    ({ id, entryId }: { id: number; entryId: number }) => playerBrowseApi.removePlaylistEntry(id, entryId),
    (entryIds, { entryId }) => entryIds.filter((e) => e !== entryId),
  );
}

/** Move one entry before or after another; reorders feel instant, the answer confirms. */
export function useMovePlaylistEntry() {
  return usePlaylistEdit(
    ({ id, entryId, to }: { id: number; entryId: number; to: PlaylistTrackMove }) => playerBrowseApi.movePlaylistEntry(id, entryId, to),
    (entryIds, { entryId, to }) => {
      const rest = entryIds.filter((e) => e !== entryId);
      const before = to.beforeEntryId !== undefined;
      const at = rest.indexOf((before ? to.beforeEntryId : to.afterEntryId) ?? -1);
      if (at < 0) return entryIds;
      rest.splice(before ? at : at + 1, 0, entryId);
      return rest;
    },
  );
}

/** Append tracks to a playlist (the server adds them; nothing is read and rewritten). */
export function useAddToPlaylist() {
  return usePlaylistEdit(({ id, trackIds }: { id: number; trackIds: number[] }) => playerBrowseApi.addPlaylistTracks(id, { trackIds }));
}
