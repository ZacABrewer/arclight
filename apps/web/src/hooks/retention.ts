import { useQuery } from '@tanstack/react-query';
import type { RetentionCandidate, RetentionRuleInputRaw } from '@arclight/shared';
import { retentionApi } from '../api/retention.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

export const retentionKeys = {
  all: ['retention'] as const,
  rules: ['retention', 'rules'] as const,
  candidates: ['retention', 'candidates'] as const,
};

export function useRetentionRules() {
  return useQuery({ queryKey: retentionKeys.rules, queryFn: retentionApi.rules.list, retry: false });
}

export function useRetentionCandidates() {
  return useQuery({ queryKey: retentionKeys.candidates, queryFn: () => retentionApi.candidates.list(), retry: false });
}

/** Create (no id) or replace a rule. Errors render inline in the editor. */
export function useSaveRetentionRule() {
  return useInvalidatingMutation(
    ({ id, body }: { id: number | null; body: RetentionRuleInputRaw }) => (id === null ? retentionApi.rules.create(body) : retentionApi.rules.update(id, body)),
    [retentionKeys.all],
    { silent: true },
  );
}

export function useDeleteRetentionRule() {
  return useInvalidatingMutation((id: number) => retentionApi.rules.remove(id), [retentionKeys.all], { errorTitle: t('hooks.retention.couldNotDeleteTheRule') });
}

export type CandidateAction = 'keep' | 'apply' | 'remove';

export function useCandidateAction() {
  return useInvalidatingMutation(
    async ({ id, action }: { id: number; action: CandidateAction }): Promise<RetentionCandidate | null> => {
      if (action === 'keep') return retentionApi.candidates.keep(id);
      if (action === 'apply') return retentionApi.candidates.apply(id);
      await retentionApi.candidates.remove(id);
      return null;
    },
    [retentionKeys.candidates],
    { errorTitle: t('hooks.retention.retentionActionFailed') },
  );
}

export function useRetentionSweep() {
  return useInvalidatingMutation((dryRun: boolean) => retentionApi.sweep(dryRun), [retentionKeys.candidates], { errorTitle: t('hooks.retention.sweepFailed') });
}
