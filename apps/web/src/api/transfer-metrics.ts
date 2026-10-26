import { DownloadMetrics, EngineMetrics, VpnMetrics, type MetricsRange } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/transfer-metrics/routes.ts (contract: packages/shared/src/transfer-metrics.ts).

export const transferMetricsApi = {
  download: (queueId: number, range: MetricsRange) => request(`/metrics/downloads/${queueId}`, DownloadMetrics, { query: { range } }),
  engine: (range: MetricsRange) => request('/metrics/engine', EngineMetrics, { query: { range } }),
  vpn: (range: MetricsRange) => request('/metrics/vpn', VpnMetrics, { query: { range } }),
};
