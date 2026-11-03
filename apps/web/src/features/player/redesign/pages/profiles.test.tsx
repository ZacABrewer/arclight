import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MOVIE_CERTIFICATIONS, type HouseholdProfile } from '@arclight/shared';
import { stubFetch } from '../../browse/test-utils.js';
import { authFor, profile, profilesResponse, PROFILES_API, renderPages } from '../profiles-test-utils.js';
import { RdProfilesPage } from './profiles.js';

// /player/profiles (features spec §1): ?manage=1&add=1 opens the new-profile editor, the editor
// posts everything at once, and Back leaves edit mode before it leaves the picker.

const Home = () => <h1>Home page</h1>;
const pages = { '/player': Home, '/player/profiles': () => <RdProfilesPage /> };

let list: HouseholdProfile[] = [];
let activeId = 1;

beforeEach(() => {
  sessionStorage.clear();
  list = [profile(1)];
  activeId = 1;
});
afterEach(() => vi.unstubAllGlobals());

function stubProfiles() {
  return stubFetch({
    [PROFILES_API]: () => profilesResponse(list, activeId),
    [`POST ${PROFILES_API}`]: (_url: URL, body: unknown) => {
      const b = body as { name: string; color: string; pin?: string | null };
      const created = profile(list.length + 1, { name: b.name, color: b.color, initial: b.name[0]!, isOwner: false, hasPin: Boolean(b.pin) });
      list = [...list, created];
      return created;
    },
  });
}

describe('RdProfilesPage', () => {
  it('?manage=1&add=1 opens the new-profile editor with the first free colour', async () => {
    stubProfiles();
    renderPages('/player/profiles?manage=1&add=1', pages, authFor(list[0]!));
    expect(await screen.findByRole('heading', { name: 'Add profile' })).toBeTruthy();
    // The owner has the first colour: the new profile starts on the second.
    expect(screen.getByRole('button', { name: 'Colour 2' }).getAttribute('aria-pressed')).toBe('true');
    // No Delete on a profile that does not exist yet.
    expect(screen.queryByRole('button', { name: 'Delete profile' })).toBeNull();
  });

  it('create posts the colour, PIN and limits, then the new tile takes focus in edit mode', async () => {
    const calls = stubProfiles();
    renderPages('/player/profiles?manage=1&add=1', pages, authFor(list[0]!));
    await screen.findByRole('heading', { name: 'Add profile' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Robin');
    await userEvent.click(screen.getByRole('button', { name: 'Colour 3' }));
    await userEvent.click(screen.getByRole('switch', { name: /PIN/ }));
    await userEvent.type(screen.getByLabelText('PIN', { selector: 'input' }), '4321');
    await userEvent.click(screen.getByRole('button', { name: /Movie rating limit/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      name: 'Robin',
      initial: 'R',
      color: '#3aa37a',
      pin: '4321',
      contentRestrictions: { maxCertification: { movie: MOVIE_CERTIFICATIONS[0], tv: null } },
    });
    // Back on the picker, still in edit mode, focus on the new tile; nobody was switched to.
    expect(await screen.findByRole('heading', { name: 'Manage profiles' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.getAttribute('data-profile-id')).toBe('2'));
    expect(calls.some((c) => c.path.endsWith('/select'))).toBe(false);
  });

  it('Back in edit mode returns to pick mode, and only then leaves', async () => {
    stubProfiles();
    list = [profile(1), profile(2, { name: 'Kid', isOwner: false })];
    const { router } = renderPages('/player', pages, authFor(list[0]!));
    await screen.findByRole('heading', { name: 'Home page' });
    await router.navigate({ to: '/player/profiles', search: { manage: 1 } as never });
    expect(await screen.findByRole('heading', { name: 'Manage profiles' })).toBeTruthy();
    // The page put pick mode underneath edit mode.
    await waitFor(() => expect(router.history.length).toBe(3));
    router.history.back();
    expect(await screen.findByRole('heading', { name: 'Who’s watching?' })).toBeTruthy();
    router.history.back();
    expect(await screen.findByRole('heading', { name: 'Home page' })).toBeTruthy();
  });

  it('the pencil enters edit mode; Escape and Done leave it', async () => {
    stubProfiles();
    list = [profile(1), profile(2, { name: 'Kid', isOwner: false })];
    renderPages('/player/profiles', pages, authFor(list[0]!));
    await userEvent.click(await screen.findByRole('button', { name: 'Manage profiles' }));
    expect(await screen.findByRole('heading', { name: 'Manage profiles' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await screen.findByRole('heading', { name: 'Who’s watching?' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Manage profiles' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Kid' }));
    expect(await screen.findByRole('heading', { name: 'Edit profile' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Still in edit mode after the editor closes.
    await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: 'Who’s watching?' })).toBeTruthy();
  });

  it('a non-owner profile gets neither Add nor the pencil, even from the address', async () => {
    stubProfiles();
    list = [profile(1), profile(2, { name: 'Kid', isOwner: false })];
    activeId = 2;
    renderPages('/player/profiles?manage=1&add=1', pages, authFor(list[1]!));
    expect(await screen.findByRole('heading', { name: 'Who’s watching?' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add profile' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage profiles' })).toBeNull();
  });
});
