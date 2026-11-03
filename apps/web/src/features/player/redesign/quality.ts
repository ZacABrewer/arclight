import type { VideoQuality } from '@arclight/shared';
import { QUALITIES } from '../video/playback.js';

// Streaming quality stays with this browser (redesign spec §4.6, §9 Q19), per profile:
// localStorage['arclight.quality.<profileId>'] ("owner" before households exist).

export const QUALITY_KEY_PREFIX = 'arclight.quality.';

const keyFor = (profileId: number | null | undefined) => `${QUALITY_KEY_PREFIX}${profileId ?? 'owner'}`;

export function readStoredQuality(profileId: number | null | undefined): VideoQuality {
  try {
    const v = localStorage.getItem(keyFor(profileId));
    return v && (QUALITIES as readonly string[]).includes(v) ? (v as VideoQuality) : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeStoredQuality(profileId: number | null | undefined, quality: VideoQuality): void {
  try {
    localStorage.setItem(keyFor(profileId), quality);
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
}
