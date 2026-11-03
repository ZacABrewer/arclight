import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { HouseholdProfile } from '@arclight/shared';
import { householdKeys, householdsApi, selectProfile } from './api';

afterEach(() => vi.restoreAllMocks());

describe('selectProfile', () => {
  it("drops the old profile's cached pages and keeps who is signed in", async () => {
    const kids = { id: 3, name: 'Kids', settings: { reduceMotion: false } } as unknown as HouseholdProfile;
    vi.spyOn(householdsApi, 'select').mockResolvedValue({ activeProfile: kids });
    const qc = new QueryClient();
    qc.setQueryData(['playback', 'video', 'home'], { continueWatching: ['owner-only'] });
    qc.setQueryData(['auth', 'me'], { user: 'a' });
    qc.setQueryData(householdKeys.profiles(), { profiles: [], activeProfileId: 1 });
    await selectProfile(qc, kids);
    expect(qc.getQueryData(['playback', 'video', 'home'])).toBeUndefined();
    expect(qc.getQueryData(['auth', 'me'])).toEqual({ user: 'a' });
    expect(qc.getQueryData(householdKeys.settings())).toEqual(kids.settings);
  });
});
