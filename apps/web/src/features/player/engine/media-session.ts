import type { PlayableItem } from '@arclight/shared';

// Lock-screen and hardware-key controls through the Media Session API. Audiobooks get ±30 s
// (seekbackward / seekforward) instead of next / previous track, as in the plan (3.4).

export interface MediaSessionControls {
  play: () => void;
  pause: () => void;
  seekTo: (ms: number) => void;
  skip: (deltaMs: number) => void;
  next: () => void;
  previous: () => void;
}

export const BOOK_SKIP_MS = 30_000;

type Action = 'play' | 'pause' | 'seekto' | 'seekforward' | 'seekbackward' | 'nexttrack' | 'previoustrack' | 'stop';

interface SessionLike {
  metadata: unknown;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler(action: Action, handler: ((details: { seekTime?: number; seekOffset?: number }) => void) | null): void;
  setPositionState?(state: { duration: number; position: number; playbackRate: number }): void;
}

function session(): SessionLike | null {
  if (typeof navigator === 'undefined') return null;
  return ((navigator as unknown as { mediaSession?: SessionLike }).mediaSession ?? null);
}

function setHandler(s: SessionLike, action: Action, handler: ((details: { seekTime?: number; seekOffset?: number }) => void) | null): void {
  try {
    s.setActionHandler(action, handler);
  } catch {
    // The browser does not know this action.
  }
}

/** Bind the actions for the kind playing now; returns an unbind function. */
export function bindMediaSession(kind: PlayableItem['kind'] | null, controls: MediaSessionControls): () => void {
  const s = session();
  if (!s) return () => undefined;
  const book = kind === 'audiobook';
  setHandler(s, 'play', () => controls.play());
  setHandler(s, 'pause', () => controls.pause());
  setHandler(s, 'stop', () => controls.pause());
  setHandler(s, 'seekto', (d) => {
    if (typeof d.seekTime === 'number') controls.seekTo(d.seekTime * 1000);
  });
  setHandler(s, 'seekbackward', book ? (d) => controls.skip(-(d.seekOffset ? d.seekOffset * 1000 : BOOK_SKIP_MS)) : null);
  setHandler(s, 'seekforward', book ? (d) => controls.skip(d.seekOffset ? d.seekOffset * 1000 : BOOK_SKIP_MS) : null);
  setHandler(s, 'nexttrack', book ? null : () => controls.next());
  setHandler(s, 'previoustrack', book ? null : () => controls.previous());
  return () => {
    for (const a of ['play', 'pause', 'stop', 'seekto', 'seekforward', 'seekbackward', 'nexttrack', 'previoustrack'] as const) setHandler(s, a, null);
  };
}

/** Artwork for the lock screen: absolute URLs (some platforms ignore relative ones). */
export function artworkFor(url: string | null): Array<{ src: string; sizes?: string }> {
  if (!url) return [];
  try {
    const abs = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href).href;
    return [{ src: abs, sizes: '512x512' }];
  } catch {
    return [];
  }
}

export function updateMediaMetadata(item: PlayableItem | null, chapterTitle?: string | null): void {
  const s = session();
  if (!s) return;
  const Ctor = (globalThis as unknown as { MediaMetadata?: new (init: object) => unknown }).MediaMetadata;
  if (!item) {
    s.metadata = null;
    s.playbackState = 'none';
    return;
  }
  const init = {
    title: item.kind === 'audiobook' && chapterTitle ? chapterTitle : item.title,
    artist: item.subtitle ?? '',
    album: item.kind === 'audiobook' ? item.title : (item.context ?? ''),
    artwork: artworkFor(item.artworkUrl),
  };
  try {
    s.metadata = Ctor ? new Ctor(init) : init;
  } catch {
    // Older engines without MediaMetadata.
  }
}

export function updateMediaPlayback(playing: boolean, positionMs: number, durationMs: number, speed: number): void {
  const s = session();
  if (!s) return;
  s.playbackState = playing ? 'playing' : 'paused';
  if (!s.setPositionState || durationMs <= 0) return;
  try {
    s.setPositionState({ duration: durationMs / 1000, position: Math.min(positionMs, durationMs) / 1000, playbackRate: speed });
  } catch {
    // Position outside the duration while a part loads: skip this update.
  }
}
