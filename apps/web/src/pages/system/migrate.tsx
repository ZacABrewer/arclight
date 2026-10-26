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
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { FormField, Input, Select, Toggle } from '../../components/form.js';
import { Page } from '../../components/page.js';
import { Table, type Column } from '../../components/table.js';

// System -> Import from existing apps. Point at an old Sonarr / Radarr / Prowlarr / Bazarr /
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

const MODE_TONE: Record<MigrationAreaPlan['mode'], BadgeTone> = { import: 'ok', stage: 'info', report: 'neutral' };

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
    pathMappings: mappings
      .filter((m) => m.from.trim() && m.to.trim())
      .map((m) => ({ from: m.from.trim(), to: m.to.trim() })),
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
  const updateMapping = (key: number, field: 'from' | 'to', value: string) =>
    setMappings((rows) => rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
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
    <Page title="Import from existing apps" subtitle="Adopt a running Sonarr, Radarr, Prowlarr, Bazarr or Seerr installation in place.">
      <Card title="Source">
        {sources.data && sources.data.length > 0 ? (
          <div className="field">
            <span className="field-label">Detected installations</span>
            <ul className="migrate-sources">
              {sources.data.map((c) => (
                <li key={`${c.app}:${c.dbPath}`}>
                  <Button size="sm" variant="ghost" onClick={() => pickCandidate(c)}>
                    {APP_LABEL[c.app]}: {c.dbPath}
                  </Button>{' '}
                  <span className="muted">({c.origin})</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <FormField label="Application">
          <Select value={app} onChange={(e) => setApp(e.target.value as MigrateApp)} options={APP_OPTIONS} />
        </FormField>
        <FormField label="Database path" hint="e.g. /config/sonarr.db, or C:\ProgramData\Sonarr\sonarr.db">
          <Input value={dbPath} onChange={(e) => setDbPath(e.target.value)} placeholder="/config/sonarr.db" />
        </FormField>
        <FormField label="Config file (optional)" hint="config.xml, config.yaml / config.ini (Bazarr) or settings.json (Seerr)">
          <Input value={configPath} onChange={(e) => setConfigPath(e.target.value)} />
        </FormField>

        <div className="field">
          <span className="field-label">Path mappings</span>
          <p className="field-hint">Rewrite path prefixes that differ between the old app and Arclight (e.g. /tv to /data/tv).</p>
          {mappings.map((m, i) => (
            <div key={m.key} className="migrate-mapping">
              <Input aria-label={`Mapping ${i + 1} from`} placeholder="/tv" value={m.from} onChange={(e) => updateMapping(m.key, 'from', e.target.value)} />
              <span aria-hidden="true"> → </span>
              <Input aria-label={`Mapping ${i + 1} to`} placeholder="/data/tv" value={m.to} onChange={(e) => updateMapping(m.key, 'to', e.target.value)} />
              <Button size="sm" variant="ghost" aria-label={`Remove mapping ${i + 1}`} onClick={() => removeMapping(m.key)}>
                Remove
              </Button>
            </div>
          ))}
          <Button size="sm" onClick={addMapping}>
            Add mapping
          </Button>
        </div>

        <Button variant="primary" loading={plan.isPending} disabled={!dbPath.trim() || running} onClick={() => plan.mutate(source())}>
          Analyze
        </Button>
        {plan.isError ? (
          <p className="field-error-text" role="alert">
            {errorMessage(plan.error)}
          </p>
        ) : null}
      </Card>

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
    </Page>
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

function PlanView({ plan, selected, onToggle, conflictPolicy, onConflictPolicy, dryRun, onDryRun, onImport, importing }: PlanViewProps) {
  const columns: Column<MigrationAreaPlan>[] = [
    {
      key: 'include',
      header: <span className="sr-only">Include</span>,
      width: '2.5rem',
      cell: (a) => (
        <input
          type="checkbox"
          aria-label={`Include ${a.label}`}
          checked={selected.has(a.area)}
          disabled={a.mode === 'report'}
          onChange={(e) => onToggle(a.area, e.target.checked)}
        />
      ),
    },
    { key: 'label', header: 'Area', cell: (a) => a.label, sortValue: (a) => a.label },
    { key: 'mode', header: 'Action', cell: (a) => <Badge tone={MODE_TONE[a.mode]}>{a.mode}</Badge> },
    { key: 'total', header: 'Found', align: 'right', cell: (a) => a.total },
    { key: 'create', header: 'New', align: 'right', cell: (a) => a.create },
    { key: 'conflicts', header: 'Conflicts', align: 'right', cell: (a) => a.conflicts },
    { key: 'already', header: 'Already imported', align: 'right', cell: (a) => a.alreadyImported },
    { key: 'unsupported', header: 'Unsupported', align: 'right', cell: (a) => a.unsupported },
    {
      key: 'details',
      header: 'Details',
      cell: (a) =>
        Object.entries(a.details)
          .map(([k, v]) => `${v} ${k}`)
          .join(', '),
    },
  ];

  return (
    <>
      <Card title={`Plan: ${APP_LABEL[plan.app]}${plan.schemaVersion ? ` (schema ${plan.schemaVersion})` : ''}`} flush>
        <Table columns={columns} rows={plan.areas} rowKey={(a) => a.area} caption="Import plan" empty={<EmptyState title="Nothing to import" />} />
      </Card>

      {plan.warnings.length > 0 ? (
        <Card title={`Warnings (${plan.warnings.length})`}>
          <ul className="migrate-list">
            {plan.warnings.map((w, i) => (
              <li key={i}>
                <Badge tone="warning">{w.area}</Badge> {w.message}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {plan.conflicts.length > 0 ? (
        <Card title={`Conflicts with existing data (${plan.conflicts.length})`}>
          <ul className="migrate-list">
            {plan.conflicts.map((c, i) => (
              <li key={i}>
                <Badge tone="info">{c.area}</Badge> {c.name}: {c.reason}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {plan.unsupported.length > 0 ? (
        <Card title={`Not supported (${plan.unsupported.length})`}>
          <ul className="migrate-list">
            {plan.unsupported.map((u, i) => (
              <li key={i}>
                <Badge tone="neutral">{u.area}</Badge> {u.name}: {u.reason}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Import">
        <FormField label="When an item already exists" hint="Overwrite updates the existing item; nothing is ever deleted.">
          <Select
            value={conflictPolicy}
            onChange={(e) => onConflictPolicy(e.target.value as MigrateConflictPolicy)}
            options={[
              { value: 'skip', label: 'Skip it' },
              { value: 'overwrite', label: 'Overwrite it' },
            ]}
          />
        </FormField>
        <FormField label="Dry run" hint="Run the import and roll it back, to see what would change.">
          <Toggle checked={dryRun} onChange={(e) => onDryRun(e.target.checked)} />
        </FormField>
        <Button variant="primary" loading={importing} disabled={selected.size === 0} onClick={onImport}>
          Import
        </Button>
      </Card>
    </>
  );
}

const STATE_TONE: Record<MigrateStatus['state'], BadgeTone> = { idle: 'neutral', running: 'info', completed: 'ok', failed: 'error' };

function RunView({ status }: { status: MigrateStatus }) {
  const resultColumns: Column<MigrationAreaResult>[] = [
    { key: 'area', header: 'Area', cell: (r) => r.area },
    { key: 'created', header: 'Created', align: 'right', cell: (r) => r.created },
    { key: 'updated', header: 'Updated', align: 'right', cell: (r) => r.updated },
    { key: 'skipped', header: 'Skipped', align: 'right', cell: (r) => r.skipped },
    { key: 'staged', header: 'Staged', align: 'right', cell: (r) => r.staged },
    { key: 'failed', header: 'Failed', align: 'right', cell: (r) => r.failed },
  ];
  const p = status.progress;
  return (
    <Card
      title={
        <>
          Import {status.app ? APP_LABEL[status.app] : ''} <Badge tone={STATE_TONE[status.state]}>{status.state}</Badge>
          {status.result?.dryRun ? <Badge tone="neutral">dry run</Badge> : null}
        </>
      }
    >
      {status.state === 'running' && p ? (
        <div className="migrate-progress" role="status">
          <p>
            Area {p.areaIndex + 1} of {p.areaCount}: {p.area} ({p.done}/{p.total})
          </p>
          <progress max={Math.max(p.total, 1)} value={p.done} aria-label={`${p.area} progress`} />
        </div>
      ) : null}
      {status.error ? (
        <p className="field-error-text" role="alert">
          {status.error}
        </p>
      ) : null}
      {status.result ? (
        <Table columns={resultColumns} rows={status.result.areas} rowKey={(r) => r.area} caption="Import result" sortable={false} />
      ) : null}
      {status.log.length > 0 ? (
        <details open={status.state === 'running'}>
          <summary>Log ({status.log.length})</summary>
          <ol className="migrate-log">
            {status.log.map((e, i) => (
              <li key={i} className={`migrate-log-${e.level}`}>
                <span className="muted">{new Date(e.time).toLocaleTimeString()}</span> {e.area ? `[${e.area}] ` : ''}
                {e.message}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </Card>
  );
}
