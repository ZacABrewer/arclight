import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MigrateApp,
  MigrateArea,
  MigrateConflictPolicy,
  MigrateDiscovery,
  MigrateStackApplyRequest,
  MigrateStackPreview,
  MigrateStackSourcePlan,
  MigrateStackSourceStatus,
  MigrateStackStatus,
  MigrateTestResult,
  MigrateTorrentAction,
  MigrateTorrentCategory,
  MigrationAreaPlan,
  MigrationAreaResult,
} from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { migrateApi } from '../../api/migrate.js';
import {
  Banner,
  Button,
  Checkbox,
  Chip,
  EmptyState,
  ErrorBlock,
  Field,
  Input,
  LinkButton,
  Pane,
  RadioGroup,
  SectionLabel,
  Segmented,
  Select,
  Stepper,
  Table,
  Toggle,
  Trail,
  type ChipTone,
  type Column,
} from '../../arclight/index.js';
import { t } from '../../i18n/index.js';
import { ConfirmModal } from './confirm-modal.js';
import { formatBytes, formatClock } from './format.js';
import {
  buildApplyRequest,
  DEFAULT_OPTIONS,
  defaultSelections,
  draftProblem,
  newDraft,
  STACK_APPS,
  toSource,
  type MappingDraft,
  type RunOptions,
  type Selections,
  type SourceDraft,
} from './migrate-model.js';
import { SystemHeader } from './system-header.js';
import './migrate.css';

export { defaultAreas } from './migrate-model.js';

// System → Import: "Import your existing stack". A wizard over the whole-stack importer:
// pick apps → connect each (live API or files) → preview → options → run (background job
// MigrateStack) → report. Nothing is written before the run; the first run is a dry run by
// default, and a real run takes an Arclight backup first.

type StepId = 'apps' | 'connect' | 'preview' | 'options' | 'run' | 'report';
const STEP_IDS: readonly StepId[] = ['apps', 'connect', 'preview', 'options', 'run', 'report'];

const STACK_KEY = ['migrate', 'stack', 'status'] as const;

export function appName(app: MigrateApp): string {
  return t(`system.migrate.app.${app}`);
}

export function areaName(area: MigrateArea): string {
  return t(`system.migrate.areas.${area}`);
}

function draftTitle(d: SourceDraft): string {
  return d.label.trim() || appName(d.app);
}

const STATE_TONE: Record<MigrateStackStatus['state'], ChipTone> = { idle: 'neutral', running: 'default', completed: 'accent', failed: 'danger', interrupted: 'warn' };
const SOURCE_TONE: Record<MigrateStackSourceStatus['state'], ChipTone> = { pending: 'muted', running: 'default', completed: 'accent', failed: 'danger', skipped: 'neutral' };

function stateLabel(state: MigrateStackStatus['state']): string {
  return t(`system.migrate.state.${state}`);
}

function sourceStateLabel(state: MigrateStackSourceStatus['state']): string {
  return t(`system.migrate.sourceState.${state}`);
}

export function SystemMigratePage() {
  const qc = useQueryClient();
  const [step, setStep] = useState<StepId>('apps');
  const [drafts, setDrafts] = useState<SourceDraft[]>([]);
  const nextId = useRef(1);
  const [preview, setPreview] = useState<MigrateStackPreview | null>(null);
  const [sel, setSel] = useState<Selections | null>(null);
  const [opts, setOpts] = useState<RunOptions>(DEFAULT_OPTIONS);
  const [lastRequest, setLastRequest] = useState<MigrateStackApplyRequest | null>(null);
  const [startedRun, setStartedRun] = useState<number | null>(null);
  const jumped = useRef(false);

  const status = useQuery({
    queryKey: STACK_KEY,
    queryFn: migrateApi.stack.status,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 1000 : false),
  });

  // Opening the page while a run is going (or after one finished): show it.
  useEffect(() => {
    if (jumped.current || !status.data) return;
    jumped.current = true;
    if (status.data.state === 'running') setStep('run');
    else if (status.data.runId !== null && status.data.state !== 'idle') setStep('report');
  }, [status.data]);

  // The run started from this page finished: show the report.
  useEffect(() => {
    if (step === 'run' && startedRun !== null && status.data?.runId === startedRun && status.data.state !== 'running') setStep('report');
  }, [step, startedRun, status.data]);

  const previewMutation = useMutation({
    mutationFn: migrateApi.stack.preview,
    meta: { silent: true },
    onSuccess: (result) => {
      setPreview(result);
      setSel(defaultSelections(result));
    },
  });

  const onRunStarted = (next: MigrateStackStatus) => {
    qc.setQueryData(STACK_KEY, next);
    setStartedRun(next.runId);
    setStep('run');
  };

  const apply = useMutation({ mutationFn: migrateApi.stack.apply, meta: { silent: true }, onSuccess: onRunStarted });
  const resume = useMutation({ mutationFn: migrateApi.stack.resume, meta: { silent: true }, onSuccess: onRunStarted });

  const addDraft = (app: MigrateApp, label = '') => {
    const id = nextId.current++;
    setDrafts((ds) => [...ds, newDraft(id, app, label)]);
  };
  const toggleApp = (app: MigrateApp, on: boolean) => {
    if (on) addDraft(app);
    else setDrafts((ds) => ds.filter((d) => d.app !== app));
  };
  const updateDraft = (id: number, patch: Partial<SourceDraft>) => setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const removeDraft = (id: number) => setDrafts((ds) => ds.filter((d) => d.id !== id));

  const runPreview = () => {
    setPreview(null);
    setStep('preview');
    previewMutation.mutate({ sources: drafts.map(toSource) });
  };

  const start = (dryRun: boolean) => {
    if (!preview || !sel) return;
    const req = buildApplyRequest(drafts, preview, sel, { ...opts, dryRun });
    setLastRequest(req);
    apply.mutate(req);
  };

  const running = status.data?.state === 'running';
  const index = STEP_IDS.indexOf(step);
  const goTo = (i: number) => {
    if (running || i >= index) return;
    setStep(STEP_IDS[i]!);
  };

  let body: ReactNode;
  if (step === 'apps') {
    body = <AppsStep drafts={drafts} onToggle={toggleApp} onAdd={addDraft} onRemove={removeDraft} onUpdate={updateDraft} onNext={() => setStep('connect')} />;
  } else if (step === 'connect') {
    body = <ConnectStep drafts={drafts} onUpdate={updateDraft} onBack={() => setStep('apps')} onNext={runPreview} />;
  } else if (step === 'preview') {
    body = (
      <PreviewStep
        preview={preview}
        loading={previewMutation.isPending}
        error={previewMutation.isError ? errorMessage(previewMutation.error) : null}
        sel={sel}
        onSel={setSel}
        onRetry={runPreview}
        onBack={() => setStep('connect')}
        onNext={() => setStep('options')}
      />
    );
  } else if (step === 'options') {
    const qbit = drafts.find((d) => d.app === 'qbittorrent' && preview?.sources[drafts.indexOf(d)]?.plan);
    body = (
      <OptionsStep
        opts={opts}
        onOpts={setOpts}
        qbittorrent={qbit ? qbit.mode : null}
        starting={apply.isPending}
        error={apply.isError ? errorMessage(apply.error) : null}
        busy={running}
        nothingSelected={!preview || !sel || buildApplyRequest(drafts, preview, sel, opts).sources.length === 0}
        onBack={() => setStep('preview')}
        onStart={() => start(opts.dryRun)}
      />
    );
  } else if (step === 'run') {
    body = <RunStep status={status.data ?? null} />;
  } else {
    body = (
      <ReportStep
        status={status.data ?? null}
        canRunForReal={!!lastRequest && !running}
        onRunForReal={() => lastRequest && apply.mutate({ ...lastRequest, dryRun: false })}
        runForRealBusy={apply.isPending}
        onResume={() => resume.mutate()}
        resumeBusy={resume.isPending}
        actionError={apply.isError ? errorMessage(apply.error) : resume.isError ? errorMessage(resume.error) : null}
        onNewImport={() => {
          setStartedRun(null);
          setStep(drafts.length > 0 ? 'options' : 'apps');
        }}
        onCleaned={() => void qc.invalidateQueries({ queryKey: STACK_KEY })}
      />
    );
  }

  return (
    <>
      <SystemHeader title={t('system.migrate.title')} subtitle={t('system.migrate.subtitle')} />
      <div className="sys-stack mig">
        <Stepper
          aria-label={t('system.migrate.steps')}
          className="mig-stepper"
          steps={STEP_IDS.map((id) => ({ id, label: t(`system.migrate.step.${id}`) }))}
          current={index}
          onStepClick={running ? undefined : goTo}
        />
        <Pane className="mig-card" aria-label={t(`system.migrate.step.${step}`)}>
          {body}
        </Pane>
      </div>
    </>
  );
}

// ---- shared bits -----------------------------------------------------------------------------

function StepHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mig-head">
      <h2 className="mig-head__title">{title}</h2>
      {children ? <p className="mig-head__lead">{children}</p> : null}
    </div>
  );
}

function Footer({ onBack, children }: { onBack?: (() => void) | undefined; children?: ReactNode }) {
  return (
    <div className="mig-footer">
      {onBack ? (
        <Button variant="ghost" onClick={onBack}>
          {t('system.migrate.back')}
        </Button>
      ) : null}
      <span className="mig-footer__spacer" />
      {children}
    </div>
  );
}

// ---- step 1: apps ----------------------------------------------------------------------------

function AppsStep({
  drafts,
  onToggle,
  onAdd,
  onRemove,
  onUpdate,
  onNext,
}: {
  drafts: SourceDraft[];
  onToggle: (app: MigrateApp, on: boolean) => void;
  onAdd: (app: MigrateApp, label?: string) => void;
  onRemove: (id: number) => void;
  onUpdate: (id: number, patch: Partial<SourceDraft>) => void;
  onNext: () => void;
}) {
  return (
    <div className="mig-body">
      <StepHead title={t('system.migrate.appsTitle')}>{t('system.migrate.appsLead')}</StepHead>
      <ul className="mig-apps">
        {STACK_APPS.map((app) => {
          const mine = drafts.filter((d) => d.app === app);
          return (
            <li key={app} className="mig-app" data-on={mine.length > 0 || undefined}>
              <Checkbox label={appName(app)} hint={t(`system.migrate.appHint.${app}`)} checked={mine.length > 0} onChange={(e) => onToggle(app, e.currentTarget.checked)} />
              {mine.length > 0 ? (
                <div className="mig-app__instances">
                  {mine.length > 1
                    ? mine.map((d, i) => (
                        <div key={d.id} className="mig-row">
                          <Input
                            aria-label={t('system.migrate.instanceLabel', { app: appName(app), n: i + 1 })}
                            placeholder={i === 0 ? appName(app) : t('system.migrate.instancePlaceholder', { app: appName(app) })}
                            value={d.label}
                            onChange={(e) => onUpdate(d.id, { label: e.currentTarget.value })}
                          />
                          <Button size="sm" variant="ghost" aria-label={t('system.migrate.removeInstance', { app: appName(app), n: i + 1 })} onClick={() => onRemove(d.id)}>
                            {t('common.remove')}
                          </Button>
                        </div>
                      ))
                    : null}
                  <div>
                    <Button size="sm" variant="secondary" onClick={() => onAdd(app, t('system.migrate.instancePlaceholder', { app: appName(app) }))}>
                      {t('system.migrate.addInstance', { app: appName(app) })}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Footer>
        <Button variant="primary" disabled={drafts.length === 0} onClick={onNext}>
          {t('system.migrate.next')}
        </Button>
      </Footer>
    </div>
  );
}

// ---- step 2: connect ---------------------------------------------------------------------------

const PROBLEM_KEY = { url: 'system.migrate.needUrl', urlScheme: 'system.migrate.needUrlScheme', apiKey: 'system.migrate.needApiKey', dbPath: 'system.migrate.needDbPath' } as const;

function ConnectStep({ drafts, onUpdate, onBack, onNext }: { drafts: SourceDraft[]; onUpdate: (id: number, patch: Partial<SourceDraft>) => void; onBack: () => void; onNext: () => void }) {
  const discovery = useQuery({ queryKey: ['migrate', 'discover'], queryFn: migrateApi.discover, staleTime: 60_000, retry: false, meta: { silent: true } });
  const [showProblems, setShowProblems] = useState(false);
  const incomplete = drafts.some((d) => draftProblem(d) !== null);
  return (
    <div className="mig-body">
      <StepHead title={t('system.migrate.connectTitle')}>{t('system.migrate.connectLead')}</StepHead>
      <Banner>{t('system.migrate.mountHint')}</Banner>
      {drafts.map((d) => (
        <SourceConnect key={d.id} draft={d} discovery={discovery.data ?? null} onUpdate={(patch) => onUpdate(d.id, patch)} showProblem={showProblems} />
      ))}
      <Footer onBack={onBack}>
        <Button
          variant="primary"
          onClick={() => {
            if (incomplete) setShowProblems(true);
            else onNext();
          }}
        >
          {t('system.migrate.preview')}
        </Button>
      </Footer>
    </div>
  );
}

function SourceConnect({ draft: d, discovery, onUpdate, showProblem }: { draft: SourceDraft; discovery: MigrateDiscovery | null; onUpdate: (patch: Partial<SourceDraft>) => void; showProblem: boolean }) {
  const test = useMutation({ mutationFn: migrateApi.test, meta: { silent: true } });
  const nextKey = useRef(1);
  const title = draftTitle(d);
  const problem = showProblem ? draftProblem(d) : null;
  const qbit = d.app === 'qbittorrent';
  const files = (discovery?.files ?? []).filter((c) => c.app === d.app);
  const network = (discovery?.network ?? []).filter((c) => c.app === d.app);
  const set = (patch: Partial<SourceDraft>) => {
    test.reset();
    onUpdate(patch);
  };
  const setMapping = (key: number, patch: Partial<MappingDraft>) => set({ mappings: d.mappings.map((m) => (m.key === key ? { ...m, ...patch } : m)) });

  return (
    <section className="mig-source" aria-label={title}>
      <div className="mig-source__head">
        <h3 className="mig-source__title">{title}</h3>
        <Segmented<'api' | 'files'>
          aria-label={t('system.migrate.howToRead', { app: title })}
          variant="soft"
          options={[
            { value: 'api', label: t('system.migrate.modeApi') },
            { value: 'files', label: t('system.migrate.modeFiles') },
          ]}
          value={d.mode}
          onChange={(mode) => set({ mode })}
        />
      </div>
      <p className="sys-muted mig-wrap">{d.mode === 'api' ? t('system.migrate.modeApiHint') : t('system.migrate.modeFilesHint')}</p>

      {d.mode === 'api' ? (
        <div className="mig-grid">
          <Field label={t('system.migrate.url')} hint={t(`system.migrate.urlHint.${d.app}`)} error={problem === 'url' || problem === 'urlScheme' ? t(PROBLEM_KEY[problem]) : undefined}>
            <Input mono value={d.url} placeholder={t(`system.migrate.urlPlaceholder.${d.app}`)} onChange={(e) => set({ url: e.currentTarget.value })} />
          </Field>
          {qbit ? (
            <>
              <Field label={t('common.username')}>
                <Input value={d.username} autoComplete="off" onChange={(e) => set({ username: e.currentTarget.value })} />
              </Field>
              <Field label={t('common.password')} hint={t('system.migrate.qbitAuthHint')}>
                <Input type="password" value={d.password} autoComplete="new-password" onChange={(e) => set({ password: e.currentTarget.value })} />
              </Field>
            </>
          ) : (
            <Field label={t('system.migrate.apiKey')} hint={t(`system.migrate.apiKeyHint.${d.app}`)} error={problem === 'apiKey' ? t(PROBLEM_KEY.apiKey) : undefined}>
              <Input mono value={d.apiKey} autoComplete="off" spellCheck={false} onChange={(e) => set({ apiKey: e.currentTarget.value })} />
            </Field>
          )}
          {network.length > 0 ? (
            <div className="mig-suggest">
              <SectionLabel>{t('system.migrate.suggestions')}</SectionLabel>
              <p className="sys-muted">{t('system.migrate.suggestionsHint')}</p>
              <ul className="sys-list">
                {network.map((c) => (
                  <li key={c.url}>
                    <Button size="sm" variant="ghost" onClick={() => set({ url: c.url })}>
                      {t('system.migrate.useValue', { value: c.url })}
                    </Button>
                    <span className="sys-muted">{c.origin}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mig-grid">
          <Field label={qbit ? t('system.migrate.btBackupPath') : t('system.migrate.databasePath')} hint={t(`system.migrate.dbHint.${d.app}`)} error={problem === 'dbPath' ? t(PROBLEM_KEY.dbPath) : undefined}>
            <Input mono value={d.dbPath} onChange={(e) => set({ dbPath: e.currentTarget.value })} />
          </Field>
          {qbit ? null : (
            <Field label={t('system.migrate.configFileOptional')} hint={t(`system.migrate.configHint.${d.app}`)}>
              <Input mono value={d.configPath} onChange={(e) => set({ configPath: e.currentTarget.value })} />
            </Field>
          )}
          {files.length > 0 ? (
            <div className="mig-suggest">
              <SectionLabel>{t('system.migrate.detected')}</SectionLabel>
              <ul className="sys-list">
                {files.map((c) => (
                  <li key={c.dbPath}>
                    <Button size="sm" variant="ghost" className="mig-wrap" onClick={() => set({ dbPath: c.dbPath, configPath: c.configPath ?? '' })}>
                      {t('system.migrate.useValue', { value: c.dbPath })}
                    </Button>
                    <span className="sys-muted">{c.origin}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <details className="mig-mappings" open={d.mappings.length > 0 || undefined}>
        <summary>{t('system.migrate.pathMappingsCount', { count: d.mappings.length })}</summary>
        <p className="sys-muted mig-wrap">{t('system.migrate.pathMappingsHint')}</p>
        {d.mappings.map((m, i) => (
          <div key={m.key} className="sys-mapping">
            <Input mono aria-label={t('system.migrate.mappingFrom', { app: title, n: i + 1 })} placeholder="/tv" value={m.from} onChange={(e) => setMapping(m.key, { from: e.currentTarget.value })} />
            <span aria-hidden="true">→</span>
            <Input mono aria-label={t('system.migrate.mappingTo', { app: title, n: i + 1 })} placeholder="/data/media/tv" value={m.to} onChange={(e) => setMapping(m.key, { to: e.currentTarget.value })} />
            <Button size="sm" variant="ghost" aria-label={t('system.migrate.removeMapping', { app: title, n: i + 1 })} onClick={() => set({ mappings: d.mappings.filter((x) => x.key !== m.key) })}>
              {t('common.remove')}
            </Button>
          </div>
        ))}
        <div>
          <Button size="sm" variant="secondary" onClick={() => set({ mappings: [...d.mappings, { key: nextKey.current++, from: '', to: '' }] })}>
            {t('system.migrate.addMapping')}
          </Button>
        </div>
      </details>

      <div className="mig-row">
        <Button variant="secondary" loading={test.isPending} disabled={draftProblem(d) !== null} onClick={() => test.mutate(toSource(d))}>
          {t('system.migrate.testValue', { app: title })}
        </Button>
        <TestResult result={test.data ?? null} error={test.isError ? errorMessage(test.error) : null} />
      </div>
    </section>
  );
}

function TestResult({ result, error }: { result: MigrateTestResult | null; error: string | null }) {
  if (error) {
    return (
      <p className="mig-test" data-ok="false" role="alert">
        {error}
      </p>
    );
  }
  if (!result) return null;
  const parts = [
    result.ok ? t('system.migrate.testOk') : t('system.migrate.testFailed'),
    result.version ? t('system.migrate.versionValue', { value: result.version }) : null,
    result.detected ? t('system.migrate.detectedApp', { app: appName(result.detected) }) : null,
    result.message,
  ].filter(Boolean);
  return (
    <p className="mig-test" data-ok={result.ok} role={result.ok ? 'status' : 'alert'}>
      {parts.join(' · ')}
    </p>
  );
}

// ---- step 3: preview ---------------------------------------------------------------------------

const POLICY_OPTIONS = () => [
  { value: 'skip', label: t('system.migrate.policySkip') },
  { value: 'overwrite', label: t('system.migrate.policyOverwrite') },
  { value: 'merge', label: t('system.migrate.policyMerge') },
];

function PreviewStep({
  preview,
  loading,
  error,
  sel,
  onSel,
  onRetry,
  onBack,
  onNext,
}: {
  preview: MigrateStackPreview | null;
  loading: boolean;
  error: string | null;
  sel: Selections | null;
  onSel: (s: Selections) => void;
  onRetry: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  if (loading || (!preview && !error)) {
    return (
      <div className="mig-body">
        <StepHead title={t('system.migrate.previewTitle')}>{t('system.migrate.reading')}</StepHead>
        <div role="status" className="mig-loading">
          <Trail value={50} state="active" label={t('system.migrate.reading')} />
        </div>
      </div>
    );
  }
  if (error || !preview || !sel) {
    return (
      <div className="mig-body">
        <StepHead title={t('system.migrate.previewTitle')} />
        <ErrorBlock title={t('system.migrate.previewFailed')} onRetry={onRetry}>
          {error}
        </ErrorBlock>
        <Footer onBack={onBack} />
      </div>
    );
  }
  const usable = preview.sources.some((s) => s.plan && (sel.areas[s.key]?.length ?? 0) > 0);
  return (
    <div className="mig-body">
      <StepHead title={t('system.migrate.previewTitle')}>{t('system.migrate.previewLead')}</StepHead>
      <div className="mig-grid">
        <Field label={t('system.migrate.defaultPolicy')} hint={t('system.migrate.policyHint')}>
          <Select value={sel.conflictPolicy} onChange={(e) => onSel({ ...sel, conflictPolicy: e.currentTarget.value as MigrateConflictPolicy })} options={POLICY_OPTIONS()} />
        </Field>
      </div>
      {preview.sources.map((s) => (
        <SourcePlan key={s.key} source={s} sel={sel} onSel={onSel} />
      ))}
      <Footer onBack={onBack}>
        <Button variant="secondary" onClick={onRetry}>
          {t('system.migrate.refresh')}
        </Button>
        <Button variant="primary" disabled={!usable} onClick={onNext}>
          {t('system.migrate.next')}
        </Button>
      </Footer>
    </div>
  );
}

function NoteList({ label, tone, items }: { label: string; tone: ChipTone; items: ReadonlyArray<{ area: MigrateArea; text: string }> }) {
  if (items.length === 0) return null;
  return (
    <details className="mig-notes" open={items.length <= 8 || undefined}>
      <summary>
        {label} <span className="al-num">{items.length}</span>
      </summary>
      <ul className="sys-list">
        {items.map((it, i) => (
          <li key={i}>
            <Chip tone={tone}>{areaName(it.area)}</Chip>
            <span className="mig-wrap">{it.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function SourcePlan({ source, sel, onSel }: { source: MigrateStackSourcePlan; sel: Selections; onSel: (s: Selections) => void }) {
  const plan = source.plan;
  const title = source.label;
  if (!plan) {
    return (
      <section className="mig-source" aria-label={title}>
        <h3 className="mig-source__title">{title}</h3>
        <ErrorBlock title={t('system.migrate.couldNotRead', { app: title })}>{source.error}</ErrorBlock>
      </section>
    );
  }
  const chosen = new Set(sel.areas[source.key] ?? []);
  const toggle = (area: MigrateArea, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(area);
    else next.delete(area);
    onSel({ ...sel, areas: { ...sel.areas, [source.key]: plan.areas.map((a) => a.area).filter((a) => next.has(a)) } });
  };
  const columns: Column<MigrationAreaPlan>[] = [
    {
      key: 'include',
      header: <span className="al-sr-only">{t('system.migrate.include')}</span>,
      width: '2.75rem',
      cell: (a) => (
        <Checkbox aria-label={t('system.migrate.includeArea', { area: areaName(a.area), app: title })} checked={chosen.has(a.area)} disabled={a.mode === 'report'} onChange={(e) => toggle(a.area, e.currentTarget.checked)} />
      ),
    },
    { key: 'label', header: t('system.migrate.area'), cell: (a) => areaName(a.area), className: 'mig-wrap' },
    { key: 'total', header: t('system.migrate.found'), align: 'right', mono: true, cell: (a) => a.total },
    { key: 'create', header: t('system.migrate.new'), align: 'right', mono: true, cell: (a) => a.create },
    { key: 'conflicts', header: t('system.migrate.conflicts'), align: 'right', mono: true, cell: (a) => a.conflicts },
    { key: 'already', header: t('system.migrate.alreadyImported'), align: 'right', mono: true, cell: (a) => a.alreadyImported },
    { key: 'unsupported', header: t('system.migrate.cantImport'), align: 'right', mono: true, cell: (a) => a.unsupported },
    {
      key: 'details',
      header: t('common.details'),
      muted: true,
      className: 'mig-wrap',
      cell: (a) =>
        [a.mode === 'report' ? t('system.migrate.reportOnly') : a.mode === 'stage' ? t('system.migrate.staged') : null, ...Object.entries(a.details).map(([k, v]) => `${v} ${k}`)]
          .filter(Boolean)
          .join(', '),
    },
    {
      key: 'policy',
      header: t('system.migrate.whenItExists'),
      cell: (a) =>
        a.mode === 'import' ? (
          <Select
            aria-label={t('system.migrate.policyFor', { area: areaName(a.area) })}
            value={sel.areaPolicies[a.area] ?? ''}
            onChange={(e) => {
              const v = e.currentTarget.value;
              const areaPolicies = { ...sel.areaPolicies };
              if (v === '') delete areaPolicies[a.area];
              else areaPolicies[a.area] = v as MigrateConflictPolicy;
              onSel({ ...sel, areaPolicies });
            }}
            options={[{ value: '', label: t('system.migrate.policyDefault') }, ...POLICY_OPTIONS()]}
          />
        ) : null,
    },
  ];
  return (
    <section className="mig-source" aria-label={title}>
      <div className="mig-source__head">
        <h3 className="mig-source__title">{title}</h3>
        {plan.schemaVersion ? <Chip tone="neutral">{t('system.migrate.versionValue', { value: plan.schemaVersion })}</Chip> : null}
        <Chip tone="muted">{plan.source.mode === 'api' ? t('system.migrate.modeApi') : t('system.migrate.modeFiles')}</Chip>
      </div>
      <div className="mig-table">
        <Table columns={columns} rows={plan.areas} rowKey={(a) => a.area} sortable={false} caption={t('system.migrate.planOf', { app: title })} empty={<EmptyState title={t('system.migrate.nothingToImport')} />} />
      </div>
      {plan.torrentCategories && plan.torrentCategories.length > 0 ? <TorrentCategories categories={plan.torrentCategories} sel={sel} onSel={onSel} /> : null}
      <NoteList label={t('system.migrate.warnings')} tone="warn" items={plan.warnings.map((w) => ({ area: w.area, text: w.message }))} />
      <NoteList label={t('system.migrate.conflictsList')} tone="neutral" items={plan.conflicts.map((c) => ({ area: c.area, text: `${c.name}: ${c.reason}` }))} />
      <NoteList label={t('system.migrate.cantImportList')} tone="muted" items={plan.unsupported.map((u) => ({ area: u.area, text: `${u.name}: ${u.reason}` }))} />
    </section>
  );
}

function TorrentCategories({ categories, sel, onSel }: { categories: MigrateTorrentCategory[]; sel: Selections; onSel: (s: Selections) => void }) {
  const name = (c: string) => c || t('system.migrate.noCategory');
  const columns: Column<MigrateTorrentCategory>[] = [
    { key: 'category', header: t('system.migrate.category'), cell: (c) => name(c.category), className: 'mig-wrap' },
    { key: 'count', header: t('system.migrate.torrents'), align: 'right', mono: true, cell: (c) => `${c.count} (${t('system.migrate.completeCount', { count: c.complete })})` },
    { key: 'size', header: t('system.migrate.size'), align: 'right', mono: true, cell: (c) => formatBytes(c.sizeBytes) },
    { key: 'path', header: t('system.migrate.savePath'), mono: true, className: 'mig-wrap', cell: (c) => c.savePath ?? '—' },
    { key: 'linked', header: t('system.migrate.linked'), align: 'right', mono: true, cell: (c) => c.linked },
    {
      key: 'action',
      header: t('common.action'),
      cell: (c) => (
        <Select
          aria-label={t('system.migrate.actionFor', { category: name(c.category) })}
          value={sel.categories[c.category] ?? 'adopt'}
          onChange={(e) => onSel({ ...sel, categories: { ...sel.categories, [c.category]: e.currentTarget.value as MigrateTorrentAction } })}
          options={[
            { value: 'adopt', label: t('system.migrate.actionAdopt') },
            { value: 'external', label: t('system.migrate.actionExternal') },
            { value: 'skip', label: t('system.migrate.actionSkip') },
          ]}
        />
      ),
    },
  ];
  return (
    <div className="mig-block">
      <SectionLabel>{t('system.migrate.torrentCategories')}</SectionLabel>
      <p className="sys-muted mig-wrap">{t('system.migrate.torrentCategoriesHint')}</p>
      <div className="mig-table">
        <Table columns={columns} rows={categories} rowKey={(c) => c.category || '(none)'} sortable={false} caption={t('system.migrate.torrentCategories')} />
      </div>
    </div>
  );
}

// ---- step 4: options -----------------------------------------------------------------------------

function OptionsStep({
  opts,
  onOpts,
  qbittorrent,
  starting,
  error,
  busy,
  nothingSelected,
  onBack,
  onStart,
}: {
  opts: RunOptions;
  onOpts: (o: RunOptions) => void;
  qbittorrent: 'api' | 'files' | null;
  starting: boolean;
  error: string | null;
  busy: boolean;
  nothingSelected: boolean;
  onBack: () => void;
  onStart: () => void;
}) {
  const needsConfirm = opts.pauseInSource && !opts.confirmSourceChanges;
  return (
    <div className="mig-body">
      <StepHead title={t('system.migrate.optionsTitle')}>{t('system.migrate.optionsLead')}</StepHead>
      <div className="mig-options">
        <Toggle label={t('system.migrate.dryRun')} checked={opts.dryRun} onChange={(e) => onOpts({ ...opts, dryRun: e.currentTarget.checked })} />
        <p className="sys-muted mig-wrap">{t('system.migrate.dryRunHint')}</p>
        <Toggle label={t('system.migrate.backup')} checked={opts.backup && !opts.dryRun} disabled={opts.dryRun} onChange={(e) => onOpts({ ...opts, backup: e.currentTarget.checked })} />
        <p className="sys-muted mig-wrap">{opts.dryRun ? t('system.migrate.backupDryRunHint') : t('system.migrate.backupHint')}</p>
      </div>
      {qbittorrent ? (
        <div className="mig-options">
          <SectionLabel>{t('system.migrate.app.qbittorrent')}</SectionLabel>
          <RadioGroup<'recheck' | 'trust'>
            legend={t('system.migrate.verifyLegend')}
            value={opts.verify}
            onChange={(verify) => onOpts({ ...opts, verify })}
            options={[
              { value: 'recheck', label: t('system.migrate.verifyRecheck'), hint: t('system.migrate.verifyRecheckHint') },
              { value: 'trust', label: t('system.migrate.verifyTrust'), hint: t('system.migrate.verifyTrustHint') },
            ]}
          />
          <Checkbox
            label={qbittorrent === 'api' ? t('system.migrate.pauseInSource') : t('system.migrate.sourceStopped')}
            hint={t('system.migrate.pauseHint')}
            checked={opts.pauseInSource}
            onChange={(e) => onOpts({ ...opts, pauseInSource: e.currentTarget.checked, confirmSourceChanges: false })}
          />
          {opts.pauseInSource ? (
            <Checkbox
              tone="danger"
              label={qbittorrent === 'api' ? t('system.migrate.confirmPause') : t('system.migrate.confirmStopped')}
              checked={opts.confirmSourceChanges}
              onChange={(e) => onOpts({ ...opts, confirmSourceChanges: e.currentTarget.checked })}
            />
          ) : null}
        </div>
      ) : null}
      {busy ? <Banner tone="warn">{t('system.migrate.alreadyRunning')}</Banner> : null}
      {error ? <ErrorBlock title={t('system.migrate.couldNotStart')}>{error}</ErrorBlock> : null}
      <Footer onBack={onBack}>
        <Button variant="primary" loading={starting} disabled={needsConfirm || nothingSelected || busy} onClick={onStart}>
          {opts.dryRun ? t('system.migrate.startDryRun') : t('system.migrate.startImport')}
        </Button>
      </Footer>
    </div>
  );
}

// ---- step 5: run ---------------------------------------------------------------------------------

function SourceChips({ status }: { status: MigrateStackStatus }) {
  return (
    <ul className="mig-chips" aria-label={t('system.migrate.sources')}>
      {status.sources.map((s, i) => (
        <li key={s.key}>
          <Chip tone={SOURCE_TONE[s.state]}>
            {s.label} · {sourceStateLabel(s.state)}
          </Chip>
          {s.error ? <span className="mig-wrap mig-error">{s.error}</span> : null}
          {status.current === i && status.state === 'running' ? <span className="al-sr-only">{t('system.migrate.current')}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function RunLog({ status, open }: { status: MigrateStackStatus; open: boolean }) {
  if (status.log.length === 0) return null;
  return (
    <details className="sys-run-log mig-log" open={open || undefined}>
      <summary>
        {t('system.migrate.log')} <span className="al-num">{status.log.length}</span>
      </summary>
      <ol>
        {status.log.map((e, i) => (
          <li key={i} data-level={e.level}>
            <span className="al-num sys-muted">{formatClock(e.time)}</span> {e.message}
          </li>
        ))}
      </ol>
    </details>
  );
}

function RunStep({ status }: { status: MigrateStackStatus | null }) {
  if (!status) return <div className="mig-body" />;
  const p = status.progress;
  const current = status.current !== null ? status.sources[status.current] : undefined;
  return (
    <div className="mig-body">
      <StepHead title={status.dryRun ? t('system.migrate.runDryTitle') : t('system.migrate.runTitle')}>{t('system.migrate.runLead')}</StepHead>
      <div className="sys-run-head">
        <Chip tone={STATE_TONE[status.state]}>{stateLabel(status.state)}</Chip>
        {status.dryRun ? <Chip tone="neutral">{t('system.migrate.dryRun')}</Chip> : null}
        {status.backup ? <span className="sys-muted mig-wrap">{t('system.migrate.backupTaken', { name: status.backup.name })}</span> : null}
      </div>
      <SourceChips status={status} />
      {status.state === 'running' && p ? (
        <div className="sys-run-progress" role="status">
          <p className="mig-wrap">
            {t('system.migrate.progressLine', { app: current?.label ?? '', area: areaName(p.area), done: p.done, total: p.total, index: p.areaIndex, count: p.areaCount })}
          </p>
          <Trail value={(p.done / Math.max(p.total, 1)) * 100} state="active" showValue label={t('system.migrate.areaProgress', { area: areaName(p.area) })} />
        </div>
      ) : null}
      {status.error ? <ErrorBlock title={t('system.migrate.runError')}>{status.error}</ErrorBlock> : null}
      <RunLog status={status} open />
    </div>
  );
}

// ---- step 6: report ------------------------------------------------------------------------------

const TOTAL_KEYS = {
  created: 'system.migrate.created',
  updated: 'system.migrate.updated',
  skipped: 'system.migrate.skipped',
  staged: 'system.migrate.staged',
  failed: 'system.migrate.failed',
} as const;

function ReportStep({
  status,
  canRunForReal,
  onRunForReal,
  runForRealBusy,
  onResume,
  resumeBusy,
  actionError,
  onNewImport,
  onCleaned,
}: {
  status: MigrateStackStatus | null;
  canRunForReal: boolean;
  onRunForReal: () => void;
  runForRealBusy: boolean;
  onResume: () => void;
  resumeBusy: boolean;
  actionError: string | null;
  onNewImport: () => void;
  onCleaned: () => void;
}) {
  const [confirm, setConfirm] = useState<'pause' | 'remove' | null>(null);
  const [cleaned, setCleaned] = useState<string | null>(null);
  if (!status || status.runId === null) {
    return (
      <div className="mig-body">
        <EmptyState title={t('system.migrate.noRun')} />
      </div>
    );
  }
  const totals = { created: 0, updated: 0, skipped: 0, staged: 0, failed: 0 };
  for (const s of status.sources) {
    for (const a of s.result?.areas ?? []) {
      totals.created += a.created;
      totals.updated += a.updated;
      totals.skipped += a.skipped;
      totals.staged += a.staged;
      totals.failed += a.failed;
    }
  }
  const resultColumns: Column<MigrationAreaResult>[] = [
    { key: 'area', header: t('system.migrate.area'), cell: (r) => areaName(r.area), className: 'mig-wrap' },
    { key: 'created', header: t('system.migrate.created'), align: 'right', mono: true, cell: (r) => r.created },
    { key: 'updated', header: t('system.migrate.updated'), align: 'right', mono: true, cell: (r) => r.updated },
    { key: 'skipped', header: t('system.migrate.skipped'), align: 'right', mono: true, cell: (r) => r.skipped },
    { key: 'staged', header: t('system.migrate.staged'), align: 'right', mono: true, cell: (r) => r.staged },
    { key: 'failed', header: t('system.migrate.failed'), align: 'right', mono: true, cell: (r) => r.failed },
  ];
  const doCleanup = async (action: 'pause' | 'remove') => {
    const r = await migrateApi.stack.cleanup({ action, confirm: true });
    setConfirm(null);
    setCleaned(t(action === 'pause' ? 'system.migrate.cleanupPaused' : 'system.migrate.cleanupRemoved', { done: r.done, failed: r.failed.length }));
    onCleaned();
  };
  return (
    <div className="mig-body">
      <StepHead title={status.dryRun ? t('system.migrate.reportDryTitle') : t('system.migrate.reportTitle')}>{status.dryRun ? t('system.migrate.reportDryLead') : t('system.migrate.reportLead')}</StepHead>
      <div className="sys-run-head">
        <Chip tone={STATE_TONE[status.state]}>{stateLabel(status.state)}</Chip>
        {status.dryRun ? <Chip tone="neutral">{t('system.migrate.dryRun')}</Chip> : null}
        {status.endedAt ? <span className="sys-muted">{formatClock(status.endedAt)}</span> : null}
      </div>
      <dl className="mig-totals" aria-label={t('system.migrate.totals')}>
        {(['created', 'updated', 'skipped', 'staged', 'failed'] as const).map((k) => (
          <div key={k}>
            <dt>{t(TOTAL_KEYS[k])}</dt>
            <dd className="al-num">{totals[k]}</dd>
          </div>
        ))}
      </dl>
      {status.backup ? <Banner>{t('system.migrate.backupTakenRestore', { name: status.backup.name })}</Banner> : null}
      {status.error ? <ErrorBlock title={t('system.migrate.runError')}>{status.error}</ErrorBlock> : null}
      {actionError ? <ErrorBlock title={t('system.migrate.couldNotStart')}>{actionError}</ErrorBlock> : null}
      {cleaned ? <Banner>{cleaned}</Banner> : null}

      {status.sources.map((s) => {
        const failedItems = (s.result?.items ?? []).filter((i) => i.outcome === 'failed');
        return (
          <section key={s.key} className="mig-source" aria-label={s.label}>
            <div className="mig-source__head">
              <h3 className="mig-source__title">{s.label}</h3>
              <Chip tone={SOURCE_TONE[s.state]}>{sourceStateLabel(s.state)}</Chip>
            </div>
            {s.error ? <ErrorBlock title={t('system.migrate.couldNotRead', { app: s.label })}>{s.error}</ErrorBlock> : null}
            {s.result ? (
              <div className="mig-table">
                <Table columns={resultColumns} rows={s.result.areas} rowKey={(r) => r.area} sortable={false} caption={t('system.migrate.resultOf', { app: s.label })} />
              </div>
            ) : null}
            <NoteList label={t('system.migrate.failedItems')} tone="danger" items={failedItems.map((i) => ({ area: i.area, text: `${i.name}: ${i.message ?? ''}` }))} />
            <NoteList label={t('system.migrate.warnings')} tone="warn" items={(s.result?.warnings ?? []).map((w) => ({ area: w.area, text: w.message }))} />
          </section>
        );
      })}

      {status.adoptedTorrents > 0 && !status.dryRun ? (
        <div className="mig-block">
          <SectionLabel>{t('system.migrate.cleanupTitle')}</SectionLabel>
          <p className="sys-muted mig-wrap">{t('system.migrate.cleanupLead', { count: status.adoptedTorrents })}</p>
          <div className="mig-row">
            <Button variant="secondary" onClick={() => setConfirm('pause')}>
              {t('system.migrate.cleanupPause')}
            </Button>
            <Button variant="danger" onClick={() => setConfirm('remove')}>
              {t('system.migrate.cleanupRemove')}
            </Button>
          </div>
        </div>
      ) : null}

      <RunLog status={status} open={false} />

      <Footer>
        <Button variant="ghost" onClick={onNewImport}>
          {t('system.migrate.changeSelection')}
        </Button>
        <LinkButton href={migrateApi.stack.reportDownloadUrl(status.runId)} download>
          {t('system.migrate.downloadReport')}
        </LinkButton>
        {status.resumable ? (
          <Button variant="secondary" loading={resumeBusy} onClick={onResume}>
            {t('system.migrate.resume')}
          </Button>
        ) : null}
        {status.dryRun && status.state === 'completed' ? (
          <Button variant="primary" loading={runForRealBusy} disabled={!canRunForReal} onClick={onRunForReal}>
            {t('system.migrate.runForReal')}
          </Button>
        ) : null}
      </Footer>
      {status.dryRun && status.state === 'completed' && !canRunForReal ? <p className="sys-muted mig-wrap">{t('system.migrate.runForRealNeedsSources')}</p> : null}

      <ConfirmModal
        open={confirm !== null}
        title={confirm === 'remove' ? t('system.migrate.cleanupRemoveTitle') : t('system.migrate.cleanupPauseTitle')}
        confirmLabel={confirm === 'remove' ? t('system.migrate.cleanupRemove') : t('system.migrate.cleanupPause')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => doCleanup(confirm ?? 'pause')}
      >
        <p className="mig-wrap">{confirm === 'remove' ? t('system.migrate.cleanupRemoveBody', { count: status.adoptedTorrents }) : t('system.migrate.cleanupPauseBody', { count: status.adoptedTorrents })}</p>
      </ConfirmModal>
    </div>
  );
}
