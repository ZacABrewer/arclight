import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MigrateApp,
  MigrateArea,
  MigrateConflictPolicy,
  MigrateStatus,
  MigrationAreaPlan,
  MigrationAreaResult,
  MigrationPlan,
  MigratePathMapping,
  MigrateSourceCandidate,
  MigrateSourceInput,
} from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { migrateApi } from '../../api/migrate.js';
import { Button, Checkbox, Chip, EmptyState, ErrorBlock, Field, Input, Pane, SectionLabel, Select, Table, Toggle, Trail, type ChipTone, type Column } from '../../arclight/index.js';
import { formatClock } from './format.js';
import { SystemHeader } from './system-header.js';
import { t } from '../../i18n/index.js';

// System → Import from existing apps. Point at an old Sonarr / Radarr / Prowlarr / Bazarr /
// Seerr database, analyse it (nothing is written), pick areas and a conflict policy, then run
// the import as a background job whose progress is polled from /migrate/status.

const APP_OPTIONS: ReadonlyArray<{ value: MigrateApp; label: string }> = [
  { value: 'sonarr', get label() { return t('system.migrate.sonarr'); } },
  { value: 'radarr', get label() { return t('system.migrate.radarr'); } },
  { value: 'prowlarr', get label() { return t('system.migrate.prowlarr'); } },
  { value: 'bazarr', get label() { return t('system.migrate.bazarr'); } },
  { value: 'seerr', get label() { return t('system.migrate.overseerrJellyseerr'); } },
];

const APP_LABEL: Record<MigrateApp, string> = Object.fromEntries(APP_OPTIONS.map((o) => [o.value, o.label])) as Record<MigrateApp, string>;

const MODE_TONE: Record<MigrationAreaPlan['mode'], ChipTone> = { import: 'accent', stage: 'default', report: 'neutral' };
const MODE_LABEL: Record<MigrationAreaPlan['mode'], string> = { get import() { return t('common.import'); }, get stage() { return t('system.migrate.stage'); }, get report() { return t('system.migrate.reportOnly'); } };

const STATUS_KEY = ['migrate', 'status'] as const;

interface MappingRow extends MigratePathMapping {
  key: number;
}

/** Areas pre-selected after analysis: anything that would write or stage something. */
export function defaultAreas(plan: MigrationPlan): MigrateArea[] {
  return plan.areas.filter((a) => a.create + a.conflicts > 0 || (a.mode === 'stage' && a.total > 0)).map((a) => a.area);
}

export function SystemMigratePage() {
  const queryClient = useQueryClient();
  const [app, setApp] = useState<MigrateApp>('sonarr');
  const [dbPath, setDbPath] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [selected, setSelected] = useState<Set<MigrateArea>>(new Set());
  const [conflictPolicy, setConflictPolicy] = useState<MigrateConflictPolicy>('skip');
  const [dryRun, setDryRun] = useState(false);

  const sources = useQuery({ queryKey: ['migrate', 'sources'], queryFn: migrateApi.sources, staleTime: 60_000 });
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: migrateApi.status,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 1000 : false),
  });

  const plan = useMutation({
    mutationFn: (source: MigrateSourceInput) => migrateApi.plan(source),
    meta: { silent: true },
    onSuccess: (result) => setSelected(new Set(defaultAreas(result))),
  });

  const apply = useMutation({
    mutationFn: migrateApi.apply,
    meta: { errorTitle: t('system.migrate.importCouldNotStart') },
    onSuccess: (next) => queryClient.setQueryData(STATUS_KEY, next),
  });

  const source = (): MigrateSourceInput => ({
    app,
    dbPath: dbPath.trim(),
    ...(configPath.trim() ? { configPath: configPath.trim() } : {}),
    pathMappings: mappings.filter((m) => m.from.trim() && m.to.trim()).map((m) => ({ from: m.from.trim(), to: m.to.trim() })),
  });

  const pickCandidate = (c: MigrateSourceCandidate) => {
    setApp(c.app);
    setDbPath(c.dbPath);
    setConfigPath(c.configPath ?? '');
    plan.reset();
  };

  const addMapping = () => {
    setMappings((rows) => [...rows, { key: nextKey, from: '', to: '' }]);
    setNextKey((k) => k + 1);
  };
  const updateMapping = (key: number, field: 'from' | 'to', value: string) => setMappings((rows) => rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  const removeMapping = (key: number) => setMappings((rows) => rows.filter((r) => r.key !== key));

  const toggleArea = (area: MigrateArea, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(area);
      else next.delete(area);
      return next;
    });

  const running = status.data?.state === 'running';
  const startImport = () => {
    if (!plan.data) return;
    const areas = plan.data.areas.map((a) => a.area).filter((a) => selected.has(a));
    apply.mutate({ source: source(), areas, conflictPolicy, dryRun });
  };

  return (
    <>
      <SystemHeader title={t('system.migrate.importFromExistingApps')} subtitle={t('system.migrate.adoptARunningSonarrRadarr')} />
      <div className="sys-stack">
        <Pane title={t('common.source')}>
          {sources.data && sources.data.length > 0 ? (
            <div className="sys-block">
              <SectionLabel>{t('system.migrate.detectedInstallations')}</SectionLabel>
              <ul className="sys-list">
                {sources.data.map((c) => (
                  <li key={`${c.app}:${c.dbPath}`}>
                    <Button size="sm" variant="ghost" onClick={() => pickCandidate(c)}>
                      {APP_LABEL[c.app]}: {c.dbPath}
                    </Button>
                    <span className="sys-muted">{c.origin}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="sys-form">
            <Field inline label={t('system.migrate.application')}>
              <Select value={app} onChange={(e) => setApp(e.target.value as MigrateApp)} options={APP_OPTIONS} />
            </Field>
            <Field inline label={t('system.migrate.databasePath')} hint={t('system.migrate.forExampleConfigSonarrDb')}>
              <Input mono value={dbPath} onChange={(e) => setDbPath(e.target.value)} placeholder="/config/sonarr.db" />
            </Field>
            <Field inline label={t('system.migrate.configFileOptional')} hint={t('system.migrate.configXmlConfigYamlOr')}>
              <Input mono value={configPath} onChange={(e) => setConfigPath(e.target.value)} />
            </Field>
          </div>

          <div className="sys-block">
            <SectionLabel>{t('system.migrate.pathMappings')}</SectionLabel>
            <p className="sys-muted">{t('system.migrate.rewritePathPrefixesThatDiffer')}</p>
            {mappings.map((m, i) => (
              <div key={m.key} className="sys-mapping">
                <Input mono aria-label={t('system.migrate.mappingValueFrom', { value: i + 1 })} placeholder="/tv" value={m.from} onChange={(e) => updateMapping(m.key, 'from', e.target.value)} />
                <span aria-hidden="true">→</span>
                <Input mono aria-label={t('system.migrate.mappingValueTo', { value: i + 1 })} placeholder="/data/tv" value={m.to} onChange={(e) => updateMapping(m.key, 'to', e.target.value)} />
                <Button size="sm" variant="ghost" aria-label={t('system.migrate.removeMappingValue', { value: i + 1 })} onClick={() => removeMapping(m.key)}>
                  {t('common.remove')}
                </Button>
              </div>
            ))}
            <div>
              <Button size="sm" variant="secondary" onClick={addMapping}>
                {t('system.migrate.addMapping')}
              </Button>
            </div>
          </div>

          <div className="sys-form__actions">
            <Button variant="primary" loading={plan.isPending} disabled={!dbPath.trim() || running} onClick={() => plan.mutate(source())}>
              {t('system.migrate.analyze')}
            </Button>
          </div>
          {plan.isError ? <ErrorBlock title={t('system.migrate.couldntAnalyseTheDatabase')}>{errorMessage(plan.error)}</ErrorBlock> : null}
        </Pane>

        {plan.data ? (
          <PlanView
            plan={plan.data}
            selected={selected}
            onToggle={toggleArea}
            conflictPolicy={conflictPolicy}
            onConflictPolicy={setConflictPolicy}
            dryRun={dryRun}
            onDryRun={setDryRun}
            onImport={startImport}
            importing={apply.isPending || running}
          />
        ) : null}

        {status.data && status.data.state !== 'idle' ? <RunView status={status.data} /> : null}
      </div>
    </>
  );
}

interface PlanViewProps {
  plan: MigrationPlan;
  selected: ReadonlySet<MigrateArea>;
  onToggle: (area: MigrateArea, on: boolean) => void;
  conflictPolicy: MigrateConflictPolicy;
  onConflictPolicy: (p: MigrateConflictPolicy) => void;
  dryRun: boolean;
  onDryRun: (v: boolean) => void;
  onImport: () => void;
  importing: boolean;
}

function NoteList({ label, tone, items }: { label: string; tone: ChipTone; items: ReadonlyArray<{ area: string; text: string }> }) {
  if (items.length === 0) return null;
  return (
    <Pane
      title={
        <SectionLabel as="h2" tone={tone === 'warn' ? 'warn' : 'default'} count={items.length}>
          {label}
        </SectionLabel>
      }
    >
      <ul className="sys-list">
        {items.map((it, i) => (
          <li key={i}>
            <Chip tone={tone}>{it.area}</Chip>
            <span>{it.text}</span>
          </li>
        ))}
      </ul>
    </Pane>
  );
}

function PlanView({ plan, selected, onToggle, conflictPolicy, onConflictPolicy, dryRun, onDryRun, onImport, importing }: PlanViewProps) {
  const columns: Column<MigrationAreaPlan>[] = [
    {
      key: 'include',
      header: <span className="al-sr-only">{t('system.migrate.include')}</span>,
      width: '2.75rem',
      cell: (a) => <Checkbox aria-label={t('system.migrate.includeLabel', { label: a.label })} checked={selected.has(a.area)} disabled={a.mode === 'report'} onChange={(e) => onToggle(a.area, e.target.checked)} />,
    },
    { key: 'label', header: t('system.migrate.area'), cell: (a) => a.label, sortValue: (a) => a.label },
    { key: 'mode', header: t('common.action'), cell: (a) => <Chip tone={MODE_TONE[a.mode]}>{MODE_LABEL[a.mode]}</Chip> },
    { key: 'total', header: t('system.migrate.found'), align: 'right', mono: true, cell: (a) => a.total },
    { key: 'create', header: t('system.migrate.new'), align: 'right', mono: true, cell: (a) => a.create },
    { key: 'conflicts', header: t('system.migrate.conflicts'), align: 'right', mono: true, cell: (a) => a.conflicts },
    { key: 'already', header: t('system.migrate.alreadyImported'), align: 'right', mono: true, cell: (a) => a.alreadyImported },
    { key: 'unsupported', header: t('system.migrate.unsupported'), align: 'right', mono: true, cell: (a) => a.unsupported },
    {
      key: 'details',
      header: t('common.details'),
      muted: true,
      cell: (a) =>
        Object.entries(a.details)
          .map(([k, v]) => `${v} ${k}`)
          .join(', '),
    },
  ];

  return (
    <>
      <Pane title={t('system.migrate.planValueValue2', { value: APP_LABEL[plan.app], value2: plan.schemaVersion ? ` · schema ${plan.schemaVersion}` : '' })} flush>
        <Table columns={columns} rows={plan.areas} rowKey={(a) => a.area} caption={t('system.migrate.importPlan')} empty={<EmptyState title={t('system.migrate.nothingToImport')} />} />
      </Pane>
      <NoteList label={t('common.warnings')} tone="warn" items={plan.warnings.map((w) => ({ area: w.area, text: w.message }))} />
      <NoteList label={t('system.migrate.conflictsWithExistingData')} tone="neutral" items={plan.conflicts.map((c) => ({ area: c.area, text: `${c.name}: ${c.reason}` }))} />
      <NoteList label={t('system.migrate.notSupported')} tone="muted" items={plan.unsupported.map((u) => ({ area: u.area, text: `${u.name}: ${u.reason}` }))} />

      <Pane title={t('common.import')}>
        <div className="sys-form">
          <Field inline label={t('system.migrate.whenAnItemAlreadyExists')} hint={t('system.migrate.overwriteUpdatesTheExistingItem')}>
            <Select
              value={conflictPolicy}
              onChange={(e) => onConflictPolicy(e.target.value as MigrateConflictPolicy)}
              options={[
                { value: 'skip', label: t('system.migrate.skipIt') },
                { value: 'overwrite', label: t('system.migrate.overwriteIt') },
              ]}
            />
          </Field>
          <Field inline label={t('common.dryRun')} hint={t('system.migrate.runTheImportAndRoll')}>
            <Toggle checked={dryRun} onChange={(e) => onDryRun(e.target.checked)} />
          </Field>
        </div>
        <div className="sys-form__actions">
          <Button variant="primary" loading={importing} disabled={selected.size === 0} onClick={onImport}>
            {t('common.import')}
          </Button>
        </div>
      </Pane>
    </>
  );
}

const STATE_TONE: Record<MigrateStatus['state'], ChipTone> = { idle: 'neutral', running: 'default', completed: 'accent', failed: 'danger' };
const STATE_LABEL: Record<MigrateStatus['state'], string> = { get idle() { return t('system.migrate.idle'); }, get running() { return t('common.running'); }, get completed() { return t('common.completed'); }, get failed() { return t('status.failed'); } };

function RunView({ status }: { status: MigrateStatus }) {
  const resultColumns: Column<MigrationAreaResult>[] = [
    { key: 'area', header: t('system.migrate.area'), cell: (r) => r.area },
    { key: 'created', header: t('system.migrate.created'), align: 'right', mono: true, cell: (r) => r.created },
    { key: 'updated', header: t('system.migrate.updated'), align: 'right', mono: true, cell: (r) => r.updated },
    { key: 'skipped', header: t('system.migrate.skipped'), align: 'right', mono: true, cell: (r) => r.skipped },
    { key: 'staged', header: t('system.migrate.staged'), align: 'right', mono: true, cell: (r) => r.staged },
    { key: 'failed', header: t('status.failed'), align: 'right', mono: true, cell: (r) => r.failed },
  ];
  const p = status.progress;
  return (
    <Pane
      title={
        <div className="sys-run-head">
          <SectionLabel as="h2">{t('system.migrate.importValue', { value: status.app ? ` · ${APP_LABEL[status.app]}` : '' })}</SectionLabel>
          {status.state === 'failed' ? (
            <Chip tone="danger">{t('system.migrate.failedValue', { value: status.error ?? t('system.migrate.seeTheLogBelow') })}</Chip>
          ) : (
            <Chip tone={STATE_TONE[status.state]}>{STATE_LABEL[status.state]}</Chip>
          )}
          {status.result?.dryRun ? <Chip tone="neutral">{t('common.dryRun')}</Chip> : null}
        </div>
      }
    >
      {status.state === 'running' && p ? (
        <div className="sys-run-progress" role="status">
          <p>
            {t('system.migrate.areaValueOfAreacountArea', { value: p.areaIndex + 1, areaCount: p.areaCount, area: p.area, done: p.done, total: p.total })}
          </p>
          <Trail value={(p.done / Math.max(p.total, 1)) * 100} state="active" showValue label={t('system.migrate.areaProgress', { area: p.area })} />
        </div>
      ) : null}
      {status.error && status.state !== 'failed' ? <ErrorBlock title={t('system.migrate.theImportReportedAnError')}>{status.error}</ErrorBlock> : null}
      {status.result ? <Table columns={resultColumns} rows={status.result.areas} rowKey={(r) => r.area} caption={t('system.migrate.importResult')} sortable={false} /> : null}
      {status.log.length > 0 ? (
        <details className="sys-run-log" open={status.state === 'running'}>
          <summary>
            {t('system.migrate.log')} <span className="al-num">{status.log.length}</span>
          </summary>
          <ol>
            {status.log.map((e, i) => (
              <li key={i} data-level={e.level}>
                <span className="al-num sys-muted">{formatClock(e.time)}</span> {e.area ? `[${e.area}] ` : ''}
                {e.message}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </Pane>
  );
}
