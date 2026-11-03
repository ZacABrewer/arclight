import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HouseholdProfile } from '@arclight/shared';
import { stubFetch } from '../browse/test-utils.js';
import { authFor, profile, profilesResponse, PROFILES_API, renderPages } from './profiles-test-utils.js';
import { AvatarMenu } from './shell.js';

// The account menu's "Add profile" (features spec §1.3): the way a single-profile account adds
// its second profile, so only the owner profile sees it, and only below the limit.

afterEach(() => vi.unstubAllGlobals());

const Profiles = () => <h1>Profiles page</h1>;

async function openMenu(profiles: HouseholdProfile[], activeId: number, max = 12) {
  stubFetch({ [PROFILES_API]: profilesResponse(profiles, activeId, max) });
  const active = profiles.find((p) => p.id === activeId)!;
  const result = renderPages('/player', { '/player': () => <AvatarMenu layout="wide" />, '/player/profiles': Profiles }, authFor(active));
  await userEvent.click(await screen.findByRole('button', { name: `Profile menu, ${active.name}` }));
  // Wait for the profiles to load (the Settings item is always there).
  await screen.findByRole('button', { name: 'Settings' });
  return result;
}

describe('AvatarMenu: Add profile', () => {
  it('shows on the owner profile below the limit and opens the new-profile editor', async () => {
    const { router } = await openMenu([profile(1)], 1);
    await userEvent.click(await screen.findByRole('button', { name: 'Add profile' }));
    expect(await screen.findByRole('heading', { name: 'Profiles page' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/player/profiles');
    expect(router.state.location.search).toMatchObject({ manage: 1, add: 1 });
  });

  it('is hidden on a non-owner profile', async () => {
    await openMenu([profile(1), profile(2, { name: 'Kid', isOwner: false })], 2);
    await screen.findByRole('button', { name: 'Owner' });
    expect(screen.queryByRole('button', { name: 'Add profile' })).toBeNull();
  });

  it('is hidden at the limit', async () => {
    await openMenu([profile(1), profile(2, { isOwner: false })], 1, 2);
    await screen.findByRole('button', { name: 'Manage profiles' });
    expect(screen.queryByRole('button', { name: 'Add profile' })).toBeNull();
  });
});
