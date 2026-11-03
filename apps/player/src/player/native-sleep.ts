import type { PluginListenerHandle } from '@capacitor/core';
import { SLEEP_FADE_MS } from '@web/features/player/engine/sleep-timer';
import type { PlayerController } from '@web/features/player/player-controller';
import type { ArclightPlayerPlugin, NativeSleepTimer } from '../native/definitions';
import type { NativeEngine } from './native-engine';

// Mirrors the player's sleep timer (the sleep control in the UI drives the controller) onto the
// native timer, so it still fires while the WebView is suspended in the background. The
// controller stays the source of truth while JS runs; native is the backstop, and its time
// left is taken back when the app returns.

/** An end-of-chapter timer whose end is this close to the end of a file arms "end of track". */
const PART_END_SLACK_MS = 1_500;
/** Re-arm a minutes timer only when its end moved more than this (the controller ticks). */
const REARM_SLACK_MS = 2_000;

export interface NativeSleepDeps {
  plugin: ArclightPlayerPlugin;
  controller: PlayerController;
  engine: Pick<NativeEngine, 'nativeTrackId' | 'setNativeFade'>;
  now?: () => number;
}

type Armed = { kind: 'minutes'; endsAt: number } | { kind: 'endOfTrack'; trackId: string };

export class NativeSleepSync {
  private armed: Armed | null = null;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;
  private listener: Promise<PluginListenerHandle> | null = null;
  private destroyed = false;

  constructor(private readonly deps: NativeSleepDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.unsubscribe = deps.controller.subscribe(() => this.sync());
    this.listener = deps.plugin.addListener('sleepTimerFired', () => this.onFired());
    this.sync();
  }

  /** What native should run for the controller's timer right now (null: nothing). */
  private wanted(): Armed | null {
    const s = this.deps.controller.getState();
    const timer = s.sleepTimer;
    if (!timer || !s.playing || !s.current) return null;
    if (timer.kind === 'minutes') return { kind: 'minutes', endsAt: this.now() + timer.remainingMs };
    // End of chapter: native can only stop at the end of a file.
    const endMs = s.positionMs + timer.remainingMs * (s.speed || 1);
    const parts = s.current.parts;
    const partIndex = parts.findIndex((p) => s.positionMs >= p.startMs && s.positionMs < p.startMs + p.durationMs);
    const part = parts[partIndex];
    if (!part || Math.abs(part.startMs + part.durationMs - endMs) > PART_END_SLACK_MS) return null;
    const trackId = this.deps.engine.nativeTrackId(partIndex);
    return trackId ? { kind: 'endOfTrack', trackId } : null;
  }

  private same(a: Armed | null, b: Armed | null): boolean {
    if (!a || !b) return a === b;
    if (a.kind === 'minutes' && b.kind === 'minutes') return Math.abs(a.endsAt - b.endsAt) <= REARM_SLACK_MS;
    if (a.kind === 'endOfTrack' && b.kind === 'endOfTrack') return a.trackId === b.trackId;
    return false;
  }

  private sync(): void {
    if (this.destroyed) return;
    const want = this.wanted();
    if (this.same(want, this.armed)) return;
    this.armed = want;
    this.deps.engine.setNativeFade(want?.kind === 'minutes');
    const timer: NativeSleepTimer = !want
      ? null
      : want.kind === 'minutes'
        ? { kind: 'minutes', endsAt: Math.round(want.endsAt), fadeMs: SLEEP_FADE_MS }
        : { kind: 'endOfTrack', trackId: want.trackId };
    void this.deps.plugin.setSleepTimer?.({ timer })?.catch(() => undefined);
  }

  private onFired(): void {
    // Native paused already; make the player agree (and turn the timer off in the UI).
    this.armed = null;
    this.deps.engine.setNativeFade(false);
    this.deps.controller.setSleepTimer(null);
    this.deps.controller.pause();
  }

  /** The app came back: take native's time left (it counted while JS was suspended). */
  onResume(): void {
    const armed = this.armed;
    if (armed?.kind === 'minutes') this.deps.controller.adjustSleepTimer(Math.max(0, armed.endsAt - this.now()));
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    void this.listener?.then((h) => h.remove()).catch(() => undefined);
    if (this.armed) void this.deps.plugin.setSleepTimer?.({ timer: null })?.catch(() => undefined);
    this.armed = null;
  }
}
