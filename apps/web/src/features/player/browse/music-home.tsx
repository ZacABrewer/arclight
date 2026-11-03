import { useEffect } from 'react';
import type { PlayerTrack } from '@arclight/shared';
import { useT } from '../../../i18n/index.js';
import { Row } from '../redesign/row.js';
import { RdError, RdLoading } from '../redesign/pages/common.js';
import { useAlbums, useArtists, useMusicHome, type BrowseFilters } from './api.js';
import { AlbumPlayTile, AlbumTile, ArtistTile, PlaylistTile, TrackTile } from './cards.js';
import { PlayerLink, playerPaths } from './kit.js';
import { MusicNav } from './music-nav.js';
import { usePlayerActions } from './player-hooks.js';
import { AudioHead, AudioNotice, AudioPage } from './rd-audio.js';

/** The Albums and Artists pages' opening filters, so the home rows share their first page. */
export const LIBRARY_DEFAULT_FILTERS: BrowseFilters = { sort: 'name', desc: false };

/**
 * /player/music (the template's Music screen): the head with the album count, the section chips,
 * then Recently Played, Albums and Artists, followed by the server's other shelves.
 */
export function MusicHomePage() {
  const t = useT();
  const home = useMusicHome();
  const albums = useAlbums(LIBRARY_DEFAULT_FILTERS);
  const artists = useArtists(LIBRARY_DEFAULT_FILTERS);
  const albumTotal = albums.data?.pages[0]?.total;
  const firstAlbums = albums.data?.pages[0]?.items ?? [];
  const firstArtists = artists.data?.pages[0]?.items ?? [];

  useEffect(() => {
    document.title = `${t('player.browse.music.title')} · ${t('player.documentTitle')}`;
  }, [t]);

  let body;
  if (home.isPending) body = <RdLoading />;
  else if (home.isError) body = <RdError title={t('player.browse.music.loadFailed')} error={home.error} onRetry={() => void home.refetch()} />;
  else {
    const d = home.data;
    const nothing = !d.jumpBackIn.length && !d.recentlyPlayed.length && !d.recentlyAdded.length && !d.playlists.length && !d.onThisDay.length && !firstAlbums.length;
    const seeAll = (to: string) => (
      <PlayerLink to={to} className="rd-music-seeall">
        {t('player.browse.seeAll')}
      </PlayerLink>
    );
    body = nothing ? (
      <AudioNotice title={t('player.browse.music.emptyTitle')}>{t('player.browse.music.emptyBody')}</AudioNotice>
    ) : (
      <div className="rd-rows rd-music-rows">
        {d.recentlyPlayed.length ? <RecentTracks tracks={d.recentlyPlayed} /> : null}
        <Row title={t('player.browse.nav.albums')} action={seeAll(playerPaths.albums)}>
          {firstAlbums.map((a) => (
            <AlbumTile key={a.id} album={a} />
          ))}
        </Row>
        <Row title={t('player.browse.nav.artists')} action={seeAll(playerPaths.artists)}>
          {firstArtists.map((a) => (
            <ArtistTile key={a.id} artist={a} />
          ))}
        </Row>
        <Row title={t('player.browse.music.jumpBackIn')}>
          {d.jumpBackIn.map((a) => (
            <AlbumPlayTile key={a.id} album={a} />
          ))}
        </Row>
        <Row title={t('player.browse.music.recentlyAdded')} action={seeAll(playerPaths.albums)}>
          {d.recentlyAdded.map((a) => (
            <AlbumTile key={a.id} album={a} />
          ))}
        </Row>
        <Row title={t('player.browse.music.yourPlaylists')} action={seeAll(playerPaths.playlists)}>
          {d.playlists.map((p) => (
            <PlaylistTile key={p.id} playlist={p} />
          ))}
        </Row>
        <Row title={t('player.browse.music.onThisDay')}>
          {d.onThisDay.map((a) => (
            <AlbumTile key={a.id} album={a} />
          ))}
        </Row>
      </div>
    );
  }

  return (
    <AudioPage>
      <AudioHead
        title={t('player.browse.music.title')}
        sub={albumTotal !== undefined ? t('player.browse.albumsCount', { count: albumTotal }) : null}
        actions={
          <PlayerLink to={playerPaths.search} className="rd-btn rd-btn--secondary">
            {t('player.browse.search.open')}
          </PlayerLink>
        }
      >
        <MusicNav />
      </AudioHead>
      {body}
    </AudioPage>
  );
}

/** Recently Played: a tile plays the row from that track, or pauses the one playing. */
function RecentTracks({ tracks }: { tracks: PlayerTrack[] }) {
  const t = useT();
  const player = usePlayerActions();
  const keys = tracks.map((tr) => tr.itemKey);
  return (
    <Row title={t('player.browse.music.recentlyPlayed')}>
      {tracks.map((tr, i) => (
        <TrackTile key={`${tr.id}-${i}`} track={tr} onPlay={() => (tr.itemKey === player.currentItemKey ? player.toggle() : player.playItems(keys, { startIndex: i, source: 'recent' }))} />
      ))}
    </Row>
  );
}
