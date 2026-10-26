import { useState } from 'react';
import type { MetricsRange } from '@arclight/shared';
import { ErrorBlock, Pane, Skeleton } from '../../arclight/index.js';
import { errorMessage } from '../../api/client.js';
import { EventSection, RangePicker, VpnUptimeStrip } from '../../components/transfer-charts/transfer-charts.js';
import { useVpnMetrics } from '../../hooks/transfer-metrics.js';
import { t } from '../../i18n/index.js';

// Settings → VPN, under the live status: connection history (connected / warning / down over
// time), kill-switch changes and forwarded-port changes from GET /metrics/vpn.

export function VpnHistoryPane() {
  const [range, setRange] = useState<MetricsRange>('24h');
  const metrics = useVpnMetrics(range);
  const data = metrics.data;
  const killSwitch = data?.annotations.filter((a) => a.type === 'killSwitchEngaged' || a.type === 'killSwitchReleased') ?? [];
  const ports = data?.annotations.filter((a) => a.type === 'portChanged') ?? [];
  const drops = data?.annotations.filter((a) => a.type === 'disconnected' || a.type === 'connected' || a.type === 'warning' || a.type === 'warningCleared') ?? [];
  return (
    <Pane title={t('transfer.vpn.title')} aria-label={t('transfer.vpn.title')} className="al-vpn-history">
      <div className="al-vpn-history__body">
        <RangePicker value={range} onChange={setRange} />
        {metrics.isPending ? (
          <Skeleton lines={3} />
        ) : metrics.isError ? (
          <ErrorBlock title={t('transfer.chart.couldntLoad')} onRetry={() => void metrics.refetch()}>
            {errorMessage(metrics.error)}
          </ErrorBlock>
        ) : data && data.points.length === 0 && data.annotations.length === 0 ? (
          <p className="al-transfer-muted">{t('transfer.vpn.noData')}</p>
        ) : data ? (
          <>
            <VpnUptimeStrip data={data} />
            <EventSection title={t('transfer.vpn.connectionEvents')} annotations={drops} />
            <EventSection title={t('transfer.vpn.killSwitchEvents')} annotations={killSwitch} />
            <EventSection title={t('transfer.vpn.portChanges')} annotations={ports} />
          </>
        ) : null}
      </div>
    </Pane>
  );
}
