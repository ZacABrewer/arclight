import { useState } from 'react';
import type { DownloadMetrics, EngineMetrics, MetricsRange, TorrentSessionStatus } from '@arclight/shared';
import { AccordionItem, ErrorBlock, SectionLabel, Skeleton } from '../../arclight/index.js';
import { ApiError, errorMessage } from '../../api/client.js';
import { RangePicker, SpeedChart } from '../../components/transfer-charts/transfer-charts.js';
import type { RatePoint } from '../../components/transfer-charts/chart-model.js';
import { useDownloadMetrics, useEngineMetrics } from '../../hooks/transfer-metrics.js';
import { formatRate } from '../../lib/format.js';
import { t } from '../../i18n/index.js';

// Transfer history on the Activity page: the speed chart in an expanded queue row, and the
// engine-wide "Transfer" section above the queue.

export const downloadRatePoints = (m: DownloadMetrics): RatePoint[] =>
  m.points.map((p) => ({ time: p.time, down: p.downloadRate, up: p.uploadRate, aux: p.peers }));

export const engineRatePoints = (m: EngineMetrics): RatePoint[] =>
  m.points.map((p) => ({ time: p.time, down: p.downloadRate, up: p.uploadRate, aux: p.peers }));

/** Speed history of one download with its timeline events as markers. */
export function DownloadTransferHistory({ id, title }: { id: number; title: string }) {
  const [range, setRange] = useState<MetricsRange>('1h');
  const metrics = useDownloadMetrics(id, range);
  return (
    <div className="al-activity-stack-xs">
      <div className="al-transfer-head">
        <SectionLabel>{t('transfer.downloadHistory')}</SectionLabel>
        <RangePicker value={range} onChange={setRange} />
      </div>
      {metrics.isPending ? (
        <Skeleton lines={3} />
      ) : metrics.isError ? (
        // A queue item from before history was recorded has nothing yet: say so instead of failing.
        metrics.error instanceof ApiError && metrics.error.status === 404 ? (
          <p className="al-transfer-muted">{t('transfer.chart.noData')}</p>
        ) : (
          <ErrorBlock title={t('transfer.chart.couldntLoad')} onRetry={() => void metrics.refetch()}>
            {errorMessage(metrics.error)}
          </ErrorBlock>
        )
      ) : (
        <SpeedChart
          title={t('transfer.download.chartTitle', { title })}
          range={metrics.data.range}
          from={metrics.data.from}
          to={metrics.data.to}
          stepMs={metrics.data.stepMs}
          points={downloadRatePoints(metrics.data)}
          annotations={metrics.data.annotations}
          auxLabel={t('transfer.legend.peers')}
        />
      )}
    </div>
  );
}

const OPEN_KEY = 'arclight.activity.transferOpen';

function readOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function EngineChart() {
  const [range, setRange] = useState<MetricsRange>('1h');
  const metrics = useEngineMetrics(range);
  return (
    <div className="al-activity-stack-xs">
      <div className="al-transfer-head">
        <span className="al-transfer-muted">{t('transfer.engine.caption')}</span>
        <RangePicker value={range} onChange={setRange} ranges={['1h', '24h', '7d']} />
      </div>
      {metrics.isPending ? (
        <Skeleton lines={3} />
      ) : metrics.isError ? (
        <ErrorBlock title={t('transfer.chart.couldntLoad')} onRetry={() => void metrics.refetch()}>
          {errorMessage(metrics.error)}
        </ErrorBlock>
      ) : (
        <SpeedChart
          title={t('transfer.engine.chartTitle')}
          range={metrics.data.range}
          from={metrics.data.from}
          to={metrics.data.to}
          stepMs={metrics.data.stepMs}
          points={engineRatePoints(metrics.data)}
          annotations={metrics.data.annotations}
          auxLabel={t('transfer.legend.peers')}
          annotationTitles
        />
      )}
    </div>
  );
}

/**
 * Collapsible engine-wide speed chart above the queue (built-in engine only). Collapsed by
 * default; the choice is remembered on this device. Nothing is fetched while collapsed.
 */
export function EngineTransferSection({ engine }: { engine: TorrentSessionStatus | undefined }) {
  const [open, setOpen] = useState(readOpen);
  if (!engine?.enabled) return null;
  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      globalThis.localStorage?.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // Storage blocked (private window): the section just forgets.
    }
  };
  return (
    <div className="al-transfer-section-slot">
      <AccordionItem
        title={t('transfer.engine.title')}
        meta={<span className="al-num">{t('transfer.engine.meta', { down: formatRate(engine.downloadRate), up: formatRate(engine.uploadRate) })}</span>}
        open={open}
        onOpenChange={toggle}
      >
        <EngineChart />
      </AccordionItem>
    </div>
  );
}
