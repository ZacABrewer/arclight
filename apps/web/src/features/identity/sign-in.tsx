import { useId, useState, type FormEvent } from 'react';
import type { OidcProviderPublic, SecondFactor, Session, SignInOptions } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { loginApi, oidcStartHref } from '../../api/identity.js';
import { Button, Field, Input, buttonClass } from '../../arclight/index.js';
import { passkeyAssertion, passkeyErrorMessage, passkeysSupported } from './webauthn.js';
import { t } from '../../i18n/index.js';
import './identity.css';

// Sign-in page pieces for identity providers, passkeys and the two-factor step. Used by
// pages/login.tsx (admin and portal sign-in) and the portal home's sign-in card.

/** `?ssoError=<code>` from the api's OpenID Connect callback, as a sentence. */
export function ssoErrorMessage(code: string): string {
  switch (code) {
    case 'state':
      return t('identity.ssoError.state');
    case 'provider':
      return t('identity.ssoError.provider');
    case 'token':
      return t('identity.ssoError.token');
    case 'no_account':
      return t('identity.ssoError.noAccount');
    case 'forbidden':
      return t('identity.ssoError.forbidden');
    case 'disabled':
      return t('identity.ssoError.disabled');
    case 'link_conflict':
      return t('identity.ssoError.linkConflict');
    default:
      return t('identity.ssoError.other');
  }
}

/** Provider buttons for the admin sign-in page or the request portal. */
export function visibleProviders(signIn: SignInOptions | undefined, place: 'login' | 'portal'): OidcProviderPublic[] {
  return (signIn?.providers ?? []).filter((p) => (place === 'portal' ? p.showOnPortal : p.showOnLogin));
}

/**
 * The username/password form is hidden when the admin turned it off and a provider button is
 * shown; `?local=1` (break-glass) always brings it back.
 */
export function passwordFormHidden(signIn: SignInOptions | undefined, providers: readonly OidcProviderPublic[], local: boolean): boolean {
  return Boolean(signIn?.hidePasswordLogin) && providers.length > 0 && !local;
}

/** "Sign in with <name>" links: a full page load to the api, which redirects to the provider. */
export function ProviderButtons({ providers, returnTo, rememberMe = true, primary = false }: { providers: readonly OidcProviderPublic[]; returnTo: string; rememberMe?: boolean; primary?: boolean }) {
  if (providers.length === 0) return null;
  return (
    <ul className="id-providers" aria-label={t('identity.signIn.providers')}>
      {providers.map((p, i) => (
        <li key={p.id}>
          <a className={buttonClass({ variant: primary && i === 0 ? 'primary' : 'secondary', size: 'lg', block: true })} href={oidcStartHref(p.id, returnTo, rememberMe)}>
            {t('identity.signIn.withProvider', { name: p.name })}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Passwordless sign-in with a discoverable passkey. Hidden where the browser has no WebAuthn. */
export function PasskeySignInButton({ rememberMe, onSession }: { rememberMe: boolean; onSession: (s: Session) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!passkeysSupported()) return null;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ceremony, options } = await loginApi.passkeyOptions();
      const response = await passkeyAssertion(options);
      const session = await loginApi.passkeyLogin({ ceremony, response: response as unknown as Record<string, unknown>, rememberMe });
      await onSession(session);
    } catch (err) {
      setError(passkeyErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <div className="id-passkey">
      <Button variant="secondary" size="lg" block loading={busy} onClick={() => void start()}>
        {t('identity.signIn.withPasskey')}
      </Button>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TwoFactorChallengeState {
  challenge: string;
  methods: SecondFactor[];
}

/** First way to ask for: the authenticator code, then a recovery code, then a passkey. */
export function initialFactor(methods: readonly SecondFactor[]): SecondFactor {
  if (methods.includes('totp')) return 'totp';
  if (methods.includes('recovery')) return 'recovery';
  return 'passkey';
}

/**
 * Second step of a password sign-in: the 6-digit authenticator code, a recovery code instead,
 * or the account's passkey. `onExpired` goes back to the password step (CHALLENGE_EXPIRED).
 */
export function TwoFactorStep({
  state,
  rememberMe,
  onSession,
  onExpired,
  onCancel,
}: {
  state: TwoFactorChallengeState;
  rememberMe: boolean;
  onSession: (s: Session) => Promise<void>;
  onExpired: (message: string) => void;
  onCancel: () => void;
}) {
  const [factor, setFactor] = useState<SecondFactor>(initialFactor(state.methods));
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeId = useId();
  const recoveryId = useId();
  const canPasskey = state.methods.includes('passkey') && passkeysSupported();

  const fail = (err: unknown, kind: 'code' | 'passkey') => {
    setBusy(false);
    if (err instanceof ApiError && err.code === 'CHALLENGE_EXPIRED') {
      onExpired(t('identity.twoFactor.expired'));
      return;
    }
    if (kind === 'passkey') setError(passkeyErrorMessage(err));
    else if (err instanceof ApiError && err.status === 401) setError(factor === 'recovery' ? t('identity.twoFactor.wrongRecovery') : t('identity.twoFactor.wrongCode'));
    else if (err instanceof ApiError && err.status === 429) setError(t('login.tooManyFailedAttemptsWait'));
    else setError(errorMessage(err));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const digits = code.replace(/\s+/g, '');
    if (factor === 'totp' && !/^\d{6}$/.test(digits)) {
      setError(t('identity.twoFactor.enterSixDigits'));
      return;
    }
    if (factor === 'recovery' && recovery.trim().length < 8) {
      setError(t('identity.twoFactor.enterRecovery'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await loginApi.twoFactor(
        factor === 'recovery' ? { challenge: state.challenge, recoveryCode: recovery.trim() } : { challenge: state.challenge, code: digits },
      );
      await onSession(session);
    } catch (err) {
      fail(err, 'code');
    }
  };

  const usePasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ceremony, options } = await loginApi.passkeyOptions(state.challenge);
      const response = await passkeyAssertion(options);
      const session = await loginApi.passkeyLogin({ ceremony, response: response as unknown as Record<string, unknown>, challenge: state.challenge, rememberMe });
      await onSession(session);
    } catch (err) {
      fail(err, 'passkey');
    }
  };

  const switchTo = (next: SecondFactor) => {
    setFactor(next);
    setError(null);
  };

  return (
    <form className="login-fields" onSubmit={(e) => void submit(e)} noValidate aria-label={t('identity.twoFactor.title')}>
      <div className="id-step-head">
        <h2 className="al-title-m id-step-title">{t('identity.twoFactor.title')}</h2>
        <p className="al-caption id-step-help">
          {factor === 'totp' ? t('identity.twoFactor.totpHelp') : factor === 'recovery' ? t('identity.twoFactor.recoveryHelp') : t('identity.twoFactor.passkeyHelp')}
        </p>
      </div>
      {factor === 'totp' ? (
        <Field label={t('identity.twoFactor.code')} htmlFor={codeId}>
          <Input
            id={codeId}
            name="otp"
            size="lg"
            mono
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={7}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.currentTarget.value)}
          />
        </Field>
      ) : null}
      {factor === 'recovery' ? (
        <Field label={t('identity.twoFactor.recoveryCode')} htmlFor={recoveryId}>
          <Input id={recoveryId} name="recovery" size="lg" mono autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus value={recovery} onChange={(e) => setRecovery(e.currentTarget.value)} />
        </Field>
      ) : null}
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      {factor === 'passkey' ? (
        canPasskey ? (
          <Button variant="primary" size="lg" block loading={busy} onClick={() => void usePasskey()}>
            {t('identity.twoFactor.usePasskey')}
          </Button>
        ) : (
          <p className="al-caption id-step-help">{t('identity.twoFactor.noPasskeySupport')}</p>
        )
      ) : (
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {t('identity.twoFactor.verify')}
        </Button>
      )}
      <div className="id-step-alt">
        {factor !== 'totp' && state.methods.includes('totp') ? (
          <Button variant="ghost" size="sm" onClick={() => switchTo('totp')}>
            {t('identity.twoFactor.useAuthenticator')}
          </Button>
        ) : null}
        {factor !== 'recovery' && state.methods.includes('recovery') ? (
          <Button variant="ghost" size="sm" onClick={() => switchTo('recovery')}>
            {t('identity.twoFactor.useRecovery')}
          </Button>
        ) : null}
        {factor !== 'passkey' && canPasskey ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void usePasskey()}>
            {t('identity.twoFactor.usePasskey')}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('identity.twoFactor.back')}
        </Button>
      </div>
    </form>
  );
}
