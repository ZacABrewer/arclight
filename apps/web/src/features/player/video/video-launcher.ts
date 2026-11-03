import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { watchPaths } from './paths.js';

// The one way to start a movie or an episode. Every play button on the Movies & TV pages calls
// `openVideo` (through `useOpenVideo`, which supplies the router's navigate). On the web the
// default opens the full-screen player page (/player/watch/play/$itemKey); the Arclight app
// swaps in its native player once at start-up:
//
//   import { setVideoLauncher } from '@web/features/player/video/video-launcher';
//   setVideoLauncher(async (itemKey, opts) => { ...ArclightPlayer.playVideo(...) });
//
// `setVideoLauncher(null)` (or calling the returned function) restores the default.

export interface OpenVideoOptions {
  /** Media time to start at. Omitted: the saved place (the player asks between 2 % and 90 %). */
  startMs?: number | undefined;
  /** Start from the beginning even when there is a saved place (Restart). */
  restart?: boolean | undefined;
  /** A specific version (media_files.id); omitted: the best version. */
  mediaFileId?: number | undefined;
  /** Router navigation, filled in by `useOpenVideo`; the default launcher uses it. */
  navigate?: ((target: { to: string; search: PlaySearch }) => void) | undefined;
}

/** Search params of the play page. */
export interface PlaySearch {
  /** Start ms. */
  t?: number;
  /** media_files.id of the version. */
  file?: number;
  restart?: 1;
}

export function playSearch(opts: OpenVideoOptions = {}): PlaySearch {
  const s: PlaySearch = {};
  if (opts.restart) s.restart = 1;
  else if (opts.startMs !== undefined && opts.startMs > 0) s.t = Math.floor(opts.startMs);
  if (opts.mediaFileId !== undefined) s.file = opts.mediaFileId;
  return s;
}

export type VideoLauncher = (itemKey: string, opts: OpenVideoOptions) => void | Promise<void>;

/** The play page URL with its options as search params (t = start ms, file, restart). */
export function playHref(itemKey: string, opts: OpenVideoOptions = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(playSearch(opts))) q.set(k, String(v));
  const qs = q.toString();
  return qs ? `${watchPaths.play(itemKey)}?${qs}` : watchPaths.play(itemKey);
}

/** The web default: open the player page. */
export const defaultVideoLauncher: VideoLauncher = (itemKey, opts) => {
  if (opts.navigate) opts.navigate({ to: watchPaths.play(itemKey), search: playSearch(opts) });
  else if (typeof window !== 'undefined') window.location.assign(playHref(itemKey, opts));
};

let override: VideoLauncher | null = null;

/** Replace how videos open (the app's native player). Returns a function that restores the previous one. */
export function setVideoLauncher(launcher: VideoLauncher | null): () => void {
  const previous = override;
  override = launcher;
  return () => {
    if (override === launcher) override = previous;
  };
}

/** The launcher in effect. */
export function getVideoLauncher(): VideoLauncher {
  return override ?? defaultVideoLauncher;
}

/** Start a movie or episode ("movie:12", "episode:40"). */
export function openVideo(itemKey: string, opts: OpenVideoOptions = {}): void | Promise<void> {
  return getVideoLauncher()(itemKey, opts);
}

/** `openVideo` bound to the router, for components. */
export function useOpenVideo(): (itemKey: string, opts?: Omit<OpenVideoOptions, 'navigate'>) => void {
  const navigate = useNavigate();
  return useCallback(
    (itemKey, opts = {}) => {
      // The /player child routes are registered untyped (router.tsx), hence the casts.
      const go = ({ to, search }: { to: string; search: PlaySearch }) => void navigate({ to: to as never, search: search as never });
      void Promise.resolve(openVideo(itemKey, { ...opts, navigate: go })).catch(() => undefined);
    },
    [navigate],
  );
}
