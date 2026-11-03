import { useEffect } from 'react';
import type { VideoCard, VideoFeaturedItem } from '@arclight/shared';
import { useT } from '../../../../i18n/index.js';
import { useAudiobookHome, useMusicHome } from '../../browse/api.js';
import { useVideoHome } from '../../video/api.js';
import { useOpenVideo } from '../../video/video-launcher.js';
import { useFeatured, useProfileSettings } from '../api.js';
import { Hero } from '../hero.js';
import { useLayout } from '../layout.js';
import { Row } from '../row.js';
import { useSections } from '../shell.js';
import { SquareTile, WideTile } from '../tiles.js';
import { RdError, RdLoading, RdPage, shareOf, useCardActions, useCardSubs, useListen } from './common.js';

// Home (the template's Home; spec §4.4 / §4.5): the rotating hero, then the rows in the
// template's order: Continue Watching, Trending Now, New Episodes, Movies for Tonight, Recently
// Played (music on), Continue Listening (audiobooks on), My List. Empty rows are left out.

export function RdHomePage() {
  const t = useT();
  const sections = useSections();
  useEffect(() => {
    document.title = t('player.documentTitle');
  }, [t]);
  return (
    <RdPage className="rd-home">
      {sections.video ? <VideoHomeBlock /> : null}
      <ListenRows music={sections.music} books={sections.books} first={!sections.video} />
    </RdPage>
  );
}

function VideoHomeBlock() {
  const t = useT();
  const layout = useLayout();
  const settings = useProfileSettings();
  const featured = useFeatured();
  const home = useVideoHome();
  const subs = useCardSubs();
  const act = useCardActions();
  const open = useOpenVideo();

  const onPlay = (item: VideoFeaturedItem) => {
    const p = item.play;
    if (!p) return;
    open(p.itemKey, p.progress && shareOf(p.progress) > 0 ? { startMs: p.progress.positionMs } : {});
  };

  if (home.isPending) return <RdLoading />;
  if (home.isError) return <RdError title={t('player.video.homeFailed')} onRetry={() => void home.refetch()} />;
  const d = home.data;
  // Next up (the next episode of a show in progress) belongs with Continue Watching.
  const seen = new Set(d.continueWatching.map((c) => c.seriesId ?? `${c.kind}:${c.id}`));
  const cw = [...d.continueWatching, ...d.nextUp.filter((c) => !seen.has(c.seriesId ?? `${c.kind}:${c.id}`))];
  const items = featured.data?.items ?? [];
  const wide = (card: VideoCard, sub: string, play = false) => (
    <WideTile
      key={`${card.kind}:${card.id}`}
      title={card.title}
      sub={sub}
      image={card.thumbUrl ?? card.backdropUrl ?? card.posterUrl}
      seed={card.title}
      progress={play ? shareOf(card.progress) : null}
      size={play ? 'cw' : undefined}
      {...(play && card.itemKey ? { onOpen: () => act.play(card) } : { href: act.href(card) })}
      label={sub ? `${card.title}, ${sub}` : card.title}
    />
  );
  const trending = d.trending ?? [];
  const tonight = d.moviesForTonight ?? d.recentMovies;
  const myList = d.myList ?? [];
  const nothing = !items.length && !cw.length && !trending.length && !d.recentEpisodes.length && !tonight.length && !myList.length;

  return (
    <>
      <Hero items={items} rotate={settings.heroRotate} seconds={8} reduceMotion={settings.reduceMotion} layout={layout === 'portrait' ? 'portrait' : 'wide'} onPlay={onPlay} />
      <div className={items.length ? 'rd-rows' : 'rd-rows rd-rows--top'}>
        {nothing ? (
          <div className="rd-empty">
            <p className="rd-empty__title">{t('player.video.emptyTitle')}</p>
            <p className="rd-empty__body">{t('player.video.emptyBody')}</p>
          </div>
        ) : null}
        <Row title={t('player.redesign.rows.continueWatching')}>{cw.map((c) => wide(c, subs.continueSub(c), true))}</Row>
        <Row title={t('player.redesign.rows.trending')}>{trending.map((c) => wide(c, subs.plainSub(c)))}</Row>
        <Row title={t('player.redesign.rows.newEpisodes')}>{d.recentEpisodes.map((c) => wide(c, subs.newEpisodeSub(c)))}</Row>
        <Row title={t('player.redesign.rows.moviesTonight')}>{tonight.map((c) => wide(c, subs.plainSub(c)))}</Row>
        <Row title={t('player.redesign.rows.myList')}>{myList.map((c) => wide(c, subs.plainSub(c)))}</Row>
      </div>
    </>
  );
}

/** Recently Played (albums) and Continue Listening (audiobooks), each behind its section toggle. */
function ListenRows({ music, books, first }: { music: boolean; books: boolean; first: boolean }) {
  if (!music && !books) return null;
  return (
    <div className={first ? 'rd-rows rd-rows--top' : 'rd-rows rd-rows--more'}>
      {music ? <RecentlyPlayedRow /> : null}
      {books ? <ContinueListeningRow /> : null}
    </div>
  );
}

function RecentlyPlayedRow() {
  const t = useT();
  const home = useMusicHome();
  const listen = useListen();
  const albums = home.data?.jumpBackIn.length ? home.data.jumpBackIn : (home.data?.recentlyAdded ?? []);
  return (
    <Row title={t('player.redesign.rows.recentlyPlayed')}>
      {albums.map((a) => (
        <SquareTile key={a.id} title={a.title} sub={a.artistName} image={a.artworkUrl} seed={a.title} onOpen={() => void listen.album(a.id)} label={`${a.title}, ${a.artistName}`} />
      ))}
    </Row>
  );
}

function ContinueListeningRow() {
  const t = useT();
  const home = useAudiobookHome();
  const listen = useListen();
  const subs = useCardSubs();
  const books = home.data?.continueListening ?? [];
  return (
    <Row title={t('player.redesign.rows.continueListening')}>
      {books.map((b) => (
        <SquareTile
          key={b.id}
          title={b.title}
          sub={subs.bookLeft(b)}
          image={b.artworkUrl}
          seed={b.title}
          progress={b.durationMs > 0 && b.progress ? Math.min(1, b.progress.positionMs / b.durationMs) : null}
          onOpen={() => listen.item(b.itemKey)}
          label={`${b.title}, ${subs.bookLeft(b)}`}
        />
      ))}
    </Row>
  );
}

