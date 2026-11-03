import { describe, expect, it, vi } from 'vitest';
import { book, track } from '@web/features/player/test-utils';
import type { PlayerController, PlayerState } from '@web/features/player/player-controller';
import { SLEEP_FADE_MS } from '@web/features/player/engine/sleep-timer';
import type { ArclightPlayerPlugin, NativeSleepTimer } from '../native/definitions';
import { NativeSleepSync } from './native-sleep';

function harness(initial: Partial<PlayerState>) {
  let state = { current: track(1), playing: true, positionMs: 0, speed: 1, sleepTimer: null, ...initial } as PlayerState;
  const listeners = new Set<() => void>();
  const controller = {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getState: () => state,
    setSleepTimer: vi.fn(),
    pause: vi.fn(),
    adjustSleepTimer: vi.fn(),
  };
  const timers: NativeSleepTimer[] = [];
  const fired = new Set<() => void>();
  const plugin = {
    setSleepTimer: async ({ timer }: { timer: NativeSleepTimer }) => void timers.push(timer),
    addListener: async (name: string, l: () => void) => {
      if (name === 'sleepTimerFired') fired.add(l);
      return { remove: async () => void fired.delete(l) };
    },
  };
  const engine = { nativeTrackId: vi.fn((i: number) => `track:1#${i}~1`), setNativeFade: vi.fn() };
  let now = 1_000_000;
  const sync = new NativeSleepSync({
    plugin: plugin as unknown as ArclightPlayerPlugin,
    controller: controller as unknown as PlayerController,
    engine,
    now: () => now,
  });
  return {
    sync,
    controller,
    engine,
    timers,
    set(next: Partial<PlayerState>) {
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    advance: (ms: number) => (now += ms),
    fire: () => fired.forEach((l) => l()),
    now: () => now,
  };
}

describe('NativeSleepSync', () => {
  it('arms the native timer while a minutes timer runs and playback plays, cancels on pause', () => {
    const h = harness({});
    expect(h.timers).toEqual([]);
    h.set({ sleepTimer: { kind: 'minutes', minutes: 15, remainingMs: 900_000 } });
    expect(h.timers.at(-1)).toEqual({ kind: 'minutes', endsAt: h.now() + 900_000, fadeMs: SLEEP_FADE_MS });
    expect(h.engine.setNativeFade).toHaveBeenLastCalledWith(true);
    // The controller ticking does not re-arm.
    h.advance(1_000);
    h.set({ sleepTimer: { kind: 'minutes', minutes: 15, remainingMs: 899_000 } });
    expect(h.timers).toHaveLength(1);
    // Paused: native would keep counting, so cancel.
    h.set({ playing: false });
    expect(h.timers.at(-1)).toBeNull();
    expect(h.engine.setNativeFade).toHaveBeenLastCalledWith(false);
    h.set({ playing: true });
    expect(h.timers.at(-1)).toMatchObject({ kind: 'minutes', endsAt: h.now() + 899_000 });
    h.set({ sleepTimer: null });
    expect(h.timers.at(-1)).toBeNull();
  });

  it('arms "end of track" when an end-of-chapter timer ends with the file', () => {
    const h = harness({ current: book(), positionMs: 1_000_000 });
    // "Middle" ends at 2,400,000, inside the second file: native cannot stop there.
    h.set({ positionMs: 1_300_000, sleepTimer: { kind: 'chapter', minutes: null, remainingMs: 1_100_000 } });
    expect(h.timers).toEqual([]);
    // A track: the end of the item is the end of its only file.
    h.set({ current: track(1), positionMs: 60_000, sleepTimer: { kind: 'chapter', minutes: null, remainingMs: 120_000 } });
    expect(h.timers.at(-1)).toEqual({ kind: 'endOfTrack', trackId: 'track:1#0~1' });
    expect(h.engine.nativeTrackId).toHaveBeenLastCalledWith(0);
  });

  it('turns the timer off and pauses when native fired it', () => {
    const h = harness({ sleepTimer: { kind: 'minutes', minutes: 5, remainingMs: 300_000 } });
    h.fire();
    expect(h.controller.setSleepTimer).toHaveBeenCalledWith(null);
    expect(h.controller.pause).toHaveBeenCalled();
    expect(h.engine.setNativeFade).toHaveBeenLastCalledWith(false);
  });

  it('takes native time left back on resume', () => {
    const h = harness({ sleepTimer: { kind: 'minutes', minutes: 5, remainingMs: 300_000 } });
    h.advance(120_000);
    h.sync.onResume();
    expect(h.controller.adjustSleepTimer).toHaveBeenCalledWith(180_000);
  });
});
