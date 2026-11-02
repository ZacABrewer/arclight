import type { PlayableItem } from '@arclight/shared';

// Loudness: the user's volume times ReplayGain (from the file's tags) times the sleep-timer
// fade. With Web Audio a GainNode carries it (and may lift quiet tracks a little above unity);
// without it the element's volume does, clamped to 0..1.

export type ReplayGainMode = 'off' | 'track' | 'album';
export const REPLAY_GAIN_MODES: readonly ReplayGainMode[] = ['off', 'track', 'album'];

/** Never boost more than this through a GainNode (about +3.5 dB) so loud masters do not clip. */
export const MAX_NODE_GAIN = 1.5;

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/** Linear ReplayGain factor for an item: track or album gain, falling back to the other. */
export function replayGainFactor(item: Pick<PlayableItem, 'replayGain'> | null | undefined, mode: ReplayGainMode): number {
  if (mode === 'off' || !item?.replayGain) return 1;
  const { trackGainDb, albumGainDb } = item.replayGain;
  const db = mode === 'track' ? (trackGainDb ?? albumGainDb) : (albumGainDb ?? trackGainDb);
  return db === null || db === undefined || !Number.isFinite(db) ? 1 : dbToLinear(db);
}

export interface LevelInput {
  volume: number;
  muted: boolean;
  replayGain: number;
  fade: number;
}

/** The level to apply; `node` allows a little boost, the element is clamped to 0..1. */
export function outputLevel({ volume, muted, replayGain, fade }: LevelInput, node: boolean): number {
  if (muted) return 0;
  const level = Math.max(0, volume) * replayGain * Math.max(0, Math.min(1, fade));
  return Math.min(level, node ? MAX_NODE_GAIN : 1);
}

/** The part of the Web Audio API the engine uses (kept small so tests can fake it). */
export interface AudioContextLike {
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  createMediaElementSource(el: unknown): { connect(node: unknown): unknown };
  createGain(): { gain: { value: number }; connect(node: unknown): unknown };
}

/** A real AudioContext where the browser has one; null otherwise (element volume instead). */
export function defaultAudioContext(): AudioContextLike | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }).AudioContext ??
    (window as unknown as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}
