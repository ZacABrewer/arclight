import { afterEach, describe, expect, it } from 'vitest';
import { setSession } from '../core/session';
import { currentVideoQuality, readVideoQuality, setActiveProfileId, writeVideoQuality } from './quality';

// Streaming quality per account and profile: profile ids repeat across servers.

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

afterEach(() => {
  setSession(null);
  setActiveProfileId(null);
});

describe('video quality', () => {
  it('keeps a choice per account and profile', () => {
    const s = memory();
    writeVideoQuality(1, '720p', s, 'a_one');
    expect(readVideoQuality(1, s, 'a_one')).toBe('720p');
    // The same profile id on another account (another server) has its own choice.
    expect(readVideoQuality(1, s, 'a_two')).toBe('auto');
    expect(readVideoQuality(2, s, 'a_one')).toBe('auto');
    s.setItem('arclight.quality.a_one.3', 'nonsense');
    expect(readVideoQuality(3, s, 'a_one')).toBe('auto');
  });

  it('defaults to the active account', () => {
    setSession({ accountId: 'a_live', serverUrl: 'https://music.example.com', token: 't', deviceId: null });
    writeVideoQuality(5, '480p');
    expect(readVideoQuality(5, undefined, 'a_live')).toBe('480p');
    setActiveProfileId(5);
    expect(currentVideoQuality()).toBe('480p');
    setSession({ accountId: 'a_other', serverUrl: 'https://music.example.com', token: 't', deviceId: null });
    expect(currentVideoQuality()).toBe('auto');
    localStorage.clear();
  });
});
