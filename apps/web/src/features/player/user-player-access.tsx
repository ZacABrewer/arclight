import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlayerAccess, Permission, type User } from '@arclight/shared';
import { usersApi } from '../../api/auth.js';
import { errorMessage } from '../../api/client.js';
import { authKeys } from '../../auth/guard.js';
import { Button, Field, Input, Toggle } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { t } from '../../i18n/index.js';
import { playerKeys } from './api.js';

// Users → edit user → Player: whether this person may use the built-in player, stream from
// outside the home network, and their own bitrate cap. Stored in users.settings.player.

/** The stored access (absent or malformed: no access). */
export function playerAccessOf(user: Pick<User, 'settings'>): PlayerAccess {
  const parsed = PlayerAccess.safeParse((user.settings as Record<string, unknown> | undefined)?.['player'] ?? {});
  return parsed.success ? parsed.data : PlayerAccess.parse({});
}

export function UserPlayerAccessEditor({ user }: { user: User }) {
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = (user.permissions & Permission.ADMIN) !== 0;
  const [draft, setDraft] = useState(() => {
    const a = playerAccessOf(user);
    return { allowed: a.allowed, allowRemote: a.allowRemote, maxBitrateKbps: String(a.maxBitrateKbps) };
  });
  const bitrate = draft.maxBitrateKbps.trim() === '' ? 0 : Number(draft.maxBitrateKbps);
  const valid = Number.isInteger(bitrate) && bitrate >= 0 && bitrate <= 100_000;
  const save = useMutation({
    mutationFn: () =>
      usersApi.update(user.id, { settings: { player: { allowed: draft.allowed, allowRemote: draft.allowRemote, maxBitrateKbps: bitrate } } }),
    meta: { silent: true },
    onSuccess: async () => {
      toast.push({ tone: 'ok', title: t('player.userAccess.saved') });
      await qc.invalidateQueries({ queryKey: authKeys.users });
      await qc.invalidateQueries({ queryKey: playerKeys.me });
    },
  });
  return (
    <div className="req-stack" data-testid="user-player-access">
      {isAdmin ? <p className="al-caption">{t('player.userAccess.adminNote')}</p> : null}
      <Field label={t('player.userAccess.allowed')} inline hint={t('player.userAccess.allowedHint')}>
        <Toggle aria-label={t('player.userAccess.allowed')} checked={draft.allowed} onChange={(e) => setDraft({ ...draft, allowed: e.currentTarget.checked })} />
      </Field>
      <Field label={t('player.userAccess.allowRemote')} inline hint={t('player.userAccess.allowRemoteHint')}>
        <Toggle aria-label={t('player.userAccess.allowRemote')} checked={draft.allowRemote} onChange={(e) => setDraft({ ...draft, allowRemote: e.currentTarget.checked })} />
      </Field>
      <Field
        label={t('player.userAccess.maxBitrate')}
        hint={t('player.userAccess.maxBitrateHint')}
        error={valid ? undefined : t('player.userAccess.maxBitrateInvalid')}
      >
        <Input
          type="number"
          min={0}
          max={100000}
          mono
          end={t('player.settings.kbps')}
          aria-label={t('player.userAccess.maxBitrate')}
          invalid={!valid}
          value={draft.maxBitrateKbps}
          onChange={(e) => setDraft({ ...draft, maxBitrateKbps: e.currentTarget.value })}
        />
      </Field>
      {save.isError ? (
        <p className="al-form-row__error" role="alert">
          {errorMessage(save.error)}
        </p>
      ) : null}
      <div className="req-actions">
        <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
          {t('player.userAccess.save')}
        </Button>
      </div>
    </div>
  );
}
