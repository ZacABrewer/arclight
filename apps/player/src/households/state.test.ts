import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { HouseholdProfile, HouseholdProfilesResponse } from '@arclight/shared';
import { shouldShowPicker } from './gate';
import { isPicked, markPicked, needsPicker } from './state';
import { selectFailure } from './api';
import { ApiError } from '../core/api';

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
    setItem: (k, v) => void m.set(k, v),
  };
}

const profile = (id: number, extra: Partial<HouseholdProfile> = {}) => ({ id, name: `P${id}`, color: '#7c6cf0', initial: 'P', isOwner: id === 1, hasPin: false, ...extra }) as HouseholdProfile;
const res = (n: number): HouseholdProfilesResponse => ({ profiles: Array.from({ length: n }, (_, i) => profile(i + 1)), activeProfileId: 1, canManage: true, max: 12 });

describe('picker state', () => {
  it('needs the picker with two or more profiles until one is picked, per account', () => {
    const s = memory();
    expect(needsPicker(res(1), 'a', s)).toBe(false);
    expect(needsPicker(res(2), 'a', s)).toBe(true);
    markPicked('a', s);
    expect(isPicked('a', s)).toBe(true);
    expect(needsPicker(res(3), 'a', s)).toBe(false);
    expect(needsPicker(res(3), 'b', s)).toBe(true);
  });

  it('asks the server only when nothing was picked yet, and lets you in when it fails', async () => {
    const s = memory();
    let calls = 0;
    const qc = new QueryClient();
    expect(await shouldShowPicker(qc, 'a', async () => (calls++, res(2)), s)).toBe(true);
    qc.clear();
    expect(await shouldShowPicker(qc, 'a', async () => (calls++, res(1)), s)).toBe(false);
    qc.clear();
    expect(await shouldShowPicker(qc, 'a', async () => Promise.reject(new Error('404')), s)).toBe(false);
    markPicked('a', s);
    expect(await shouldShowPicker(qc, 'a', async () => (calls++, res(4)), s)).toBe(false);
    expect(calls).toBe(2);
  });
});

describe('selectFailure', () => {
  it('reads the households error codes', () => {
    expect(selectFailure(new ApiError(401, 'pin-wrong', '/x'))).toEqual({ kind: 'pin-wrong' });
    expect(selectFailure(new ApiError(401, 'pin-required', '/x'))).toEqual({ kind: 'pin-required' });
    expect(selectFailure(new ApiError(429, 'pin-locked', '/x'))).toEqual({ kind: 'pin-locked', retryAfterSeconds: 900 });
    expect(selectFailure(new Error('boom'))).toEqual({ kind: 'other', message: 'boom' });
  });

  it('reads the owner-profile password codes as password-required (the pad cannot take a password)', () => {
    for (const code of ['password-required', 'password-wrong', 'reauth-required']) {
      expect(selectFailure(new ApiError(code === 'reauth-required' ? 403 : 401, code, '/x'))).toEqual({ kind: 'password-required' });
    }
  });
});
