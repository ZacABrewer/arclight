import { Link } from '@tanstack/react-router';
import { useArtistAlbums, useArtistList, useFeatures } from '../../hooks/music.js';
import { MusicChip } from '../library/music/music-kit.js';
import { t } from '../../i18n/index.js';

// "Artist – Album" labels for music rows in Activity (queue, history, blocklist, pending).
// Queue, history, blocklist and pending records carry `artistId` and `albumIds` with
// `mediaType: 'music'`; names come from the record when the server includes them, else from
// the artist list and that artist's albums (both cached and shared by every row).

/** The music fields an activity record may carry (all optional; older servers send none). */
export interface MusicTarget {
  mediaType?: string | null | undefined;
  artistId?: number | null | undefined;
  albumIds?: readonly number[] | null | undefined;
  /** Single-album records (some history rows). */
  albumId?: number | null | undefined;
  artistName?: string | null | undefined;
  albumTitle?: string | null | undefined;
}

/** True for a record about music (by media type, or by carrying a music target). */
export function isMusicRecord(r: MusicTarget): boolean {
  return r.mediaType === 'music' || r.artistId != null || (r.albumIds?.length ?? 0) > 0 || r.albumId != null;
}

/** The record's album ids, single or listed, without duplicates. */
export function albumIdsOf(r: MusicTarget): number[] {
  return [...new Set([...(r.albumIds ?? []), ...(r.albumId != null ? [r.albumId] : [])])];
}

/** "Artist – Album", "Artist – Album (+2)", "Artist" or the album alone. */
export function musicLabel(artist: string | null, album: string | null, more: number): string {
  const base = artist && album ? t('activity.music.artistAlbum', { artist, album }) : (album ?? artist ?? t('common.music'));
  return more > 0 ? t('activity.music.moreAlbums', { label: base, count: more }) : base;
}

/** The music chip plus "Artist – Album", linked to the (first) album, else the artist. */
export function MusicMediaLabel({ record }: { record: MusicTarget }) {
  const features = useFeatures();
  const ids = albumIdsOf(record);
  const needsArtist = !record.artistName && record.artistId != null;
  const needsAlbum = !record.albumTitle && ids.length > 0 && record.artistId != null;
  const artists = useArtistList(features.music && needsArtist);
  const albums = useArtistAlbums(record.artistId, features.music && needsAlbum);
  const artistName = record.artistName ?? artists.data?.find((a) => a.id === record.artistId)?.name ?? null;
  const first = ids[0];
  const albumTitle = record.albumTitle ?? (first !== undefined ? albums.data?.find((a) => a.id === first)?.title : undefined) ?? null;
  const text = musicLabel(artistName, albumTitle, Math.max(0, ids.length - 1));
  return (
    <span className="al-activity-music">
      <MusicChip />
      {first !== undefined ? (
        <Link className="al-link" to="/library/music/album/$id" params={{ id: String(first) }}>
          {text}
        </Link>
      ) : record.artistId != null ? (
        <Link className="al-link" to="/library/music/artist/$id" params={{ id: String(record.artistId) }}>
          {text}
        </Link>
      ) : (
        <span>{text}</span>
      )}
    </span>
  );
}
