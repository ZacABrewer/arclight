import { useState } from 'react';
import type { PlayerMovie, PlayerSeries, VideoCard } from '@arclight/shared';
import { Icon, Mark } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { PlayerLink } from '../browse/kit.js';
import { watchedShare } from './format.js';
import { useOpenVideo } from './video-launcher.js';
import { watchPaths } from './paths.js';

// Movies & TV cards. Like the music cards, a card is a link (artwork + text) with a separate
// play button beside it, never a button inside a link, so a D-pad focus manager can reach both.

/** 2:3 poster or 16:9 still, with the brand mark standing in when there is no image. */
export function VideoArt({
  src,
  shape,
  progress,
  badges,
  corner,
}: {
  src: string | null | undefined;
  shape: 'poster' | 'wide';
  progress?: number | undefined;
  badges?: readonly string[] | undefined;
  /** Top-right marker: a tick when watched, or the unwatched count of a show. */
  corner?: { kind: 'done'; label: string } | { kind: 'count'; count: number; label: string } | null | undefined;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cx('vw-art', shape === 'wide' ? 'vw-art--wide' : 'vw-art--poster')}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <div className="vw-art__placeholder" data-testid="vw-art-placeholder" aria-hidden="true">
          <Mark size={36} />
        </div>
      )}
      {badges && badges.length > 0 ? (
        <span className="vw-art__badges">
          {badges.slice(0, 3).map((b) => (
            <span key={b} className="vw-badge">
              {b}
            </span>
          ))}
        </span>
      ) : null}
      {corner ? (
        <span className={cx('vw-art__corner', corner.kind === 'done' && 'vw-art__corner--done')} role="img" aria-label={corner.label}>
          {corner.kind === 'done' ? <Icon name="check" size={16} /> : corner.count}
        </span>
      ) : null}
      {progress !== undefined && progress > 0 && progress < 1 ? (
        <div className="vw-art__progress" aria-hidden="true">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function PlayButton({ label, onPlay, className }: { label: string; onPlay: () => void; className?: string | undefined }) {
  return (
    <button type="button" className={cx('vw-card__play', className)} aria-label={label} onClick={onPlay}>
      <Icon name="play" size={20} />
    </button>
  );
}

export function MovieCard({ movie }: { movie: PlayerMovie }) {
  const t = useT();
  const open = useOpenVideo();
  const meta = [movie.year, movie.certification].filter(Boolean).join(' · ');
  return (
    <li className="vw-card">
      <PlayerLink to={watchPaths.movie(movie.id)} className="vw-card__link">
        <VideoArt
          src={movie.posterUrl}
          shape="poster"
          badges={movie.badges}
          progress={watchedShare(movie.progress, movie.played)}
          corner={movie.played ? { kind: 'done', label: t('player.video.watched') } : null}
        />
        <span className="vw-card__title">{movie.title}</span>
        {meta ? <span className="vw-card__sub">{meta}</span> : null}
      </PlayerLink>
      <PlayButton label={t('player.video.playNamed', { title: movie.title })} onPlay={() => open(movie.itemKey)} />
    </li>
  );
}

export function SeriesCard({ series }: { series: PlayerSeries }) {
  const t = useT();
  const left = Math.max(0, series.episodeCount - series.playedCount);
  const done = series.episodeCount > 0 && left === 0;
  const meta = [series.year, series.network].filter(Boolean).join(' · ');
  return (
    <li className="vw-card">
      <PlayerLink to={watchPaths.show(series.id)} className="vw-card__link">
        <VideoArt
          src={series.posterUrl}
          shape="poster"
          badges={series.badges}
          corner={
            done
              ? { kind: 'done', label: t('player.video.watched') }
              : series.playedCount > 0
                ? { kind: 'count', count: left, label: t('player.video.unwatchedCount', { count: left }) }
                : null
          }
        />
        <span className="vw-card__title">{series.title}</span>
        {meta ? <span className="vw-card__sub">{meta}</span> : null}
      </PlayerLink>
    </li>
  );
}

/** Where a home card's text link goes: the movie, or the show of a series / episode card. */
export function cardHref(card: VideoCard): string {
  if (card.kind === 'movie') return watchPaths.movie(card.id);
  if (card.kind === 'series') return watchPaths.show(card.id);
  return watchPaths.show(card.seriesId ?? card.id);
}

/** A home-shelf card: 16:9 for episodes and continue watching, 2:3 for recent movies. */
export function HomeCard({ card, shape = 'wide' }: { card: VideoCard; shape?: 'poster' | 'wide' }) {
  const t = useT();
  const open = useOpenVideo();
  const share = watchedShare(card.progress);
  const src = shape === 'poster' ? card.posterUrl : (card.thumbUrl ?? card.backdropUrl ?? card.posterUrl);
  const sub = card.subtitle ?? (card.year ? String(card.year) : null);
  return (
    <li className={cx('vw-card', shape === 'wide' && 'vw-card--wide')}>
      <PlayerLink to={cardHref(card)} className="vw-card__link">
        <VideoArt src={src} shape={shape} progress={share} badges={card.badges} corner={card.progress?.played ? { kind: 'done', label: t('player.video.watched') } : null} />
        <span className="vw-card__title">{card.title}</span>
        {sub ? <span className="vw-card__sub">{sub}</span> : null}
      </PlayerLink>
      {card.itemKey ? (
        <PlayButton
          className={shape === 'wide' ? 'vw-card__play--wide' : undefined}
          label={t(share > 0 ? 'player.video.resumeNamed' : 'player.video.playNamed', { title: card.subtitle ? `${card.title} · ${card.subtitle}` : card.title })}
          onPlay={() => open(card.itemKey!, share > 0 && card.progress ? { startMs: card.progress.positionMs } : {})}
        />
      ) : null}
    </li>
  );
}
