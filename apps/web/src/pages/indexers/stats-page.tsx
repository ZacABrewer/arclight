import { useEffect, useState } from 'react';
import type { IndexerStatsDay, IndexerStatsEntry } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { EmptyState, ErrorBlock, KeyValue, PageHeader, Pane, Select, Skeleton, Table, type Column } from '../../arclight/index.js';
import { useIndexerStats } from '../../hooks/indexers.js';
import { areaPath, axisTicks, barLayout, failureRate, linePath, seriesMax, type DayMetric } from './stats-model.js';
import './stats.css';
import { t } from '../../i18n/index.js';


// Chart geometry (viewBox units). Plot area sits inside the margins; axes and labels outside.
const W = 640;
const H = 180;
const M = { top: 8, right: 8, bottom: 28, left: 44 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

/** Arclight chart styling: 1px cyan strokes, fills at most 12%, text-4 mono axes, no glow. */
export const CHART = {
  stroke: 'var(--al-cyan)',
  strokeWidth: 1,
  fillOpacity: 0.1,
  axis: 'var(--al-line-2)',
  label: 'var(--al-text-4)',
  font: 'var(--al-mono)',
} as const;

const LINES: { metric: DayMetric; label: string; color: string; dash?: string }[] = [
  { metric: 'queries', get label() { return t('indexers.stats.queries'); }, color: CHART.stroke },
  { metric: 'grabs', get label() { return t('indexers.stats.grabs'); }, color: CHART.stroke, dash: '4 3' },
  { metric: 'failures', get label() { return t('indexers.stats.failures'); }, color: 'var(--al-danger)', dash: '1 3' },
];

function YAxis({ max }: { max: number }) {
  return (
    <g className="mt-chart__axis" aria-hidden="true">
      {axisTicks(max).map((item) => {
        const y = M.top + PH - (item / Math.max(1, max)) * PH;
        return (
          <g key={item}>
            <line x1={M.left} x2={M.left + PW} y1={y} y2={y} stroke={CHART.axis} strokeWidth={CHART.strokeWidth} strokeOpacity={item === 0 ? 1 : 0.4} />
            <text x={M.left - 8} y={y + 4} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label}>
              {item}
            </text>
          </g>
        );
      })}
      <line x1={M.left} x2={M.left} y1={M.top} y2={M.top + PH} stroke={CHART.axis} strokeWidth={CHART.strokeWidth} />
    </g>
  );
}

function QueriesBarChart({ entries }: { entries: readonly IndexerStatsEntry[] }) {
  const max = Math.max(1, ...entries.map((e) => e.queries));
  const bars = barLayout(
    entries.map((e) => ({ label: e.indexerName, value: e.queries })),
    PW,
    PH,
    12,
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-chart" role="img" aria-label={t('indexers.stats.queriesPerIndexer')}>
      <YAxis max={max} />
      <g transform={`translate(${M.left} ${M.top})`}>
        {bars.map((b) => (
          <g key={b.label}>
            <rect
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              fill={CHART.stroke}
              fillOpacity={CHART.fillOpacity}
              stroke={CHART.stroke}
              strokeWidth={CHART.strokeWidth}
              vectorEffect="non-scaling-stroke"
            >
              <title>{`${b.label}: ${b.value} queries`}</title>
            </rect>
            <text x={b.x + b.width / 2} y={PH + 18} textAnchor="middle" fontSize={11} fontFamily={CHART.font} fill={CHART.label}>
              {b.label.length > 14 ? `${b.label.slice(0, 13)}…` : b.label}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

function shortDate(iso: string): string {
  return iso.slice(5); // MM-DD
}

function DailyLineChart({ days }: { days: readonly IndexerStatsDay[] }) {
  const max = seriesMax(
    days,
    LINES.map((l) => l.metric),
  );
  const queries = linePath(days, 'queries', PW, PH, max);
  const first = days[0];
  const last = days[days.length - 1];
  return (
    <figure className="mt-chart-figure">
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-chart" role="img" aria-label={t('indexers.stats.dailyActivity')}>
        <YAxis max={max} />
        <g transform={`translate(${M.left} ${M.top})`}>
          <path className="mt-chart__area" d={areaPath(queries, PW, PH, days.length)} fill={CHART.stroke} fillOpacity={CHART.fillOpacity} stroke="none" />
          {LINES.map((l) => (
            <path
              key={l.metric}
              d={l.metric === 'queries' ? queries : linePath(days, l.metric, PW, PH, max)}
              fill="none"
              stroke={l.color}
              strokeWidth={CHART.strokeWidth}
              strokeDasharray={l.dash}
              vectorEffect="non-scaling-stroke"
              data-metric={l.metric}
            />
          ))}
          {first ? (
            <text x={0} y={PH + 18} fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
              {shortDate(first.date)}
            </text>
          ) : null}
          {last && last !== first ? (
            <text x={PW} y={PH + 18} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
              {shortDate(last.date)}
            </text>
          ) : null}
        </g>
      </svg>
      <figcaption className="mt-chart__legend">
        {LINES.map((l) => (
          <span key={l.metric} className="mt-chart__key">
            <svg width="20" height="8" aria-hidden="true">
              <line x1="0" x2="20" y1="4" y2="4" stroke={l.color} strokeWidth={CHART.strokeWidth} strokeDasharray={l.dash} />
            </svg>
            {l.label}
          </span>
        ))}
        <span className="mt-chart__key">
          {t('indexers.stats.max')} <span className="al-num">{max}</span>/day
        </span>
      </figcaption>
    </figure>
  );
}

const ms = (v: number | null) => (v === null ? '—' : `${v} ms`);

const columns: Column<IndexerStatsEntry>[] = [
  { key: 'name', get header() { return t('common.indexer'); }, sortValue: (e) => e.indexerName, cell: (e) => e.indexerName },
  { key: 'queries', get header() { return t('indexers.stats.queries'); }, align: 'right', mono: true, sortValue: (e) => e.queries, cell: (e) => e.queries },
  { key: 'grabs', get header() { return t('indexers.stats.grabs'); }, align: 'right', mono: true, sortValue: (e) => e.grabs, cell: (e) => e.grabs },
  { key: 'failures', get header() { return t('indexers.stats.failures'); }, align: 'right', mono: true, sortValue: (e) => e.failures, cell: (e) => e.failures },
  { key: 'rate', get header() { return t('indexers.stats.failureRate'); }, align: 'right', mono: true, cell: (e) => failureRate(e) },
  { key: 'avg', get header() { return t('indexers.stats.avgResponse'); }, align: 'right', mono: true, sortValue: (e) => e.avgResponseMs ?? -1, cell: (e) => ms(e.avgResponseMs) },
];

/** Indexers → Stats: queries, grabs, failures and response times per indexer. */
export function IndexerStatsPage() {
  const [days, setDays] = useState(30);
  const stats = useIndexerStats(days);

  useEffect(() => {
    document.title = t('indexers.stats.titleArclight', { title: t('indexers.stats.title') });
  }, []);

  return (
    <>
      <PageHeader index="08" title={t('indexers.stats.title')}>
        <Select
          aria-label={t('indexers.stats.window')}
          value={String(days)}
          onChange={(e) => setDays(Number(e.currentTarget.value))}
          options={[
            { value: '7', label: t('indexers.stats.last7Days') },
            { value: '30', label: t('indexers.stats.last30Days') },
            { value: '90', label: t('indexers.stats.last90Days') },
          ]}
        />
      </PageHeader>
      {stats.isPending ? (
        <Pane>
          <Skeleton lines={4} />
        </Pane>
      ) : stats.isError ? (
        <ErrorBlock title={t('indexers.stats.indexerStatsDidNotLoad')} onRetry={() => void stats.refetch()}>
          {errorMessage(stats.error)}
        </ErrorBlock>
      ) : stats.data.indexers.length === 0 ? (
        <EmptyState title={t('indexers.stats.noIndexerActivityYet')}>{t('indexers.stats.statsAppearOnceIndexersHave')}</EmptyState>
      ) : (
        <div className="mt-stats">
          <Pane title={t('indexers.stats.totals')} aria-label={t('indexers.stats.totals')}>
            <KeyValue
              layout="grid"
              columns={4}
              className="mt-stats__totals"
              items={[
                { label: t('indexers.stats.queries'), value: stats.data.totals.queries },
                { label: t('indexers.stats.grabs'), value: stats.data.totals.grabs },
                { label: t('indexers.stats.failures'), value: `${stats.data.totals.failures} · ${failureRate(stats.data.totals)}` },
                { label: t('indexers.stats.avgResponse'), value: ms(stats.data.totals.avgResponseMs) },
              ]}
            />
          </Pane>
          <div className="mt-stats__charts">
            <Pane title={t('indexers.stats.queriesPerIndexer')}>
              <QueriesBarChart entries={stats.data.indexers} />
            </Pane>
            <Pane title={t('indexers.stats.dailyActivity')}>
              <DailyLineChart days={stats.data.totals.byDay} />
            </Pane>
          </div>
          <Pane flush title={t('indexers.stats.perIndexer')}>
            <Table caption={t('indexers.stats.indexerStats')} columns={columns} rows={stats.data.indexers} rowKey={(e) => String(e.indexerId)} defaultSort={{ key: 'queries', direction: 'desc' }} />
          </Pane>
        </div>
      )}
    </>
  );
}
