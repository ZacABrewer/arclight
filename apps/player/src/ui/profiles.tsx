import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input } from '@web/arclight/index';
import { useT } from '@web/i18n/index';
import { householdKeys, householdsApi, useActiveProfile } from '../households/api';
import { PIN_LENGTH } from '../tv/profile-parts';
import { usePickProfile } from '../households/use-pick';
import { ProfileAvatar } from '../kit/profile-avatar';

// "Who's watching?" on phones (§4.4): the title, a 2-column grid of 96 px avatars with names, and
// the PIN as a 4-dot field over the system number pad. "Add profile" (a dashed tile) while the
// owner profile is active. A stand-in until the shared portrait picker from the web redesign is
// mounted here.
export function PhoneProfilesScreen() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { profiles, canManage, max } = useActiveProfile();
  const picker = usePickProfile(() => void navigate({ to: '/player' }));
  const [pin, setPin] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (name: string) => householdsApi.create({ name }),
    onSuccess: async () => {
      setAdding(null);
      await qc.invalidateQueries({ queryKey: householdKeys.profiles() });
    },
  });

  if (adding !== null) {
    const name = adding.trim();
    return (
      <div className="al-app pl-app app-profiles">
        <h1 className="app-profiles__title">{t('app.tv.addProfile')}</h1>
        <Input autoFocus maxLength={24} value={adding} aria-label={t('app.tv.profileName')} onChange={(e) => setAdding(e.target.value)} />
        <p className="app-profiles__msg" role="status">
          {create.isError ? t('app.tv.saveFailed') : ''}
        </p>
        <div className="app-row">
          <Button variant="ghost" onClick={() => setAdding(null)}>
            {t('app.tv.cancel')}
          </Button>
          <Button variant="primary" disabled={!name || create.isPending} onClick={() => create.mutate(name)}>
            {t('app.tv.key.done')}
          </Button>
        </div>
      </div>
    );
  }

  if (picker.pinFor) {
    const p = picker.pinFor;
    return (
      <div className="al-app pl-app app-profiles">
        <h1 className="app-profiles__title">{t('app.tv.pin.enterFor', { name: p.name })}</h1>
        <ProfileAvatar color={p.color} initial={p.initial} size={96} />
        <div className="app-profiles__dots" aria-hidden="true">
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span key={i} className={`app-profiles__dot${i < pin.length ? ' app-profiles__dot--on' : ''}`} />
          ))}
        </div>
        <Input
          key={picker.resetKey}
          className="app-profiles__pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          maxLength={PIN_LENGTH}
          aria-label={t('app.tv.pin.enterFor', { name: p.name })}
          disabled={picker.locked || picker.busy}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH);
            setPin(v);
            if (v.length === PIN_LENGTH) {
              setPin('');
              e.target.value = '';
              picker.submitPin(v);
            }
          }}
        />
        <p className="app-profiles__msg" role="status">
          {picker.message ?? ''}
        </p>
        <Button variant="ghost" onClick={picker.cancel}>
          {t('app.tv.cancel')}
        </Button>
      </div>
    );
  }

  return (
    <div className="al-app pl-app app-profiles">
      <h1 className="app-profiles__title">{t('app.tv.whoIsWatching')}</h1>
      <div className="app-profiles__grid">
        {profiles.map((p) => (
          <button key={p.id} type="button" className="app-profiles__item" onClick={() => picker.pick(p)}>
            <ProfileAvatar color={p.color} initial={p.initial} size={96} />
            <span>{p.name}</span>
          </button>
        ))}
        {canManage && profiles.length < max ? (
          <button type="button" className="app-profiles__item" onClick={() => setAdding('')}>
            <span className="app-profiles__add" aria-hidden="true">
              +
            </span>
            <span>{t('app.tv.addProfile')}</span>
          </button>
        ) : null}
      </div>
      {picker.message ? (
        <p className="app-profiles__msg" role="status">
          {picker.message}
        </p>
      ) : null}
    </div>
  );
}
