import { useEffect, useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginMethod, MediaServerKind } from '@arclight/shared';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { ApiError, errorMessage } from '../api/client.js';
import { authApi } from '../api/auth.js';
import { Backdrop, Banner, Button, Checkbox, Field, Input, Mark, Pane, Segmented } from '../arclight/index.js';
import { authKeys, safeRedirect } from '../auth/guard.js';
import { usePlexPinFlow } from '../features/requests/plex-pin.js';
import { t } from '../i18n/index.js';

const KIND_LABEL: Record<MediaServerKind, string> = { get jellyfin() { return t('common.jellyfin'); }, get emby() { return t('common.emby'); }, get plex() { return t('common.plex'); } };

/** Login methods offered for the configured sign-in server: Local plus Jellyfin/Emby (Plex uses the PIN button). */
export function loginMethodOptions(kind: MediaServerKind | null | undefined): Array<{ value: LoginMethod; label: string }> {
  const local = { value: 'local' as const, label: t('login.local') };
  if (kind === 'jellyfin' || kind === 'emby') return [local, { value: kind, label: KIND_LABEL[kind] }];
  return [local];
}

export function loginErrorMessage(err: unknown, method: LoginMethod = 'local'): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return method === 'local' ? t('login.incorrectUsernameOrPassword') : t('login.theMediaServerDidNot');
    if (err.status === 403 && method !== 'local') return err.message || t('login.signInWithTheMedia');
    if (err.status === 429) return t('login.tooManyFailedAttemptsWait');
  }
  return errorMessage(err);
}

/** Page 07: centred chamfered card on the open backdrop; warn banner when the session expired. */
export function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const expired = search['expired'] === true || search['expired'] === 1 || search['expired'] === '1';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<LoginMethod>('local');
  const options = useQuery({ queryKey: [...authKeys.status, 'login-options'], queryFn: authApi.loginOptions, retry: false, staleTime: 60_000 });
  const serverKind = options.data?.mediaServerLogin?.kind ?? null;
  const methods = loginMethodOptions(serverKind);
  const finish = async () => {
    await qc.invalidateQueries({ queryKey: authKeys.all });
    await router.navigate({ href: safeRedirect(search['redirect']), replace: true });
  };
  const plex = usePlexPinFlow({
    createPin: authApi.plexPin,
    poll: async (pin) => {
      const res = await authApi.plexPoll({ id: pin.id, rememberMe });
      return 'pending' in res ? null : res;
    },
    onDone: finish,
  });
  const userId = useId();
  const passId = useId();

  useEffect(() => {
    document.title = t('login.signInArclight');
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError(t('login.enterYourUsernameAndPassword'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi.login({ method, username: username.trim(), password, rememberMe });
      await finish();
    } catch (err) {
      setError(loginErrorMessage(err, method));
      setBusy(false);
    }
  };

  return (
    <div className="al-app login">
      <Backdrop vx={0.5} horizon={0.58} />
      <main className="login-main">
        {expired ? <Banner tone="warn">{t('login.yourSessionExpiredSignIn')}</Banner> : null}
        <Pane chamfer="both" strong className="login-card" bare>
          <form className="login-form" onSubmit={(e) => void onSubmit(e)} noValidate aria-labelledby="login-title">
            <div className="login-brand">
              <Mark size={44} />
              <span className="login-wordmark" aria-hidden="true">
                {t('common.arclight')}
              </span>
              <h1 id="login-title" className="al-sr-only">
                {t('login.signIn')}
              </h1>
            </div>
            {methods.length > 1 ? (
              <Segmented aria-label={t('login.signInWith')} full variant="soft" options={methods} value={method} onChange={(v) => { setMethod(v); setError(null); }} />
            ) : null}
            <Field label={method === 'local' ? t('common.username') : t('login.valueUsername', { value: KIND_LABEL[method as MediaServerKind] ?? 'Media server' })} htmlFor={userId}>
              <Input id={userId} name="username" size="lg" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
            </Field>
            <Field label={t('common.password')} htmlFor={passId}>
              <Input id={passId} name="password" type="password" size="lg" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
            </Field>
            <Checkbox label={t('login.keepMeSignedIn')} checked={rememberMe} onChange={(e) => setRememberMe(e.currentTarget.checked)} />
            {error ? (
              <p className="login-error" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              {t('login.signIn')}
            </Button>
            {serverKind === 'plex' ? (
              <div className="login-plex">
                <span className="login-or" aria-hidden="true">
                  {t('login.or')}
                </span>
                {plex.state.phase === 'waiting' ? (
                  <>
                    <p className="al-caption login-plex__wait" role="status">
                      {t('login.approveTheSignInIn')} <span className="al-num">{plex.state.pin.code}</span>
                    </p>
                    <Button variant="ghost" block onClick={plex.cancel}>
                      {t('login.cancelPlexSignIn')}
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" size="lg" block loading={plex.state.phase === 'done'} onClick={plex.start}>
                    {t('login.signInWithPlex')}
                  </Button>
                )}
                {plex.state.phase === 'error' ? (
                  <p className="login-error" role="alert">
                    {plex.state.message}
                  </p>
                ) : null}
              </div>
            ) : null}
          </form>
        </Pane>
        <p className="login-foot">{t('login.forgotYourPasswordAnAdmin')}</p>
      </main>
    </div>
  );
}
