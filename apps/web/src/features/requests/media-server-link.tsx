import { useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MediaServerKind, UserRequestSettings } from '@arclight/shared';
import { authApi } from '../../api/auth.js';
import { errorMessage } from '../../api/client.js';
import { mediaServerLinkApi } from '../../api/media-servers.js';
import { Button, Field, Input, KeyValue, Skeleton } from '../../arclight/index.js';
import { authKeys } from '../../auth/guard.js';
import { useToast } from '../../components/toast.js';
import { useUserRequestSettings } from '../../hooks/requests.js';
import { requestKeys } from '../../hooks/request-keys.js';
import { useSignInServer } from '../../hooks/media-servers.js';
import { formatDateTime } from '../../lib/ui-preferences.js';
import { usePlexPinFlow } from './plex-pin.js';
import { t } from '../../i18n/index.js';

// Profile → Media server account: link this Arclight user to their Jellyfin/Emby account
// (username + password) or their Plex account (PIN: create, open Plex, poll until linked), or
// remove the link.

export const KIND_LABELS: Record<MediaServerKind, string> = { get jellyfin() { return t('common.jellyfin'); }, get emby() { return t('common.emby'); }, get plex() { return t('common.plex'); } };

/** Which server kind the link form is for: the existing link, then the sign-in server. */
export function linkKindFor(link: UserRequestSettings['mediaServerLink'], configured: MediaServerKind | null | undefined): MediaServerKind | null {
  return link?.kind ?? configured ?? null;
}

/** Poll answer for the link flow: null while Plex waits for the user, else the new settings. */
export async function pollPlexLink(pinId: number): Promise<UserRequestSettings | null> {
  const res = await mediaServerLinkApi.plexPoll(pinId);
  return 'pending' in res ? null : res;
}

export function MediaServerLinkPanel({ userId, isAdmin = false }: { userId: number; isAdmin?: boolean }) {
  const settings = useUserRequestSettings(userId);
  const signIn = useSignInServer(isAdmin);
  const options = useQuery({ queryKey: [...authKeys.status, 'login-options'], queryFn: authApi.loginOptions, retry: false, staleTime: 60_000 });
  const qc = useQueryClient();
  const toast = useToast();
  const ids = { user: useId(), pass: useId() };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Links the signed-in user (POST /user/me/mediaserver/plex/pin + poll); no new session.
  const plex = usePlexPinFlow({
    createPin: mediaServerLinkApi.plexPin,
    poll: (pin) => pollPlexLink(pin.id),
    onDone: (next) => {
      qc.setQueryData(requestKeys.users.settings(userId), next);
      toast.push({ tone: 'ok', title: t('features.requests.mediaServerLink.plexAccountLinked') });
    },
  });

  if (settings.isPending) return <Skeleton lines={2} />;
  if (settings.isError) return <p className="al-caption">{t('features.requests.mediaServerLink.accountLinksAreUnavailableErrormessage', { errorMessage: errorMessage(settings.error) })}</p>;
  const link = settings.data.mediaServerLink;
  const kind = linkKindFor(link, signIn.data?.kind ?? options.data?.mediaServerLogin?.kind);

  const run = async (fn: () => Promise<UserRequestSettings>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      qc.setQueryData(requestKeys.users.settings(userId), next);
      toast.push({ tone: 'ok', title: done });
      setUsername('');
      setPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (link) {
    return (
      <div className="req-stack" aria-label={t('features.requests.mediaServerLink.linkedMediaServerAccount')}>
        <KeyValue
          items={[
            { label: t('features.requests.mediaServerLink.server'), value: KIND_LABELS[link.kind], mono: false },
            { label: t('common.account'), value: link.username },
            { label: t('features.requests.mediaServerLink.linked'), value: formatDateTime(link.linkedAt) },
          ]}
        />
        {error ? <p className="login-error" role="alert">{error}</p> : null}
        <div className="req-actions">
          <Button variant="danger" loading={busy} onClick={() => void run(() => mediaServerLinkApi.unlink(userId), t('features.requests.mediaServerLink.accountUnlinked'))}>
            {t('features.requests.mediaServerLink.unlinkValueAccount', { value: KIND_LABELS[link.kind] })}
          </Button>
        </div>
      </div>
    );
  }

  // Admins sign in with their Arclight password only; the api refuses a link to an admin.
  if (isAdmin) return <p className="al-caption" style={{ margin: 0 }}>{t('features.requests.mediaServerLink.adminsCannotLink')}</p>;
  if (!kind) return <p className="al-caption" style={{ margin: 0 }}>{t('features.requests.mediaServerLink.noMediaServerIsSet')}</p>;

  if (kind === 'plex') {
    const waiting = plex.state.phase === 'waiting' ? plex.state.pin : null;
    return (
      <div className="req-stack">
        <p className="al-caption" style={{ margin: 0 }}>{t('features.requests.mediaServerLink.linkYourPlexAccountTo')}</p>
        {waiting ? (
          <p className="al-caption" role="status" style={{ margin: 0 }}>
            {t('features.requests.mediaServerLink.approveInPlex')} <span className="al-num">{waiting.code}</span>{' '}
            <a className="mk-link" href={waiting.authUrl} target="plex-auth" rel="noreferrer">
              {t('features.requests.mediaServerLink.openPlexAgain')}
            </a>
          </p>
        ) : null}
        {plex.state.phase === 'error' ? <p className="login-error" role="alert">{plex.state.message}</p> : null}
        <div className="req-actions">
          {waiting ? (
            <Button variant="ghost" onClick={plex.cancel}>
              {t('common.cancel')}
            </Button>
          ) : (
            <Button variant="secondary" loading={plex.state.phase === 'done'} onClick={plex.start}>
              {t('features.requests.mediaServerLink.linkPlexAccount')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError(t('features.requests.mediaServerLink.enterYourUsername'));
      return;
    }
    void run(() => mediaServerLinkApi.link(userId, { username: username.trim(), password }), `${KIND_LABELS[kind]} account linked`);
  };
  return (
    <form className="req-stack" onSubmit={submit} aria-label={t('features.requests.mediaServerLink.linkValueAccount', { value: KIND_LABELS[kind] })}>
      <Field label={t('features.requests.mediaServerLink.valueUsername', { value: KIND_LABELS[kind] })} htmlFor={ids.user}>
        <Input id={ids.user} autoComplete="off" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
      </Field>
      <Field label={t('common.password')} htmlFor={ids.pass} hint={t('features.requests.mediaServerLink.usedOnceToGetA')}>
        <Input id={ids.pass} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
      </Field>
      {error ? <p className="login-error" role="alert">{error}</p> : null}
      <div className="req-actions">
        <Button type="submit" variant="primary" loading={busy}>
          {t('features.requests.mediaServerLink.linkAccount')}
        </Button>
      </div>
    </form>
  );
}
