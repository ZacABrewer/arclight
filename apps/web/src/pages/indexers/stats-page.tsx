import { useState } from 'react';
import type { IndexerStatsDay, IndexerStatsEntry } from '@media-tron/shared';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Select } from '../../components/form.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { Table, type Column } from '../../components/table.js';
import { useIndexerStats } from '../../hooks/indexers.js';
import { barLayout, failureRate, linePath, seriesMax, type DayMetric } from './stats-model.js';

const W = 640;
const H = 180;

const LINES: { metric: DayMetric; label: string; color: string }[] = [
  { metric: 'queries', label: 'Queries', color: 'var(--accent)' },
  { metric: 'grabs', label: 'Grabs', color: 'var(--ok)' },
  { metric: 'failures', label: 'Failures', color: 'var(--error)' },
];

function QueriesBarChart({ entries }: { entries: readonly IndexerStatsEntry[] }) {
  const bars = barLayout(
    entries.map((e) => ({ label: e.indexerName, value: e.queries })),
    W,
    H,
  );
  return (
    <svg viewBox={`0 0 ${W} ${H + 24}`} className="chart" role="img" aria-label="Queries per indexer">
      {bars.map((b) => (
        <g key={b.label}>
          <rect x={b.x} y={b.y} width={b.width} height={b.height} fill="var(--accent)" opacity={0.8}>
            <title>{`${b.label}: ${b.value} queries`}</title>
          </rect>
          <text x={b.x + b.width / 2} y={H + 16} textAnchor="middle" fontSize="11" fill="currentColor">
            {b.label.length > 14 ? `${b.label.slice(0, 13)}…` : b.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function DailyLineChart({ days }: { days: readonly IndexerStatsDay[] }) {
  const max = seriesMax(
    days,
    LINES.map((l) => l.metric),
  );
  return (
    <figure className="chart-figure">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Daily activity">
        <line x1={0} y1={H} x2={W} y2={H} stroke="currentColor" opacity={0.3} />
        {LINES.map((l) => (
          <path key={l.metric} d={linePath(days, l.metric, W, H, max)} fill="none" stroke={l.color} strokeWidth={2} data-metric={l.metric} />
        ))}
      </svg>
      <figcaption className="row muted">
        {LINES.map((l) => (
          <span key={l.metric}>
            <span aria-hidden="true" style={{ color: l.color }}>
              ■
            </span>{' '}
            {l.label}
          </span>
        ))}
        <span>max {max}/day</span>
      </figcaption>
    </figure>
  );
}

const columns: Column<IndexerStatsEntry>[] = [
  { key: 'name', header: 'Indexer', sortValue: (e) => e.indexerName, cell: (e) => e.indexerName },
  { key: 'queries', header: 'Queries', align: 'right', sortValue: (e) => e.queries, cell: (e) => e.queries },
  { key: 'grabs', header: 'Grabs', align: 'right', sortValue: (e) => e.grabs, cell: (e) => e.grabs },
  { key: 'failures', header: 'Failures', align: 'right', sortValue: (e) => e.failures, cell: (e) => e.failures },
  { key: 'rate', header: 'Failure rate', align: 'right', cell: (e) => failureRate(e) },
  {
    key: 'avg',
    header: 'Avg response',
    align: 'right',
    sortValue: (e) => e.avgResponseMs ?? -1,
    cell: (e) => (e.avgResponseMs === null ? '—' : `${e.avgResponseMs} ms`),
  },
];

/** Indexers → Stats: queries, grabs, failures and response times per indexer. */
export function IndexerStatsPage() {
  const [days, setDays] = useState(30);
  const stats = useIndexerStats(days);

  return (
    <Page
      title="Indexer Stats"
      actions={
        <Select
          aria-label="Window"
          value={String(days)}
          onChange={(e) => setDays(Number(e.currentTarget.value))}
          options={[
            { value: '7', label: 'Last 7 days' },
            { value: '30', label: 'Last 30 days' },
            { value: '90', label: 'Last 90 days' },
          ]}
        />
      }
    >
      {stats.isPending ? (
        <LoadingBlock />
      ) : stats.isError ? (
        <ErrorView error={stats.error} onRetry={() => void stats.refetch()} />
      ) : stats.data.indexers.length === 0 ? (
        <EmptyState title="No indexer activity yet">Stats appear once indexers have been queried.</EmptyState>
      ) : (
        <>
          <div className="stat-tiles" aria-label="Totals">
            <Card title="Queries">{stats.data.totals.queries}</Card>
            <Card title="Grabs">{stats.data.totals.grabs}</Card>
            <Card title="Failures">{stats.data.totals.failures}</Card>
            <Card title="Avg response">{stats.data.totals.avgResponseMs === null ? '—' : `${stats.data.totals.avgResponseMs} ms`}</Card>
          </div>
          <Card title="Queries per indexer">
            <QueriesBarChart entries={stats.data.indexers} />
          </Card>
          <Card title="Daily activity">
            <DailyLineChart days={stats.data.totals.byDay} />
          </Card>
          <Card flush title="Per indexer">
            <Table caption="Indexer stats" columns={columns} rows={stats.data.indexers} rowKey={(e) => String(e.indexerId)} defaultSort={{ key: 'queries', direction: 'desc' }} />
          </Card>
        </>
      )}
    </Page>
  );
}
