import type { VideoQuality } from '@arclight/shared';

// Streaming quality is a device setting per profile (spec §4.3, §9 Q18/Q19):
// localStorage['arclight.quality.<profileId>'], Auto / Original / 1080p / 720p / 480p.

export const VIDEO_QUALITIES: readonly VideoQuality[] = ['auto', 'original', '1080p', '720p', '480p'];

const key = (profileId: number | string | null | undefined) => `arclight.quality.${profileId ?? 'owner'}`;

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readVideoQuality(profileId: number | string | null | undefined, s: Storage | null = store()): VideoQuality {
  try {
    const v = s?.getItem(key(profileId));
    return VIDEO_QUALITIES.includes(v as VideoQuality) ? (v as VideoQuality) : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeVideoQuality(profileId: number | string | null | undefined, q: VideoQuality, s: Storage | null = store()): void {
  try {
    s?.setItem(key(profileId), q);
  } catch {
    // Blocked storage: the choice lasts until the page is reloaded.
  }
}

/** The active profile id, as the app last saw it (set by the profile hooks). */
let activeProfileId: number | null = null;
export const setActiveProfileId = (id: number | null): void => {
  activeProfileId = id;
};
export const currentVideoQuality = (): VideoQuality => readVideoQuality(activeProfileId);
