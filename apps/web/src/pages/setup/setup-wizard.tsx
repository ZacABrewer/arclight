import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { PASSWORD_MIN_LENGTH, type AuthMethod, type MediaType, type SetupStatus, type SetupStepId } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { setupApi, usersApi } from '../../api/auth.js';
import { LanguageSelect } from '../../components/language-select.js';
import { filesystemApi } from '../../api/filesystem.js';
import { libraryApi } from '../../api/library.js';
import { metadataApi } from '../../api/metadata.js';
import { settingsApi } from '../../api/settings.js';
import {
  Backdrop,
  Banner,
  Button,
  ErrorBlock,
  Field,
  FormSection,
  Input,
  Mark,
  Pane,
  PathPickerField,
  SectionLabel,
  Segmented,
  Select,
  Skeleton,
  Stepper,
  type PathEntry,
} from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { authKeys } from '../../auth/guard.js';
import { formatBytes } from '../system/format.js';
import { DownloadClientsPage } from '../settings/download-clients/download-clients-page.js';
import { IndexersPage } from '../settings/indexers/indexers-page.js';
import { VpnSettingsPage } from '../settings/vpn.js';
import { crumbsFor } from './path-crumbs.js';
import { UserDefaultsFields, useUserDefaults } from '../../features/users/user-defaults.js';
import { t, chooseLocale, deviceLocale, type LocaleSetting } from '../../i18n/index.js';
import { rootKindLabel } from '../../components/media/root-kind.js';

// Page 08 first-run wizard: Admin → User defaults → TMDB → Root folders → Download client →
// Indexer → VPN. One chamfered card per step under a diamond stepper. The admin step creates a
// local admin account (username + password; never a media-server account) and signs it in; no
// other step opens before it. Every later step saves through the normal api as that admin, and
// the last step marks setup complete (with the sign-in method).

export type WizardStep = SetupStepId | 'users' | 'vpn';
export const WIZARD_STEPS: readonly { id: WizardStep; label: string; optional?: boolean }[] = [
  { id: 'admin', get label() { return t('common.admin'); } },
  { id: 'users', get label() { return t('setup.wizard.userDefaults'); } },
  { id: 'tmdb', get label() { return t('setup.wizard.tmdb'); } },
  { id: 'rootFolders', get label() { return t('common.rootFolders'); } },
  { id: 'downloadClient', get label() { return t('setup.wizard.downloadClient'); }, optional: true },
  { id: 'indexer', get label() { return t('common.indexer'); }, optional: true },
  { id: 'vpn', get label() { return t('common.vpn'); }, optional: true },
];

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export interface AdminDraft {
  username: string;
  password: string;
  confirm: string;
  email: string;
}

export function validateAdmin(d: AdminDraft): FieldErrors<keyof AdminDraft> {
  const e: FieldErrors<keyof AdminDraft> = {};
  const username = d.username.trim();
  if (username.length < 2) e.username = t('setup.wizard.atLeast2Characters');
  else if (!/^[A-Za-z0-9._@-]+$/.test(username)) e.username = t('setup.wizard.lettersDigitsAndOnly');
  if (d.password.length < PASSWORD_MIN_LENGTH) e.password = t('setup.wizard.atLeastPasswordMinLength', { PASSWORD_MIN_LENGTH });
  if (d.confirm !== d.password) e.confirm = t('setup.wizard.passwordsDoNotMatch');
  if (d.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) e.email = t('setup.wizard.notAValidEmailAddress');
  return e;
}

export interface RootFolderDraft {
  tv: string;
  movies: string;
}

/** Absolute POSIX (/data/tv) or Windows (D:\Media, \\nas\share) path. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

export function validateRootFolders(d: RootFolderDraft, alreadyHasOne: boolean): FieldErrors<keyof RootFolderDraft | 'form'> {
  const e: FieldErrors<keyof RootFolderDraft | 'form'> = {};
  const tv = d.tv.trim();
  const movies = d.movies.trim();
  if (tv && !isAbsolutePath(tv)) e.tv = t('setup.wizard.useAnAbsolutePath');
  if (movies && !isAbsolutePath(movies)) e.movies = t('setup.wizard.useAnAbsolutePath');
  if (tv && movies && tv === movies) e.movies = t('setup.wizard.tvAndMoviesNeedDifferent');
  if (!tv && !movies && !alreadyHasOne) e.form = t('setup.wizard.addAtLeastOneRoot');
  return e;
}

/** The step to show for stepper index `i`: nothing past the admin step until the admin exists. */
export function wizardTarget(i: number, adminDone: boolean): WizardStep {
  if (!adminDone) return 'admin';
  return WIZARD_STEPS[Math.min(Math.max(i, 0), WIZARD_STEPS.length - 1)]!.id;
}

export function firstIncompleteStep(status: SetupStatus): WizardStep {
  const next = status.steps.find((s) => !s.complete && !s.optional);
  return next?.id ?? 'downloadClient';
}

function hasErrors(e: object): boolean {
  return Object.values(e).some(Boolean);
}

interface StepFooterProps {
  onBack?: (() => void) | undefined;
  onSkip?: (() => void) | undefined;
  onContinue: () => void;
  continueLabel?: string | undefined;
  busy?: boolean | undefined;
  extra?: ReactNode;
}

/** Back (ghost) left; Skip for now (ghost) + Continue (primary) right. */
function StepFooter({ onBack, onSkip, onContinue, continueLabel = t('setup.wizard.continue'), busy, extra }: StepFooterProps) {
  return (
    <div className="wiz-footer">
      {onBack ? (
        <Button variant="ghost" onClick={onBack}>
          {t('setup.wizard.back')}
        </Button>
      ) : null}
      <span className="wiz-footer__spacer" />
      {extra}
      {onSkip ? (
        <Button variant="ghost" onClick={onSkip}>
          {t('setup.wizard.skipForNow')}
        </Button>
      ) : null}
      <Button variant="primary" loading={busy ?? false} onClick={onContinue}>
        {continueLabel}
      </Button>
    </div>
  );
}

function StepHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="wiz-head">
      <h2 className="wiz-head__title">{title}</h2>
      {children ? <p className="wiz-head__lead">{children}</p> : null}
    </div>
  );
}

function AdminStep({ onDone }: { onDone: () => void }) {
  const { refresh } = useAuth();
  const [draft, setDraft] = useState<AdminDraft>({ username: 'admin', password: '', confirm: '', email: '' });
  const [errors, setErrors] = useState<FieldErrors<keyof AdminDraft>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [language, setLanguage] = useState<LocaleSetting>(() => deviceLocale() ?? 'auto');
  const set = (k: keyof AdminDraft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: e.currentTarget.value });

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const found = validateAdmin(draft);
    setErrors(found);
    if (hasErrors(found)) return;
    setBusy(true);
    setFailure(null);
    try {
      await setupApi.createAdmin({ username: draft.username.trim(), password: draft.password, ...(draft.email.trim() ? { email: draft.email.trim() } : {}) });
      // The new admin is signed in now: keep the language on the account (best effort).
      if (language !== 'auto') await usersApi.updateMe({ settings: { locale: language } }).catch(() => undefined);
      await refresh();
      onDone();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="wiz-body" onSubmit={(e) => void submit(e)} noValidate>
      <StepHead title={t('setup.wizard.createTheAdminAccount')}>{t('setup.wizard.adminIsLocal')}</StepHead>
      <div className="wiz-grid">
        <Field label={t('setup.wizard.language')} hint={t('setup.wizard.languageHint')}>
          <LanguageSelect
            value={language}
            onChange={(v) => {
              setLanguage(v);
              void chooseLocale(v);
            }}
          />
        </Field>
        <Field label={t('common.username')} error={errors.username}>
          <Input size="lg" autoComplete="username" value={draft.username} onChange={set('username')} />
        </Field>
        <Field label={t('setup.wizard.emailOptional')} error={errors.email}>
          <Input size="lg" type="email" autoComplete="email" value={draft.email} onChange={set('email')} />
        </Field>
        <Field label={t('common.password')} hint={t('setup.wizard.atLeastPasswordMinLength', { PASSWORD_MIN_LENGTH })} error={errors.password}>
          <Input size="lg" type="password" autoComplete="new-password" value={draft.password} onChange={set('password')} />
        </Field>
        <Field label={t('setup.wizard.confirmPassword')} error={errors.confirm}>
          <Input size="lg" type="password" autoComplete="new-password" value={draft.confirm} onChange={set('confirm')} />
        </Field>
      </div>
      {failure ? <ErrorBlock title={t('setup.wizard.couldntCreateTheAdminAccount')}>{failure}</ErrorBlock> : null}
      <button type="submit" hidden />
      <StepFooter onContinue={() => void submit()} continueLabel={t('setup.wizard.createAdminAccount')} busy={busy} />
    </form>
  );
}

/** Who else may sign in, and what new accounts get (Settings > Users later). */
function UserDefaultsStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const state = useUserDefaults();
  const next = async () => {
    if (await state.save()) onDone();
  };
  return (
    <div className="wiz-body">
      <StepHead title={t('setup.wizard.userDefaultsTitle')}>{t('setup.wizard.userDefaultsLead')}</StepHead>
      <UserDefaultsFields state={state} />
      <StepFooter onBack={onBack} onContinue={() => void next()} busy={state.saving} />
    </div>
  );
}

function TmdbStep({ complete, onBack, onDone }: { complete: boolean; onBack: () => void; onDone: () => void }) {
  const [key, setKey] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<'test' | 'next' | null>(null);

  const save = async () => {
    if (key.trim()) await settingsApi.metadata.update({ tmdbApiKey: key.trim() });
  };

  const test = async () => {
    if (!key.trim() && !complete) return setResult({ ok: false, message: t('setup.wizard.enterAKeyFirst') });
    setBusy('test');
    try {
      await save();
      const found = await metadataApi.search('The Matrix', 'movie');
      setResult({ ok: true, message: t('setup.wizard.theKeyWorksATest', { foundCount: found.length }) });
    } catch (err) {
      setResult({ ok: false, message: t('setup.wizard.testFailedErrormessage', { errorMessage: errorMessage(err) }) });
    } finally {
      setBusy(null);
    }
  };

  const next = async () => {
    if (!key.trim() && !complete) return setResult({ ok: false, message: t('setup.wizard.aTmdbApiKeyIs') });
    setBusy('next');
    try {
      await save();
      onDone();
    } catch (err) {
      setResult({ ok: false, message: t('setup.wizard.saveFailedErrormessage', { errorMessage: errorMessage(err) }) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="wiz-body">
      <StepHead title={t('setup.wizard.connectTmdb')}>
        {t('setup.wizard.arclightReadsSeriesAndMovie', { value: complete ? t('setup.wizard.aKeyIsAlreadySaved') : '' })}
      </StepHead>
      <Field label={t('setup.wizard.tmdbApiKey')}>
        <Input size="lg" mono value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.currentTarget.value)} />
      </Field>
      {result ? (
        result.ok ? (
          <Banner>{result.message}</Banner>
        ) : (
          <p className="wiz-error" role="alert">
            {result.message}
          </p>
        )
      ) : null}
      <StepFooter
        onBack={onBack}
        onContinue={() => void next()}
        busy={busy === 'next'}
        extra={
          <Button variant="secondary" loading={busy === 'test'} onClick={() => void test()}>
            {t('setup.wizard.testKey')}
          </Button>
        }
      />
    </div>
  );
}

const ROOT_KIND_LABEL: Record<MediaType, string> = { get series() { return t('common.tv'); }, get movie() { return t('common.movies'); } };

function RootFoldersStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<MediaType>('series');
  const [path, setPath] = useState('');
  const [browse, setBrowse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const folders = useQuery({ queryKey: ['setup', 'rootfolders'], queryFn: libraryApi.rootFolders.list, retry: false });
  const listing = useQuery({ queryKey: ['setup', 'fs', browse], queryFn: () => filesystemApi.list(browse), retry: false });

  const entries: PathEntry[] = (listing.data?.directories ?? []).map((d) => ({ name: d.name, path: d.path, kind: d.type === 'drive' ? 'drive' : 'folder' }));
  const added = folders.data ?? [];

  const add = async (value: string) => {
    const p = value.trim();
    if (!p) return;
    if (!isAbsolutePath(p)) return setError(t('setup.wizard.useAnAbsolutePathSuch'));
    if (added.some((f) => f.path === p)) return setError(t('setup.wizard.pIsAlreadyAdded', { p }));
    setBusy(true);
    setError(null);
    try {
      await setupApi.addRootFolder({ path: p, mediaType: kind, createIfMissing: true });
      setPath('');
      await qc.invalidateQueries({ queryKey: ['setup', 'rootfolders'] });
      // The other kind usually comes next.
      setKind(kind === 'series' ? 'movie' : 'series');
    } catch (err) {
      setError(t('setup.wizard.couldntAddPErrormessage', { p, errorMessage: errorMessage(err) }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await libraryApi.rootFolders.remove(id);
      await qc.invalidateQueries({ queryKey: ['setup', 'rootfolders'] });
    } catch (err) {
      setError(t('setup.wizard.couldntRemoveTheFolderErrormessage', { errorMessage: errorMessage(err) }));
    }
  };

  const next = () => {
    if (added.length === 0) return setError(t('setup.wizard.addAtLeastOneRoot'));
    onDone();
  };

  return (
    <div className="wiz-body">
      <StepHead title={t('setup.wizard.whereIsYourMediaStored')}>{t('setup.wizard.addARootFolderFor')}</StepHead>
      <Segmented<MediaType>
        aria-label={t('setup.wizard.folderFor')}
        options={[
          { value: 'series', label: t('common.tv') },
          { value: 'movie', label: t('common.movies') },
        ]}
        value={kind}
        onChange={setKind}
      />
      <PathPickerField
        label={t('setup.wizard.valueRootFolder', { value: ROOT_KIND_LABEL[kind] })}
        value={path}
        onChange={setPath}
        entries={entries}
        crumbs={crumbsFor(listing.data?.path ?? browse)}
        onNavigate={(p) => setBrowse(p)}
        onAdd={(p) => void add(p)}
        addLabel={busy ? t('setup.wizard.adding') : t('common.add')}
        loading={listing.isLoading}
        error={error ?? (listing.isError ? t('setup.wizard.couldntListFoldersErrormessage', { errorMessage: errorMessage(listing.error) }) : undefined)}
        placeholder={kind === 'series' ? '/media/tv' : '/media/movies'}
      />
      <div className="wiz-added">
        <SectionLabel count={added.length || undefined}>{t('common.added')}</SectionLabel>
        {folders.isLoading ? (
          <Skeleton lines={1} />
        ) : added.length === 0 ? (
          <p className="wiz-muted">{t('setup.wizard.nothingAddedYet')}</p>
        ) : (
          <ul>
            {added.map((f) => (
              <li key={f.id} className="wiz-added__row">
                <span className="wiz-added__dot" aria-hidden="true" />
                <span className="al-num wiz-added__path">{f.path}</span>
                <span className="wiz-muted">
                  {rootKindLabel(f.mediaType)}
                  {f.freeSpaceBytes != null ? (
                    <>
                      {' · '}
                      <span className="al-num">{formatBytes(f.freeSpaceBytes)}</span> {t('setup.wizard.free')}
                    </>
                  ) : null}
                </span>
                <Button size="sm" variant="ghost" className="wiz-added__remove" aria-label={t('setup.wizard.removePath', { path: f.path })} onClick={() => void remove(f.id)}>
                  {t('common.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <StepFooter onBack={onBack} onContinue={next} />
    </div>
  );
}

function EmbeddedStep({ title, lead, children, complete, onBack, onDone }: { title: string; lead: string; children: ReactNode; complete: boolean; onBack: () => void; onDone: () => void }) {
  return (
    <div className="wiz-body">
      <StepHead title={title}>{lead}</StepHead>
      <div className="wiz-embed">{children}</div>
      <StepFooter onBack={onBack} onSkip={complete ? undefined : onDone} onContinue={onDone} />
    </div>
  );
}

function VpnStep({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [method, setMethod] = useState<AuthMethod>('forms');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = async (to: '/' | '/system/migrate' = '/') => {
    setBusy(true);
    try {
      await setupApi.complete({ authMethod: method });
      await qc.invalidateQueries({ queryKey: authKeys.all });
      await router.navigate({ to, replace: true });
    } catch (err) {
      setFailure(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="wiz-body">
      <StepHead title={t('setup.wizard.protectDownloadsWithAVpn')}>{t('setup.wizard.optionalArclightPausesDownloadsWhenever')}</StepHead>
      <div className="wiz-embed">
        <VpnSettingsPage />
      </div>
      <FormSection label={t('setup.wizard.signIn')}>
        <Field label={t('setup.wizard.howPeopleSignIn')} hint={t('setup.wizard.youCanChangeThisLater')}>
          <Select
            value={method}
            onChange={(e) => setMethod(e.currentTarget.value as AuthMethod)}
            options={[
              { value: 'forms', label: t('setup.wizard.loginPageRecommended') },
              { value: 'basic', label: t('setup.wizard.browserPromptHttpBasic') },
              { value: 'none', label: t('setup.wizard.noneOnTheLocalNetwork') },
            ]}
          />
        </Field>
      </FormSection>
      <FormSection label={t('setup.wizard.importStackOptional')}>
        <p className="wiz-muted">{t('setup.wizard.importStackLead')}</p>
        <div>
          <Button variant="secondary" loading={busy} onClick={() => void finish('/system/migrate')}>
            {t('setup.wizard.finishAndImport')}
          </Button>
        </div>
      </FormSection>
      {failure ? <ErrorBlock title={t('setup.wizard.couldntFinishSetup')}>{failure}</ErrorBlock> : null}
      <StepFooter onBack={onBack} onSkip={() => void finish()} onContinue={() => void finish()} continueLabel={t('setup.wizard.finishSetup')} busy={busy} />
    </div>
  );
}

function WizardFrame({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div className="al-app wiz">
      <Backdrop vx={0.5} horizon={0.625} spire={false} />
      <header className="wiz-bar">
        <Mark size={26} />
        <span className="al-wordmark">{t('common.arclight')}</span>
        <span className="wiz-bar__label">{t('setup.wizard.setup')}</span>
        <span className="wiz-bar__spacer" />
        {index >= 0 ? (
          <span className="wiz-bar__count">
            {t('setup.wizard.step')} <span className="al-num">{index + 1}</span> {t('setup.wizard.ofWizardStepscount', { WIZARD_STEPSCount: WIZARD_STEPS.length })}
          </span>
        ) : null}
      </header>
      <main className="wiz-main">{children}</main>
    </div>
  );
}

export function SetupWizard() {
  const { status: authStatus } = useAuth();
  const setup = useQuery({ queryKey: authKeys.setup, queryFn: setupApi.status, retry: false });
  const [step, setStep] = useState<WizardStep | null>(null);
  const router = useRouter();

  useEffect(() => {
    document.title = t('setup.wizard.setupArclight');
  }, []);

  useEffect(() => {
    if (step === null && setup.data) setStep(firstIncompleteStep(setup.data));
  }, [setup.data, step]);

  if (setup.isError) {
    return (
      <WizardFrame index={-1}>
        <ErrorBlock title={t('setup.wizard.couldntLoadSetup')} onRetry={() => void setup.refetch()}>
          {errorMessage(setup.error)}
        </ErrorBlock>
      </WizardFrame>
    );
  }
  if (setup.isPending || step === null) {
    return (
      <WizardFrame index={-1}>
        <Pane chamfer="tl" className="wiz-card">
          <Skeleton lines={4} />
        </Pane>
      </WizardFrame>
    );
  }

  const complete = (id: WizardStep) => (id === 'vpn' || id === 'users' ? false : (setup.data.steps.find((s) => s.id === id)?.complete ?? false));
  const index = WIZARD_STEPS.findIndex((s) => s.id === step);
  const goTo = (i: number) => {
    void setup.refetch();
    setStep(wizardTarget(i, complete('admin')));
  };
  const next = () => goTo(index + 1);
  const back = () => goTo(index - 1);
  const needsSignIn = complete('admin') && !authStatus?.authenticated && step !== 'admin';

  let body: ReactNode;
  if (needsSignIn) {
    body = (
      <div className="wiz-body">
        <StepHead title={t('setup.wizard.signInToContinue')}>{t('setup.wizard.anAdminAccountAlreadyExists')}</StepHead>
        <StepFooter onContinue={() => void router.navigate({ to: '/login', search: { redirect: '/setup' } })} continueLabel={t('setup.wizard.signIn2')} />
      </div>
    );
  } else if (step === 'admin') {
    body = complete('admin') ? (
      <div className="wiz-body">
        <StepHead title={t('setup.wizard.theAdminAccountIsReady')}>{t('setup.wizard.continueToUserDefaults')}</StepHead>
        <StepFooter onContinue={next} />
      </div>
    ) : (
      <AdminStep
        onDone={() => {
          // The admin exists now (setup status catches up on the refetch).
          void setup.refetch();
          setStep('users');
        }}
      />
    );
  } else if (step === 'users') body = <UserDefaultsStep onBack={back} onDone={next} />;
  else if (step === 'tmdb') body = <TmdbStep complete={complete('tmdb')} onBack={back} onDone={next} />;
  else if (step === 'rootFolders') body = <RootFoldersStep onBack={back} onDone={next} />;
  else if (step === 'downloadClient') {
    body = (
      <EmbeddedStep title={t('setup.wizard.addADownloadClient')} lead={t('setup.wizard.optionalTheClientDownloadsThe')} complete={complete('downloadClient')} onBack={back} onDone={next}>
        <DownloadClientsPage />
      </EmbeddedStep>
    );
  } else if (step === 'indexer') {
    body = (
      <EmbeddedStep title={t('setup.wizard.addAnIndexer')} lead={t('setup.wizard.optionalIndexersAreWhereArclight')} complete={complete('indexer')} onBack={back} onDone={next}>
        <IndexersPage />
      </EmbeddedStep>
    );
  } else body = <VpnStep onBack={back} />;

  return (
    <WizardFrame index={index}>
      <Stepper
        aria-label={t('setup.wizard.setupSteps')}
        className="wiz-stepper"
        steps={WIZARD_STEPS.map((s) => ({ id: s.id, label: s.label }))}
        current={index}
        onStepClick={(i) => goTo(i)}
      />
      <Pane chamfer="tl" strong className="wiz-card" aria-label={WIZARD_STEPS[index]?.label}>
        {body}
      </Pane>
    </WizardFrame>
  );
}
