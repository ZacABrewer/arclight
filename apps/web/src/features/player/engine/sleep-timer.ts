import type { PlayableChapter, PlayableKind } from '@arclight/shared';
import { chapterBounds, chapterIndexAt } from './timeline.js';

// Sleep timer and "rewind a little on resume", kept free of the audio element so they can be
// driven by a fake clock in tests.

/** Presets offered in the sleep menu (minutes). */
export const SLEEP_PRESETS_MIN: readonly number[] = [5, 10, 15, 30, 45, 60, 90, 120];
/** The last stretch fades out over this long. */
export const SLEEP_FADE_MS = 10_000;

export type SleepTimerSetting = { kind: 'minutes'; minutes: number } | { kind: 'chapter' };

export interface SleepTimerState {
  kind: 'minutes' | 'chapter';
  /** Minutes chosen (minutes timers). */
  minutes: number | null;
  /** Listening time left (wall clock while playing; chapter: at the current speed). */
  remainingMs: number;
}

export interface SleepContext {
  now: number;
  /** The item playing; an end-of-chapter timer belongs to the one it was set on. */
  itemKey?: string | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  speed: number;
  chapters: readonly PlayableChapter[];
}

export interface SleepTick {
  remainingMs: number;
  /** 1 = full volume; ramps to 0 over the last SLEEP_FADE_MS. */
  fade: number;
  expired: boolean;
}

/** Volume factor for the time left. */
export function sleepFade(remainingMs: number): number {
  if (remainingMs >= SLEEP_FADE_MS) return 1;
  return Math.max(0, remainingMs / SLEEP_FADE_MS);
}

/**
 * A running timer. Minutes count down only while something plays (pausing pauses the timer);
 * "end of chapter" pins the end of the chapter playing when it was set (the end of the item
 * when there are no chapters) and counts in listening time at the current speed. It is tied to
 * the item it was set on: once playback moves to another item, it has run out.
 */
export class SleepTimer {
  private setting: SleepTimerSetting;
  private leftMs: number;
  private endMs: number;
  private lastTick: number;
  private readonly itemKey: string | null;

  constructor(setting: SleepTimerSetting, ctx: SleepContext) {
    this.setting = setting;
    this.lastTick = ctx.now;
    this.itemKey = ctx.itemKey ?? null;
    if (setting.kind === 'minutes') {
      this.leftMs = Math.max(1, setting.minutes) * 60_000;
      this.endMs = 0;
    } else {
      const index = chapterIndexAt(ctx.chapters, ctx.positionMs);
      const bounds = index >= 0 ? chapterBounds(ctx.chapters, index, ctx.durationMs) : null;
      this.endMs = bounds ? bounds.endMs : ctx.durationMs;
      this.leftMs = this.chapterLeft(ctx);
    }
  }

  get kind(): SleepTimerSetting['kind'] {
    return this.setting.kind;
  }

  get minutes(): number | null {
    return this.setting.kind === 'minutes' ? this.setting.minutes : null;
  }

  /** The pinned end of chapter on the item timeline (chapter timers). */
  get chapterEndMs(): number | null {
    return this.setting.kind === 'chapter' ? this.endMs : null;
  }

  private chapterLeft(ctx: SleepContext): number {
    return Math.max(0, (this.endMs - ctx.positionMs) / Math.max(0.5, ctx.speed));
  }

  /** Minutes timers: set the time left (a native copy of the timer is the reference). */
  setRemaining(remainingMs: number, now: number): void {
    if (this.setting.kind !== 'minutes') return;
    this.leftMs = Math.max(0, remainingMs);
    this.lastTick = now;
  }

  tick(ctx: SleepContext): SleepTick {
    const elapsed = Math.max(0, ctx.now - this.lastTick);
    this.lastTick = ctx.now;
    if (this.setting.kind === 'minutes') {
      if (ctx.playing) this.leftMs = Math.max(0, this.leftMs - elapsed);
    } else if (this.itemKey !== null && ctx.itemKey != null && ctx.itemKey !== this.itemKey) {
      // The item ended (or was left): that was the end of "this chapter".
      this.leftMs = 0;
    } else {
      this.leftMs = this.chapterLeft(ctx);
    }
    return { remainingMs: this.leftMs, fade: sleepFade(this.leftMs), expired: this.leftMs <= 0 };
  }

  state(): SleepTimerState {
    return { kind: this.setting.kind, minutes: this.minutes, remainingMs: this.leftMs };
  }
}

/** After a pause this long, an audiobook resumes a little earlier. */
export const REWIND_AFTER_PAUSE_MS = 5 * 60_000;
export const REWIND_ON_RESUME_MS = 10_000;

/** How far back to jump when resuming (audiobooks only, after a long pause). */
export function rewindOnResumeMs(kind: PlayableKind | null | undefined, pausedAt: number | null, now: number): number {
  if (kind !== 'audiobook' || pausedAt === null) return 0;
  return now - pausedAt > REWIND_AFTER_PAUSE_MS ? REWIND_ON_RESUME_MS : 0;
}
