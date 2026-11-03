import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useT } from '@web/i18n/index';
import { browseKeys, playerBrowseApi } from '@web/features/player/browse/api';
import { useAudioActions, bookLeft } from '../actions';
import { Row, RoundTile, SquareTile } from '../tiles';
import { recentAlbums } from './home';
import type { ReactNode } from 'react';

// Music and Audiobooks (template "music" / "books"): the page head ("Music · N albums",
// "Audiobooks · N audiobooks") and rows. Music: Recently Played, Albums, Artists. Audiobooks:
// Continue Listening, Library. Albums and artists start playing and open Listen; books resume.

function Page({ title, count, children }: { title: string; count: string | null; children: ReactNode }) {
  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-rows-page">
        <div className="tv-page-head">
          <h1 className="tv-h1">{title}</h1>
          {count ? <span className="tv-count">{count}</span> : null}
        </div>
        <div className="tv-rows">{children}</div>
      </div>
    </div>
  );
}

const bookFraction = (b: { progress: { positionMs: number; durationMs: number } | null; durationMs: number }) =>
  b.progress && b.progress.positionMs > 0 ? b.progress.positionMs / (b.progress.durationMs || b.durationMs || 1) : null;

export function TvMusicScreen() {
  const t = useT();
  const { startAlbum, startArtist } = useAudioActions();
  const home = useQuery({ queryKey: browseKeys.musicHome(), queryFn: playerBrowseApi.musicHome });
  const albums = useQuery({ queryKey: browseKeys.albums({}), queryFn: () => playerBrowseApi.albums({}, 1) });
  const artists = useQuery({ queryKey: browseKeys.artists({}), queryFn: () => playerBrowseApi.artists({}, 1) });
  const recent = useMemo(() => recentAlbums(home.data?.recentlyPlayed ?? []), [home.data]);
  const total = albums.data?.total;
  return (
    <Page title={t('app.tv.tab.music')} count={total != null ? t('app.tv.albumCount', { count: total }) : null}>
      {recent.length ? (
        <Row title={t('app.tv.row.recentlyPlayed')}>
          {recent.map((a) => (
            <SquareTile key={a.id} id={`mr-${a.id}`} title={a.title} sub={a.artist} art={a.art} onOpen={() => void startAlbum(a.id)} />
          ))}
        </Row>
      ) : null}
      {albums.data?.items.length ? (
        <Row title={t('app.tv.row.albums')}>
          {albums.data.items.map((a) => (
            <SquareTile key={a.id} id={`ma-${a.id}`} title={a.title} sub={a.artistName} art={a.artworkUrl} onOpen={() => void startAlbum(a.id)} />
          ))}
        </Row>
      ) : null}
      {artists.data?.items.length ? (
        <Row title={t('app.tv.row.artists')}>
          {artists.data.items.map((a) => (
            <RoundTile key={a.id} id={`mar-${a.id}`} title={a.name} art={a.imageUrl} onOpen={() => void startArtist(a.id)} />
          ))}
        </Row>
      ) : null}
    </Page>
  );
}

export function TvBooksScreen() {
  const t = useT();
  const { startBook } = useAudioActions();
  const home = useQuery({ queryKey: browseKeys.audiobookHome(), queryFn: playerBrowseApi.audiobookHome });
  const library = useQuery({ queryKey: browseKeys.audiobooks({}), queryFn: () => playerBrowseApi.audiobooks({}, 1) });
  const listening = home.data?.continueListening ?? [];
  const total = library.data?.total;
  return (
    <Page title={t('app.tv.tab.books')} count={total != null ? t('app.tv.audiobookCount', { count: total }) : null}>
      {listening.length ? (
        <Row title={t('app.tv.row.continueListening')}>
          {listening.map((b) => (
            <SquareTile key={b.id} id={`bc-${b.id}`} title={b.title} sub={bookLeft(b.progress, b.durationMs, t)} art={b.artworkUrl} fraction={bookFraction(b)} onOpen={() => startBook(b)} />
          ))}
        </Row>
      ) : null}
      {library.data?.items.length ? (
        <Row title={t('app.tv.row.library')}>
          {library.data.items.map((b) => (
            <SquareTile key={b.id} id={`bl-${b.id}`} title={b.title} sub={b.authors[0] ?? null} art={b.artworkUrl} fraction={bookFraction(b)} onOpen={() => startBook(b)} />
          ))}
        </Row>
      ) : null}
    </Page>
  );
}
