import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { PASSWORD_MIN_LENGTH, type AuthMethod, type SetupStatus, type SetupStepId } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { setupApi } from '../../api/auth.js';
import { metadataApi } from '../../api/metadata.js';
import { settingsApi } from '../../api/settings.js';
import { useAuth } from '../../auth/auth-context.js';
import { authKeys } from '../../auth/guard.js';
import { Button } from '../../components/button.js';
import { FormField, Input, Select, Toggle } from '../../components/form.js';
import { LoadingBlock } from '../../components/spinner.js';
import { cx } from '../../lib/cx.js';
import { DownloadClientsPage } from '../settings/download-clients/download-clients-page.js';
import { IndexersPage } from '../settings/indexers/indexers-page.js';

// First-run wizard: admin -> TMDB key -> root folders -> download client -> indexer -> done.
// The admin step signs the new admin in; every later step saves through the normal api as
// that admin, and "Finish" marks setup complete.

export type WizardStep = SetupStepId | 'done';
export const WIZARD_STEPS: readonly { id: WizardStep; label: string; optional?: boolean }[] = [
  { id: 'admin', label: 'Admin account' },
  { id: 'tmdb', label: 'TMDB key' },
  { id: 'rootFolders', label: 'Root folders' },
  { id: 'downloadClient', label: 'Download client', optional: true },
  { id: 'indexer', label: 'Indexer', optional: true },
  { id: 'done', label: 'Done' },
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

function StepNav({ onBack, onNext, nextLabel = 'Next', busy, extra }: { onBack?: () => void; onNext: () => void; nextLabel?: string; busy?: boolean; extra?: ReactNode }) {
  return (
    <div className="wizard-nav">
      <div>{onBack ? <Button variant="ghost" onClick={onBack}>Back</Button> : null}</div>
      <div className="row">
        {extra}
        <Button variant="primary" loading={busy ?? false} onClick={onNext}>
          {nextLabel}
        </Button>
      </div>
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
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <p className="muted">Create the administrator account. You will use it to sign in.</p>
      <FormField label="Username" error={errors.username}>
        <Input autoComplete="username" value={draft.username} onChange={set('username')} />
      </FormField>
      <FormField label="Password" error={errors.password}>
        <Input type="password" autoComplete="new-password" value={draft.password} onChange={set('password')} />
      </FormField>
      <FormField label="Confirm password" error={errors.confirm}>
        <Input type="password" autoComplete="new-password" value={draft.confirm} onChange={set('confirm')} />
      </FormField>
      <FormField label="Email (optional)" error={errors.email}>
        <Input type="email" autoComplete="email" value={draft.email} onChange={set('email')} />
      </FormField>
      {failure ? <p className="text-error" role="alert">{failure}</p> : null}
      <button type="submit" hidden />
      <StepNav onNext={() => void submit()} nextLabel="Create admin" busy={busy} />
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
      setResult({ ok: true, message: `Key works (${found.length} results for a test search).` });
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const next = async () => {
    if (!key.trim() && !complete) return setResult({ ok: false, message: 'A TMDB API key is required for metadata.' });
    setBusy('next');
    try {
      await save();
      onDone();
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <p className="muted">
        Arclight reads series and movie information from TMDB. Create a free v3 API key at themoviedb.org (Settings → API).
        {complete ? ' A key is already configured; enter a new one to replace it.' : ''}
      </p>
      <FormField label="TMDB API key">
        <Input value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.currentTarget.value)} />
      </FormField>
      {result ? <p className={result.ok ? 'text-ok' : 'text-error'} role={result.ok ? 'status' : 'alert'}>{result.message}</p> : null}
      <StepNav
        onBack={onBack}
        onNext={() => void next()}
        busy={busy === 'next'}
        extra={<Button loading={busy === 'test'} onClick={() => void test()}>Test</Button>}
      />
    </div>
  );
}

function RootFoldersStep({ complete, onBack, onDone }: { complete: boolean; onBack: () => void; onDone: () => void }) {
  const [draft, setDraft] = useState<RootFolderDraft>({ tv: '', movies: '' });
  const [create, setCreate] = useState(true);
  const [errors, setErrors] = useState<FieldErrors<keyof RootFolderDraft | 'form'>>({});
  const [busy, setBusy] = useState(false);

  const next = async () => {
    const found = validateRootFolders(draft, complete);
    setErrors(found);
    if (hasErrors(found)) return;
    setBusy(true);
    try {
      if (draft.tv.trim()) await setupApi.addRootFolder({ path: draft.tv.trim(), mediaType: 'series', createIfMissing: create });
      if (draft.movies.trim()) await setupApi.addRootFolder({ path: draft.movies.trim(), mediaType: 'movie', createIfMissing: create });
      onDone();
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="muted">Where your library lives. Series and movies each get their own root folder.{complete ? ' You already have one; add more or continue.' : ''}</p>
      <FormField label="TV root folder" hint="e.g. /data/media/tv" error={errors.tv}>
        <Input value={draft.tv} onChange={(e) => setDraft({ ...draft, tv: e.currentTarget.value })} />
      </FormField>
      <FormField label="Movies root folder" hint="e.g. /data/media/movies" error={errors.movies}>
        <Input value={draft.movies} onChange={(e) => setDraft({ ...draft, movies: e.currentTarget.value })} />
      </FormField>
      <Toggle label="Create folders that do not exist" checked={create} onChange={(e) => setCreate(e.currentTarget.checked)} />
      {errors.form ? <p className="text-error" role="alert">{errors.form}</p> : null}
      <StepNav onBack={onBack} onNext={() => void next()} busy={busy} />
    </div>
  );
}

function DoneStep({ onBack }: { onBack: () => void }) {
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
    <div className="stack">
      <p>Almost there. Choose how people sign in; you can change this later under Settings → Security.</p>
      <FormField label="Authentication">
        <Select
          value={method}
          onChange={(e) => setMethod(e.currentTarget.value as AuthMethod)}
          options={[
            { value: 'forms', label: 'Login page (recommended)' },
            { value: 'basic', label: 'Browser prompt (HTTP Basic)' },
            { value: 'none', label: 'None on the local network' },
          ]}
        />
      </FormField>
      {failure ? <p className="text-error" role="alert">{failure}</p> : null}
      <StepNav onBack={onBack} onNext={() => void finish()} nextLabel="Finish setup" busy={busy} />
    </div>
  );
}

export function SetupWizard() {
  const { status: authStatus } = useAuth();
  const setup = useQuery({ queryKey: authKeys.setup, queryFn: setupApi.status, retry: false });
  const [step, setStep] = useState<WizardStep | null>(null);

  useEffect(() => {
    document.title = 'Setup · Arclight';
  }, []);

  useEffect(() => {
    if (step === null && setup.data) setStep(firstIncompleteStep(setup.data));
  }, [setup.data, step]);

  if (setup.isPending || step === null) return <LoadingBlock />;
  if (setup.isError) return <p className="text-error">{errorMessage(setup.error)}</p>;

  const complete = (id: SetupStepId) => setup.data.steps.find((s) => s.id === id)?.complete ?? false;
  const index = WIZARD_STEPS.findIndex((s) => s.id === step);
  const go = (offset: number) => {
    void setup.refetch();
    setStep(WIZARD_STEPS[Math.min(Math.max(index + offset, 0), WIZARD_STEPS.length - 1)]!.id);
  };
  const needsSignIn = complete('admin') && !authStatus?.authenticated && step !== 'admin';

  let body: ReactNode;
  if (needsSignIn) {
    body = (
      <div className="stack">
        <p>An admin account already exists. Sign in with it to continue setup.</p>
        <Link to="/login" search={{ redirect: '/setup' }} className="btn btn-primary btn-md">
          Sign in
        </Link>
      </div>
    );
  } else if (step === 'admin') {
    body = complete('admin') ? (
      <div className="stack">
        <p>The admin account is set up.</p>
        <StepNav onNext={() => go(1)} />
      </div>
    ) : (
      <AdminStep onDone={() => go(1)} />
    );
  } else if (step === 'tmdb') body = <TmdbStep complete={complete('tmdb')} onBack={() => go(-1)} onDone={() => go(1)} />;
  else if (step === 'rootFolders') body = <RootFoldersStep complete={complete('rootFolders')} onBack={() => go(-1)} onDone={() => go(1)} />;
  else if (step === 'downloadClient' || step === 'indexer') {
    body = (
      <div className="stack">
        <p className="muted">Optional. {step === 'downloadClient' ? 'Add the client that downloads releases.' : 'Add an indexer to search for releases.'} You can also do this later in Settings.</p>
        <div className="setup-embed">{step === 'downloadClient' ? <DownloadClientsPage /> : <IndexersPage />}</div>
        <StepNav onBack={() => go(-1)} onNext={() => go(1)} nextLabel={complete(step) ? 'Next' : 'Skip'} />
      </div>
    );
  } else body = <DoneStep onBack={() => go(-1)} />;

  return (
    <div className="auth-screen">
      <div className="wizard card">
        <div className="card-body stack">
          <div className="auth-brand">ARCLIGHT</div>
          <h1 className="auth-title">Welcome · setup</h1>
          <ol className="wizard-steps" aria-label="Setup steps">
            {WIZARD_STEPS.map((s, i) => (
              <li key={s.id} className={cx('wizard-step', i === index && 'wizard-step-active', i < index && 'wizard-step-done')} aria-current={i === index ? 'step' : undefined}>
                {s.label}
                {s.optional ? <span className="muted"> (optional)</span> : null}
              </li>
            ))}
          </ol>
          <h2 className="wizard-step-title">{WIZARD_STEPS[index]?.label}</h2>
          {body}
        </div>
      </div>
    </div>
  );
}
