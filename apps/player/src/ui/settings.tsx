import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Banner, Button, Icon, Pane, Select, SwitchButton, buttonClass, cx } from '@web/arclight/index';
import { LOCALES, applyLocaleSetting, useT, type LocaleSetting } from '@web/i18n/index';
import { useAccounts, useAppSettings, useServices } from '../app/context';
import { accountLabel, type Account } from '../core/accounts';
import { STREAM_QUALITIES, type AppSettings, type StreamQuality } from '../core/settings';
import { signOut } from '../core/sign-in';
import { APP_VERSION } from '../config';
import { hostOf } from './onboarding';
import { isTvMode } from '../tv/tv-mode';

// Settings: accounts (switch, add, sign out), streaming and download quality, storage, language,
// progress sync, about.

/** Applies the app's language setting ('system' follows the phone). */
export function applyAppLanguage(language: string): Promise<unknown> {
  return applyLocaleSetting(language === 'system' ? 'auto' : (language as LocaleSetting));
}

function Row({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="app-setting">
      <div className="app-setting__text">
        <label className="app-setting__label" htmlFor={htmlFor}>
          {label}
        </label>
        {hint ? <p className="app-setting__hint">{hint}</p> : null}
      </div>
      <div className="app-setting__control">{children}</div>
    </div>
  );
}

function AccountRow({ account, active }: { account: Account; active: boolean }) {
  const t = useT();
  const services = useServices();
  const navigate = useNavigate();
  const [hasToken, setHasToken] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void services.accounts.token(account.id).then((tok) => live && setHasToken(Boolean(tok)));
    return () => {
      live = false;
    };
  }, [services, account.id, active]);

  const server = `${account.serverName} · ${hostOf(account.serverUrl)}`;
  return (
    <li className={cx('app-account', active && 'is-active')}>
      <div className="app-account__text">
        <span className="app-account__name">
          {accountLabel(account)}
          {active ? <span className="app-chip">{t('app.settings.active')}</span> : null}
          {!hasToken ? <span className="app-chip app-chip--warn">{t('app.settings.signedOut')}</span> : null}
        </span>
        <span className="app-account__server">{server}</span>
      </div>
      <div className="app-row">
        {!hasToken ? (
          <Link to="/sign-in" search={{ server: account.serverUrl }} className={buttonClass({ variant: 'secondary' })}>
            {t('app.settings.signInAgain')}
          </Link>
        ) : !active ? (
          <Button
            variant="secondary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await services.switchAccount(account.id);
              setBusy(false);
              void navigate({ to: '/player' });
            }}
          >
            {t('app.settings.switch')}
          </Button>
        ) : null}
        <Button variant="ghost" data-tv-not-first="" onClick={() => setConfirm(true)}>
          {t('app.settings.signOut')}
        </Button>
      </div>
      {confirm ? (
        <Banner
          tone="danger"
          action={
            <div className="app-row">
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                {t('app.common.cancel')}
              </Button>
              <Button
                variant="danger-solid"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  await signOut(services.accounts, account.id);
                  if (active) await services.switchAccount(null);
                  setBusy(false);
                  setConfirm(false);
                }}
              >
                {t('app.settings.signOut')}
              </Button>
            </div>
          }
        >
          {t('app.settings.signOutConfirm', { server })}
        </Banner>
      ) : null}
    </li>
  );
}

const LIMITS_GB = [0, 2, 5, 10, 20, 50, 100];
const KEEP_FREE_GB = [0, 1, 2, 5, 10];

export function SettingsPage() {
  const t = useT();
  const services = useServices();
  const { accounts, active } = useAccounts();
  const [settings, update] = useAppSettings();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let live = true;
    void services.progressQueue.size().then((n) => live && setPending(n));
    return () => {
      live = false;
    };
  }, [services]);

  const qualityOptions = STREAM_QUALITIES.map((q) => ({
    value: q,
    label: q === 'original' ? t('app.settings.original') : t('app.settings.aac', { kbps: q.split('-')[1] }),
  }));

  const setQuality = (key: 'wifiQuality' | 'cellularQuality' | 'downloadQuality', value: string) => {
    void update({ [key]: value as StreamQuality } as Partial<AppSettings>).then(() => services.player().resetLinks());
  };

  const backend = services.backend;

  return (
    <div className="app-page">
      <h1 className="app-page__title">{t('app.settings.title')}</h1>

      <section className="app-section">
        <h2 className="app-section__title">{t('app.settings.accounts')}</h2>
        <Pane>
          <ul className="app-accounts">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} active={a.id === active?.id} />
            ))}
          </ul>
          <Link to="/welcome" className={buttonClass({ variant: 'ghost', block: true })}>
            <Icon name="plus" size={20} /> {t('app.settings.addAccount')}
          </Link>
        </Pane>
      </section>

      <section className="app-section">
        <h2 className="app-section__title">{t('app.settings.streaming')}</h2>
        <Pane>
          <Row label={t('app.settings.wifiQuality')} htmlFor="set-wifi">
            <Select id="set-wifi" options={qualityOptions} value={settings.wifiQuality} onChange={(e) => setQuality('wifiQuality', e.target.value)} />
          </Row>
          {/* A TV has no mobile data; it keeps no downloads either. */}
          {!services.tv ? (
            <Row label={t('app.settings.cellularQuality')} hint={t('app.settings.qualityHint')} htmlFor="set-cell">
              <Select id="set-cell" options={qualityOptions} value={settings.cellularQuality} onChange={(e) => setQuality('cellularQuality', e.target.value)} />
            </Row>
          ) : null}
        </Pane>
      </section>

      {!services.tv ? (
      <section className="app-section">
        <h2 className="app-section__title">{t('app.settings.downloads')}</h2>
        <Pane>
          <Row label={t('app.settings.downloadQuality')} htmlFor="set-dl">
            <Select id="set-dl" options={qualityOptions} value={settings.downloadQuality} onChange={(e) => setQuality('downloadQuality', e.target.value)} />
          </Row>
          <Row label={t('app.settings.wifiOnly')}>
            <SwitchButton
              checked={settings.downloadsWifiOnly}
              aria-label={t('app.settings.wifiOnly')}
              onChange={(v) => void update({ downloadsWifiOnly: v }).then(() => services.downloads.applyPolicy())}
            />
          </Row>
          <Row label={t('app.settings.storageLimit')} htmlFor="set-limit">
            <Select
              id="set-limit"
              value={String(settings.storageLimitGb)}
              options={LIMITS_GB.map((g) => ({ value: String(g), label: g === 0 ? t('app.settings.noLimit') : t('app.settings.gb', { count: g }) }))}
              onChange={(e) => void update({ storageLimitGb: Number(e.target.value) })}
            />
          </Row>
          <Row label={t('app.settings.keepFree')} htmlFor="set-free">
            <Select
              id="set-free"
              value={String(settings.keepFreeGb)}
              options={KEEP_FREE_GB.map((g) => ({ value: String(g), label: t('app.settings.gb', { count: g }) }))}
              onChange={(e) => void update({ keepFreeGb: Number(e.target.value) })}
            />
          </Row>
        </Pane>
      </section>
      ) : null}

      <section className="app-section">
        <h2 className="app-section__title">{t('app.settings.privacy')}</h2>
        <Pane>
          <Row label={t('app.settings.reportProgress')} hint={t('app.settings.reportProgressHint')}>
            <SwitchButton checked={settings.reportProgress} aria-label={t('app.settings.reportProgress')} onChange={(v) => void update({ reportProgress: v })} />
          </Row>
          {pending > 0 ? <p className="app-hint">{t('app.settings.pending', { count: pending })}</p> : null}
        </Pane>
      </section>

      <section className="app-section">
        <h2 className="app-section__title">{t('app.settings.language')}</h2>
        <Pane>
          <Row label={t('app.settings.language')} htmlFor="set-lang">
            <Select
              id="set-lang"
              value={settings.language}
              options={[{ value: 'system', label: t(isTvMode() ? 'app.tv.languageSystem' : 'app.settings.languageSystem') }, ...LOCALES.map((l) => ({ value: l.code, label: l.nativeName }))]}
              onChange={(e) => {
                const language = e.target.value;
                void update({ language }).then(() => applyAppLanguage(language));
              }}
            />
          </Row>
        </Pane>
      </section>

      <section className="app-section">
        <h2 className="app-section__title">{t('app.settings.about')}</h2>
        <Pane className="app-about">
          <p>{t('app.settings.version', { version: APP_VERSION })}</p>
          {active ? <p>{t('app.settings.server', { name: active.serverName, version: active.serverVersion })}</p> : null}
          <p>{t('app.settings.engine', { engine: backend.native ? t('app.settings.engineNative') : t('app.settings.engineWeb') })}</p>
        </Pane>
      </section>
    </div>
  );
}
