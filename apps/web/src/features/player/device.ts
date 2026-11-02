// Small local-storage helpers for the player. Storage can be missing or throw (private windows,
// blocked site data), so every access is wrapped and falls back to memory.

const memory = new Map<string, string>();

export function readStored(key: string): string | null {
  try {
    const v = window.localStorage.getItem(key);
    if (v !== null) return v;
  } catch {
    // Fall back to memory.
  }
  return memory.get(key) ?? null;
}

export function writeStored(key: string, value: string): void {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Memory only.
  }
}

export const DEVICE_ID_KEY = 'arclight.player.deviceId';

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Fall through.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Stable per browser install: random, kept in local storage (max 64 chars, the contract's limit). */
export function deviceId(): string {
  const stored = readStored(DEVICE_ID_KEY);
  if (stored && stored.length > 0 && stored.length <= 64) return stored;
  const id = `web-${randomId()}`.slice(0, 64);
  writeStored(DEVICE_ID_KEY, id);
  return id;
}

/** "Firefox", "Safari", ...: a readable device name for "last played on". */
export function browserName(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/edg\//i.test(userAgent)) return 'Edge';
  if (/firefox|fxios/i.test(userAgent)) return 'Firefox';
  if (/chrome|crios|chromium/i.test(userAgent)) return 'Chrome';
  if (/safari/i.test(userAgent)) return 'Safari';
  return 'Browser';
}

export interface PlayerPrefs {
  volume: number;
  muted: boolean;
  replayGain: 'off' | 'track' | 'album';
}

const PREFS_KEY = 'arclight.player.prefs';
export const DEFAULT_PREFS: PlayerPrefs = { volume: 1, muted: false, replayGain: 'off' };

export function loadPrefs(): PlayerPrefs {
  try {
    const raw = readStored(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<PlayerPrefs>;
    return {
      volume: typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1 ? p.volume : DEFAULT_PREFS.volume,
      muted: typeof p.muted === 'boolean' ? p.muted : false,
      replayGain: p.replayGain === 'track' || p.replayGain === 'album' ? p.replayGain : 'off',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: PlayerPrefs): void {
  writeStored(PREFS_KEY, JSON.stringify(p));
}
