import { useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { PlayerTrack } from '@arclight/shared';
import { Button, Icon, Menu, Popover, type MenuItem } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { AddToPlaylistDialog } from './add-to-playlist.js';
import { clockTime, groupByDisc } from './format.js';
import { Artwork, NowPlayingBars, PlayerLink, playerPaths } from './kit.js';
import { usePlayerActions } from './player-hooks.js';

export interface TrackListProps {
  tracks: readonly PlayerTrack[];
  /** Queue source for "Playing from ..." ("album:12"). */
  source: string;
  /** Accessible name of the list. */
  label: string;
  /** Album page: split by disc and show track numbers. */
  byDisc?: boolean | undefined;
  /** Show the cover and album link (playlists, search, top tracks). */
  showAlbum?: boolean | undefined;
  /** Extra controls at the end of each row (playlist reorder/remove). */
  rowActions?: ((track: PlayerTrack, index: number) => ReactNode) | undefined;
}

/** A tracklist: click a title to play from there; each row has its own menu. */
export function TrackList({ tracks, source, label, byDisc = false, showAlbum = false, rowActions }: TrackListProps) {
  const t = useT();
  const player = usePlayerActions();
  const [adding, setAdding] = useState<number[] | null>(null);
  const keys = tracks.map((tr) => tr.itemKey);
  const play = (index: number) => {
    const tr = tracks[index];
    if (tr && tr.itemKey === player.currentItemKey) player.toggle();
    else player.playItems(keys, { startIndex: index, source });
  };
  const groups = byDisc ? groupByDisc(tracks) : [{ disc: 1, tracks: tracks.map((track, index) => ({ track, index })) }];
  const multiDisc = byDisc && groups.length > 1;

  return (
    <div className="pb-tracks">
      {groups.map((g) => (
        <div key={g.disc} className="pb-tracks__disc">
          {multiDisc ? <h3 className="pb-tracks__disc-title">{t('player.browse.album.disc', { n: g.disc })}</h3> : null}
          <ol className="pb-tracks__list" aria-label={multiDisc ? t('player.browse.album.discLabel', { label, n: g.disc }) : label}>
            {g.tracks.map(({ track, index }) => (
              <TrackRow
                key={`${track.id}-${index}`}
                track={track}
                number={byDisc ? (track.trackNumber ?? index + 1) : index + 1}
                current={track.itemKey === player.currentItemKey}
                playing={player.playing}
                showAlbum={showAlbum}
                onPlay={() => play(index)}
                onAddToPlaylist={() => setAdding([track.id])}
                extra={rowActions?.(track, index)}
              />
            ))}
          </ol>
        </div>
      ))}
      <AddToPlaylistDialog open={adding !== null} onClose={() => setAdding(null)} trackIds={adding ?? []} />
    </div>
  );
}

function TrackRow({
  track,
  number,
  current,
  playing,
  showAlbum,
  onPlay,
  onAddToPlaylist,
  extra,
}: {
  track: PlayerTrack;
  number: number;
  current: boolean;
  playing: boolean;
  showAlbum: boolean;
  onPlay: () => void;
  onAddToPlaylist: () => void;
  extra: ReactNode;
}) {
  const t = useT();
  return (
    <li className={cx('pb-track', current && 'pb-track--current')} aria-current={current ? 'true' : undefined}>
      <span className="pb-track__num">{current ? <NowPlayingBars playing={playing} /> : <span className="al-num">{number}</span>}</span>
      {showAlbum ? <Artwork src={track.artworkUrl} alt="" size={40} className="pb-track__art" /> : null}
      <span className="pb-track__main">
        <button
          type="button"
          className="pb-track__title"
          onClick={onPlay}
          aria-label={current && playing ? t('player.browse.track.pause', { title: track.title }) : t('player.browse.track.play', { title: track.title })}
        >
          {track.title}
          {track.explicit ? (
            <span className="pb-explicit" title={t('player.browse.track.explicit')}>
              {t('player.browse.track.explicitShort')}
            </span>
          ) : null}
        </button>
        <span className="pb-track__sub">
          <PlayerLink to={playerPaths.artist(track.artistId)}>{track.artistName}</PlayerLink>
          {showAlbum ? (
            <>
              <span aria-hidden="true"> · </span>
              <PlayerLink to={playerPaths.album(track.albumId)}>{track.albumTitle}</PlayerLink>
            </>
          ) : null}
        </span>
      </span>
      <span className="pb-track__time al-num">{clockTime(track.durationMs)}</span>
      {extra}
      <TrackMenu track={track} showAlbum={showAlbum} onAddToPlaylist={onAddToPlaylist} />
    </li>
  );
}

/** Per-track actions: Play next, Add to queue, Add to playlist, Go to artist (and album). */
export function TrackMenu({ track, showAlbum = true, onAddToPlaylist }: { track: PlayerTrack; showAlbum?: boolean; onAddToPlaylist: () => void }) {
  const t = useT();
  const player = usePlayerActions();
  const navigate = useNavigate();
  const go = (to: string) => void navigate({ to } as unknown as Parameters<typeof navigate>[0]);
  const items: MenuItem[] = [
    { id: 'next', label: t('player.browse.track.playNext'), onSelect: () => player.playNext([track.itemKey]) },
    { id: 'queue', label: t('player.browse.track.addToQueue'), onSelect: () => player.addToQueue([track.itemKey]) },
    { id: 'playlist', label: t('player.browse.track.addToPlaylist'), onSelect: onAddToPlaylist },
    { id: 'artist', label: t('player.browse.track.goToArtist'), onSelect: () => go(playerPaths.artist(track.artistId)), separatorBefore: true },
    ...(showAlbum ? [{ id: 'album', label: t('player.browse.track.goToAlbum'), onSelect: () => go(playerPaths.album(track.albumId)) }] : []),
  ];
  return (
    <Popover
      placement="bottom-end"
      width={220}
      label={t('player.browse.track.menu', { title: track.title })}
      trigger={(p) => <Button {...p} variant="ghost" className="pb-icon-btn" icon={<Icon name="more" />} aria-label={t('player.browse.track.menu', { title: track.title })} />}
    >
      {(close) => <Menu items={items} onDone={close} />}
    </Popover>
  );
}
