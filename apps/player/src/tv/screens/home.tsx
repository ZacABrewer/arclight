import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MusicHome, PlayerTrack, VideoCard, VideoFeaturedItem } from '@arclight/shared';
import { useLocale, useT } from '@web/i18n/index';
import { browseKeys, playerBrowseApi } from '@web/features/player/browse/api';
import { useVideoHome } from '@web/features/player/video/api';
import { useProfileSettings } from '../../households/api';
import { useFeatured, useMyList } from '@web/features/player/redesign/api';
import { artBackground } from '@web/features/player/redesign/placeholder';
import { bookLeft, cardArt, cardSub, continueSub, useAudioActions, useVideoActions } from '../actions';
import { fraction, kickerLabel, leftLabel, metaItems, playLabel, type Translate } from '../format';
import { HeroTitle, Kicker, MetaLine, PlayIcon, ProgressLine, Row, SquareTile, WideTile } from '../tiles';

// TV Home (spec §4.3, template "home"): the rotating featured hero, then the rows in the
// template's order, each only when it has items.

export const HERO_ROTATE_MS = 8000;

/** One square tile per album, newest play first (MusicHome.recentlyPlayed is tracks). */
export function recentAlbums(tracks: readonly PlayerTrack[]): { id: number; title: string; artist: string; art: string | null }[] {
  const seen = new Set<number>();
  const out: { id: number; title: string; artist: string; art: string | null }[] = [];
  for (const tr of tracks) {
    if (seen.has(tr.albumId)) continue;
    seen.add(tr.albumId);
    out.push({ id: tr.albumId, title: tr.albumTitle, artist: tr.artistName, art: tr.artworkUrl });
  }
  return out;
}

/** New Episodes: one tile per show. */
export function newEpisodes(cards: readonly VideoCard[]): VideoCard[] {
  const seen = new Set<number>();
  return cards.filter((c) => {
    const key = c.seriesId ?? -c.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function Hero({ items, rotate, t }: { items: VideoFeaturedItem[]; rotate: boolean; t: Translate }) {
  const { locale } = useLocale();
  const { openTitle, play } = useVideoActions();
  const [idx, setIdx] = useState(0);
  const n = items.length;
  useEffect(() => {
    if (!rotate || n < 2) return;
    const id = window.setInterval(() => setIdx((i) => (i + 1) % n), HERO_ROTATE_MS);
    return () => window.clearInterval(id);
  }, [rotate, n]);
  const item = items[Math.min(idx, n - 1)];
  if (!item) return null;
  const progress = item.play?.progress ?? null;
  const f = fraction(progress);
  return (
    <>
      <div className="tv-hero" aria-hidden="true">
        {items.map((it, i) => (
          <div key={`${it.kind}:${it.id}`} className="tv-hero__layer" style={{ background: artBackground(it.backdropUrl, it.title), opacity: i === idx ? 1 : 0 }} />
        ))}
        <div className="tv-hero__shade" />
      </div>
      <div className="tv-hero__spacer">
        <div className="tv-hero__content">
          <Kicker>{kickerLabel(item.kicker, item.kickerWeekday, t, locale)}</Kicker>
          <HeroTitle title={item.title} logoUrl={item.logoUrl} />
          <MetaLine items={metaItems(item, t)} />
          {item.overview ? <p className="tv-blurb">{item.overview}</p> : null}
          <div className="tv-btns" data-tv-row="" data-tv-ytop="">
            <button
              type="button"
              className="tv-btn tv-btn--primary"
              data-tv-key="hero-play"
              data-tv-autofocus=""
              data-tv-r="8"
              onClick={() => (item.play ? play(item.play.itemKey, progress) : openTitle(item.kind, item.id))}
            >
              <PlayIcon />
              {playLabel(item.kind, item.play, t)}
            </button>
            <button type="button" className="tv-btn tv-btn--secondary" data-tv-key="hero-info" data-tv-r="8" onClick={() => openTitle(item.kind, item.id)}>
              {t('app.tv.moreInfo')}
            </button>
          </div>
          <ProgressLine fraction={f !== null && f < 1 ? f : null} label={leftLabel(progress, t)} />
        </div>
        {n > 1 ? (
          <div className="tv-hero__dots" aria-hidden="true">
            {items.map((it, i) => (
              <span key={`${it.kind}:${it.id}`} className={`tv-hero__dot${i === idx ? ' tv-hero__dot--on' : ''}`} />
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function TvHomeScreen() {
  const t = useT();
  const settings = useProfileSettings();
  const featured = useFeatured();
  const home = useVideoHome();
  const music = useQuery({ queryKey: browseKeys.musicHome(), queryFn: playerBrowseApi.musicHome, enabled: settings.showMusic, retry: false });
  const books = useQuery({ queryKey: browseKeys.audiobookHome(), queryFn: playerBrowseApi.audiobookHome, enabled: settings.showAudiobooks, retry: false });
  const myListQuery = useMyList(home.isSuccess && home.data.myList === undefined);
  const { openCard } = useVideoActions();
  const { startAlbum, startBook } = useAudioActions();
  const items = featured.data?.items ?? [];
  const h = home.data;
  const myList = h?.myList ?? myListQuery.data?.items ?? [];
  const albums = useMemo(() => recentAlbums((music.data as MusicHome | undefined)?.recentlyPlayed ?? []), [music.data]);
  const fresh = useMemo(() => newEpisodes(h?.recentEpisodes ?? []), [h?.recentEpisodes]);
  const listening = settings.showAudiobooks ? (books.data?.continueListening ?? []) : [];

  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-rows-page">
        {items.length ? <Hero items={items} rotate={settings.heroRotate} t={t} /> : <div style={{ height: 108 }} />}
        <div className="tv-rows">
          {h?.continueWatching.length ? (
            <Row title={t('app.tv.row.continueWatching')}>
              {h.continueWatching.map((c) => (
                <WideTile key={`${c.kind}:${c.id}`} id={`cw-${c.kind}:${c.id}`} title={c.title} sub={continueSub(c, t)} art={cardArt(c)} fraction={fraction(c.progress)} onOpen={() => openCard(c, true)} />
              ))}
            </Row>
          ) : null}
          {h?.trending?.length ? (
            <Row title={t('app.tv.row.trending')}>
              {h.trending.map((c) => (
                <WideTile key={`${c.kind}:${c.id}`} id={`tr-${c.kind}:${c.id}`} title={c.title} sub={cardSub(c, t)} art={cardArt(c)} onOpen={() => openCard(c)} />
              ))}
            </Row>
          ) : null}
          {fresh.length ? (
            <Row title={t('app.tv.row.newEpisodes')}>
              {fresh.map((c) => (
                <WideTile
                  key={`${c.kind}:${c.id}`}
                  id={`ne-${c.kind}:${c.id}`}
                  title={c.title}
                  sub={c.seasonNumber != null ? t('app.tv.newEpisodeSub', { s: c.seasonNumber }) : t('app.tv.newEpisode')}
                  art={c.backdropUrl ?? c.thumbUrl ?? c.posterUrl}
                  onOpen={() => openCard(c)}
                />
              ))}
            </Row>
          ) : null}
          {h?.moviesForTonight?.length ? (
            <Row title={t('app.tv.row.moviesForTonight')}>
              {h.moviesForTonight.map((c) => (
                <WideTile key={`${c.kind}:${c.id}`} id={`mv-${c.kind}:${c.id}`} title={c.title} sub={cardSub(c, t)} art={cardArt(c)} onOpen={() => openCard(c)} />
              ))}
            </Row>
          ) : null}
          {settings.showMusic && albums.length ? (
            <Row title={t('app.tv.row.recentlyPlayed')}>
              {albums.map((a) => (
                <SquareTile key={a.id} id={`mu-${a.id}`} title={a.title} sub={a.artist} art={a.art} onOpen={() => void startAlbum(a.id)} />
              ))}
            </Row>
          ) : null}
          {listening.length ? (
            <Row title={t('app.tv.row.continueListening')}>
              {listening.map((b) => (
                <SquareTile
                  key={b.id}
                  id={`bk-${b.id}`}
                  title={b.title}
                  sub={bookLeft(b.progress, b.durationMs, t)}
                  art={b.artworkUrl}
                  fraction={b.progress && b.durationMs ? b.progress.positionMs / (b.progress.durationMs || b.durationMs) : null}
                  onOpen={() => startBook(b)}
                />
              ))}
            </Row>
          ) : null}
          {myList.length ? (
            <Row title={t('app.tv.row.myList')}>
              {myList.map((c) => (
                <WideTile key={`${c.kind}:${c.id}`} id={`my-${c.kind}:${c.id}`} title={c.title} sub={cardSub(c, t)} art={cardArt(c)} onOpen={() => openCard(c)} />
              ))}
            </Row>
          ) : null}
        </div>
      </div>
    </div>
  );
}
