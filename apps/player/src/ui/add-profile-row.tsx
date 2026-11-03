import { Icon } from '@web/arclight/index';
import { useT } from '@web/i18n/index';
import { canAddProfile } from '@web/features/player/redesign/profile-session';
import { useActiveProfile } from '../households/api';

// The account sheet's "Add profile" (features spec §1.3): the picker only shows with two or more
// profiles, so a single-profile account adds its second one here. Owner profile, below the limit.

export const ADD_PROFILE_HREF = '/player/profiles?manage=1&add=1';

export function AddProfileRow({ go }: { go: (to: string) => void }) {
  const t = useT();
  const { profiles, canManage, max } = useActiveProfile();
  if (!canAddProfile({ canManage, count: profiles.length, max })) return null;
  return (
    <button type="button" className="app-sheet__row" onClick={() => go(ADD_PROFILE_HREF)}>
      <Icon name="plus" size={20} />
      <span>{t('app.tv.addProfile')}</span>
    </button>
  );
}
