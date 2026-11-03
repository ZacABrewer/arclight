import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoFeaturedItem } from '@arclight/shared';
import { cx } from '../../../arclight/cx.js';
import { useT, useLocale } from '../../../i18n/index.js';
import { PlayerLink } from '../browse/kit.js';
import { watchPaths } from '../video/paths.js';
import { MetaLine, useRuntimeLabel } from './meta-line.js';
import { MyListButton } from './my-list-button.js';
import { RdIcon } from './icons.js';
import { artBackground } from './placeholder.js';
import { ProgressBar } from './tiles.js';

// The rotating hero on Home (redesign spec §4.2, §4.4, §4.5). Wide: the template's composition
// (art crossfading .9 s, content at the left, dots at the right). Portrait: full-bleed slides in
// a scroll-snap strip, swiped by hand; rotation pauses while touching and for 10 s after.

export interface HeroProps {
  items: readonly VideoFeaturedItem[];
  rotate: boolean;
  /** Seconds per item (§9 Q8: 8). */
  seconds?: number | undefined;
  reduceMotion: boolean;
  layout: 'wide' | 'portrait';
  /** Play / Resume. */
  onPlay: (item: VideoFeaturedItem) => void;
}

const TOUCH_PAUSE_MS = 10_000;

export function detailHref(item: { kind: 'movie' | 'series'; id: number }): string {
  return item.kind === 'movie' ? watchPaths.movie(item.id) : watchPaths.show(item.id);
}

/** "New episode every Friday", "Just added", ... */
export function useKicker() {
  const t = useT();
  const { locale } = useLocale();
  return (item: Pick<VideoFeaturedItem, 'kicker' | 'kickerWeekday'>) => {
    if (item.kicker === 'new-episode' && item.kickerWeekday !== null) {
      // 2023-01-01 was a Sunday: day 0.
      const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + item.kickerWeekday)));
      return t('player.redesign.kicker.newEpisodeEvery', { weekday });
    }
    return t(`player.redesign.kicker.${item.kicker}`);
  };
}

/** "Resume S2 E5", "Play S1 E1", "Resume", "Play". */
export function usePlayLabel() {
  const t = useT();
  return (item: Pick<VideoFeaturedItem, 'kind' | 'play'>) => {
    const p = item.play;
    const resume = Boolean(p?.progress && p.progress.positionMs > 0 && !p.progress.played);
    if (item.kind === 'series' && p && p.seasonNumber !== null && p.episodeNumber !== null) {
      return t(resume ? 'player.redesign.resumeEpisode' : 'player.redesign.playEpisode', { season: p.seasonNumber, episode: p.episodeNumber });
    }
    return t(resume ? 'player.redesign.resume' : 'player.redesign.play');
  };
}

function shareOf(item: VideoFeaturedItem): number {
  const p = item.play?.progress;
  if (!p || p.played || p.durationMs <= 0 || p.positionMs <= 0) return 0;
  return Math.min(1, p.positionMs / p.durationMs);
}

function HeroTitle({ item, className }: { item: VideoFeaturedItem; className: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (item.logoUrl && failed !== item.logoUrl) {
    return (
      <h2 className={cx(className, 'rd-hero__logo')}>
        <img src={item.logoUrl} alt={item.title} onError={() => setFailed(item.logoUrl)} />
      </h2>
    );
  }
  return <h2 className={className}>{item.title}</h2>;
}

function HeroContent({ item, onPlay, portrait, dots }: { item: VideoFeaturedItem; onPlay: (i: VideoFeaturedItem) => void; portrait: boolean; dots?: React.ReactNode }) {
  const t = useT();
  const kicker = useKicker();
  const playLabel = usePlayLabel();
  const runtime = useRuntimeLabel();
  const share = shareOf(item);
  const left = share > 0 && item.play?.progress ? (item.play.progress.durationMs - item.play.progress.positionMs) / 60_000 : 0;
  return (
    <div className="rd-hero__content">
      <div className="rd-kicker">
        <span className="rd-kicker__dot" aria-hidden="true" />
        {kicker(item)}
      </div>
      <HeroTitle item={item} className="rd-hero__title" />
      <MetaLine year={item.year} cert={item.certification} runtimeMinutes={item.runtimeMinutes} seasons={item.kind === 'series' ? item.seasonCount : null} genres={item.genres} chips={item.chips} />
      {item.overview ? <p className="rd-hero__blurb">{item.overview}</p> : null}
      <div className="rd-hero__buttons">
        {item.play ? (
          <button type="button" className="rd-btn rd-btn--primary rd-hero__play" onClick={() => onPlay(item)}>
            <RdIcon name="play" size={18} />
            {playLabel(item)}
          </button>
        ) : null}
        {portrait ? (
          <MyListButton kind={item.kind} id={item.id} inList={item.inMyList} variant="square" />
        ) : (
          <PlayerLink to={detailHref(item)} className="rd-btn rd-btn--secondary">
            {t('player.redesign.moreInfo')}
          </PlayerLink>
        )}
      </div>
      {dots}
      {share > 0 && !portrait ? (
        <div className="rd-resume">
          <ProgressBar value={share} className="rd-resume__bar" />
          <span>{t('player.redesign.timeLeft', { time: runtime(left) })}</span>
        </div>
      ) : null}
    </div>
  );
}

function Dots({ count, index }: { count: number; index: number }) {
  if (count < 2) return null;
  return (
    <div className="rd-hero__dots" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={cx('rd-hero__dot', i === index && 'is-on')} />
      ))}
    </div>
  );
}

export function Hero(props: HeroProps) {
  if (!props.items.length) return null;
  return props.layout === 'portrait' ? <PortraitHero {...props} /> : <WideHero {...props} />;
}

function useRotation(count: number, enabled: boolean, seconds: number, index: number, go: (i: number) => void, pausedUntil: React.RefObject<number>) {
  useEffect(() => {
    if (!enabled || count < 2) return undefined;
    const id = window.setInterval(() => {
      if (document.hidden || Date.now() < (pausedUntil.current ?? 0)) return;
      go((index + 1) % count);
    }, seconds * 1000);
    return () => window.clearInterval(id);
  }, [enabled, count, seconds, index, go, pausedUntil]);
}

function WideHero({ items, rotate, seconds = 8, reduceMotion, onPlay }: HeroProps) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const paused = useRef(0);
  const i = Math.min(index, items.length - 1);
  const item = items[i]!;
  useRotation(items.length, rotate, seconds, i, setIndex, paused);
  return (
    <section
      className={cx('rd-hero rd-hero--wide', reduceMotion && 'rd-hero--still')}
      aria-roledescription={t('player.redesign.hero.role')}
      aria-label={t('player.redesign.hero.label')}
      // Keyboard focus inside holds the item still, so its buttons do not change under the user.
      onFocus={() => (paused.current = Number.MAX_SAFE_INTEGER)}
      onBlur={() => (paused.current = Date.now())}
    >
      <div className="rd-hero__art" aria-hidden="true">
        {items.map((it, n) => (
          <div key={`${it.kind}:${it.id}`} className={cx('rd-hero__layer', n === i && 'is-on')} style={{ background: artBackground(it.backdropUrl, it.title) }} />
        ))}
        <div className="rd-hero__shade" />
      </div>
      <HeroContent key={`${item.kind}:${item.id}`} item={item} onPlay={onPlay} portrait={false} />
      <Dots count={items.length} index={i} />
    </section>
  );
}

function PortraitHero({ items, rotate, seconds = 8, reduceMotion, onPlay }: HeroProps) {
  const t = useT();
  const strip = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const paused = useRef(0);
  const i = Math.min(index, items.length - 1);

  const go = useCallback(
    (n: number) => {
      const el = strip.current;
      if (!el) return;
      el.scrollTo({ left: n * el.clientWidth, behavior: reduceMotion ? 'auto' : 'smooth' });
    },
    [reduceMotion],
  );
  useRotation(items.length, rotate, seconds, i, go, paused);

  const onScroll = () => {
    const el = strip.current;
    if (!el || !el.clientWidth) return;
    const n = Math.round(el.scrollLeft / el.clientWidth);
    if (n !== index) setIndex(n);
  };
  const hold = () => (paused.current = Number.MAX_SAFE_INTEGER);
  const release = () => (paused.current = Date.now() + TOUCH_PAUSE_MS);

  return (
    <section className="rd-hero rd-hero--portrait" aria-roledescription={t('player.redesign.hero.role')} aria-label={t('player.redesign.hero.label')}>
      <div ref={strip} className="rd-hero__strip" onScroll={onScroll} onTouchStart={hold} onTouchEnd={release} onTouchCancel={release} onFocus={hold} onBlur={release}>
        {items.map((it, n) => (
          <div key={`${it.kind}:${it.id}`} className="rd-hero__slide" aria-hidden={n !== i || undefined} inert={n !== i ? true : undefined}>
            <PlayerLink to={detailHref(it)} className="rd-hero__art" aria-label={t('player.redesign.openTitle', { title: it.title })}>
              <span className="rd-hero__layer is-on" style={{ background: artBackground(it.backdropUrl, it.title) }} />
              <span className="rd-hero__shade" />
            </PlayerLink>
            <HeroContent item={it} onPlay={onPlay} portrait dots={<Dots count={items.length} index={i} />} />
          </div>
        ))}
      </div>
    </section>
  );
}
