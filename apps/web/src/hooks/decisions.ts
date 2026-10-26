import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { decisionsApi, type DecisionPageQuery, type DecisionScope } from '../api/decisions.js';

// Decision log. The first key segment is 'history' so live.ts's release/history invalidations
// (a new grab writes a batch) refresh these lists too.
export const decisionKeys = {
  all: ['history', 'decisions'] as const,
  list: (scope: DecisionScope, paging: DecisionPageQuery) => ['history', 'decisions', 'list', scope, paging] as const,
  batch: (batchId: string) => ['history', 'decisions', 'batch', batchId] as const,
};

export function useDecisionLog(scope: DecisionScope, paging: DecisionPageQuery, enabled = true) {
  return useQuery({
    queryKey: decisionKeys.list(scope, paging),
    queryFn: () => decisionsApi.list(scope, paging),
    placeholderData: keepPreviousData,
    enabled,
    retry: false,
  });
}

export function useDecisionBatch(batchId: string | null) {
  return useQuery({
    queryKey: decisionKeys.batch(batchId ?? ''),
    queryFn: () => decisionsApi.batch(batchId ?? ''),
    enabled: batchId !== null && batchId !== '',
    retry: false,
  });
}
