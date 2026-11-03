import { Preferences } from '@capacitor/preferences';

/** Minimal async key-value store: Capacitor Preferences in the app, a Map in tests. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

/** Capacitor Preferences (UserDefaults / SharedPreferences; localStorage in a browser). */
export const preferencesStore: KeyValueStore = {
  get: async (key) => (await Preferences.get({ key })).value,
  set: (key, value) => Preferences.set({ key, value }),
  remove: (key) => Preferences.remove({ key }),
};

export async function readJson<T>(kv: KeyValueStore, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const writeJson = (kv: KeyValueStore, key: string, value: unknown) => kv.set(key, JSON.stringify(value));
