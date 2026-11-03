import { useNavigate } from '@tanstack/react-router';
import { HOUSEHOLD_PROFILES_MAX } from '@arclight/shared';
import { useAuth } from '../../../auth/auth-context.js';
import { useT } from '../../../i18n/index.js';
import { useHouseholdProfiles } from './api.js';
import { RdIcon } from './icons.js';
import { ADD_PROFILE_SEARCH, canAddProfile } from './profile-session.js';
import { redesignPaths } from './paths.js';

// "Add profile" outside the picker (features spec §1.3): the picker only shows with two or more
// profiles, so a single-profile account adds its second one from the account menu or Settings.
// Both open Manage profiles with the new-profile editor already open.

/** The account's profile limit, and whether the owner profile is active with room for another. */
export function useAddProfileView(): { canAdd: boolean; max: number } {
  const { session, user } = useAuth();
  const data = useHouseholdProfiles(Boolean(session || user)).data;
  const max = data?.max ?? HOUSEHOLD_PROFILES_MAX;
  return { canAdd: data ? canAddProfile({ canManage: data.canManage, count: data.profiles.length, max }) : false, max };
}

export function useCanAddProfile(): boolean {
  return useAddProfileView().canAdd;
}

/** Goes to Manage profiles with the new-profile editor open. */
export function useOpenAddProfile(): () => void {
  const navigate = useNavigate();
  return () => void navigate({ to: redesignPaths.profiles as '/player', search: ADD_PROFILE_SEARCH as never });
}

/** The account menu's item; `onPick` closes the menu. */
export function AddProfileMenuItem({ onPick }: { onPick: () => void }) {
  const t = useT();
  const canAdd = useCanAddProfile();
  const open = useOpenAddProfile();
  if (!canAdd) return null;
  return (
    <button
      type="button"
      className="rd-menu__item"
      onClick={() => {
        onPick();
        open();
      }}
    >
      <RdIcon name="plus" />
      <span>{t('player.redesign.profiles.add')}</span>
    </button>
  );
}
