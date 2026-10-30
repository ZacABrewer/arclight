import { useQueries } from '@tanstack/react-query';
import { musicApi } from '../../api/music.js';
import { audiobooksApi } from '../../api/audiobooks.js';
import { audiobookKeys } from '../../hooks/audiobook-keys.js';
import { musicKeys } from '../../hooks/music-keys.js';
import { useArtistList, useFeatures } from '../../hooks/music.js';
import { useAuthorList } from '../../hooks/audiobooks.js';
import { albumIdsOf, type MusicTarget } from './music-media.js';
import { bookIdsOf, type AudiobookTarget } from './audiobook-media.js';

// Names behind the ids of music and audiobook records (artist, album, author, book), so the
// Activity list search matches what the rows show. Same queries (keys and fetchers) as the
// row labels (music-media.tsx, audiobook-media.tsx), so nothing is fetched twice.

export interface AudioNames {
  /** Artist / author name and album / book titles of a record (empty when none). */
  of: (r: MusicTarget & AudiobookTarget) => string[];
  artist: (id: number | null | undefined) => string | undefined;
  album: (artistId: number | null | undefined, albumId: number | null | undefined) => string | undefined;
  author: (id: number | null | undefined) => string | undefined;
  book: (authorId: number | null | undefined, bookId: number | null | undefined) => string | undefined;
}

const unique = (ids: ReadonlyArray<number | null | undefined>) => [...new Set(ids.filter((id): id is number => id != null && id > 0))];

/** Name lookups for the artists and authors in `artistIds` / `authorIds` (their albums / books). */
export function useAudioNames(artistIds: ReadonlyArray<number | null | undefined>, authorIds: ReadonlyArray<number | null | undefined>): AudioNames {
  const features = useFeatures();
  const artists = unique(artistIds);
  const authors = unique(authorIds);
  const artistList = useArtistList(features.music && artists.length > 0);
  const authorList = useAuthorList(features.audiobooks && authors.length > 0);
  const albums = useQueries({
    queries: artists.map((id) => ({
      queryKey: musicKeys.albums.list(id),
      queryFn: () => musicApi.albums.list(id),
      enabled: features.music,
      staleTime: 60_000,
    })),
  });
  const books = useQueries({
    queries: authors.map((id) => ({
      queryKey: audiobookKeys.books.list(id),
      queryFn: () => audiobooksApi.books.list(id),
      enabled: features.audiobooks,
      staleTime: 60_000,
    })),
  });

  const artist = (id: number | null | undefined) => (id == null ? undefined : artistList.data?.find((a) => a.id === id)?.name);
  const author = (id: number | null | undefined) => (id == null ? undefined : authorList.data?.find((a) => a.id === id)?.name);
  const album = (artistId: number | null | undefined, albumId: number | null | undefined) => {
    if (artistId == null || albumId == null) return undefined;
    return albums[artists.indexOf(artistId)]?.data?.find((a) => a.id === albumId)?.title;
  };
  const book = (authorId: number | null | undefined, bookId: number | null | undefined) => {
    if (authorId == null || bookId == null) return undefined;
    return books[authors.indexOf(authorId)]?.data?.find((b) => b.id === bookId)?.title;
  };
  const of = (r: MusicTarget & AudiobookTarget) => {
    const out: Array<string | null | undefined> = [r.artistName, r.albumTitle, r.authorName, r.bookTitle];
    if (r.artistId != null) {
      out.push(artist(r.artistId));
      for (const id of albumIdsOf(r)) out.push(album(r.artistId, id));
    }
    if (r.authorId != null) {
      out.push(author(r.authorId));
      for (const id of bookIdsOf(r)) out.push(book(r.authorId, id));
    }
    return out.filter((s): s is string => typeof s === 'string' && s !== '');
  };
  return { of, artist, album, author, book };
}
