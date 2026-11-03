import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Backdrop, Banner, Button, Field, Icon, Input, Mark, Pane } from '@web/arclight/index';
import { useT } from '@web/i18n/index';
import { useServices } from '../app/context';
import type { SignInSearch } from '../app/router';
import { connect } from '../core/probe';
import { normalisePairCode } from '../core/qr';
import { transportPolicy } from '../core/transport';
import { signInWithPairCode, signInWithPassword, type SignInFailure, type SignInOutcome } from '../core/sign-in';
import { scanPairingCode } from './scan';
import { ServerCheck, usePreferHttps } from './server-check';
import { DeviceCodeSignIn } from '../tv/device-code-panel';
import { isTvMode } from '../tv/tv-mode';

// First run and adding accounts: Welcome → (scan a pairing QR code | enter an address) → sign in.
// A pairing link or QR code, and any plain-http server, first shows the server check
// (ui/server-check.tsx): nothing is paired, saved or switched before the user accepts it.

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Onboarding({ children, back }: { children: ReactNode; back?: (() => void) | undefined }) {
  const t = useT();
  return (
    <div className="al-app app-onboarding">
      <Backdrop vx={0.5} horizon={0.62} />
      <header className="app-onboarding__head">
        {back ? (
          <Button variant="ghost" className="app-touch" icon={<Icon name="chevronLeft" size={24} />} aria-label={t('app.nav.back')} onClick={back} />
        ) : (
          <span />
        )}
      </header>
      <main className="app-onboarding__main">{children}</main>
    </div>
  );
}

function useScan() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setError(null);
    setBusy(true);
    const res = await scanPairingCode();
    setBusy(false);
    if (res.kind === 'error') setError(res.message);
    else if (res.kind === 'pairing') void navigate({ to: '/sign-in', search: { server: res.server, ...(res.code ? { code: res.code } : {}) } });
  };
  return { scan, error, busy };
}

export function WelcomePage() {
  const t = useT();
  const navigate = useNavigate();
  const { accounts } = useServices();
  const { scan, error, busy } = useScan();
  const hasAccounts = accounts.list().length > 0;
  const tv = isTvMode();
  return (
    <Onboarding back={hasAccounts ? () => void navigate({ to: '/player/settings' }) : undefined}>
      <div className="app-welcome">
        <Mark size={72} />
        <h1 className="app-welcome__title">{t('app.welcome.title')}</h1>
        <p className="app-welcome__body">{t('app.welcome.body')}</p>
        {tv ? (
          // A TV has no camera: the address first, then a code confirmed on a phone.
          <div className="app-stack">
            <Button variant="primary" block data-tv-autofocus icon={<Icon name="server" size={20} />} onClick={() => void navigate({ to: '/add-server' })}>
              {t('app.welcome.enter')}
            </Button>
          </div>
        ) : (
          <div className="app-stack">
            <Button variant="primary" block loading={busy} icon={<Icon name="link" size={20} />} onClick={() => void scan()}>
              {t('app.welcome.scan')}
            </Button>
            <p className="app-hint">{t('app.welcome.scanHelp')}</p>
            <Button variant="secondary" block icon={<Icon name="server" size={20} />} onClick={() => void navigate({ to: '/add-server' })}>
              {t('app.welcome.enter')}
            </Button>
          </div>
        )}
        {error ? <Banner tone="warn">{error}</Banner> : null}
      </div>
    </Onboarding>
  );
}

export function AddServerPage() {
  const t = useT();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { address?: string };
  const [address, setAddress] = useState(search.address ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ url: string; needsSetup: boolean } | null>(null);
  const { scan, error: scanError, busy: scanning } = useScan();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFound(null);
    setBusy(true);
    const res = await connect((u, init) => fetch(u, init), address);
    setBusy(false);
    if (!res.ok) {
      setError(t(res.reason === 'invalid' ? 'app.addServer.error.invalid' : `app.addServer.error.${res.reason}`, { host: res.host ?? address }));
      return;
    }
    if (res.needsSetup || transportPolicy.need(res.url) !== 'none') {
      setFound({ url: res.url, needsSetup: res.needsSetup });
      return;
    }
    void navigate({ to: '/sign-in', search: { server: res.url } });
  };

  if (found && !found.needsSetup) {
    return (
      <Onboarding back={() => setFound(null)}>
        <Pane chamfer="both" strong className="app-card">
          <h1 className="app-card__title">{t('app.addServer.title')}</h1>
          <ServerCheck
            url={found.url}
            acceptLabel={t('app.addServer.connect')}
            onAccept={() => void navigate({ to: '/sign-in', search: { server: found.url } })}
            onCancel={() => setFound(null)}
          />
        </Pane>
      </Onboarding>
    );
  }

  return (
    <Onboarding back={() => void navigate({ to: '/welcome' })}>
      <Pane chamfer="both" strong className="app-card">
        <h1 className="app-card__title">{t('app.addServer.title')}</h1>
        <form className="app-stack" onSubmit={(e) => void submit(e)} noValidate>
          <Field label={t('app.addServer.address')} hint={t('app.addServer.addressHint')} error={error ?? undefined}>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="url"
              enterKeyHint="go"
              size="lg"
              data-tv-autofocus
            />
          </Field>
          {found?.needsSetup ? <Banner tone="warn">{t('app.addServer.needsSetup')}</Banner> : null}
          <Button type="submit" variant="primary" block loading={busy} disabled={!address.trim()}>
            {busy ? t('app.addServer.checking') : t('app.addServer.connect')}
          </Button>
          {!isTvMode() ? (
            <Button variant="ghost" block loading={scanning} icon={<Icon name="link" size={20} />} onClick={() => void scan()}>
              {t('app.welcome.scan')}
            </Button>
          ) : null}
          {scanError ? <Banner tone="warn">{scanError}</Banner> : null}
        </form>
      </Pane>
    </Onboarding>
  );
}

type Step = 'password' | 'totp' | 'recovery' | 'pair' | 'device';

export function SignInPage() {
  const t = useT();
  const navigate = useNavigate();
  const services = useServices();
  const search = useSearch({ strict: false }) as SignInSearch;
  const linked = search.server ?? '';
  // A pairing link / QR code always asks first (with the server's host and whether it is
  // encrypted), and so does a plain-http server the user has not allowed yet.
  const [acceptedUrl, setAcceptedUrl] = useState<string | null>(null);
  const accepted = acceptedUrl !== null;
  const mustCheck = !!linked && (!!search.code || transportPolicy.need(linked) !== 'none');
  // Over https when the server answers there; the accepted address is kept from then on.
  const preferred = usePreferHttps(linked, mustCheck && !accepted);
  const server = acceptedUrl ?? preferred.url;
  const checking = preferred.checking;
  const showCheck = mustCheck && !accepted;
  // TV: sign in with a code confirmed on a phone (typing a password with a remote is no fun).
  const [step, setStep] = useState<Step>(search.code ? 'pair' : isTvMode() ? 'device' : 'password');
  const [username, setUsername] = useState(() => services.accounts.list().find((a) => a.serverUrl === server)?.username ?? '');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [recovery, setRecovery] = useState('');
  const [code, setCode] = useState(search.code ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ reason: SignInFailure; message: string } | null>(null);

  useEffect(() => {
    if (!linked) void navigate({ to: '/add-server', replace: true });
  }, [linked, navigate]);

  const finish = async (out: SignInOutcome) => {
    if (out.ok) {
      await services.switchAccount(out.account.id);
      void navigate({ to: '/player', replace: true });
      return;
    }
    setBusy(false);
    setFailure({ reason: out.reason, message: out.message });
    if (out.reason === 'totp-required' && step === 'password') setStep('totp');
    if (out.reason === 'pairing-required') setStep('pair');
  };

  const pair = async (raw: string) => {
    setFailure(null);
    setBusy(true);
    await finish(await signInWithPairCode(services.accounts, server, raw));
  };

  // Opened from a QR code / pairing link: pair once the user accepted the server.
  const acceptServer = () => {
    setAcceptedUrl(server);
    if (search.code) void pair(search.code);
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    setBusy(true);
    await finish(
      await signInWithPassword(services.accounts, {
        serverUrl: server,
        username: username.trim(),
        password,
        ...(step === 'totp' && totp ? { totp: totp.replace(/\s/g, '') } : {}),
        ...(step === 'recovery' && recovery ? { recoveryCode: recovery.trim() } : {}),
      }),
    );
  };

  const failureText = failure
    ? failure.reason === 'totp-required' && step === 'totp'
      ? null
      : t(`app.signIn.error.${failure.reason}`, { message: failure.message })
    : null;

  return (
    <Onboarding back={() => void navigate({ to: services.accounts.list().length ? '/player/settings' : '/welcome' })}>
      <Pane chamfer="both" strong className="app-card">
        <h1 className="app-card__title">{t('app.signIn.title')}</h1>
        <p className="app-card__sub">{t('app.signIn.to', { server: hostOf(server) })}</p>
        {search.expired ? <Banner tone="warn">{t('app.signIn.expired', { server: hostOf(server) })}</Banner> : null}
        {showCheck && checking ? (
          <Button variant="primary" block loading disabled>
            {t('app.addServer.checking')}
          </Button>
        ) : showCheck ? (
          <ServerCheck
            url={server}
            acceptLabel={search.code ? t('app.signIn.pair') : t('app.addServer.connect')}
            onAccept={acceptServer}
            onCancel={() => void navigate({ to: services.accounts.list().length ? '/player/settings' : '/welcome' })}
          />
        ) : step === 'device' ? (
          <DeviceCodeSignIn
            server={server}
            onSignedIn={(account) => void finish({ ok: true, account })}
            onPassword={() => (setFailure(null), setStep('password'))}
          />
        ) : step === 'pair' ? (
          <form
            className="app-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void pair(code);
            }}
            noValidate
          >
            <Field label={t('app.signIn.pairCode')} hint={t('app.signIn.pairHint')} error={failureText ?? undefined}>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                mono
                size="lg"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="one-time-code"
                maxLength={12}
              />
            </Field>
            <Button type="submit" variant="primary" block loading={busy} disabled={normalisePairCode(code).length !== 8}>
              {busy ? t('app.signIn.pairing', { server: hostOf(server) }) : t('app.signIn.pair')}
            </Button>
            <Button variant="ghost" block onClick={() => (setFailure(null), setStep('password'))}>
              {t('app.signIn.passwordInstead')}
            </Button>
          </form>
        ) : (
          <form className="app-stack" onSubmit={(e) => void submitPassword(e)} noValidate>
            {step === 'password' ? (
              <>
                <Field label={t('app.signIn.username')}>
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="username" size="lg" />
                </Field>
                <Field label={t('app.signIn.password')} error={failureText ?? undefined}>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" size="lg" />
                </Field>
              </>
            ) : step === 'totp' ? (
              <Field label={t('app.signIn.totp')} hint={t('app.signIn.totpHint')} error={failureText ?? undefined}>
                <Input
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  mono
                  size="lg"
                  autoFocus
                />
              </Field>
            ) : (
              <Field label={t('app.signIn.recovery')} error={failureText ?? undefined}>
                <Input value={recovery} onChange={(e) => setRecovery(e.target.value)} autoCapitalize="none" autoCorrect="off" mono size="lg" autoFocus />
              </Field>
            )}
            <Button
              type="submit"
              variant="primary"
              block
              loading={busy}
              disabled={step === 'password' ? !username.trim() || !password : step === 'totp' ? totp.replace(/\s/g, '').length !== 6 : !recovery.trim()}
            >
              {t('app.signIn.submit')}
            </Button>
            {step === 'totp' ? (
              <Button variant="ghost" block onClick={() => (setFailure(null), setStep('recovery'))}>
                {t('app.signIn.useRecovery')}
              </Button>
            ) : null}
            {step === 'password' ? (
              <Button variant="ghost" block onClick={() => (setFailure(null), setStep(isTvMode() ? 'device' : 'pair'))}>
                {isTvMode() ? t('app.tv.code.instead') : t('app.signIn.pairInstead')}
              </Button>
            ) : null}
          </form>
        )}
        <Button variant="ghost" block onClick={() => void navigate({ to: '/add-server' })}>
          {t('app.signIn.otherServer')}
        </Button>
      </Pane>
    </Onboarding>
  );
}

/**
 * A saved account on a plain-http server on the internet, from before the cleartext policy (or
 * whose host has since answered over https): moved to https when the server answers there,
 * otherwise confirmed once by typing the host name. Until then the API client sends it nothing.
 */
export function SecureServerPage() {
  const t = useT();
  const navigate = useNavigate();
  const services = useServices();
  const account = services.accounts.active();
  const saved = account?.serverUrl ?? '';
  const { url, checking } = usePreferHttps(saved, !!account);
  const [busy, setBusy] = useState(false);
  const finished = useRef(false);

  const done = async () => {
    if (finished.current) return;
    finished.current = true;
    setBusy(true);
    if (account) await services.switchAccount(account.id);
    void navigate({ to: '/player', replace: true });
  };

  useEffect(() => {
    if (!account) {
      void navigate({ to: '/', replace: true });
      return;
    }
    if (checking) return;
    if (url !== saved) {
      void services.accounts.moveServer(saved, url).then(done);
      return;
    }
    if (transportPolicy.allowsCredentials(saved)) void done();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, checking, url, saved]);

  return (
    <Onboarding>
      <Pane chamfer="both" strong className="app-card">
        <h1 className="app-card__title">{t('app.serverCheck.savedTitle')}</h1>
        <p className="app-card__sub">{t('app.serverCheck.savedBody')}</p>
        {!account || checking || url !== saved ? (
          <Button variant="primary" block loading disabled>
            {t('app.addServer.checking')}
          </Button>
        ) : (
          <ServerCheck url={saved} acceptLabel={t('app.serverCheck.continue')} busy={busy} onAccept={() => void done()} onCancel={() => void navigate({ to: '/welcome' })} />
        )}
      </Pane>
    </Onboarding>
  );
}
