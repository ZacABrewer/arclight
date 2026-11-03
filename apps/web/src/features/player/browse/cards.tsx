import { useQueryClient } from '@tanstack/react-query';
import type { PlayerAlbum, PlayerArtist, PlayerAudiobook, PlayerTrack, UserPlaylistSummary } from '@arclight/shared';
import { Icon } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { Art, RoundTile, SquareTile } from '../redesign/tiles.js';
import { browseKeys, playerBrowseApi } from './api.js';
import { isInProgress, lengthLabel, names, progressShare, shuffled, timeLeftLabel } from './format.js';
import { Artwork, FormatBadge, PlayerLink, playerPaths } from './kit.js';
import { usePlayerActions } from './player-hooks.js';

// Tiles and list rows for albums, artists, playlists, tracks and audiobooks. Tiles follow the
// redesign rule (redesign/tiles.tsx): a tile is one link or one button, with nothing drawn on the
// artwork. Grids use the same tiles at full cell width (`fill`).

/** Play an album or playlist that is only known by its summary: loads its tracks first. */
export function usePlayCollection() {
  const qc = useQueryClient();
  const player = usePlayerActions();
  return {
    album: async (id: number, opts: { shuffle?: boolean } = {}) => {
      const album = await qc.fetchQuery({ queryKey: browseKeys.album(id), queryFn: () => playerBrowseApi.album(id) });
      const keys = album.tracks.map((tr) => tr.itemKey);
      if (keys.length) player.playItems(opts.shuffle ? shuffled(keys) : keys, { source: `album:${id}` });
    },
    playlist: async (id: number, opts: { shuffle?: boolean } = {}) => {
      const list = await qc.fetchQuery({ queryKey: browseKeys.playlist(id), queryFn: () => playerBrowseApi.playlist(id) });
      const keys = list.tracks.map((tr) => tr.itemKey);
      if (keys.length) player.playItems(opts.shuffle ? shuffled(keys) : keys, { source: `playlist:${id}` });
    },
  };
}

const fillClass = (fill: boolean | undefined) => (fill ? 'rd-music-tile--fill' : undefined);

/** Album tile: opens the album. `sub` defaults to the artist (the template's album rows). */
export function AlbumTile({ album, sub, fill }: { album: PlayerAlbum; sub?: string | undefined; fill?: boolean | undefined }) {
  return <SquareTile title={album.title} sub={sub ?? album.artistName} image={album.artworkUrl} href={playerPaths.album(album.id)} className={fillClass(fill)} />;
}

/** Album tile that plays the album (Jump back in: picking up where you were, like Continue Watching). */
export function AlbumPlayTile({ album }: { album: PlayerAlbum }) {
  const t = useT();
  const play = usePlayCollection();
  return <SquareTile title={album.title} sub={album.artistName} image={album.artworkUrl} label={t('player.browse.album.playNamed', { title: album.title })} onOpen={() => void play.album(album.id)} />;
}

/** Recently played track: plays the row from this track (or pauses it when it is the one playing). */
export function TrackTile({ track, onPlay }: { track: PlayerTrack; onPlay: () => void }) {
  const t = useT();
  return <SquareTile title={track.title} sub={track.artistName} image={track.artworkUrl} label={t('player.browse.track.playBy', { title: track.title, artist: track.artistName })} onOpen={onPlay} />;
}

export function ArtistTile({ artist, fill }: { artist: PlayerArtist; fill?: boolean | undefined }) {
  return <RoundTile title={artist.name} image={artist.imageUrl} href={playerPaths.artist(artist.id)} className={fillClass(fill)} />;
}

/** Audiobook tile: author under the title, the accent bar while in progress. */
export function BookTile({ book, fill }: { book: PlayerAudiobook; fill?: boolean | undefined }) {
  const t = useT();
  return (
    <SquareTile
      title={book.title}
      sub={names(book.authors) ?? t('player.browse.book.unknownAuthor')}
      image={book.artworkUrl}
      progress={isInProgress(book.progress) ? progressShare(book.progress, book.durationMs) : null}
      href={playerPaths.book(book.id)}
      className={fillClass(fill)}
    />
  );
}

/** Continue listening: resumes the book; the sub says how long is left. */
export function ContinueBookTile({ book }: { book: PlayerAudiobook }) {
  const t = useT();
  const player = usePlayerActions();
  return (
    <SquareTile
      title={book.title}
      sub={timeLeftLabel(book.progress, book.durationMs)}
      image={book.artworkUrl}
      progress={progressShare(book.progress, book.durationMs)}
      label={t('player.browse.book.resumeNamed', { title: book.title })}
      onOpen={() => player.playItem(book.itemKey)}
    />
  );
}

/** Up to four covers as a 2x2 mosaic over the placeholder; one cover fills the frame. */
export function PlaylistArt({ name, urls, className }: { name: string; urls: readonly string[]; className?: string | undefined }) {
  if (urls.length < 4) return <Art image={urls[0]} seed={name} className={className} />;
  return (
    <Art seed={name} className={cx('rd-music-mosaic', className)}>
      {urls.slice(0, 4).map((u, i) => (
        <img key={i} src={u} alt="" loading="lazy" decoding="async" draggable={false} />
      ))}
    </Art>
  );
}

/** Playlist tile (the square tile with the mosaic art): opens the playlist. */
export function PlaylistTile({ playlist, fill }: { playlist: UserPlaylistSummary; fill?: boolean | undefined }) {
  const t = useT();
  return (
    <PlayerLink to={playerPaths.playlist(playlist.id)} className={cx('rd-tile rd-tile--square', fillClass(fill))}>
      <PlaylistArt name={playlist.name} urls={playlist.artworkUrls} className="rd-tile__art" />
      <span className="rd-tile__text">
        <span className="rd-tile__name">{playlist.name}</span>
        <span className="rd-tile__sub">{t('player.browse.playlist.meta', { count: playlist.trackCount, length: lengthLabel(playlist.durationMs) })}</span>
      </span>
    </PlayerLink>
  );
}

/** List view row for an album: cover, title, counts, format and a play button. */
export function AlbumRow({ album }: { album: PlayerAlbum }) {
  const t = useT();
  const play = usePlayCollection();
  return (
    <li className="pb-row">
      <Artwork src={album.artworkUrl} alt="" size={48} className="pb-row__art" />
      <PlayerLink to={playerPaths.album(album.id)} className="pb-row__main">
        <span className="pb-row__title">{album.title}</span>
        <span className="pb-row__sub">{[album.artistName, album.year].filter(Boolean).join(' · ')}</span>
      </PlayerLink>
      <span className="pb-row__detail pb-hide-narrow">{t('player.browse.album.meta', { count: album.trackCount, length: lengthLabel(album.durationMs) })}</span>
      <span className="pb-row__format pb-hide-narrow">
        <FormatBadge label={album.formatLabel} lossless={album.lossless} />
      </span>
      <button type="button" className="pb-icon-btn al-btn al-btn--ghost al-btn--icon" aria-label={t('player.browse.album.playNamed', { title: album.title })} onClick={() => void play.album(album.id)}>
        <Icon name="play" />
      </button>
    </li>
  );
}

export function ArtistRow({ artist }: { artist: PlayerArtist }) {
  const t = useT();
  return (
    <li className="pb-row pb-row--artist">
      <Artwork src={artist.imageUrl} alt="" size={48} shape="round" className="pb-row__art" />
      <PlayerLink to={playerPaths.artist(artist.id)} className="pb-row__main">
        <span className="pb-row__title">{artist.name}</span>
        <span className="pb-row__sub">{artist.genres.slice(0, 3).join(', ')}</span>
      </PlayerLink>
      <span className="pb-row__detail">
        {t('player.browse.artist.albumCount', { count: artist.albumCount })} · {t('player.browse.artist.trackCount', { count: artist.trackCount })}
      </span>
    </li>
  );
}
