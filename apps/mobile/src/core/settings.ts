import { KEYS } from '../config.js';
import { readJson, writeJson, type KeyValueStore } from './kv.js';

export interface AppSettings {
  /** Face ID / Touch ID / fingerprint on launch and after being in the background. Off by default. */
  biometricLock: boolean;
  /** Minutes in the background before the lock is asked again (0 = every time). */
  lockAfterMinutes: number;
}

export const DEFAULT_SETTINGS: AppSettings = { biometricLock: false, lockAfterMinutes: 5 };
export const LOCK_AFTER_CHOICES = [0, 1, 5, 15, 60] as const;

export async function loadSettings(kv: KeyValueStore): Promise<AppSettings> {
  const s = await readJson<Partial<AppSettings>>(kv, KEYS.settings);
  return {
    biometricLock: typeof s?.biometricLock === 'boolean' ? s.biometricLock : DEFAULT_SETTINGS.biometricLock,
    lockAfterMinutes: typeof s?.lockAfterMinutes === 'number' && s.lockAfterMinutes >= 0 ? s.lockAfterMinutes : DEFAULT_SETTINGS.lockAfterMinutes,
  };
}

export const saveSettings = (kv: KeyValueStore, s: AppSettings) => writeJson(kv, KEYS.settings, s);

/** Lock again after returning from the background? */
export function shouldLockOnResume(settings: AppSettings, backgroundedAt: number | null, now: number): boolean {
  if (!settings.biometricLock) return false;
  if (backgroundedAt === null) return false;
  return now - backgroundedAt >= settings.lockAfterMinutes * 60_000;
}
