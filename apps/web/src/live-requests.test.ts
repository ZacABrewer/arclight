import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { applyServerEvent } from './live.js';
import { requestKeys } from './hooks/request-keys.js';

function seeded() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const keys = [
    requestKeys.requests.list({ filter: 'pending' }),
    requestKeys.requests.count,
    requestKeys.requests.detail(7),
    requestKeys.discover.title('movie', 603),
    requestKeys.watchlist.list(undefined),
    requestKeys.issues.list({ filter: 'open' }),
    requestKeys.issues.detail(3),
    requestKeys.sliders,
  ];
  for (const k of keys) qc.setQueryData(k, { seeded: true });
  return qc;
}

const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated ?? false;

describe('live layer: request and issue events', () => {
  it('a request event invalidates request lists, counts, the request, title pages and the watchlist', () => {
    const qc = seeded();
    applyServerEvent(qc, { type: 'request', action: 'approved', id: 7 });
    expect(stale(qc, requestKeys.requests.list({ filter: 'pending' }))).toBe(true);
    expect(stale(qc, requestKeys.requests.count)).toBe(true);
    expect(stale(qc, requestKeys.requests.detail(7))).toBe(true);
    expect(stale(qc, requestKeys.discover.title('movie', 603))).toBe(true);
    expect(stale(qc, requestKeys.watchlist.list(undefined))).toBe(true);
    expect(stale(qc, requestKeys.issues.list({ filter: 'open' }))).toBe(false);
    expect(stale(qc, requestKeys.sliders)).toBe(false);
  });

  it('an issue event invalidates issue queries (and title pages for the open count) only', () => {
    const qc = seeded();
    applyServerEvent(qc, { type: 'issue', action: 'updated', id: 3 });
    expect(stale(qc, requestKeys.issues.list({ filter: 'open' }))).toBe(true);
    expect(stale(qc, requestKeys.issues.detail(3))).toBe(true);
    expect(stale(qc, requestKeys.discover.title('movie', 603))).toBe(true);
    expect(stale(qc, requestKeys.requests.count)).toBe(false);
    expect(stale(qc, requestKeys.watchlist.list(undefined))).toBe(false);
  });
});
