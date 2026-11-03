import { useState } from 'react';
import type { VideoCard } from '@arclight/shared';
import { Button, Skeleton } from '@web/arclight/index';
import { cx } from '@web/arclight/cx';
import { useT } from '@web/i18n/index';
import { usePlaybackCapabilities } from '@web/features/player/api';
import { PlayerLink } from '@web/features/player/browse/kit';
import { PlayerHome } from '@web/features/player/ui/player-home';
import { useVideoHome } from '@web/features/player/video/api';
import { VideoArt, cardHref } from '@web/features/player/video/cards';
import { watchedShare } from '@web/features/player/video/format';
import { watchPaths } from '@web/features/player/video/paths';
import { useOpenVideo } from '@web/features/player/video/video-launcher';
import { GENRE_HANDOFF_KEY } from '@web/features/player/video/watch-home';
import '@web/features/player/video/watch.css';

// TV home: a hero with the backdrop, title and progress of the focused card, and big rows under
// it (Continue watching, Next up, Recently added movies and episodes, Genres). OK on a Continue
// watching / Next up card plays it (resuming); on the others it opens the movie or the show.
// Without Movies & TV on the server, the music / audiobook home.

type Shape = 'poster' | 'wide';

function heroArt(card: VideoCard): string | null {
  return card.backdropUrl ?? card.thumbUrl ?? card.posterUrl;
}

function TvCard({ card, shape, play, onFocus }: { card: VideoCard; shape: Shape; play: boolean; onFocus: (c: VideoCard) => void }) {
  const t = useT();
  const open = useOpenVideo();
  const share = watchedShare(card.progress);
  const src = shape === 'poster' ? card.posterUrl : (card.thumbUrl ?? card.backdropUrl ?? card.posterUrl);
  const sub = card.subtitle ?? (card.year ? String(card.year) : null);
  const body = (
    <>
      <VideoArt src={src} shape={shape} progress={share} badges={card.badges} corner={card.progress?.played ? { kind: 'done', label: t('player.video.watched') } : null} />
      <span className="tv-card__title">{card.title}</span>
      {sub ? <span className="tv-card__sub">{sub}</span> : null}
    </>
  );
  const common = {
    className: cx('tv-card', `tv-card--${shape}`),
    'data-tv-key': `${card.kind}:${card.id}`,
    onFocus: () => onFocus(card),
  };
  if (play && card.itemKey) {
    const key = card.itemKey;
    return (
      <li className="tv-row__item">
        <button
          type="button"
          {...common}
          aria-label={t(share > 0 ? 'player.video.resumeNamed' : 'player.video.playNamed', { title: card.subtitle ? `${card.title} · ${card.subtitle}` : card.title })}
          onClick={() => open(key, share > 0 && card.progress ? { startMs: card.progress.positionMs } : {})}
        >
          {body}
        </button>
      </li>
    );
  }
  return (
    <li className="tv-row__item">
      <PlayerLink to={cardHref(card)} {...common}>
        {body}
      </PlayerLink>
    </li>
  );
}

function TvRow({ title, cards, shape, play, onFocus }: { title: string; cards: VideoCard[]; shape: Shape; play: boolean; onFocus: (c: VideoCard) => void }) {
  if (!cards.length) return null;
  return (
    <section className="tv-row">
      <h2 className="tv-row__title">{title}</h2>
      <ul className="tv-row__list">
        {cards.map((c) => (
          <TvCard key={`${c.kind}:${c.id}`} card={c} shape={shape} play={play} onFocus={onFocus} />
        ))}
      </ul>
    </section>
  );
}

function Hero({ card }: { card: VideoCard | null }) {
  const t = useT();
  if (!card) return <section className="tv-hero tv-hero--empty" />;
  const art = heroArt(card);
  const share = watchedShare(card.progress);
  const meta = [card.kind === 'movie' ? t('player.video.movie') : null, card.subtitle, card.year ? String(card.year) : null, ...card.badges].filter(Boolean);
  return (
    <section className="tv-hero" aria-live="polite">
      {art ? <img key={art} className="tv-hero__art" src={art} alt="" decoding="async" /> : null}
      <div className="tv-hero__shade" />
      <div className="tv-hero__text">
        <h1 className="tv-hero__title">{card.title}</h1>
        {meta.length ? <p className="tv-hero__meta">{meta.join(' · ')}</p> : null}
        {share > 0 && share < 1 ? (
          <div className="tv-hero__progress" aria-label={t('player.video.progressLabel', { percent: Math.round(share * 100) })}>
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function TvHome() {
  const caps = usePlaybackCapabilities(true);
  if (caps.isPending) return <Skeleton lines={6} />;
  if (!caps.data?.sections.video) return <PlayerHome />;
  return <TvVideoHome />;
}

function TvVideoHome() {
  const t = useT();
  const home = useVideoHome();
  const [focused, setFocused] = useState<VideoCard | null>(null);

  if (home.isPending) return <Skeleton lines={8} />;
  if (home.isError) {
    return (
      <div className="tv-message">
        <h1>{t('player.video.homeFailed')}</h1>
        <Button variant="secondary" onClick={() => void home.refetch()}>
          {t('app.player.retry')}
        </Button>
      </div>
    );
  }
  const d = home.data;
  const first = d.continueWatching[0] ?? d.nextUp[0] ?? d.recentMovies[0] ?? d.recentEpisodes[0] ?? null;
  if (!first) {
    return (
      <div className="tv-message">
        <h1>{t('player.video.emptyTitle')}</h1>
        <p>{t('player.video.emptyBody')}</p>
      </div>
    );
  }
  return (
    <div className="tv-home">
      <Hero card={focused ?? first} />
      <div className="tv-rows">
        <TvRow title={t('player.video.continueWatching')} cards={d.continueWatching} shape="wide" play onFocus={setFocused} />
        <TvRow title={t('player.video.nextUp')} cards={d.nextUp} shape="wide" play onFocus={setFocused} />
        <TvRow title={t('player.video.recentMovies')} cards={d.recentMovies} shape="poster" play={false} onFocus={setFocused} />
        <TvRow title={t('player.video.recentEpisodes')} cards={d.recentEpisodes} shape="wide" play={false} onFocus={setFocused} />
        {d.genres.length ? (
          <section className="tv-row">
            <h2 className="tv-row__title">{t('player.video.genres')}</h2>
            <ul className="tv-row__list tv-row__list--chips">
              {d.genres.map((g) => (
                <li key={g}>
                  <PlayerLink to={watchPaths.movies} className="vw-chip tv-chip" data-tv-key={`genre:${g}`} onClick={() => handOff(g)}>
                    {g}
                  </PlayerLink>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function handOff(genre: string) {
  try {
    sessionStorage.setItem(GENRE_HANDOFF_KEY, genre);
  } catch {
    // The Movies page opens unfiltered.
  }
}
