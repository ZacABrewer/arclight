import type { LibraryGrowth } from '@arclight/shared';
import { Meter } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';
import { formatSize } from '../../lib/format.js';
import { CHART } from '../../pages/indexers/stats-page.js';
import { axisTicks } from '../../pages/indexers/stats-model.js';
import { seriesPath } from '../../pages/system/stats/stats-model.js';
import { heatmapMax, hourLabel, monthKeyLabel, weekdayName, type ShareRow } from './stats-model.js';
import '../../pages/indexers/stats.css';

// Hand-drawn SVG charts in the Arclight chart style (1px cyan, fills at most 12%, text-4 mono
// axes; CHART tokens from Indexers → Stats). The SVGs scale to the pane width, phones included.

const W = 640;
const H = 180;
const M = { top: 8, right: 8, bottom: 28, left: 44 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

function YAxis({ max, format = String }: { max: number; format?: ((n: number) => string) | undefined }) {
  return (
    <g aria-hidden="true">
      {axisTicks(max).map((tick) => {
        const y = M.top + PH - (tick / Math.max(1, max)) * PH;
        return (
          <g key={tick}>
            <line x1={M.left} x2={M.left + PW} y1={y} y2={y} stroke={CHART.axis} strokeWidth={1} strokeOpacity={tick === 0 ? 1 : 0.4} />
            <text x={M.left - 8} y={y + 4} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label}>
              {format(tick)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export interface Bar {
  key: string;
  /** Axis label (shown at the ends, or under every bar with `labelEvery`). */
  label: string;
  value: number;
  /** Tooltip text. */
  title: string;
}

/** Vertical bars, one per entry, scaled to the largest value. */
export function BarChart({ bars, label, labelEvery = false, format }: { bars: readonly Bar[]; label: string; labelEvery?: boolean; format?: ((n: number) => string) | undefined }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const top = Math.max(1, Math.ceil(max));
  const slot = bars.length ? PW / bars.length : PW;
  const gap = Math.min(4, slot / 4);
  const first = bars[0];
  const last = bars[bars.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-chart" role="img" aria-label={label}>
      <YAxis max={top} format={format} />
      <g transform={`translate(${M.left} ${M.top})`}>
        {bars.map((b, i) => {
          const h = (b.value / top) * PH;
          return b.value > 0 ? (
            <rect
              key={b.key}
              data-bar={b.key}
              x={i * slot + gap / 2}
              y={PH - h}
              width={Math.max(1, slot - gap)}
              height={h}
              fill={CHART.stroke}
              fillOpacity={CHART.fillOpacity}
              stroke={CHART.stroke}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            >
              <title>{b.title}</title>
            </rect>
          ) : null;
        })}
        {labelEvery
          ? bars.map((b, i) => (
              <text key={b.key} x={i * slot + slot / 2} y={PH + 18} textAnchor="middle" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
                {b.label}
              </text>
            ))
          : null}
        {!labelEvery && first ? (
          <text x={0} y={PH + 18} fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
            {first.label}
          </text>
        ) : null}
        {!labelEvery && last && last !== first ? (
          <text x={PW} y={PH + 18} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
            {last.label}
          </text>
        ) : null}
      </g>
    </svg>
  );
}

const HM = { left: 40, top: 4, bottom: 22, cell: 24 };

/** Plays by weekday (rows, Sunday first) and hour (columns); opacity follows the count. */
export function Heatmap({ grid }: { grid: readonly (readonly number[])[] }) {
  const max = heatmapMax(grid);
  const width = HM.left + 24 * HM.cell;
  const height = HM.top + 7 * HM.cell + HM.bottom;
  const total = grid.flat().reduce((n, v) => n + v, 0);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-chart" role="img" aria-label={t('watchStats.heatmapLabel', { count: total })}>
      {Array.from({ length: 7 }, (_, day) => (
        <g key={day}>
          <text x={HM.left - 6} y={HM.top + day * HM.cell + HM.cell / 2 + 4} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
            {weekdayName(day, 'short')}
          </text>
          {Array.from({ length: 24 }, (_, hour) => {
            const v = grid[day]?.[hour] ?? 0;
            return (
              <rect
                key={hour}
                data-cell={`${day}-${hour}`}
                x={HM.left + hour * HM.cell + 1}
                y={HM.top + day * HM.cell + 1}
                width={HM.cell - 2}
                height={HM.cell - 2}
                fill={CHART.stroke}
                fillOpacity={v > 0 ? 0.08 + (v / max) * 0.72 : 0}
                stroke={CHART.axis}
                strokeOpacity={0.4}
                strokeWidth={1}
              >
                <title>{t('watchStats.heatmapCell', { day: weekdayName(day), hour: hourLabel(hour), count: v })}</title>
              </rect>
            );
          })}
        </g>
      ))}
      {[0, 6, 12, 18, 23].map((hour) => (
        <text key={hour} x={HM.left + hour * HM.cell + HM.cell / 2} y={HM.top + 7 * HM.cell + 16} textAnchor="middle" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
          {String(hour).padStart(2, '0')}
        </text>
      ))}
    </svg>
  );
}

/** Storage used over the daily snapshots (1px line, faint fill). */
export function StorageChart({ snapshots }: { snapshots: LibraryGrowth['snapshots'] }) {
  const values = snapshots.map((p) => p.usedBytes);
  const line = seriesPath(values, PW, PH);
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-chart" role="img" aria-label={t('watchStats.storageLabel', { from: formatSize(first?.usedBytes), to: formatSize(last?.usedBytes) })}>
      <line x1={M.left} x2={M.left + PW} y1={M.top + PH} y2={M.top + PH} stroke={CHART.axis} strokeWidth={1} aria-hidden="true" />
      <text x={M.left - 8} y={M.top + 10} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
        {formatSize(Math.max(...values))}
      </text>
      <text x={M.left - 8} y={M.top + PH} textAnchor="end" fontSize={11} fontFamily={CHART.font} fill={CHART.label} aria-hidden="true">
        {formatSize(Math.min(...values))}
      </text>
      <g transform={`translate(${M.left} ${M.top})`}>
        <path d={`${line} L${PW} ${PH} L0 ${PH} Z`} fill={CHART.stroke} fillOpacity={CHART.fillOpacity} stroke="none" />
        <path d={line} fill="none" stroke={CHART.stroke} strokeWidth={1} vectorEffect="non-scaling-stroke" data-series="storage" />
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

/** Movies and series added per month: one bar per month (movies + series), episodes in the tooltip. */
export function AddedChart({ added }: { added: LibraryGrowth['added'] }) {
  const bars: Bar[] = added.map((m) => ({
    key: m.month,
    label: monthKeyLabel(m.month),
    value: m.movies + m.series,
    title: t('watchStats.addedTooltip', { month: monthKeyLabel(m.month), movies: m.movies, series: m.series, episodes: m.episodes }),
  }));
  return <BarChart bars={bars} label={t('watchStats.addedLabel', { count: bars.reduce((n, b) => n + b.value, 0) })} labelEvery={bars.length <= 12} />;
}

/** Labelled meter rows (share of the total), value on the right. */
export function ShareList({ rows, label, valueText }: { rows: readonly ShareRow[]; label: string; valueText: (row: ShareRow) => string }) {
  if (rows.length === 0) return <p className="al-caption">{t('watchStats.nothingYet')}</p>;
  return (
    <ul className="ws-shares" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="ws-share">
          <span className="ws-share__label">{r.label}</span>
          <Meter value={r.pct} label={t('watchStats.shareOf', { label: r.label })} valueText={valueText(r)} />
        </li>
      ))}
    </ul>
  );
}
