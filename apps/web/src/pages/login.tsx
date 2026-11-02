import { useEffect, useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginMethod, MediaServerKind, Session } from '@arclight/shared';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { ApiError, errorMessage } from '../api/client.js';
import { authApi } from '../api/auth.js';
import { Backdrop, Banner, Button, Checkbox, Field, Input, Mark, Pane, Segmented } from '../arclight/index.js';
import { authKeys, safeRedirect } from '../auth/guard.js';
import { usePlexPinFlow } from '../features/requests/plex-pin.js';
import { PasskeySignInButton, ProviderButtons, TwoFactorStep, passwordFormHidden, ssoErrorMessage, visibleProviders, type TwoFactorChallengeState } from '../features/identity/sign-in.js';
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

const truthy = (v: unknown) => v === true || v === 1 || v === '1';

/** Where the sign-in returns to: `redirect`, or `returnTo` after a failed identity-provider sign-in. */
export function loginTarget(search: Record<string, unknown>): string {
  return safeRedirect(typeof search['redirect'] === 'string' ? search['redirect'] : search['returnTo']);
}

/** Page 07: centred chamfered card on the open backdrop; warn banner when the session expired. */
export function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const expired = truthy(search['expired']);
  const local = truthy(search['local']);
  const ssoError = typeof search['ssoError'] === 'string' ? search['ssoError'] : null;
  const target = loginTarget(search);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<LoginMethod>('local');
  const [twoFactor, setTwoFactor] = useState<TwoFactorChallengeState | null>(null);
  const options = useQuery({ queryKey: [...authKeys.status, 'login-options'], queryFn: authApi.loginOptions, retry: false, staleTime: 60_000 });
  const serverKind = options.data?.mediaServerLogin?.kind ?? null;
  const methods = loginMethodOptions(serverKind);
  const signIn = options.data?.signIn;
  // The portal's sign-in (a /portal target) shows the providers meant for the portal.
  const providers = visibleProviders(signIn, target === '/portal' || target.startsWith('/portal/') || target.startsWith('/portal?') ? 'portal' : 'login');
  const hidePassword = passwordFormHidden(signIn, providers, local);
  const finish = async () => {
    await qc.invalidateQueries({ queryKey: authKeys.all });
    await router.navigate({ href: target, replace: true });
  };
  const onSession = async (_session: Session) => {
    await finish();
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
      const res = await authApi.login({ method, username: username.trim(), password, rememberMe });
      if ('twoFactorRequired' in res) {
        setTwoFactor({ challenge: res.challenge, methods: res.methods });
        setPassword('');
        setBusy(false);
        return;
      }
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
        {ssoError ? <Banner tone="danger">{ssoErrorMessage(ssoError)}</Banner> : null}
        <Pane chamfer="both" strong className="login-card" bare>
          <div className="login-form">
            <div className="login-brand">
              <Mark size={44} />
              <span className="login-wordmark" aria-hidden="true">
                {t('common.arclight')}
              </span>
              <h1 id="login-title" className="al-sr-only">
                {t('login.signIn')}
              </h1>
            </div>
            {twoFactor ? (
              <TwoFactorStep
                state={twoFactor}
                rememberMe={rememberMe}
                onSession={onSession}
                onExpired={(message) => {
                  setTwoFactor(null);
                  setError(message);
                }}
                onCancel={() => {
                  setTwoFactor(null);
                  setError(null);
                }}
              />
            ) : (
              <>
                {providers.length > 0 || signIn?.passkeys ? (
                  <div className="login-fields">
                    <ProviderButtons providers={providers} returnTo={target} rememberMe={rememberMe} primary={hidePassword} />
                    {signIn?.passkeys ? <PasskeySignInButton rememberMe={rememberMe} onSession={onSession} /> : null}
                  </div>
                ) : null}
                {hidePassword ? (
                  <Checkbox label={t('login.keepMeSignedIn')} checked={rememberMe} onChange={(e) => setRememberMe(e.currentTarget.checked)} />
                ) : (
                  <form className="login-fields" onSubmit={(e) => void onSubmit(e)} noValidate aria-labelledby="login-title">
                    {providers.length > 0 || signIn?.passkeys ? (
                      <span className="login-or" aria-hidden="true">
                        {t('login.or')}
                      </span>
                    ) : null}
                    {local && signIn?.hidePasswordLogin ? <p className="id-local-note">{t('identity.signIn.localNote')}</p> : null}
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
                  </form>
                )}
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
              </>
            )}
          </div>
        </Pane>
        <p className="login-foot">{t('login.forgotYourPasswordAnAdmin')}</p>
      </main>
    </div>
  );
}
