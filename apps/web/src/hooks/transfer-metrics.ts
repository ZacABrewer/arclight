import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { MetricsRange } from '@arclight/shared';
import { transferMetricsApi } from '../api/transfer-metrics.js';

// Transfer history. The server writes one point per minute, so the last hour refetches every
// 30 s (it includes the minute in progress) and longer ranges every 2 minutes.
export const transferMetricsKeys = {
  all: ['transfer-metrics'] as const,
  download: (id: number, range: MetricsRange) => ['transfer-metrics', 'download', id, range] as const,
  engine: (range: MetricsRange) => ['transfer-metrics', 'engine', range] as const,
  vpn: (range: MetricsRange) => ['transfer-metrics', 'vpn', range] as const,
};

export const metricsPollMs = (range: MetricsRange) => (range === '1h' ? 30_000 : 120_000);

export function useDownloadMetrics(id: number, range: MetricsRange, enabled = true) {
  return useQuery({
    queryKey: transferMetricsKeys.download(id, range),
    queryFn: () => transferMetricsApi.download(id, range),
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: metricsPollMs(range),
  });
}

export function useEngineMetrics(range: MetricsRange, enabled = true) {
  return useQuery({
    queryKey: transferMetricsKeys.engine(range),
    queryFn: () => transferMetricsApi.engine(range),
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: metricsPollMs(range),
  });
}

export function useVpnMetrics(range: MetricsRange, enabled = true) {
  return useQuery({
    queryKey: transferMetricsKeys.vpn(range),
    queryFn: () => transferMetricsApi.vpn(range),
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: metricsPollMs(range),
  });
}
