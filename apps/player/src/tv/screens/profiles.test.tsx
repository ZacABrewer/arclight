import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProfileSettings, type HouseholdProfile, type HouseholdProfileCreate } from '@arclight/shared';
import { FocusManager } from '../focus-manager';
import type { Box } from '../spatial';

// The TV picker (features spec §1): the round Add tile opens the full new-profile page, the
// pencil button under the row turns the tiles into edit mode, Back leaves edit mode, and D-pad
// focus reaches the button and comes back up to the tile it left.

const state = vi.hoisted(() => ({
  profiles: [] as HouseholdProfile[],
  canManage: true,
  max: 12,
  search: {} as Record<string, unknown>,
  pick: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => state.search,
}));
vi.mock('../../households/use-pick', () => ({
  usePickProfile: () => ({ pick: state.pick, pinFor: null, message: null, locked: false, busy: false, resetKey: 0, cancel: vi.fn(), submitPin: vi.fn() }),
}));
vi.mock('../../households/api', () => ({
  householdKeys: { profiles: () => ['households', 'profiles'] },
  householdsApi: {
    create: (body: HouseholdProfileCreate) => state.create(body),
    update: vi.fn(),
    remove: vi.fn(),
  },
  useProfileSettings: () => ProfileSettings.parse({}),
  useActiveProfile: () => ({ profile: state.profiles[0] ?? null, profiles: state.profiles, canManage: state.canManage, max: state.max }),
}));

const { TvProfilesScreen } = await import('./profiles');
const { applyToDraft, createBody } = await import('./manage-profiles');

function profile(id: number, over: Partial<HouseholdProfile> = {}): HouseholdProfile {
  const name = over.name ?? (id === 1 ? 'Owner' : `P${id}`);
  return {
    id,
    name,
    color: '#7c6cf0',
    initial: name[0]!,
    isOwner: id === 1,
    hasPin: false,
    contentRestrictions: null,
    settings: ProfileSettings.parse({}),
    sortOrder: id,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TvProfilesScreen />
    </QueryClientProvider>,
  );
}

const key = (k: string) => document.querySelector<HTMLElement>(`[data-tv-key="${k}"]`)!;

beforeEach(() => {
  state.profiles = [profile(1), profile(2, { name: 'Kid', isOwner: false, hasPin: true })];
  state.canManage = true;
  state.max = 12;
  state.search = {};
  state.pick.mockReset();
  state.create.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('TvProfilesScreen', () => {
  it('pick mode picks; the pencil turns the tiles into edit mode and Back leaves it', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Who’s watching?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kid' }));
    expect(state.pick).toHaveBeenCalledWith(state.profiles[1]);

    fireEvent.click(screen.getByRole('button', { name: 'Manage profiles' }));
    expect(screen.getByRole('heading', { name: 'Manage profiles' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    // Edit mode is a scope, so the remote's Back reaches it as Escape.
    expect(document.querySelector('.tv-profiles')!.hasAttribute('data-tv-scope')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Kid' }));
    expect(state.pick).toHaveBeenCalledTimes(1);
    // The profile's page opened over the picker; its Back closes it, then Back leaves edit mode.
    const page = screen.getByRole('dialog', { name: 'Kid' });
    fireEvent.keyDown(page, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Manage profiles' })).toBeTruthy();
    fireEvent.keyDown(key('prof-2'), { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Who’s watching?' })).toBeTruthy();
  });

  it('no Add tile or pencil for a non-owner profile, no Add tile at the limit', () => {
    state.canManage = false;
    const { unmount } = show();
    expect(screen.queryByRole('button', { name: 'Add profile' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage profiles' })).toBeNull();
    unmount();
    state.canManage = true;
    state.max = 2;
    show();
    expect(screen.queryByRole('button', { name: 'Add profile' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Manage profiles' })).toBeTruthy();
  });

  it('?manage=1&add=1 arrives in edit mode with the new-profile page open', () => {
    state.search = { manage: '1', add: '1' };
    show();
    expect(screen.getByRole('heading', { name: 'Manage profiles' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Add profile' })).toBeTruthy();
    // Save waits for a name.
    expect((key('mp-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the new-profile page creates with every choice and focuses the new tile', async () => {
    const created = profile(3, { name: 'Robin', isOwner: false, color: '#3aa37a' });
    state.create.mockImplementation(async () => {
      state.profiles = [...state.profiles, created];
      return created;
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    expect(screen.getByRole('dialog', { name: 'Add profile' })).toBeTruthy();
    // The colour starts on the first one not taken: the owner and Kid both use the first.
    expect(key('mp-color-1').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(key('mp-color-2'));
    fireEvent.click(key('mp-movie-limit'));
    fireEvent.click(key('mp-name'));
    for (const c of 'ROBIN') fireEvent.click(key(`nk-${c}`));
    fireEvent.click(key('nk-done'));
    expect(screen.getByRole('heading', { name: 'Robin' })).toBeTruthy();
    fireEvent.click(key('mp-save'));
    await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
    expect(state.create.mock.calls[0]![0]).toEqual({
      name: 'Robin',
      initial: 'R',
      color: '#3aa37a',
      pin: null,
      contentRestrictions: { maxCertification: { movie: 'G', tv: null }, hideAdultContent: false },
    });
  });

  it('Down from a tile reaches the pencil; Up returns to the tile it left', () => {
    state.profiles = [profile(1), profile(2, { isOwner: false }), profile(3, { isOwner: false })];
    show();
    const boxes: Record<string, Box> = {
      'prof-1': { left: 300, top: 260, right: 432, bottom: 392 },
      'prof-2': { left: 476, top: 260, right: 608, bottom: 392 },
      'prof-3': { left: 652, top: 260, right: 784, bottom: 392 },
      'prof-add': { left: 828, top: 260, right: 960, bottom: 392 },
      'prof-manage': { left: 560, top: 470, right: 720, bottom: 514 },
    };
    const fm = new FocusManager({
      rectOf: (el) => boxes[el.getAttribute('data-tv-key') ?? ''] ?? { left: 0, top: 0, right: 1280, bottom: 720 },
      visible: () => true,
      revealStage: () => {},
      reveal: () => {},
    });
    const detach = fm.attach();
    try {
      key('prof-3').focus();
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(key('prof-manage'));
      // The nearest tile up is prof-2; Up goes back to prof-3, where focus came from.
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(key('prof-3'));
    } finally {
      detach();
    }
  });
});

describe('new-profile draft', () => {
  it('keeps changes until Save and sends them all', () => {
    let d = { name: '', color: '#e0913a', pin: null as string | null, contentRestrictions: null };
    d = applyToDraft(d, { name: ' Robin ', initial: 'R' }) as typeof d;
    d = applyToDraft(d, { pin: '1234' }) as typeof d;
    expect(createBody(d)).toEqual({ name: 'Robin', initial: 'R', color: '#e0913a', pin: '1234', contentRestrictions: null });
    expect(applyToDraft(d, { pin: null }).pin).toBeNull();
  });
});
