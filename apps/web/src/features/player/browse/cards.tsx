import { useQueryClient } from '@tanstack/react-query';
import type { PlayerAlbum, PlayerArtist, PlayerAudiobook, UserPlaylistSummary } from '@arclight/shared';
import { Icon } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { browseKeys, playerBrowseApi } from './api.js';
import { isInProgress, lengthLabel, names, progressShare, shuffled, timeLeftLabel } from './format.js';
import { Artwork, FormatBadge, PlayerLink, playerPaths } from './kit.js';
import { usePlayerActions } from './player-hooks.js';

// Cards and rows for albums, artists, playlists and audiobooks. A card is a link (artwork +
// text) with a separate play button beside it, never a button inside a link.

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

function PlayOverlay({ label, onPlay }: { label: string; onPlay: () => void }) {
  return (
    <button type="button" className="pb-card__play" aria-label={label} onClick={onPlay}>
      <Icon name="play" size={20} />
    </button>
  );
}

export function AlbumCard({ album, as = 'li' }: { album: PlayerAlbum; as?: 'li' | 'div' }) {
  const t = useT();
  const play = usePlayCollection();
  const As = as;
  return (
    <As className="pb-card">
      <PlayerLink to={playerPaths.album(album.id)} className="pb-card__link">
        <Artwork src={album.artworkUrl} alt="">
          {album.formatLabel || album.lossless ? (
            <span className="pb-card__badge">
              <FormatBadge label={album.formatLabel} lossless={album.lossless} />
            </span>
          ) : null}
        </Artwork>
        <span className="pb-card__title">{album.title}</span>
        <span className="pb-card__sub">{[album.artistName, album.year].filter(Boolean).join(' · ')}</span>
      </PlayerLink>
      <PlayOverlay label={t('player.browse.album.playNamed', { title: album.title })} onPlay={() => void play.album(album.id)} />
    </As>
  );
}

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

export function ArtistCard({ artist, as = 'li' }: { artist: PlayerArtist; as?: 'li' | 'div' }) {
  const t = useT();
  const As = as;
  return (
    <As className="pb-card pb-card--artist">
      <PlayerLink to={playerPaths.artist(artist.id)} className="pb-card__link">
        <Artwork src={artist.imageUrl} alt="" shape="round" />
        <span className="pb-card__title">{artist.name}</span>
        <span className="pb-card__sub">{t('player.browse.artist.albumCount', { count: artist.albumCount })}</span>
      </PlayerLink>
    </As>
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

export function PlaylistCard({ playlist }: { playlist: UserPlaylistSummary }) {
  const t = useT();
  const play = usePlayCollection();
  return (
    <li className="pb-card">
      <PlayerLink to={playerPaths.playlist(playlist.id)} className="pb-card__link">
        <PlaylistArt urls={playlist.artworkUrls} />
        <span className="pb-card__title">{playlist.name}</span>
        <span className="pb-card__sub">{t('player.browse.playlist.meta', { count: playlist.trackCount, length: lengthLabel(playlist.durationMs) })}</span>
      </PlayerLink>
      {playlist.trackCount > 0 ? (
        <PlayOverlay label={t('player.browse.playlist.playNamed', { name: playlist.name })} onPlay={() => void play.playlist(playlist.id)} />
      ) : null}
    </li>
  );
}

/** Up to four covers as a 2x2 mosaic; one cover fills the frame. */
export function PlaylistArt({ urls, size }: { urls: readonly string[]; size?: number | string }) {
  if (urls.length < 4) return <Artwork src={urls[0]} alt="" size={size} />;
  return (
    <div className="pb-art pb-mosaic" style={size === undefined ? undefined : { width: size }}>
      {urls.slice(0, 4).map((u, i) => (
        <img key={i} src={u} alt="" loading="lazy" decoding="async" />
      ))}
    </div>
  );
}

export function BookCard({ book, as = 'li', showLeft = false }: { book: PlayerAudiobook; as?: 'li' | 'div'; showLeft?: boolean }) {
  const t = useT();
  const player = usePlayerActions();
  const share = progressShare(book.progress, book.durationMs);
  const As = as;
  const resumable = isInProgress(book.progress);
  return (
    <As className={cx('pb-card', 'pb-card--book')}>
      <PlayerLink to={playerPaths.book(book.id)} className="pb-card__link">
        <Artwork src={book.artworkUrl} alt="" progress={share}>
          {book.progress?.played ? (
            <span className="pb-card__done" role="img" aria-label={t('player.browse.book.finished')}>
              <Icon name="check" />
            </span>
          ) : null}
        </Artwork>
        <span className="pb-card__title">{book.title}</span>
        <span className="pb-card__sub">{names(book.authors) ?? t('player.browse.book.unknownAuthor')}</span>
        {showLeft && resumable ? <span className="pb-card__meta al-num">{timeLeftLabel(book.progress, book.durationMs)}</span> : null}
        {!showLeft && book.seriesTitle ? (
          <span className="pb-card__meta">{book.seriesPosition ? t('player.browse.book.seriesPosition', { series: book.seriesTitle, position: book.seriesPosition }) : book.seriesTitle}</span>
        ) : null}
      </PlayerLink>
      <PlayOverlay
        label={resumable ? t('player.browse.book.resumeNamed', { title: book.title }) : t('player.browse.book.playNamed', { title: book.title })}
        onPlay={() => player.playItem(book.itemKey)}
      />
    </As>
  );
}
