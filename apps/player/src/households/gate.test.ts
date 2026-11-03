import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { HouseholdProfilesResponse } from '@arclight/shared';
import { shouldShowPicker } from './gate';
import { markPicked } from './state';

const res = (n: number) => ({ profiles: Array.from({ length: n }, (_, i) => ({ id: `p${i}` })) }) as unknown as HouseholdProfilesResponse;

describe("shouldShowPicker (Who's watching? before the first page)", () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('shows for two or more profiles, once per run', async () => {
    expect(await shouldShowPicker(qc, 'acc', async () => res(2), sessionStorage)).toBe(true);
    markPicked('acc', sessionStorage);
    expect(await shouldShowPicker(qc, 'acc', async () => res(2), sessionStorage)).toBe(false);
  });

  it('skips with a single profile', async () => {
    expect(await shouldShowPicker(qc, 'acc', async () => res(1), sessionStorage)).toBe(false);
  });

  it('goes straight in when the server has no households or is unreachable', async () => {
    const fail = vi.fn(async () => {
      throw new Error('404');
    });
    expect(await shouldShowPicker(qc, 'acc', fail, sessionStorage)).toBe(false);
  });
});
