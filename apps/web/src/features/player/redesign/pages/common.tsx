import { useCallback, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { PlayerAudiobook, VideoCard, VideoProgress } from '@arclight/shared';
import { errorMessage } from '../../../../api/client.js';
import { cx } from '../../../../arclight/cx.js';
import { useT } from '../../../../i18n/index.js';
import { browseKeys, playerBrowseApi } from '../../browse/api.js';
import { usePlayerActions } from '../../browse/player-hooks.js';
import { cardHref } from '../../video/cards.js';
import { useOpenVideo } from '../../video/video-launcher.js';
import { useRuntimeLabel } from '../meta-line.js';

// Pieces the redesigned pages share: tile subs in the template's wording, the resume point,
// starting audio from a tile (it opens Now playing, the template's Listen screen) and the page
// frame with its loading / error states.

/** 0-1 of a card's progress; 0 when unstarted or played. */
export function shareOf(p: VideoProgress | null | undefined): number {
  if (!p || p.played || p.durationMs <= 0 || p.positionMs <= 0) return 0;
  return Math.min(1, p.positionMs / p.durationMs);
}

/** Minutes left of a progress, or 0. */
export function minutesLeft(p: VideoProgress | null | undefined): number {
  if (!p || p.durationMs <= 0) return 0;
  return Math.max(0, (p.durationMs - p.positionMs) / 60_000);
}

/** The first card of each show (the server lists up to three new episodes per show; a row of
 *  the same show's tile three times over reads as a glitch). Movies pass through. */
export function onePerSeries<T extends { kind: string; id: number; seriesId?: number | undefined }>(cards: readonly T[]): T[] {
  const seen = new Set<string>();
  return cards.filter((c) => {
    const key = c.seriesId !== undefined ? `series:${c.seriesId}` : `${c.kind}:${c.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Subs under tiles: "S2 · E5 · 27m left", "27m left", "S3 · New episode", the server's subtitle or the year. */
export function useCardSubs() {
  const t = useT();
  const runtime = useRuntimeLabel();
  const left = (p: VideoProgress | null | undefined) => t('player.redesign.timeLeft', { time: runtime(minutesLeft(p)) });
  return {
    continueSub(card: VideoCard): string {
      const hasLeft = shareOf(card.progress) > 0;
      if (card.kind === 'episode' && card.seasonNumber !== undefined && card.episodeNumber !== undefined) {
        return hasLeft
          ? t('player.redesign.sub.episodeLeft', { season: card.seasonNumber, episode: card.episodeNumber, time: runtime(minutesLeft(card.progress)) })
          : t('player.redesign.sub.episode', { season: card.seasonNumber, episode: card.episodeNumber });
      }
      return hasLeft ? left(card.progress) : (card.subtitle ?? (card.year ? String(card.year) : ''));
    },
    newEpisodeSub(card: VideoCard): string {
      return card.seasonNumber !== undefined ? t('player.redesign.sub.newEpisode', { season: card.seasonNumber }) : (card.subtitle ?? '');
    },
    plainSub(card: VideoCard): string {
      if (card.kind === 'series') return card.subtitle ?? (card.year ? String(card.year) : '');
      return card.year ? String(card.year) : (card.subtitle ?? '');
    },
    bookLeft(book: PlayerAudiobook): string {
      const pos = book.progress?.positionMs ?? 0;
      return t('player.redesign.timeLeft', { time: runtime(Math.max(0, book.durationMs - pos) / 60_000) });
    },
  };
}

/** Where a card goes: Continue Watching plays; everything else opens the title. */
export function useCardActions() {
  const open = useOpenVideo();
  return {
    href: (card: VideoCard) => cardHref(card),
    play: (card: VideoCard) => {
      if (!card.itemKey) return;
      const p = card.progress;
      open(card.itemKey, p && shareOf(p) > 0 ? { startMs: p.positionMs } : {});
    },
  };
}

/** Start an album or an audiobook from a tile and open Now playing (the template's Listen screen). */
export function useListen() {
  const actions = usePlayerActions();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toNowPlaying = useCallback(() => void navigate({ to: '/player/now-playing' as '/player' }), [navigate]);
  return {
    album: async (albumId: number) => {
      const album = await qc.fetchQuery({ queryKey: browseKeys.album(albumId), queryFn: () => playerBrowseApi.album(albumId) });
      const keys = album.tracks.map((x) => x.itemKey);
      if (!keys.length) return;
      actions.playItems(keys, { source: `album:${albumId}` });
      toNowPlaying();
    },
    item: (itemKey: string) => {
      actions.playItem(itemKey);
      toNowPlaying();
    },
  };
}

/** The page's container: wide pages leave room for the fixed header; portrait ones for the bars. */
export function RdPage({ children, className, label }: { children: ReactNode; className?: string | undefined; label?: string | undefined }) {
  return (
    <div className={cx('rd-page', className)} aria-label={label}>
      {children}
    </div>
  );
}

export function RdLoading() {
  const t = useT();
  return (
    <div className="rd-loading" role="status" aria-live="polite">
      <span className="rd-loading__bar" />
      <span className="rd-loading__bar" />
      <span className="rd-loading__bar" />
      <span className="rd-visually-hidden">{t('player.browse.loading')}</span>
    </div>
  );
}

/** A load failure: what failed, why (the server's or the network's own message) and a retry. */
export function RdError({ title, error, onRetry }: { title: string; error?: unknown; onRetry: () => void }) {
  const t = useT();
  const reason = error == null ? '' : errorMessage(error).trim();
  return (
    <div className="rd-empty" role="alert">
      <p className="rd-empty__title">{title}</p>
      {reason ? <p className="rd-empty__body">{reason}</p> : null}
      <button type="button" className="rd-btn rd-btn--secondary" onClick={onRetry}>
        {t('player.redesign.retry')}
      </button>
    </div>
  );
}
