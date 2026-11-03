import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { RdError, RdLoading } from '../redesign/pages/common.js';
import { AddToPlaylistDialog } from './add-to-playlist.js';
import { useAlbum } from './api.js';
import { DownloadButton } from './download.js';
import { lengthLabel, shuffled } from './format.js';
import { FormatBadge, PlayerLink, playerPaths, useNumericParam } from './kit.js';
import { usePlayerActions } from './player-hooks.js';
import { AudioDetail, AudioNotice, AudioPage, DetailAction, PrimaryAction } from './rd-audio.js';
import { TrackList } from './tracks.js';

/** /player/music/album/$albumId: the title page, then the track list by disc. */
export function AlbumPage() {
  const t = useT();
  const id = useNumericParam('albumId');
  const q = useAlbum(id);
  const player = usePlayerActions();
  const [adding, setAdding] = useState(false);

  if (!Number.isFinite(id)) {
    return (
      <AudioPage>
        <AudioNotice title={t('player.browse.album.notFound')} />
      </AudioPage>
    );
  }
  if (q.isPending) return <RdLoading />;
  if (q.isError) {
    return (
      <AudioPage>
        <RdError title={t('player.browse.album.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      </AudioPage>
    );
  }

  const album = q.data;
  const keys = album.tracks.map((tr) => tr.itemKey);
  const source = `album:${album.id}`;

  return (
    <AudioDetail
      kicker={album.albumType ?? t('player.browse.album.kind')}
      title={album.title}
      image={album.artworkUrl}
      lines={
        <>
          <p className="rd-music-detail__line">
            <PlayerLink to={playerPaths.artist(album.artistId)}>{album.artistName}</PlayerLink>
            {album.year ? <span className="al-num"> · {album.year}</span> : null}
          </p>
          <p className="rd-music-detail__meta">
            <span>{t('player.browse.album.meta', { count: album.trackCount || album.tracks.length, length: lengthLabel(album.durationMs) })}</span>
            <FormatBadge label={album.formatLabel} lossless={album.lossless} />
          </p>
          {album.genres.length ? <p className="rd-music-detail__meta">{album.genres.join(', ')}</p> : null}
        </>
      }
      primary={<PrimaryAction label={t('player.browse.play')} disabled={!keys.length} onClick={() => player.playItems(keys, { source })} />}
      actions={
        <>
          <DetailAction icon="shuffle" label={t('player.browse.shuffle')} disabled={!keys.length} onClick={() => player.playItems(shuffled(keys), { source })} />
          <DetailAction icon="plus" label={t('player.browse.track.addToPlaylist')} disabled={!keys.length} onClick={() => setAdding(true)} />
          <DownloadButton itemKeys={keys} />
        </>
      }
    >
      {album.tracks.length ? (
        <TrackList tracks={album.tracks} source={source} label={t('player.browse.album.tracklist')} byDisc />
      ) : (
        <AudioNotice title={t('player.browse.album.noTracks')}>{t('player.browse.album.noTracksBody')}</AudioNotice>
      )}
      <AddToPlaylistDialog open={adding} onClose={() => setAdding(false)} trackIds={album.tracks.map((tr) => tr.id)} />
    </AudioDetail>
  );
}
