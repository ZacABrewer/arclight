import { Link } from '@tanstack/react-router';
import type { ActivityStats, LibraryStats, StatsBucket, StatsTopItem, StorageStats } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { EmptyState, ErrorBlock, KeyValue, Meter, Pane, Skeleton, Table, type Column } from '../../../arclight/index.js';
import { useActivityStats, useLibraryStats, useStorageStats } from '../../../hooks/stats.js';
import { formatSize } from '../../../lib/format.js';
import { CHART } from '../../indexers/stats-page.js';
import { axisTicks } from '../../indexers/stats-model.js';
import { SystemHeader } from '../system-header.js';
import { activityMax, bucketShares, fillDays, formatDelta, groupedBars, rootUsage, seriesPath, type ActivityMetric } from './stats-model.js';
import '../../indexers/stats.css';
import './stats.css';
import { t, intlLocale } from '../../../i18n/index.js';
import { rootKindLabel } from '../../../components/media/root-kind.js';

// Chart geometry in viewBox units; the SVG scales to the pane width (mobile included).
const W = 640;
const H = 180;
const M = { top: 8, right: 8, bottom: 28, left: 44 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

const METRICS: { metric: ActivityMetric; label: string; color: string; fillOpacity: number }[] = [
  { metric: 'grabbed', get label() { return t('common.grabbed'); }, color: CHART.stroke, fillOpacity: 0 },
  { metric: 'imported', get label() { return t('common.imported'); }, color: CHART.stroke, fillOpacity: CHART.fillOpacity },
  { metric: 'failed', get label() { return t('status.failed'); }, color: 'var(--al-danger)', fillOpacity: CHART.fillOpacity },
];

function YAxis({ max, format = String }: { max: number; format?: (n: number) => string }) {
  return (
    <g aria-hidden="true">
      {axisTicks(max).map((item) => {
        const y = M.top + PH - (item / Math.max(1, max)) * PH;
        return (
          <g key={item}>
            <line x1={M.left} x2={M.left + PW} y1={y} y2={y} stroke={CHART.axis} strokeWidth={1} strokeOpacity={item === 0 ? 1 : 0.4} />
            <text x={M.left - 8} y={y + 4} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label}>
              {format(item)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Grabs, imports and failures per day: grouped 1px bars, failures in red. */
export function ActivityChart({ stats }: { stats: ActivityStats }) {
  const days = fillDays(stats.perDay, stats.since, stats.days);
  const metrics = METRICS.map((m) => m.metric);
  const max = activityMax(days, metrics);
  const bars = groupedBars(days, metrics, PW, PH, 2);
  const first = days[0];
  const last = days[days.length - 1];
  const style = new Map(METRICS.map((m) => [m.metric, m]));
  return (
    <figure className="mt-chart-figure">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-chart"
        role="img"
        aria-label={t('system.stats.activityOverDaysDaysGrabbed', { days: stats.days, grabbed: stats.totals.grabbed, imported: stats.totals.imported, failed: stats.totals.failed })}
      >
        <YAxis max={max} />
        <g transform={`translate(${M.left} ${M.top})`}>
          {bars
            .filter((b) => b.value > 0)
            .map((b) => {
              const s = style.get(b.metric)!;
              return (
                <rect
                  key={`${b.date}-${b.metric}`}
                  data-metric={b.metric}
                  x={b.x}
                  y={b.y}
                  width={b.width}
                  height={b.height}
                  fill={s.color}
                  fillOpacity={s.fillOpacity}
                  stroke={s.color}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                >
                  <title>{`${b.date}: ${b.value} ${s.label.toLowerCase()}`}</title>
                </rect>
              );
            })}
          {first ? (
            <text x={0} y={PH + 18} fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
              {first.date.slice(5)}
            </text>
          ) : null}
          {last && last !== first ? (
            <text x={PW} y={PH + 18} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
              {last.date.slice(5)}
            </text>
          ) : null}
        </g>
      </svg>
      <figcaption className="mt-chart__legend">
        {METRICS.map((m) => (
          <span key={m.metric} className="mt-chart__key">
            <svg width="12" height="10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="11" height="9" fill={m.color} fillOpacity={m.fillOpacity} stroke={m.color} strokeWidth={1} />
            </svg>
            {m.label} <span className="al-num">{stats.totals[m.metric]}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Library size over the snapshot days (1px line, ≤12% fill). */
export function GrowthChart({ points }: { points: StorageStats['growth']['points'] }) {
  const values = points.map((p) => p.usedBytes);
  const line = seriesPath(values, PW, PH);
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-chart" role="img" aria-label={t('system.stats.librarySizeFromSizeTo', { size: formatSize(first?.usedBytes), size2: formatSize(last?.usedBytes) })}>
      <line x1={M.left} x2={M.left + PW} y1={M.top + PH} y2={M.top + PH} stroke={CHART.axis} strokeWidth={1} aria-hidden="true" />
      <text x={M.left - 8} y={M.top + 10} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
        {formatSize(Math.max(...values))}
      </text>
      <text x={M.left - 8} y={M.top + PH} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
        {formatSize(Math.min(...values))}
      </text>
      <g transform={`translate(${M.left} ${M.top})`}>
        <path d={`${line} L${PW} ${PH} L0 ${PH} Z`} fill={CHART.stroke} fillOpacity={CHART.fillOpacity} stroke="none" />
        <path d={line} fill="none" stroke={CHART.stroke} strokeWidth={1} vectorEffect="non-scaling-stroke" data-series="growth" />
        {first ? (
          <text x={0} y={PH + 18} fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
            {first.date.slice(5, 10)}
          </text>
        ) : null}
        {last && last !== first ? (
          <text x={PW} y={PH + 18} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
            {last.date.slice(5, 10)}
          </text>
        ) : null}
      </g>
    </svg>
  );
}

function StoragePane({ data }: { data: StorageStats }) {
  return (
    <Pane chamfer="tl" title={t('system.stats.storage')} aria-label={t('system.stats.storage')}>
      <KeyValue
        layout="grid"
        columns={3}
        className="al-stats-kv"
        items={[
          { label: t('system.stats.usedByArclight'), value: formatSize(data.totalUsedBytes) },
          { label: t('common.files'), value: data.totalFiles.toLocaleString(intlLocale()) },
          { label: t('system.stats.last30Days'), value: formatDelta(data.growth.last30.deltaBytes) },
        ]}
      />
      {data.rootFolders.length === 0 ? (
        <EmptyState title={t('system.stats.noRootFolders')}>{t('system.stats.addOneUnderSettingsMedia')}</EmptyState>
      ) : (
        <ul className="al-stats-roots">
          {data.rootFolders.map((r) => {
            const u = rootUsage(r);
            return (
              <li key={r.path} className="al-stats-root">
                <div className="al-stats-root__head">
                  <span className="al-num al-stats-root__path">{r.path}</span>
                  <span className="al-caption">{rootKindLabel(r.mediaType)}</span>
                </div>
                <Meter
                  value={u.usedPct ?? 0}
                  tone={u.tone}
                  label={t('system.stats.pathUsed', { path: r.path })}
                  valueText={<span data-tone={u.tone === 'warn' ? 'warn' : undefined}>{u.text}</span>}
                />
                <p className="al-caption al-num al-stats-root__foot">
                  {t('system.stats.sizeInFilecountFiles', { size: formatSize(r.usedByArclightBytes), fileCount: r.fileCount.toLocaleString(intlLocale()) })}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Pane>
  );
}

function LibraryPane({ data }: { data: LibraryStats }) {
  return (
    <Pane title={t('common.library')} aria-label={t('system.stats.libraryCounts')}>
      <div className="al-stats-library">
        <section aria-label={t('common.series')}>
          <h3 className="al-label">{t('system.stats.series')}</h3>
          <KeyValue
            items={[
              { label: t('system.stats.total'), value: data.series.total },
              { label: t('status.monitored'), value: data.series.monitored },
              { label: t('system.stats.continuing'), value: data.series.continuing },
              { label: t('system.stats.ended'), value: data.series.ended },
            ]}
          />
        </section>
        <section aria-label={t('common.episodes')}>
          <h3 className="al-label">{t('system.stats.episodes')}</h3>
          <KeyValue
            items={[
              { label: t('status.downloaded'), value: `${data.episodes.downloaded} / ${data.episodes.total}` },
              { label: t('status.missing'), value: data.episodes.missing },
              { label: t('status.unaired'), value: data.episodes.unaired },
              { label: t('status.cutoffUnmet'), value: data.episodes.cutoffUnmet },
            ]}
          />
        </section>
        <section aria-label={t('common.movies')}>
          <h3 className="al-label">{t('system.stats.movies')}</h3>
          <KeyValue
            items={[
              { label: t('status.downloaded'), value: `${data.movies.downloaded} / ${data.movies.total}` },
              { label: t('status.monitored'), value: data.movies.monitored },
              { label: t('status.missing'), value: data.movies.missing },
              { label: t('status.cutoffUnmet'), value: data.movies.cutoffUnmet },
            ]}
          />
        </section>
        <section aria-label={t('common.files')}>
          <h3 className="al-label">{t('system.stats.files')}</h3>
          <KeyValue
            items={[
              { label: t('common.files'), value: data.files.total },
              { label: t('common.size'), value: formatSize(data.files.sizeBytes) },
            ]}
          />
        </section>
      </div>
    </Pane>
  );
}

/** One breakdown as labelled Meter rows (share of size), mono size and file count. */
export function BucketPane({ title, buckets }: { title: string; buckets: readonly StatsBucket[] }) {
  const rows = bucketShares(buckets);
  return (
    <Pane title={title} aria-label={title}>
      {rows.length === 0 ? (
        <p className="al-caption">{t('system.stats.noFilesYet')}</p>
      ) : (
        <ul className="al-stats-buckets">
          {rows.map((b) => (
            <li key={b.key} className="al-stats-bucket">
              <span className="al-num al-stats-bucket__label">{b.label}</span>
              <Meter value={b.pct} label={t('system.stats.labelShare', { label: b.label })} valueText={`${formatSize(b.sizeBytes)} · ${b.count}`} />
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

function TopTable({ title, items }: { title: string; items: readonly StatsTopItem[] }) {
  const columns: Column<StatsTopItem>[] = [
    {
      key: 'title',
      header: t('common.title'),
      cell: (i) =>
        i.mediaType === 'series' ? (
          <Link className="al-link" to="/library/series/$id" params={{ id: String(i.id) }}>
            {i.title}
          </Link>
        ) : (
          <Link className="al-link" to="/library/movie/$id" params={{ id: String(i.id) }}>
            {i.title}
          </Link>
        ),
    },
    { key: 'year', header: t('common.year'), mono: true, muted: true, cell: (i) => (i.year > 0 ? i.year : '—') },
    { key: 'files', header: t('common.files'), mono: true, align: 'right', cell: (i) => i.fileCount },
    { key: 'size', header: t('common.size'), mono: true, align: 'right', cell: (i) => formatSize(i.sizeBytes) },
  ];
  return (
    <Pane title={title} aria-label={title} flush>
      <Table caption={title} columns={columns} rows={items} rowKey={(i) => `${i.mediaType}-${i.id}`} density="dense" empty={<EmptyState title={t('system.stats.nothingOnDiskYet')} />} />
    </Pane>
  );
}

function Loading({ title }: { title: string }) {
  return (
    <Pane title={title}>
      <Skeleton lines={4} />
    </Pane>
  );
}

function Failed({ title, error, retry }: { title: string; error: unknown; retry: () => void }) {
  return (
    <Pane title={title}>
      <ErrorBlock title={t('system.stats.couldntLoadTitle', { title: title.toLowerCase() })} onRetry={retry}>
        {errorMessage(error)}
      </ErrorBlock>
    </Pane>
  );
}

/** System → Stats (/system/stats): storage, library counts, breakdowns and 30-day activity. */
export function SystemStatsPage() {
  const storage = useStorageStats(10);
  const library = useLibraryStats();
  const activity = useActivityStats(30);
  const s = storage.data;
  return (
    <>
      <SystemHeader
        title={t('system.stats.stats')}
        actions={
          <Link className="al-link" to="/indexers/stats">
            {t('system.stats.indexerStats')}
          </Link>
        }
      />
      <div className="al-stats">
        <div className="al-stats__grid al-stats__grid--hero">
          {storage.isPending ? <Loading title={t('system.stats.storage')} /> : storage.isError ? <Failed title={t('system.stats.storage')} error={storage.error} retry={() => void storage.refetch()} /> : <StoragePane data={s!} />}
          {library.isPending ? <Loading title={t('common.library')} /> : library.isError ? <Failed title={t('common.library')} error={library.error} retry={() => void library.refetch()} /> : <LibraryPane data={library.data} />}
        </div>
        {activity.isPending ? (
          <Loading title={t('common.activity')} />
        ) : activity.isError ? (
          <Failed title={t('common.activity')} error={activity.error} retry={() => void activity.refetch()} />
        ) : (
          <Pane title={t('system.stats.activityLastDaysDays', { days: activity.data.days })} aria-label={t('common.activity')}>
            <ActivityChart stats={activity.data} />
          </Pane>
        )}
        {s ? (
          <>
            {s.growth.points.length > 1 ? (
              <Pane
                title={t('system.stats.librarySize')}
                aria-label={t('system.stats.librarySize')}
                actions={
                  <span className="al-caption al-num">
                    {t('system.stats.n30DDelta90D', { delta: formatDelta(s.growth.last30.deltaBytes), delta2: formatDelta(s.growth.last90.deltaBytes) })}
                  </span>
                }
              >
                <GrowthChart points={s.growth.points} />
              </Pane>
            ) : null}
            <div className="al-stats__grid">
              <BucketPane title={t('system.stats.byQuality')} buckets={s.byQuality} />
              <BucketPane title={t('system.stats.byVideoCodec')} buckets={s.byVideoCodec} />
              <BucketPane title={t('system.stats.byResolution')} buckets={s.byResolution} />
              <BucketPane title={t('system.stats.byDynamicRange')} buckets={s.byDynamicRange} />
            </div>
            <div className="al-stats__grid">
              <TopTable title={t('system.stats.largestSeries')} items={s.topSeries} />
              <TopTable title={t('system.stats.largestMovies')} items={s.topMovies} />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
