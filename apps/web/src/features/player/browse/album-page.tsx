import { useState } from 'react';
import { Button, ButtonGroup, Icon } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { AddToPlaylistDialog } from './add-to-playlist.js';
import { useAlbum } from './api.js';
import { lengthLabel, shuffled } from './format.js';
import { Artwork, DetailsSkeleton, Empty, FormatBadge, LoadError, PlayerLink, ShuffleIcon, playerPaths, useNumericParam } from './kit.js';
import { usePlayerActions } from './player-hooks.js';
import { TrackList } from './tracks.js';

/** /player/music/album/$albumId */
export function AlbumPage() {
  const t = useT();
  const id = useNumericParam('albumId');
  const q = useAlbum(id);
  const player = usePlayerActions();
  const [adding, setAdding] = useState(false);

  if (!Number.isFinite(id)) return <Empty title={t('player.browse.album.notFound')} />;
  if (q.isPending) return <DetailsSkeleton label={t('player.browse.loading')} />;
  if (q.isError) {
    return (
      <div className="pb-page">
        <LoadError title={t('player.browse.album.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }

  const album = q.data;
  const keys = album.tracks.map((tr) => tr.itemKey);
  const source = `album:${album.id}`;

  return (
    <div className="pb-page">
      <section className="pb-hero" aria-labelledby="pb-album-title">
        <Artwork src={album.artworkUrl} alt={t('player.browse.album.cover', { title: album.title })} className="pb-hero__art" loading="eager" />
        <div className="pb-hero__body">
          <p className="pb-eyebrow">{album.albumType ?? t('player.browse.album.kind')}</p>
          <h1 className="pb-title" id="pb-album-title">
            {album.title}
          </h1>
          <p className="pb-hero__line">
            <PlayerLink to={playerPaths.artist(album.artistId)}>{album.artistName}</PlayerLink>
            {album.year ? <span className="al-num"> · {album.year}</span> : null}
          </p>
          <p className="pb-hero__meta">
            <span>{t('player.browse.album.meta', { count: album.trackCount || album.tracks.length, length: lengthLabel(album.durationMs) })}</span>
            <FormatBadge label={album.formatLabel} lossless={album.lossless} />
          </p>
          {album.genres.length ? <p className="pb-muted">{album.genres.join(', ')}</p> : null}
          <ButtonGroup className="pb-hero__actions">
            <Button variant="primary" icon={<Icon name="play" />} disabled={!keys.length} onClick={() => player.playItems(keys, { source })}>
              {t('player.browse.play')}
            </Button>
            <Button icon={<ShuffleIcon />} disabled={!keys.length} onClick={() => player.playItems(shuffled(keys), { source })}>
              {t('player.browse.shuffle')}
            </Button>
            <Button variant="ghost" icon={<Icon name="plus" />} disabled={!keys.length} onClick={() => setAdding(true)}>
              {t('player.browse.track.addToPlaylist')}
            </Button>
          </ButtonGroup>
        </div>
      </section>
      {album.tracks.length ? (
        <TrackList tracks={album.tracks} source={source} label={t('player.browse.album.tracklist')} byDisc />
      ) : (
        <Empty title={t('player.browse.album.noTracks')}>{t('player.browse.album.noTracksBody')}</Empty>
      )}
      <AddToPlaylistDialog open={adding} onClose={() => setAdding(false)} trackIds={album.tracks.map((tr) => tr.id)} />
    </div>
  );
}
