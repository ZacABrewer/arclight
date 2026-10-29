import { useMemo, useState } from 'react';
import { INDEXER_HEALTH_DEFAULT_DAYS, type Indexer, type IndexerHealthEntry, type IndexerHealthThresholds } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { indexersApi } from '../../api/indexers.js';
import { Button, Chip, ErrorBlock, Pane, Select, Skeleton, Table, type Column } from '../../arclight/index.js';
import { TestButton } from '../../components/forms/test-result.js';
import { useIndexerHealth, useIndexerList, useUpdateIndexer } from '../../hooks/indexers.js';
import { formatDateTime } from '../../lib/format.js';
import { formatDuration, formatRelative, t } from '../../i18n/index.js';
import { indexerTestOutcome, toIndexerBody } from '../settings/indexers/indexer-fields.js';
import { EditIndexerDialog } from '../settings/indexers/indexers-page.js';
import { formatAvgResults, formatRatio, healthOrder, toggleEnabledBody, VERDICT_RANK, VERDICT_TONE, verdictLabel, verdictReason } from './health-model.js';

const NO_THRESHOLDS: IndexerHealthThresholds = { failureRate: 0, slowAvgMs: 0, slowP95Ms: 0, zeroResultRate: 0, minQueriesForNoResults: 0 };

interface Row {
  entry: IndexerHealthEntry;
  indexer: Indexer | undefined;
}

function When({ iso, empty }: { iso: string | null; empty: string }) {
  if (!iso) return <span className="mt-health__muted">{empty}</span>;
  return <time dateTime={iso} title={formatDateTime(iso)}>{formatRelative(iso)}</time>;
}

function StatusCell({ entry }: { entry: IndexerHealthEntry }) {
  if (entry.disabledTill) {
    return (
      <Chip tone="warn" title={t('indexers.health.backingOffUntil', { dateTime: formatDateTime(entry.disabledTill), count: entry.failureCount })}>
        {t('indexers.health.backingOff')}
      </Chip>
    );
  }
  return entry.enabled ? <Chip tone="accent">{t('common.enabled')}</Chip> : <Chip tone="muted">{t('common.disabled')}</Chip>;
}

function columnsFor(
  thresholds: IndexerHealthThresholds,
  actions: { edit: (i: Indexer) => void; toggle: (i: Indexer, entry: IndexerHealthEntry) => void; toggling: number | null },
): Column<Row>[] {
  return [
    {
      key: 'name',
      header: t('common.indexer'),
      sortValue: (r) => r.entry.indexerName,
      cell: ({ entry, indexer }) =>
        indexer ? (
          <button type="button" className="mt-health__name" onClick={() => actions.edit(indexer)} aria-label={t('indexers.health.editName', { name: entry.indexerName })}>
            {entry.indexerName}
          </button>
        ) : (
          entry.indexerName
        ),
    },
    {
      key: 'verdict',
      header: t('indexers.health.verdict'),
      sortValue: (r) => VERDICT_RANK[r.entry.verdict],
      cell: ({ entry }) => (
        <Chip tone={VERDICT_TONE[entry.verdict]} title={verdictReason(entry, thresholds)}>
          {verdictLabel(entry.verdict)}
        </Chip>
      ),
    },
    { key: 'queries', header: t('indexers.stats.queries'), align: 'right', mono: true, sortValue: (r) => r.entry.queries, cell: (r) => r.entry.queries },
    {
      key: 'failureRate',
      header: t('indexers.stats.failureRate'),
      align: 'right',
      mono: true,
      sortValue: (r) => r.entry.failureRate,
      cell: (r) => formatRatio(r.entry.failureRate),
    },
    {
      key: 'avg',
      header: t('indexers.stats.avgResponse'),
      align: 'right',
      mono: true,
      sortValue: (r) => r.entry.avgResponseMs,
      cell: (r) => formatDuration(r.entry.avgResponseMs),
    },
    {
      key: 'p95',
      header: t('indexers.health.p95Response'),
      align: 'right',
      mono: true,
      sortValue: (r) => r.entry.p95ResponseMs,
      cell: (r) => formatDuration(r.entry.p95ResponseMs),
    },
    {
      key: 'avgResults',
      header: t('indexers.health.avgResults'),
      align: 'right',
      mono: true,
      sortValue: (r) => r.entry.avgResults,
      cell: (r) => formatAvgResults(r.entry.avgResults),
    },
    {
      key: 'zero',
      header: t('indexers.health.zeroResults'),
      align: 'right',
      mono: true,
      sortValue: (r) => r.entry.zeroResultRate,
      cell: (r) => formatRatio(r.entry.zeroResultRate),
    },
    { key: 'grabs', header: t('indexers.stats.grabs'), align: 'right', mono: true, sortValue: (r) => r.entry.grabs, cell: (r) => r.entry.grabs },
    {
      key: 'lastSuccess',
      header: t('indexers.health.lastSuccess'),
      mono: true,
      sortValue: (r) => r.entry.lastSuccessAt,
      cell: (r) => <When iso={r.entry.lastSuccessAt} empty={t('common.never')} />,
    },
    {
      key: 'lastFailure',
      header: t('indexers.health.lastFailure'),
      sortValue: (r) => r.entry.lastFailureAt,
      cell: ({ entry }) => (
        <div className="mt-health__failure">
          <When iso={entry.lastFailureAt} empty={t('common.never')} />
          {entry.lastFailureMessage ? (
            <span className="mt-health__message" title={entry.lastFailureMessage}>
              {entry.lastFailureMessage}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: t('common.status'),
      sortValue: (r) => (r.entry.disabledTill ? 2 : r.entry.enabled ? 0 : 1),
      cell: (r) => <StatusCell entry={r.entry} />,
    },
    {
      key: 'actions',
      header: t('common.actions'),
      cell: ({ entry, indexer }) =>
        indexer ? (
          <div className="mt-health__actions">
            <TestButton
              size="sm"
              label={t('common.test')}
              onTest={async () => indexerTestOutcome(await indexersApi.test(toIndexerBody(indexer as unknown as Record<string, unknown>)))}
            />
            <Button
              size="sm"
              variant="ghost"
              loading={actions.toggling === indexer.id}
              onClick={() => actions.toggle(indexer, entry)}
              aria-label={entry.enabled ? t('indexers.health.disableName', { name: entry.indexerName }) : t('indexers.health.enableName', { name: entry.indexerName })}
            >
              {entry.enabled ? t('indexers.health.disable') : t('indexers.health.enable')}
            </Button>
          </div>
        ) : null,
    },
  ];
}

/**
 * Indexers → Stats, top pane: one row per indexer with a health verdict (healthy / slow /
 * failing / unused / no results), the metrics behind it, and Edit / Test / Enable actions.
 */
export function IndexerHealthPane() {
  const [days, setDays] = useState<number>(INDEXER_HEALTH_DEFAULT_DAYS);
  const health = useIndexerHealth(days);
  const list = useIndexerList();
  const update = useUpdateIndexer();
  const [editing, setEditing] = useState<Indexer | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);

  const rows = useMemo<Row[] | undefined>(() => {
    if (!health.data) return undefined;
    const byId = new Map((list.data ?? []).map((i) => [i.id, i]));
    return [...health.data.indexers].sort(healthOrder).map((entry) => ({ entry, indexer: byId.get(entry.indexerId) }));
  }, [health.data, list.data]);

  const columns = columnsFor(health.data?.thresholds ?? NO_THRESHOLDS, {
    edit: setEditing,
    toggling,
    toggle: (indexer, entry) => {
      setToggling(indexer.id);
      update.mutate(
        { id: indexer.id, body: toggleEnabledBody(entry.enabled) },
        {
          onSettled: () => {
            setToggling(null);
            void health.refetch();
          },
        },
      );
    },
  });

  const problems = health.data?.indexers.filter((e) => e.verdict !== 'healthy' && e.verdict !== 'unused').length ?? 0;

  return (
    <Pane
      flush
      title={t('indexers.health.title')}
      aria-label={t('indexers.health.title')}
      actions={
        <Select
          aria-label={t('indexers.health.period')}
          value={String(days)}
          onChange={(e) => setDays(Number(e.currentTarget.value))}
          options={[
            { value: '1', label: t('indexers.health.last24Hours') },
            { value: '7', label: t('indexers.stats.last7Days') },
            { value: '30', label: t('indexers.stats.last30Days') },
          ]}
        />
      }
    >
      {health.isPending ? (
        <div className="mt-health__pad">
          <Skeleton lines={3} />
        </div>
      ) : health.isError ? (
        <div className="mt-health__pad">
          <ErrorBlock title={t('indexers.health.didNotLoad')} onRetry={() => void health.refetch()}>
            {errorMessage(health.error)}
          </ErrorBlock>
        </div>
      ) : health.data.indexers.length === 0 ? (
        <p className="mt-health__pad mt-health__muted">{t('indexers.health.noIndexers')}</p>
      ) : (
        <>
          <p className="mt-health__summary" aria-live="polite">
            {problems === 0 ? t('indexers.health.allHealthy') : t('indexers.health.needAttention', { count: problems })}
          </p>
          <Table caption={t('indexers.health.title')} columns={columns} rows={rows} rowKey={(r) => String(r.entry.indexerId)} />
        </>
      )}
      {editing ? (
        <EditIndexerDialog
          indexer={editing}
          onClose={() => {
            setEditing(null);
            void health.refetch();
          }}
        />
      ) : null}
    </Pane>
  );
}
