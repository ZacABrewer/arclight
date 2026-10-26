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

// System → Import from existing apps. Point at an old Sonarr / Radarr / Prowlarr / Bazarr /
// Seerr database, analyse it (nothing is written), pick areas and a conflict policy, then run
// the import as a background job whose progress is polled from /migrate/status.

const APP_OPTIONS: ReadonlyArray<{ value: MigrateApp; label: string }> = [
  { value: 'sonarr', label: 'Sonarr' },
  { value: 'radarr', label: 'Radarr' },
  { value: 'prowlarr', label: 'Prowlarr' },
  { value: 'bazarr', label: 'Bazarr' },
  { value: 'seerr', label: 'Overseerr / Jellyseerr' },
];

const APP_LABEL: Record<MigrateApp, string> = Object.fromEntries(APP_OPTIONS.map((o) => [o.value, o.label])) as Record<MigrateApp, string>;

const MODE_TONE: Record<MigrationAreaPlan['mode'], ChipTone> = { import: 'accent', stage: 'default', report: 'neutral' };
const MODE_LABEL: Record<MigrationAreaPlan['mode'], string> = { import: 'Import', stage: 'Stage', report: 'Report only' };

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
    meta: { errorTitle: 'Import could not start' },
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
      <SystemHeader title="Import from existing apps" subtitle="Adopt a running Sonarr, Radarr, Prowlarr, Bazarr or Seerr installation in place." />
      <div className="sys-stack">
        <Pane title="Source">
          {sources.data && sources.data.length > 0 ? (
            <div className="sys-block">
              <SectionLabel>Detected installations</SectionLabel>
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
            <Field inline label="Application">
              <Select value={app} onChange={(e) => setApp(e.target.value as MigrateApp)} options={APP_OPTIONS} />
            </Field>
            <Field inline label="Database path" hint="For example /config/sonarr.db or C:\ProgramData\Sonarr\sonarr.db.">
              <Input mono value={dbPath} onChange={(e) => setDbPath(e.target.value)} placeholder="/config/sonarr.db" />
            </Field>
            <Field inline label="Config file (optional)" hint="config.xml, config.yaml or config.ini (Bazarr), settings.json (Seerr).">
              <Input mono value={configPath} onChange={(e) => setConfigPath(e.target.value)} />
            </Field>
          </div>

          <div className="sys-block">
            <SectionLabel>Path mappings</SectionLabel>
            <p className="sys-muted">Rewrite path prefixes that differ between the old app and Arclight, for example /tv to /data/tv.</p>
            {mappings.map((m, i) => (
              <div key={m.key} className="sys-mapping">
                <Input mono aria-label={`Mapping ${i + 1} from`} placeholder="/tv" value={m.from} onChange={(e) => updateMapping(m.key, 'from', e.target.value)} />
                <span aria-hidden="true">→</span>
                <Input mono aria-label={`Mapping ${i + 1} to`} placeholder="/data/tv" value={m.to} onChange={(e) => updateMapping(m.key, 'to', e.target.value)} />
                <Button size="sm" variant="ghost" aria-label={`Remove mapping ${i + 1}`} onClick={() => removeMapping(m.key)}>
                  Remove
                </Button>
              </div>
            ))}
            <div>
              <Button size="sm" variant="secondary" onClick={addMapping}>
                Add mapping
              </Button>
            </div>
          </div>

          <div className="sys-form__actions">
            <Button variant="primary" loading={plan.isPending} disabled={!dbPath.trim() || running} onClick={() => plan.mutate(source())}>
              Analyze
            </Button>
          </div>
          {plan.isError ? <ErrorBlock title="Couldn't analyse the database">{errorMessage(plan.error)}</ErrorBlock> : null}
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
      header: <span className="al-sr-only">Include</span>,
      width: '2.75rem',
      cell: (a) => <Checkbox aria-label={`Include ${a.label}`} checked={selected.has(a.area)} disabled={a.mode === 'report'} onChange={(e) => onToggle(a.area, e.target.checked)} />,
    },
    { key: 'label', header: 'Area', cell: (a) => a.label, sortValue: (a) => a.label },
    { key: 'mode', header: 'Action', cell: (a) => <Chip tone={MODE_TONE[a.mode]}>{MODE_LABEL[a.mode]}</Chip> },
    { key: 'total', header: 'Found', align: 'right', mono: true, cell: (a) => a.total },
    { key: 'create', header: 'New', align: 'right', mono: true, cell: (a) => a.create },
    { key: 'conflicts', header: 'Conflicts', align: 'right', mono: true, cell: (a) => a.conflicts },
    { key: 'already', header: 'Already imported', align: 'right', mono: true, cell: (a) => a.alreadyImported },
    { key: 'unsupported', header: 'Unsupported', align: 'right', mono: true, cell: (a) => a.unsupported },
    {
      key: 'details',
      header: 'Details',
      muted: true,
      cell: (a) =>
        Object.entries(a.details)
          .map(([k, v]) => `${v} ${k}`)
          .join(', '),
    },
  ];

  return (
    <>
      <Pane title={`Plan · ${APP_LABEL[plan.app]}${plan.schemaVersion ? ` · schema ${plan.schemaVersion}` : ''}`} flush>
        <Table columns={columns} rows={plan.areas} rowKey={(a) => a.area} caption="Import plan" empty={<EmptyState title="Nothing to import" />} />
      </Pane>
      <NoteList label="Warnings" tone="warn" items={plan.warnings.map((w) => ({ area: w.area, text: w.message }))} />
      <NoteList label="Conflicts with existing data" tone="neutral" items={plan.conflicts.map((c) => ({ area: c.area, text: `${c.name}: ${c.reason}` }))} />
      <NoteList label="Not supported" tone="muted" items={plan.unsupported.map((u) => ({ area: u.area, text: `${u.name}: ${u.reason}` }))} />

      <Pane title="Import">
        <div className="sys-form">
          <Field inline label="When an item already exists" hint="Overwrite updates the existing item. Nothing is ever deleted.">
            <Select
              value={conflictPolicy}
              onChange={(e) => onConflictPolicy(e.target.value as MigrateConflictPolicy)}
              options={[
                { value: 'skip', label: 'Skip it' },
                { value: 'overwrite', label: 'Overwrite it' },
              ]}
            />
          </Field>
          <Field inline label="Dry run" hint="Run the import and roll it back, to see what would change.">
            <Toggle checked={dryRun} onChange={(e) => onDryRun(e.target.checked)} />
          </Field>
        </div>
        <div className="sys-form__actions">
          <Button variant="primary" loading={importing} disabled={selected.size === 0} onClick={onImport}>
            Import
          </Button>
        </div>
      </Pane>
    </>
  );
}

const STATE_TONE: Record<MigrateStatus['state'], ChipTone> = { idle: 'neutral', running: 'default', completed: 'accent', failed: 'danger' };
const STATE_LABEL: Record<MigrateStatus['state'], string> = { idle: 'Idle', running: 'Running', completed: 'Completed', failed: 'Failed' };

function RunView({ status }: { status: MigrateStatus }) {
  const resultColumns: Column<MigrationAreaResult>[] = [
    { key: 'area', header: 'Area', cell: (r) => r.area },
    { key: 'created', header: 'Created', align: 'right', mono: true, cell: (r) => r.created },
    { key: 'updated', header: 'Updated', align: 'right', mono: true, cell: (r) => r.updated },
    { key: 'skipped', header: 'Skipped', align: 'right', mono: true, cell: (r) => r.skipped },
    { key: 'staged', header: 'Staged', align: 'right', mono: true, cell: (r) => r.staged },
    { key: 'failed', header: 'Failed', align: 'right', mono: true, cell: (r) => r.failed },
  ];
  const p = status.progress;
  return (
    <Pane
      title={
        <div className="sys-run-head">
          <SectionLabel as="h2">{`Import${status.app ? ` · ${APP_LABEL[status.app]}` : ''}`}</SectionLabel>
          {status.state === 'failed' ? (
            <Chip tone="danger">Failed · {status.error ?? 'see the log below'}</Chip>
          ) : (
            <Chip tone={STATE_TONE[status.state]}>{STATE_LABEL[status.state]}</Chip>
          )}
          {status.result?.dryRun ? <Chip tone="neutral">Dry run</Chip> : null}
        </div>
      }
    >
      {status.state === 'running' && p ? (
        <div className="sys-run-progress" role="status">
          <p>
            Area {p.areaIndex + 1} of {p.areaCount}: {p.area} ({p.done}/{p.total})
          </p>
          <Trail value={(p.done / Math.max(p.total, 1)) * 100} state="active" showValue label={`${p.area} progress`} />
        </div>
      ) : null}
      {status.error && status.state !== 'failed' ? <ErrorBlock title="The import reported an error">{status.error}</ErrorBlock> : null}
      {status.result ? <Table columns={resultColumns} rows={status.result.areas} rowKey={(r) => r.area} caption="Import result" sortable={false} /> : null}
      {status.log.length > 0 ? (
        <details className="sys-run-log" open={status.state === 'running'}>
          <summary>
            Log · <span className="al-num">{status.log.length}</span>
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
