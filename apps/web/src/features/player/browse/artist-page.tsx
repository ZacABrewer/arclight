import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PlayerArtistDetails } from '@arclight/shared';
import { Button, ButtonGroup, Icon } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { browseKeys, playerBrowseApi, useArtist } from './api.js';
import { AlbumCard } from './cards.js';
import { groupAlbums, shuffled } from './format.js';
import { Artwork, DetailsSkeleton, Empty, LoadError, ShuffleIcon, useNumericParam } from './kit.js';
import { usePlayerActions } from './player-hooks.js';
import { TrackList } from './tracks.js';

/**
 * Every track by the artist, album by album (oldest first). The contract has no per-artist
 * track list, so this loads each album's details (cached for the album pages).
 */
function useArtistTracks() {
  const qc = useQueryClient();
  return async (artist: PlayerArtistDetails): Promise<string[]> => {
    const albums = [...artist.albums].sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
    const details = await Promise.all(albums.map((a) => qc.fetchQuery({ queryKey: browseKeys.album(a.id), queryFn: () => playerBrowseApi.album(a.id) })));
    return details.flatMap((d) => d.tracks.map((tr) => tr.itemKey));
  };
}

/** /player/music/artist/$artistId */
export function ArtistPage() {
  const t = useT();
  const id = useNumericParam('artistId');
  const q = useArtist(id);
  const player = usePlayerActions();
  const allTracks = useArtistTracks();
  const [busy, setBusy] = useState<'play' | 'shuffle' | null>(null);

  if (!Number.isFinite(id)) return <Empty title={t('player.browse.artist.notFound')} />;
  if (q.isPending) return <DetailsSkeleton label={t('player.browse.loading')} />;
  if (q.isError) {
    return (
      <div className="pb-page">
        <LoadError title={t('player.browse.artist.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }

  const artist = q.data;
  const source = `artist:${artist.id}`;
  const playAll = async (mode: 'play' | 'shuffle') => {
    setBusy(mode);
    try {
      const keys = await allTracks(artist);
      if (keys.length) player.playItems(mode === 'shuffle' ? shuffled(keys) : keys, { source });
    } finally {
      setBusy(null);
    }
  };
  const groups = groupAlbums(artist.albums);
  const canPlay = artist.trackCount > 0 || artist.albums.length > 0;

  return (
    <div className="pb-page">
      <section className="pb-hero pb-hero--artist" aria-labelledby="pb-artist-title">
        <Artwork src={artist.imageUrl} alt={t('player.browse.artist.photo', { name: artist.name })} shape="round" className="pb-hero__art" loading="eager" />
        <div className="pb-hero__body">
          <p className="pb-eyebrow">{t('player.browse.artist.kind')}</p>
          <h1 className="pb-title" id="pb-artist-title">
            {artist.name}
          </h1>
          <p className="pb-hero__meta">
            {t('player.browse.artist.albumCount', { count: artist.albumCount })} · {t('player.browse.artist.trackCount', { count: artist.trackCount })}
          </p>
          {artist.genres.length ? <p className="pb-muted">{artist.genres.join(', ')}</p> : null}
          <ButtonGroup className="pb-hero__actions">
            <Button variant="primary" icon={<Icon name="play" />} disabled={!canPlay} loading={busy === 'play'} onClick={() => void playAll('play')}>
              {t('player.browse.playAll')}
            </Button>
            <Button icon={<ShuffleIcon />} disabled={!canPlay} loading={busy === 'shuffle'} onClick={() => void playAll('shuffle')}>
              {t('player.browse.shuffle')}
            </Button>
          </ButtonGroup>
          {artist.overview ? <p className="pb-overview">{artist.overview}</p> : null}
        </div>
      </section>

      {artist.topTracks.length ? (
        <section className="pb-section" aria-labelledby="pb-top-tracks">
          <h2 className="pb-section__title" id="pb-top-tracks">
            {t('player.browse.artist.topTracks')}
          </h2>
          <TrackList tracks={artist.topTracks} source={source} label={t('player.browse.artist.topTracks')} showAlbum />
        </section>
      ) : null}

      {groups.length === 0 ? (
        <Empty title={t('player.browse.artist.noAlbums')}>{t('player.browse.music.emptyBody')}</Empty>
      ) : (
        groups.map((g) => (
          <section key={g.group} className="pb-section" aria-labelledby={`pb-group-${g.group}`}>
            <h2 className="pb-section__title" id={`pb-group-${g.group}`}>
              {t(`player.browse.artist.group.${g.group}`)}
            </h2>
            <ul className="pb-grid" aria-labelledby={`pb-group-${g.group}`}>
              {g.albums.map((a) => (
                <AlbumCard key={a.id} album={a} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
