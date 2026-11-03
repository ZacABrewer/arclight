import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useT } from '@web/i18n/index';
import { householdKeys, householdsApi, useActiveProfile, useProfileSettings } from '../../households/api';
import { usePickProfile } from '../../households/use-pick';
import { Lockup } from '../../kit/lockup';
import { ProfileAvatar } from '../../kit/profile-avatar';
import { NameKeyboard, PinPad, TvPanel } from '../profile-parts';
import { TvStage } from '../stage';
import { HOME_PATH, tvRuntime } from '../tv-runtime';
import '../tv.css';

// "Who's watching?" on TV (template "profiles", §4.3, §9 Q3/Q5): the lockup top-left, the title,
// one row of 132 px avatars with names. The avatar circle takes focus and its name lights up with
// it. A final dashed "Add profile" tile while the owner profile is active and there is room. A
// profile with a PIN opens the PIN pad. Choosing goes to Home with focus on the hero's Play.

export function TvProfilesScreen() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const settings = useProfileSettings();
  const { profile: active, profiles, canManage, max } = useActiveProfile();
  const [adding, setAdding] = useState(false);
  const picker = usePickProfile(() => {
    tvRuntime()?.focus.forget();
    void navigate({ to: HOME_PATH });
  });
  const create = useMutation({
    mutationFn: (name: string) => householdsApi.create({ name }),
    onSuccess: async () => {
      setAdding(false);
      await qc.invalidateQueries({ queryKey: householdKeys.profiles() });
    },
  });

  return (
    <TvStage focusStyle={settings.focusStyle} reduceMotion={settings.reduceMotion} className={settings.reduceMotion ? 'tv-motion-off' : undefined}>
      <div className="tv-profiles">
        <Lockup height={22} className="tv-profiles__logo" />
        <h1 className="tv-profiles__title">{t('app.tv.whoIsWatching')}</h1>
        <div className="tv-profiles__row" data-tv-row="">
          {profiles.map((p) => (
            <div key={p.id} className="tv-prof">
              <button
                type="button"
                className="tv-prof__avatar"
                data-tv-key={`prof-${p.id}`}
                data-tv-autofocus={p.id === active?.id ? '' : undefined}
                data-tv-r="66"
                onClick={() => picker.pick(p)}
                aria-label={p.name}
              >
                <ProfileAvatar color={p.color} initial={p.initial} size={132} />
              </button>
              <span className="tv-prof__name">{p.name}</span>
            </div>
          ))}
          {canManage && profiles.length < max ? (
            <div className="tv-prof">
              <button type="button" className="tv-prof__add" data-tv-key="prof-add" data-tv-r="66" onClick={() => setAdding(true)} aria-label={t('app.tv.addProfile')}>
                +
              </button>
              <span className="tv-prof__name">{t('app.tv.addProfile')}</span>
            </div>
          ) : null}
        </div>
        {picker.message && !picker.pinFor ? (
          <div className="tv-pin__msg" role="status">
            {picker.message}
          </div>
        ) : null}
      </div>
      {picker.pinFor ? (
        <TvPanel label={t('app.tv.pin.enterFor', { name: picker.pinFor.name })} onClose={picker.cancel}>
          <PinPad
            title={t('app.tv.pin.enterFor', { name: picker.pinFor.name })}
            message={picker.message}
            locked={picker.locked}
            busy={picker.busy}
            resetKey={picker.resetKey}
            onComplete={picker.submitPin}
          />
        </TvPanel>
      ) : null}
      {adding ? (
        <TvPanel label={t('app.tv.addProfile')} onClose={() => setAdding(false)}>
          <NameKeyboard title={t('app.tv.profileName')} busy={create.isPending} message={create.isError ? t('app.tv.saveFailed') : null} onDone={(name) => create.mutate(name)} />
        </TvPanel>
      ) : null}
    </TvStage>
  );
}
