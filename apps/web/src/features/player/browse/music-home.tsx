import type { PlayerAlbum, PlayerTrack } from '@arclight/shared';
import { Icon } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { useMusicHome } from './api.js';
import { AlbumCard, PlaylistCard, usePlayCollection } from './cards.js';
import { Artwork, Empty, GridSkeleton, LoadError, NowPlayingBars, PageTitle, PlayerLink, Shelf, playerPaths } from './kit.js';
import { MusicNav } from './music-nav.js';
import { usePlayerActions } from './player-hooks.js';

/** /player/music: shelves of what to play next. */
export function MusicHomePage() {
  const t = useT();
  const home = useMusicHome();

  let body;
  if (home.isPending) body = <GridSkeleton count={6} label={t('player.browse.loading')} />;
  else if (home.isError) body = <LoadError title={t('player.browse.music.loadFailed')} error={home.error} onRetry={() => void home.refetch()} />;
  else {
    const d = home.data;
    const nothing = !d.jumpBackIn.length && !d.recentlyPlayed.length && !d.recentlyAdded.length && !d.playlists.length && !d.onThisDay.length;
    body = nothing ? (
      <Empty title={t('player.browse.music.emptyTitle')}>{t('player.browse.music.emptyBody')}</Empty>
    ) : (
      <>
        {d.jumpBackIn.length ? (
          <Shelf title={t('player.browse.music.jumpBackIn')}>
            {d.jumpBackIn.map((a) => (
              <JumpTile key={a.id} album={a} />
            ))}
          </Shelf>
        ) : null}
        {d.recentlyPlayed.length ? <RecentTracks tracks={d.recentlyPlayed} /> : null}
        {d.recentlyAdded.length ? (
          <Shelf title={t('player.browse.music.recentlyAdded')} action={<PlayerLink to={playerPaths.albums} className="al-link">{t('player.browse.seeAll')}</PlayerLink>}>
            {d.recentlyAdded.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </Shelf>
        ) : null}
        {d.playlists.length ? (
          <Shelf title={t('player.browse.music.yourPlaylists')} action={<PlayerLink to={playerPaths.playlists} className="al-link">{t('player.browse.seeAll')}</PlayerLink>}>
            {d.playlists.map((p) => (
              <PlaylistCard key={p.id} playlist={p} />
            ))}
          </Shelf>
        ) : null}
        {d.onThisDay.length ? (
          <Shelf title={t('player.browse.music.onThisDay')}>
            {d.onThisDay.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </Shelf>
        ) : null}
      </>
    );
  }

  return (
    <div className="pb-page">
      <PageTitle actions={<PlayerLink to={playerPaths.search} className="al-btn al-btn--secondary">{t('player.browse.search.open')}</PlayerLink>}>
        {t('player.browse.music.title')}
      </PageTitle>
      <MusicNav />
      {body}
    </div>
  );
}

/** Compact "jump back in" tile: cover, title, artist, and a play button. */
function JumpTile({ album }: { album: PlayerAlbum }) {
  const t = useT();
  const play = usePlayCollection();
  return (
    <li className="pb-jump">
      <PlayerLink to={playerPaths.album(album.id)} className="pb-jump__link">
        <Artwork src={album.artworkUrl} alt="" size={64} />
        <span className="pb-jump__text">
          <span className="pb-card__title">{album.title}</span>
          <span className="pb-card__sub">{album.artistName}</span>
        </span>
      </PlayerLink>
      <button type="button" className="pb-icon-btn al-btn al-btn--ghost al-btn--icon" aria-label={t('player.browse.album.playNamed', { title: album.title })} onClick={() => void play.album(album.id)}>
        <Icon name="play" />
      </button>
    </li>
  );
}

function RecentTracks({ tracks }: { tracks: PlayerTrack[] }) {
  const t = useT();
  const player = usePlayerActions();
  const keys = tracks.map((tr) => tr.itemKey);
  return (
    <Shelf title={t('player.browse.music.recentlyPlayed')}>
      {tracks.map((tr, i) => {
        const current = tr.itemKey === player.currentItemKey;
        return (
          <li key={`${tr.id}-${i}`} className="pb-card">
            <button
              type="button"
              className="pb-card__link"
              aria-label={t('player.browse.track.playBy', { title: tr.title, artist: tr.artistName })}
              onClick={() => (current ? player.toggle() : player.playItems(keys, { startIndex: i, source: 'recent' }))}
            >
              <Artwork src={tr.artworkUrl} alt="">
                {current ? (
                  <span className="pb-card__badge">
                    <NowPlayingBars playing={player.playing} />
                  </span>
                ) : null}
              </Artwork>
              <span className="pb-card__title">{tr.title}</span>
              <span className="pb-card__sub">{tr.artistName}</span>
            </button>
          </li>
        );
      })}
    </Shelf>
  );
}
