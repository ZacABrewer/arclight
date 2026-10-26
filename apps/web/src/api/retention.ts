import { RetentionCandidate, RetentionRule, RetentionSweepResult, type RetentionCandidateQuery, type RetentionRuleInputRaw } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/retention/routes.ts (docs/API.md § retention).

export const retentionApi = {
  rules: {
    list: () => request('/retentionrule', RetentionRule.array()),
    get: (id: number) => request(`/retentionrule/${id}`, RetentionRule),
    create: (body: RetentionRuleInputRaw) => request('/retentionrule', RetentionRule, { method: 'POST', json: body }),
    update: (id: number, body: RetentionRuleInputRaw) => request(`/retentionrule/${id}`, RetentionRule, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/retentionrule/${id}`, null, { method: 'DELETE' }),
  },
  candidates: {
    list: (query: Partial<RetentionCandidateQuery> = {}) => request('/retention/candidates', RetentionCandidate.array(), { query }),
    apply: (id: number) => request(`/retention/candidate/${id}/apply`, RetentionCandidate, { method: 'POST' }),
    keep: (id: number) => request(`/retention/candidate/${id}/keep`, RetentionCandidate, { method: 'POST' }),
    remove: (id: number) => request(`/retention/candidate/${id}`, null, { method: 'DELETE' }),
  },
  sweep: (dryRun: boolean) => request('/retention/sweep', RetentionSweepResult, { method: 'POST', json: { dryRun } }),
};
