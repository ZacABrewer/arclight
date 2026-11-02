import { Link } from '@tanstack/react-router';
import type { CSSProperties } from 'react';
import { t } from '../../../i18n/index.js';
import { usePlayer } from '../player-context.js';
import { BOOK_SKIP_MS } from '../engine/media-session.js';
import { Artwork } from './parts.js';
import { PlayerIcon } from './player-icons.js';

/**
 * The bar docked at the bottom of every /player page: cover, title, play / pause, next (or
 * ±30 s for audiobooks) and a thin progress line. The cover and titles open Now playing.
 */
export function MiniPlayer() {
  const { state, toggle, next, skip } = usePlayer();
  const item = state.current;
  if (!item) return null;
  const book = item.kind === 'audiobook';
  const chapter = book && state.chapterIndex >= 0 ? item.chapters[state.chapterIndex]?.title : null;
  const pct = state.durationMs > 0 ? Math.min(100, (state.positionMs / state.durationMs) * 100) : 0;
  return (
    <section className="pl-mini" aria-label={t('player.mini.label')} style={{ '--pl-p': `${pct}%` } as CSSProperties}>
      <div
        className="pl-mini__progress"
        role="progressbar"
        aria-label={t('player.mini.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      />
      <Link to="/player/now-playing" className="pl-mini__open" aria-label={t('player.mini.open', { title: item.title })}>
        <Artwork url={item.artworkUrl} className="pl-mini__art" />
        <span className="pl-mini__text">
          <span className="pl-mini__title">{item.title}</span>
          <span className="pl-mini__sub">{chapter ?? item.subtitle ?? ''}</span>
        </span>
      </Link>
      <div className="pl-mini__controls">
        {book ? (
          <button type="button" className="pl-btn" onClick={() => skip(-BOOK_SKIP_MS)} aria-label={t('player.controls.back30')}>
            <PlayerIcon name="back30" />
          </button>
        ) : null}
        <button
          type="button"
          className="pl-btn pl-btn--primary"
          onClick={toggle}
          aria-label={state.playing ? t('player.controls.pause') : t('player.controls.play')}
          aria-busy={state.buffering || state.loading || undefined}
        >
          <PlayerIcon name={state.playing ? 'pause' : 'play'} />
        </button>
        {book ? (
          <button type="button" className="pl-btn" onClick={() => skip(BOOK_SKIP_MS)} aria-label={t('player.controls.forward30')}>
            <PlayerIcon name="forward30" />
          </button>
        ) : (
          <button type="button" className="pl-btn" onClick={next} aria-label={t('player.controls.next')} disabled={state.queueIndex >= state.queue.length - 1 && state.repeat === 'off'}>
            <PlayerIcon name="next" />
          </button>
        )}
      </div>
    </section>
  );
}
