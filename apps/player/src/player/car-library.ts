import type { QueryClient } from '@tanstack/react-query';
import { playbackApi, playerKeys } from '@web/features/player/api';
import { playerBrowseApi } from '@web/features/player/browse/api';
import { netState } from '../core/network';
import { getSession } from '../core/session';
import { entryStatus, type DownloadIndex } from '../offline/download-index';
import type { CarLibrary } from './car';

// The car's lists from the Arclight server (through the query cache, so the phone's own screens
// and the car share what was fetched) and from the download index.

const STALE_MS = 60_000;

export function createCarLibrary(qc: QueryClient, index: DownloadIndex): CarLibrary {
  const cached = <T>(key: readonly unknown[], fn: () => Promise<T>) => qc.fetchQuery({ queryKey: ['car', ...key], queryFn: fn, staleTime: STALE_MS });
  return {
    online: () => netState().online && getSession() !== null,
    continueListening: async () => (await qc.fetchQuery({ queryKey: playerKeys.continue, queryFn: () => playbackApi.continue(), staleTime: STALE_MS })).items,
    albums: async () => (await cached(['albums'], () => playerBrowseApi.albums({ sort: 'name' }, 1))).items,
    album: (id) => cached(['album', id], () => playerBrowseApi.album(id)),
    artists: async () => (await cached(['artists'], () => playerBrowseApi.artists({ sort: 'name' }, 1))).items,
    artist: (id) => cached(['artist', id], () => playerBrowseApi.artist(id)),
    playlists: () => cached(['playlists'], () => playerBrowseApi.playlists()),
    playlist: (id) => cached(['playlist', id], () => playerBrowseApi.playlist(id)),
    books: async () => (await cached(['books'], () => playerBrowseApi.audiobooks({ sort: 'name' }, 1))).items,
    search: (q) => playerBrowseApi.search(q),
    downloads: () => {
      const session = getSession();
      if (!session) return [];
      return index
        .all(session.accountId)
        .filter((e) => entryStatus(e) === 'completed')
        .map((e) => ({ item: e.item, artworkPath: e.artwork?.status === 'completed' ? e.artwork.path : undefined }));
    },
  };
}
