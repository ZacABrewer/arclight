import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { MetricsRange, type MetricAnnotation, type QueueSeverity, type VpnMetrics } from '@arclight/shared';
import { EmptyState, Segmented, Table, type Column } from '../../arclight/index.js';
import { formatDateTime, formatRate, formatUptime } from '../../lib/format.js';
import { intlLocale, t } from '../../i18n/index.js';
import { clusterAnnotations, formatAxisTime, gapPath, niceCeil, summarizeRates, vpnSegments, vpnTotals, type RatePoint, type VpnState } from './chart-model.js';
import './transfer-charts.css';

// Transfer history charts: a speed chart (down/up, a secondary line such as peers, event
// markers) and the VPN connection strip. Hand-drawn SVG in the Arclight chart style (1px cyan,
// fills ≤12%, text-4 mono axes). Each has a text summary and a data table for screen readers.

const H = 200;
const M = { top: 10, right: 40, bottom: 26, left: 64 };
const FONT = 'var(--al-mono)';
const AXIS = 'var(--al-line-2)';
const LABEL = 'var(--al-text-4)';
const DOWN = 'var(--al-cyan)';
const UP = 'var(--al-cyan)';
const AUX = 'var(--al-text-3)';
const MARKER: Readonly<Record<QueueSeverity, string>> = { ok: 'var(--al-text-3)', info: 'var(--al-text-3)', warning: 'var(--al-warn)', error: 'var(--al-danger)' };

/** Width the SVG is drawn at: the container's, so labels stay 11px on a phone. */
function useWidth(fallback = 640): [RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.max(280, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export const METRICS_RANGES = MetricsRange.options;

/** 1 h · 6 h · 24 h · 7 d. */
export function RangePicker({ value, onChange, ranges = METRICS_RANGES }: { value: MetricsRange; onChange: (r: MetricsRange) => void; ranges?: readonly MetricsRange[] }) {
  return (
    <Segmented
      variant="soft"
      aria-label={t('transfer.range.label')}
      value={value}
      onChange={onChange}
      options={ranges.map((r) => ({ value: r, label: t(`transfer.range.${r}`) }))}
      className="al-transfer-range"
    />
  );
}

/** Text of one marker: the timeline entry or VPN transition in words. */
export function annotationLabel(a: MetricAnnotation): string {
  if (a.source === 'vpn') {
    if (a.type === 'portChanged') return a.port === undefined ? t('transfer.vpnEvent.portRemoved') : t('transfer.vpnEvent.portChanged', { port: a.port });
    return t(`transfer.vpnEvent.${a.type}`);
  }
  if (a.reason === 'killSwitch' && a.type === 'paused') return t('transfer.annotation.killSwitchPause');
  if (a.reason === 'killSwitch' && a.type === 'resumed') return t('transfer.annotation.killSwitchResume');
  return t(`activity.timeline.${a.type}`);
}

function annotationText(a: MetricAnnotation, withTitle: boolean): string {
  const parts = [annotationLabel(a)];
  if (withTitle && a.title) parts.push(a.title);
  if (a.message && a.source === 'vpn') parts.push(a.message);
  return parts.join(' · ');
}

export interface SpeedChartProps {
  /** Accessible name of the chart ("Engine speed"). */
  title: string;
  range: MetricsRange;
  from: string;
  to: string;
  stepMs: number;
  points: readonly RatePoint[];
  annotations: readonly MetricAnnotation[];
  /** Legend label of `aux` (e.g. "Peers"); no secondary line when absent. */
  auxLabel?: string | undefined;
  /** Name each annotation's download in its text (engine-wide charts). */
  annotationTitles?: boolean | undefined;
}

/** Download/upload speed with an optional secondary line on its own axis and event markers. */
export function SpeedChart({ title, range, from, to, stepMs, points, annotations, auxLabel, annotationTitles = false }: SpeedChartProps) {
  const [ref, W] = useWidth();
  const [showTable, setShowTable] = useState(false);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const PW = W - M.left - M.right;
  const PH = H - M.top - M.bottom;
  const summary = summarizeRates(points);
  const hasAux = auxLabel !== undefined && points.some((p) => p.aux !== undefined);
  const maxRate = niceCeil(Math.max(summary?.peakDown ?? 0, summary?.peakUp ?? 0), 1024);
  const maxAux = niceCeil(summary?.peakAux ?? 0, 5);
  // Each point sits mid-step; the minute in progress is clamped to the right edge.
  const x = (p: { time: string }) => Math.min(PW, Math.max(0, ((Date.parse(p.time) + stepMs / 2 - fromMs) / Math.max(1, toMs - fromMs)) * PW));
  const yRate = (v: number) => PH - (Math.min(v, maxRate) / maxRate) * PH;
  const yAux = (v: number) => PH - (Math.min(v, maxAux) / maxAux) * PH;
  const down = gapPath(points, (p) => p.down, x, yRate, stepMs);
  const up = gapPath(points, (p) => p.up, x, yRate, stepMs);
  const aux = hasAux ? gapPath(points, (p) => p.aux ?? 0, x, yAux, stepMs) : '';
  const clusters = clusterAnnotations(annotations, fromMs, toMs, PW);
  const locale = intlLocale();

  const summaryText = summary
    ? [
        t('transfer.chart.summary', { down: formatRate(summary.avgDown), up: formatRate(summary.avgUp), peakDown: formatRate(summary.peakDown), peakUp: formatRate(summary.peakUp) }),
        hasAux && summary.peakAux !== null ? t('transfer.chart.auxPeak', { label: auxLabel ?? '', value: Math.round(summary.peakAux) }) : null,
        annotations.length ? t('transfer.chart.eventCount', { count: annotations.length }) : null,
      ]
        .filter(Boolean)
        .join(' ')
    : t('transfer.chart.noData');

  const rows = [...points].reverse();
  const columns: Column<RatePoint>[] = [
    { key: 'time', header: t('transfer.chart.time'), mono: true, cell: (p) => <time dateTime={p.time}>{formatDateTime(p.time)}</time> },
    { key: 'down', header: t('transfer.legend.download'), mono: true, align: 'right', cell: (p) => formatRate(p.down) },
    { key: 'up', header: t('transfer.legend.upload'), mono: true, align: 'right', cell: (p) => formatRate(p.up) },
    ...(hasAux ? [{ key: 'aux', header: auxLabel ?? '', mono: true, align: 'right' as const, cell: (p: RatePoint) => (p.aux === undefined ? '—' : String(Math.round(p.aux))) }] : []),
  ];

  return (
    <figure className="al-transfer-chart" ref={ref}>
      {points.length === 0 && annotations.length === 0 ? (
        <EmptyState title={t('transfer.chart.noData')} />
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="al-transfer-chart__svg" role="img" aria-label={`${title}. ${summaryText}`}>
          <g aria-hidden="true">
            {[0, 0.5, 1].map((f) => {
              const y = M.top + PH - f * PH;
              return (
                <g key={f}>
                  <line x1={M.left} x2={M.left + PW} y1={y} y2={y} stroke={AXIS} strokeWidth={1} strokeOpacity={f === 0 ? 1 : 0.4} />
                  <text x={M.left - 6} y={y + 4} textAnchor="end" fontSize={11} fontFamily={FONT} fill={LABEL}>
                    {formatRate(maxRate * f)}
                  </text>
                  {hasAux ? (
                    <text x={M.left + PW + 6} y={y + 4} fontSize={11} fontFamily={FONT} fill={LABEL}>
                      {Math.round(maxAux * f)}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {[fromMs, (fromMs + toMs) / 2, toMs].map((ms, i) => (
              <text key={i} x={M.left + (i / 2) * PW} y={H - 6} textAnchor={i === 0 ? 'start' : i === 1 ? 'middle' : 'end'} fontSize={11} fontFamily={FONT} fill={LABEL}>
                {formatAxisTime(ms, range, locale)}
              </text>
            ))}
          </g>
          <g transform={`translate(${M.left} ${M.top})`}>
            {down ? <path d={down} fill="none" stroke={DOWN} strokeWidth={1} vectorEffect="non-scaling-stroke" data-series="down" /> : null}
            {up ? <path d={up} fill="none" stroke={UP} strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" data-series="up" /> : null}
            {aux ? <path d={aux} fill="none" stroke={AUX} strokeWidth={1} strokeDasharray="1 3" vectorEffect="non-scaling-stroke" data-series="aux" /> : null}
            {clusters.map((c) => (
              <g key={`${c.time}-${c.x}`} data-marker={c.severity}>
                <title>{c.items.map((a) => `${formatDateTime(a.time)} · ${annotationText(a, annotationTitles)}`).join('\n')}</title>
                <line x1={c.x} x2={c.x} y1={0} y2={PH} stroke={MARKER[c.severity]} strokeWidth={1} strokeOpacity={0.7} vectorEffect="non-scaling-stroke" />
                <rect x={c.x - 4} y={-6} width={8} height={8} fill={MARKER[c.severity]} />
                {/* Wider invisible hit area for the hover title. */}
                <rect x={c.x - 6} y={-8} width={12} height={PH + 8} fill="transparent" />
              </g>
            ))}
          </g>
        </svg>
      )}
      <figcaption className="al-transfer-chart__caption">
        <span className="al-transfer-chart__legend" aria-hidden="true">
          <Key dash={undefined} color={DOWN} label={t('transfer.legend.download')} />
          <Key dash="4 3" color={UP} label={t('transfer.legend.upload')} />
          {hasAux ? <Key dash="1 3" color={AUX} label={auxLabel ?? ''} /> : null}
          {annotations.length ? (
            <span className="al-transfer-key">
              <svg width="10" height="10" aria-hidden="true">
                <rect x="1" y="1" width="8" height="8" fill="var(--al-warn)" />
              </svg>
              {t('transfer.legend.events')}
            </span>
          ) : null}
        </span>
        <span className="al-transfer-chart__summary">{summaryText}</span>
      </figcaption>
      {points.length > 0 || annotations.length > 0 ? (
        <details className="al-transfer-chart__data" onToggle={(e) => setShowTable(e.currentTarget.open)}>
          <summary>{t('transfer.chart.dataTable')}</summary>
          {showTable ? (
            <div className="al-transfer-chart__tables">
              {annotations.length ? <AnnotationList annotations={annotations} titles={annotationTitles} /> : null}
              {rows.length ? <Table caption={title} columns={columns} rows={rows} rowKey={(p) => p.time} sortable={false} /> : null}
            </div>
          ) : null}
        </details>
      ) : null}
    </figure>
  );
}

function Key({ color, dash, label }: { color: string; dash: string | undefined; label: string }) {
  return (
    <span className="al-transfer-key">
      <svg width="20" height="8" aria-hidden="true">
        <line x1="0" x2="20" y1="4" y2="4" stroke={color} strokeWidth={1} strokeDasharray={dash} />
      </svg>
      {label}
    </span>
  );
}

/** Events newest first, as a list with times (the markers' text alternative). */
export function AnnotationList({ annotations, titles = false, label = t('transfer.chart.eventsTable') }: { annotations: readonly MetricAnnotation[]; titles?: boolean; label?: string }) {
  return (
    <ul className="al-transfer-events" aria-label={label}>
      {[...annotations].reverse().map((a, i) => (
        <li key={`${a.time}-${i}`} data-severity={a.severity}>
          <time dateTime={a.time}>{formatDateTime(a.time)}</time> <span>{annotationText(a, titles)}</span>
        </li>
      ))}
    </ul>
  );
}

const STATE_COLOR: Readonly<Record<VpnState, string>> = { up: 'var(--al-cyan)', warning: 'var(--al-warn)', down: 'var(--al-danger)' };

const fmtSpan = (ms: number) => formatUptime(Math.round(ms / 1000));

/**
 * VPN connection strip: connected / warning / down per step across the window, blank where
 * nothing was sampled (VPN disabled or Arclight not running), with uptime in words.
 */
export function VpnUptimeStrip({ data }: { data: VpnMetrics }) {
  const fromMs = Date.parse(data.from);
  const toMs = Date.parse(data.to);
  const span = Math.max(1, toMs - fromMs);
  const segments = vpnSegments(data.points, data.stepMs);
  const totals = vpnTotals(segments);
  const locale = intlLocale();
  const uptime = data.uptime === null ? null : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(data.uptime);
  const label = t('transfer.vpn.stripLabel', {
    range: t(`transfer.rangeLong.${data.range}`),
    up: fmtSpan(totals.up),
    warning: fmtSpan(totals.warning),
    down: fmtSpan(totals.down),
  });
  return (
    <div className="al-vpn-strip">
      {uptime !== null ? <p className="al-vpn-strip__uptime al-num">{t('transfer.vpn.uptime', { percent: uptime })}</p> : null}
      <div className="al-vpn-strip__bar" role="img" aria-label={label}>
        {segments.map((s) => (
          <span
            key={s.startMs}
            className="al-vpn-strip__seg"
            data-state={s.state}
            title={`${formatDateTime(new Date(s.startMs).toISOString())} – ${formatDateTime(new Date(Math.min(s.endMs, toMs)).toISOString())}: ${t(`transfer.vpn.legend.${s.state}`)}`}
            style={{
              left: `${Math.max(0, ((s.startMs - fromMs) / span) * 100)}%`,
              width: `${Math.max(0.3, ((Math.min(s.endMs, toMs) - Math.max(s.startMs, fromMs)) / span) * 100)}%`,
              background: STATE_COLOR[s.state],
            }}
          />
        ))}
      </div>
      <div className="al-vpn-strip__axis" aria-hidden="true">
        <span>{formatAxisTime(fromMs, data.range, locale)}</span>
        <span>{formatAxisTime(toMs, data.range, locale)}</span>
      </div>
      <p className="al-transfer-chart__legend" aria-hidden="true">
        {(['up', 'warning', 'down'] as const).map((s) => (
          <span key={s} className="al-transfer-key">
            <svg width="10" height="10" aria-hidden="true">
              <rect x="0" y="0" width="10" height="10" fill={STATE_COLOR[s]} />
            </svg>
            {t(`transfer.vpn.legend.${s}`)}
          </span>
        ))}
        <span className="al-transfer-key">
          <svg width="10" height="10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="var(--al-line-3)" />
          </svg>
          {t('transfer.vpn.legend.noData')}
        </span>
      </p>
    </div>
  );
}

/** A titled block with an empty line when the list has nothing. */
export function EventSection({ title, annotations, children }: { title: string; annotations: readonly MetricAnnotation[]; children?: ReactNode }) {
  return (
    <section className="al-transfer-section" aria-label={title}>
      <h3 className="al-transfer-section__title">{title}</h3>
      {children}
      {annotations.length ? <AnnotationList annotations={annotations} label={title} /> : <p className="al-transfer-muted">{t('transfer.vpn.none')}</p>}
    </section>
  );
}
