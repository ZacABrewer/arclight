import type { VideoQuality } from '@arclight/shared';
import { getSession } from '../core/session';

// Streaming quality is a device setting per profile (spec §4.3, §9 Q18/Q19):
// localStorage['arclight.quality.<accountId>.<profileId>'], Auto / Original / 1080p / 720p / 480p.
// Profile ids are only unique on one server, so the key carries the account (the active one by
// default) as well.

export const VIDEO_QUALITIES: readonly VideoQuality[] = ['auto', 'original', '1080p', '720p', '480p'];

type Id = number | string | null | undefined;

const key = (accountId: Id, profileId: Id) => `arclight.quality.${accountId ?? 'none'}.${profileId ?? 'owner'}`;
const activeAccount = (): string | null => getSession()?.accountId ?? null;

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readVideoQuality(profileId: Id, s: Storage | null = store(), accountId: Id = activeAccount()): VideoQuality {
  try {
    const v = s?.getItem(key(accountId, profileId));
    return VIDEO_QUALITIES.includes(v as VideoQuality) ? (v as VideoQuality) : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeVideoQuality(profileId: Id, q: VideoQuality, s: Storage | null = store(), accountId: Id = activeAccount()): void {
  try {
    s?.setItem(key(accountId, profileId), q);
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
