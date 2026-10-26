import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { PASSWORD_MIN_LENGTH, type AuthMethod, type MediaType, type SetupStatus, type SetupStepId } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { setupApi } from '../../api/auth.js';
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

// Page 08 first-run wizard: Admin → TMDB → Root folders → Download client → Indexer → VPN.
// One chamfered card per step under a diamond stepper. The admin step signs the new admin
// in; every later step saves through the normal api as that admin, and the last step marks
// setup complete (with the sign-in method).

export type WizardStep = SetupStepId | 'vpn';
export const WIZARD_STEPS: readonly { id: WizardStep; label: string; optional?: boolean }[] = [
  { id: 'admin', label: 'Admin' },
  { id: 'tmdb', label: 'TMDB' },
  { id: 'rootFolders', label: 'Root folders' },
  { id: 'downloadClient', label: 'Download client', optional: true },
  { id: 'indexer', label: 'Indexer', optional: true },
  { id: 'vpn', label: 'VPN', optional: true },
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
  if (username.length < 2) e.username = 'At least 2 characters.';
  else if (!/^[A-Za-z0-9._@-]+$/.test(username)) e.username = 'Letters, digits and . _ @ - only.';
  if (d.password.length < PASSWORD_MIN_LENGTH) e.password = `At least ${PASSWORD_MIN_LENGTH} characters.`;
  if (d.confirm !== d.password) e.confirm = 'Passwords do not match.';
  if (d.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) e.email = 'Not a valid email address.';
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
  if (tv && !isAbsolutePath(tv)) e.tv = 'Use an absolute path.';
  if (movies && !isAbsolutePath(movies)) e.movies = 'Use an absolute path.';
  if (tv && movies && tv === movies) e.movies = 'TV and movies need different folders.';
  if (!tv && !movies && !alreadyHasOne) e.form = 'Add at least one root folder.';
  return e;
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
function StepFooter({ onBack, onSkip, onContinue, continueLabel = 'Continue', busy, extra }: StepFooterProps) {
  return (
    <div className="wiz-footer">
      {onBack ? (
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      ) : null}
      <span className="wiz-footer__spacer" />
      {extra}
      {onSkip ? (
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
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
      <StepHead title="Create the admin account">You sign in with this account. You can add more people later.</StepHead>
      <div className="wiz-grid">
        <Field label="Username" error={errors.username}>
          <Input size="lg" autoComplete="username" value={draft.username} onChange={set('username')} />
        </Field>
        <Field label="Email (optional)" error={errors.email}>
          <Input size="lg" type="email" autoComplete="email" value={draft.email} onChange={set('email')} />
        </Field>
        <Field label="Password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} error={errors.password}>
          <Input size="lg" type="password" autoComplete="new-password" value={draft.password} onChange={set('password')} />
        </Field>
        <Field label="Confirm password" error={errors.confirm}>
          <Input size="lg" type="password" autoComplete="new-password" value={draft.confirm} onChange={set('confirm')} />
        </Field>
      </div>
      {failure ? <ErrorBlock title="Couldn't create the admin account">{failure}</ErrorBlock> : null}
      <button type="submit" hidden />
      <StepFooter onContinue={() => void submit()} continueLabel="Create admin account" busy={busy} />
    </form>
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
    if (!key.trim() && !complete) return setResult({ ok: false, message: 'Enter a key first.' });
    setBusy('test');
    try {
      await save();
      const found = await metadataApi.search('The Matrix', 'movie');
      setResult({ ok: true, message: `The key works. A test search found ${found.length} results.` });
    } catch (err) {
      setResult({ ok: false, message: `Test failed · ${errorMessage(err)}` });
    } finally {
      setBusy(null);
    }
  };

  const next = async () => {
    if (!key.trim() && !complete) return setResult({ ok: false, message: 'A TMDB API key is required for series and movie information.' });
    setBusy('next');
    try {
      await save();
      onDone();
    } catch (err) {
      setResult({ ok: false, message: `Save failed · ${errorMessage(err)}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="wiz-body">
      <StepHead title="Connect TMDB">
        Arclight reads series and movie information from TMDB. Create a free v3 API key at themoviedb.org under Settings › API.
        {complete ? ' A key is already saved; enter a new one to replace it.' : ''}
      </StepHead>
      <Field label="TMDB API key">
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
            Test key
          </Button>
        }
      />
    </div>
  );
}

const ROOT_KIND_LABEL: Record<MediaType, string> = { series: 'TV', movie: 'Movies' };

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
    if (!isAbsolutePath(p)) return setError('Use an absolute path, such as /media/tv.');
    if (added.some((f) => f.path === p)) return setError(`${p} is already added.`);
    setBusy(true);
    setError(null);
    try {
      await setupApi.addRootFolder({ path: p, mediaType: kind, createIfMissing: true });
      setPath('');
      await qc.invalidateQueries({ queryKey: ['setup', 'rootfolders'] });
      // The other kind usually comes next.
      setKind(kind === 'series' ? 'movie' : 'series');
    } catch (err) {
      setError(`Couldn't add ${p} · ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await libraryApi.rootFolders.remove(id);
      await qc.invalidateQueries({ queryKey: ['setup', 'rootfolders'] });
    } catch (err) {
      setError(`Couldn't remove the folder · ${errorMessage(err)}`);
    }
  };

  const next = () => {
    if (added.length === 0) return setError('Add at least one root folder.');
    onDone();
  };

  return (
    <div className="wiz-body">
      <StepHead title="Where is your media stored?">Add a root folder for TV and one for movies. Arclight imports finished downloads into these.</StepHead>
      <Segmented<MediaType>
        aria-label="Folder for"
        options={[
          { value: 'series', label: 'TV' },
          { value: 'movie', label: 'Movies' },
        ]}
        value={kind}
        onChange={setKind}
      />
      <PathPickerField
        label={`${ROOT_KIND_LABEL[kind]} root folder`}
        value={path}
        onChange={setPath}
        entries={entries}
        crumbs={crumbsFor(listing.data?.path ?? browse)}
        onNavigate={(p) => setBrowse(p)}
        onAdd={(p) => void add(p)}
        addLabel={busy ? 'Adding…' : 'Add'}
        loading={listing.isLoading}
        error={error ?? (listing.isError ? `Couldn't list folders · ${errorMessage(listing.error)}` : undefined)}
        placeholder={kind === 'series' ? '/media/tv' : '/media/movies'}
      />
      <div className="wiz-added">
        <SectionLabel count={added.length || undefined}>Added</SectionLabel>
        {folders.isLoading ? (
          <Skeleton lines={1} />
        ) : added.length === 0 ? (
          <p className="wiz-muted">Nothing added yet.</p>
        ) : (
          <ul>
            {added.map((f) => (
              <li key={f.id} className="wiz-added__row">
                <span className="wiz-added__dot" aria-hidden="true" />
                <span className="al-num wiz-added__path">{f.path}</span>
                <span className="wiz-muted">
                  {ROOT_KIND_LABEL[f.mediaType]}
                  {f.freeSpaceBytes != null ? (
                    <>
                      {' · '}
                      <span className="al-num">{formatBytes(f.freeSpaceBytes)}</span> free
                    </>
                  ) : null}
                </span>
                <Button size="sm" variant="ghost" className="wiz-added__remove" aria-label={`Remove ${f.path}`} onClick={() => void remove(f.id)}>
                  Remove
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

  const finish = async () => {
    setBusy(true);
    try {
      await setupApi.complete({ authMethod: method });
      await qc.invalidateQueries({ queryKey: authKeys.all });
      await router.navigate({ to: '/', replace: true });
    } catch (err) {
      setFailure(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="wiz-body">
      <StepHead title="Protect downloads with a VPN">Optional. Arclight pauses downloads whenever the tunnel drops. You can set this up later in Settings › VPN.</StepHead>
      <div className="wiz-embed">
        <VpnSettingsPage />
      </div>
      <FormSection label="Sign-in">
        <Field label="How people sign in" hint="You can change this later in Settings › Security.">
          <Select
            value={method}
            onChange={(e) => setMethod(e.currentTarget.value as AuthMethod)}
            options={[
              { value: 'forms', label: 'Login page (recommended)' },
              { value: 'basic', label: 'Browser prompt (HTTP Basic)' },
              { value: 'none', label: 'None on the local network' },
            ]}
          />
        </Field>
      </FormSection>
      {failure ? <ErrorBlock title="Couldn't finish setup">{failure}</ErrorBlock> : null}
      <StepFooter onBack={onBack} onSkip={() => void finish()} onContinue={() => void finish()} continueLabel="Finish setup" busy={busy} />
    </div>
  );
}

function WizardFrame({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div className="al-app wiz">
      <Backdrop vx={0.5} horizon={0.625} spire={false} />
      <header className="wiz-bar">
        <Mark size={26} />
        <span className="al-wordmark">ARCLIGHT</span>
        <span className="wiz-bar__label">Setup</span>
        <span className="wiz-bar__spacer" />
        {index >= 0 ? (
          <span className="wiz-bar__count">
            Step <span className="al-num">{index + 1}</span> of {WIZARD_STEPS.length}
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
    document.title = 'Setup · Arclight';
  }, []);

  useEffect(() => {
    if (step === null && setup.data) setStep(firstIncompleteStep(setup.data));
  }, [setup.data, step]);

  if (setup.isError) {
    return (
      <WizardFrame index={-1}>
        <ErrorBlock title="Couldn't load setup" onRetry={() => void setup.refetch()}>
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

  const complete = (id: WizardStep) => (id === 'vpn' ? false : (setup.data.steps.find((s) => s.id === id)?.complete ?? false));
  const index = WIZARD_STEPS.findIndex((s) => s.id === step);
  const goTo = (i: number) => {
    void setup.refetch();
    setStep(WIZARD_STEPS[Math.min(Math.max(i, 0), WIZARD_STEPS.length - 1)]!.id);
  };
  const next = () => goTo(index + 1);
  const back = () => goTo(index - 1);
  const needsSignIn = complete('admin') && !authStatus?.authenticated && step !== 'admin';

  let body: ReactNode;
  if (needsSignIn) {
    body = (
      <div className="wiz-body">
        <StepHead title="Sign in to continue">An admin account already exists. Sign in with it to finish setup.</StepHead>
        <StepFooter onContinue={() => void router.navigate({ to: '/login', search: { redirect: '/setup' } })} continueLabel="Sign in" />
      </div>
    );
  } else if (step === 'admin') {
    body = complete('admin') ? (
      <div className="wiz-body">
        <StepHead title="The admin account is ready">Continue to connect TMDB.</StepHead>
        <StepFooter onContinue={next} />
      </div>
    ) : (
      <AdminStep onDone={next} />
    );
  } else if (step === 'tmdb') body = <TmdbStep complete={complete('tmdb')} onBack={back} onDone={next} />;
  else if (step === 'rootFolders') body = <RootFoldersStep onBack={back} onDone={next} />;
  else if (step === 'downloadClient') {
    body = (
      <EmbeddedStep title="Add a download client" lead="Optional. The client downloads the releases Arclight grabs." complete={complete('downloadClient')} onBack={back} onDone={next}>
        <DownloadClientsPage />
      </EmbeddedStep>
    );
  } else if (step === 'indexer') {
    body = (
      <EmbeddedStep title="Add an indexer" lead="Optional. Indexers are where Arclight searches for releases." complete={complete('indexer')} onBack={back} onDone={next}>
        <IndexersPage />
      </EmbeddedStep>
    );
  } else body = <VpnStep onBack={back} />;

  return (
    <WizardFrame index={index}>
      <Stepper
        aria-label="Setup steps"
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
