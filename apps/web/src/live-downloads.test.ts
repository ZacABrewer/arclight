import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { applyServerEvent } from './live.js';
import { activityKeys } from './hooks/settings-keys.js';
import { torrentKeys } from './hooks/torrent.js';

function seeded() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const k of [activityKeys.queue({ page: 1 }), activityKeys.queueTimeline(4), torrentKeys.status, ['history', 'list', {}]]) qc.setQueryData(k, { seeded: true });
  return qc;
}

const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated ?? false;

describe('live layer: download timeline and engine lockdown events', () => {
  it('a timeline entry refreshes the queue and its timelines', () => {
    const qc = seeded();
    applyServerEvent(qc, {
      type: 'download',
      action: 'event',
      event: { id: 1, trackedDownloadId: 4, downloadId: 'abc', title: 'x', type: 'stalled', severity: 'warning', time: '2026-10-26T10:00:00Z' },
    });
    expect(stale(qc, activityKeys.queue({ page: 1 }))).toBe(true);
    expect(stale(qc, activityKeys.queueTimeline(4))).toBe(true);
    expect(stale(qc, torrentKeys.status)).toBe(false);
    expect(stale(qc, ['history', 'list', {}])).toBe(false);
  });

  it('a lockdown refreshes the engine status (banner) and the queue', () => {
    const qc = seeded();
    applyServerEvent(qc, { type: 'torrent', action: 'lockdown', reason: 'VPN kill switch engaged.', infoHashes: ['abc'] });
    expect(stale(qc, torrentKeys.status)).toBe(true);
    expect(stale(qc, activityKeys.queue({ page: 1 }))).toBe(true);
  });
});
