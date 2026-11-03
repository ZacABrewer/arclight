import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PlayerArtistDetails } from '@arclight/shared';
import { useT } from '../../../i18n/index.js';
import { RdError, RdLoading } from '../redesign/pages/common.js';
import { browseKeys, playerBrowseApi, useArtist } from './api.js';
import { AlbumTile } from './cards.js';
import { groupAlbums, shuffled } from './format.js';
import { useNumericParam } from './kit.js';
import { usePlayerActions } from './player-hooks.js';
import { AudioDetail, AudioNotice, AudioPage, AudioSection, DetailAction, PrimaryAction } from './rd-audio.js';
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

/** /player/music/artist/$artistId: the title page (round photo), top tracks, then the albums by kind. */
export function ArtistPage() {
  const t = useT();
  const id = useNumericParam('artistId');
  const q = useArtist(id);
  const player = usePlayerActions();
  const allTracks = useArtistTracks();
  const [busy, setBusy] = useState<'play' | 'shuffle' | null>(null);

  if (!Number.isFinite(id)) {
    return (
      <AudioPage>
        <AudioNotice title={t('player.browse.artist.notFound')} />
      </AudioPage>
    );
  }
  if (q.isPending) return <RdLoading />;
  if (q.isError) {
    return (
      <AudioPage>
        <RdError title={t('player.browse.artist.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      </AudioPage>
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
    <AudioDetail
      kicker={t('player.browse.artist.kind')}
      title={artist.name}
      image={artist.imageUrl}
      round
      lines={
        <>
          <p className="rd-music-detail__meta">
            {t('player.browse.artist.albumCount', { count: artist.albumCount })} · {t('player.browse.artist.trackCount', { count: artist.trackCount })}
          </p>
          {artist.genres.length ? <p className="rd-music-detail__meta">{artist.genres.join(', ')}</p> : null}
        </>
      }
      primary={<PrimaryAction label={t('player.browse.playAll')} disabled={!canPlay} busy={busy === 'play'} onClick={() => void playAll('play')} />}
      actions={<DetailAction icon="shuffle" label={t('player.browse.shuffle')} disabled={!canPlay} busy={busy === 'shuffle'} onClick={() => void playAll('shuffle')} />}
      extra={artist.overview ? <p className="rd-music-detail__blurb">{artist.overview}</p> : null}
    >
      {artist.topTracks.length ? (
        <AudioSection title={t('player.browse.artist.topTracks')}>
          <TrackList tracks={artist.topTracks} source={source} label={t('player.browse.artist.topTracks')} showAlbum />
        </AudioSection>
      ) : null}

      {groups.length === 0 ? (
        <AudioNotice title={t('player.browse.artist.noAlbums')}>{t('player.browse.music.emptyBody')}</AudioNotice>
      ) : (
        groups.map((g) => (
          <AudioSection key={g.group} title={t(`player.browse.artist.group.${g.group}`)}>
            <ul className="rd-music-grid" aria-label={t(`player.browse.artist.group.${g.group}`)}>
              {g.albums.map((a) => (
                <li key={a.id}>
                  <AlbumTile album={a} sub={a.year ? String(a.year) : undefined} fill />
                </li>
              ))}
            </ul>
          </AudioSection>
        ))
      )}
    </AudioDetail>
  );
}
