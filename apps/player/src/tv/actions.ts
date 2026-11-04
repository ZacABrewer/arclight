import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { VideoCard, VideoProgress } from '@arclight/shared';
import { browseKeys, playerBrowseApi } from '@web/features/player/browse/api';
import { usePlayer } from '@web/features/player/player-context';
import { watchPaths } from '@web/features/player/video/paths';
import { useOpenVideo } from '@web/features/player/video/video-launcher';
import type { Translate } from './format';
import { left, leftLabel } from './format';

// What the TV tiles do (the template's openTitle / playTitle / startAudio): video titles open their
// detail, Continue Watching plays, albums / artists / audiobooks start playing and open Listen.

export const LISTEN_PATH = '/player/now-playing';

const resuming = (p: VideoProgress | null | undefined) => Boolean(p && !p.played && p.positionMs > 0);

export function useVideoActions() {
  const navigate = useNavigate();
  const open = useOpenVideo();
  const openTitle = useCallback(
    (kind: 'movie' | 'series', id: number) => void navigate({ to: kind === 'movie' ? watchPaths.movie(id) : watchPaths.show(id) }),
    [navigate],
  );
  /** Plays, resuming where it was left; `mediaFileId` picks a version (omitted: the best one). */
  const play = useCallback(
    (itemKey: string, progress?: VideoProgress | null, mediaFileId?: number) =>
      open(itemKey, { ...(resuming(progress) && progress ? { startMs: progress.positionMs } : {}), ...(mediaFileId !== undefined ? { mediaFileId } : {}) }),
    [open],
  );
  const restart = useCallback((itemKey: string, mediaFileId?: number) => open(itemKey, { startMs: 0, restart: true, ...(mediaFileId !== undefined ? { mediaFileId } : {}) }), [open]);
  /** A card: episodes / Continue Watching play; series and movies open their detail. */
  const openCard = useCallback(
    (card: VideoCard, playIt = false) => {
      if (playIt && card.itemKey) return play(card.itemKey, card.progress);
      if (card.kind === 'episode') return card.seriesId ? openTitle('series', card.seriesId) : card.itemKey ? play(card.itemKey, card.progress) : undefined;
      return openTitle(card.kind, card.id);
    },
    [openTitle, play],
  );
  return { openTitle, play, restart, openCard };
}

export function useAudioActions() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { playItems } = usePlayer();
  const toListen = useCallback(() => void navigate({ to: LISTEN_PATH }), [navigate]);
  const startAlbum = useCallback(
    async (albumId: number) => {
      const album = await qc.fetchQuery({ queryKey: browseKeys.album(albumId), queryFn: () => playerBrowseApi.album(albumId) });
      if (!album.tracks.length) return;
      playItems(
        album.tracks.map((t) => t.itemKey),
        { source: `album:${albumId}` },
      );
      toListen();
    },
    [qc, playItems, toListen],
  );
  const startArtist = useCallback(
    async (artistId: number) => {
      const artist = await qc.fetchQuery({ queryKey: browseKeys.artist(artistId), queryFn: () => playerBrowseApi.artist(artistId) });
      const first = artist.albums[0];
      if (artist.topTracks.length) {
        playItems(
          artist.topTracks.map((t) => t.itemKey),
          { source: `artist:${artistId}` },
        );
        toListen();
      } else if (first) await startAlbum(first.id);
    },
    [qc, playItems, toListen, startAlbum],
  );
  const startBook = useCallback(
    (book: { id: number; itemKey: string }) => {
      // No startMs: the player resumes from the saved place.
      playItems([book.itemKey], { source: `audiobook:${book.id}` });
      toListen();
    },
    [playItems, toListen],
  );
  return { startAlbum, startArtist, startBook };
}

/** The template's tile subs. */
export function cardSub(card: VideoCard, t: Translate): string | null {
  if (card.kind === 'episode') return card.subtitle;
  return card.year ? String(card.year) : null;
}

/** Continue Watching: "S2 · E5 · 27m left" / "27m left". */
export function continueSub(card: VideoCard, t: Translate): string | null {
  const l = leftLabel(card.progress, t);
  if (card.kind === 'episode' && card.seasonNumber != null && card.episodeNumber != null) {
    return [`S${card.seasonNumber}`, `E${card.episodeNumber}`, l].filter(Boolean).join(' · ');
  }
  return l;
}

/** Focus v2's dwell strip: the episode ("S1:E2 · Pilot"), else year · network · badges. */
export function cardMeta(card: VideoCard): string | null {
  if (card.kind === 'episode') return card.subtitle;
  const parts = [card.year ? String(card.year) : null, card.subtitle, ...card.badges].filter((x): x is string => !!x);
  return parts.length ? parts.join(' · ') : null;
}

export function cardArt(card: VideoCard): string | null {
  return card.kind === 'episode' ? (card.thumbUrl ?? card.backdropUrl ?? card.posterUrl) : (card.backdropUrl ?? card.thumbUrl ?? card.posterUrl);
}

/** "X left" for an audiobook, from its saved progress. */
export function bookLeft(p: { positionMs: number; durationMs: number } | null | undefined, durationMs: number, t: Translate): string | null {
  if (!p || p.positionMs <= 0) return null;
  const total = p.durationMs > 0 ? p.durationMs : durationMs;
  return t('app.tv.left', { time: left(Math.max(0, total - p.positionMs) / 1000) });
}
