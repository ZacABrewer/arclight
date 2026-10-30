import {
  Tag,
  TagApplication,
  TagBulkDeleteResult,
  TagRule,
  TagRuleOptions,
  TagRuleRunResult,
  TagUsage,
  type TagEntityType,
  type TagRuleInputRaw,
} from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/tag-rules/routes.ts (docs/API.md § tag-rules).

export const tagRulesApi = {
  rules: {
    list: () => request('/tagrule', TagRule.array()),
    create: (body: TagRuleInputRaw) => request('/tagrule', TagRule, { method: 'POST', json: body }),
    update: (id: number, body: TagRuleInputRaw) => request(`/tagrule/${id}`, TagRule, { method: 'PUT', json: body }),
    remove: (id: number, removeTags: boolean) => request(`/tagrule/${id}`, null, { method: 'DELETE', query: { removeTags } }),
    order: (ids: readonly number[]) => request('/tagrule/order', TagRule.array(), { method: 'PUT', json: { ids } }),
  },
  preview: (rule: TagRuleInputRaw, id?: number) =>
    request('/tagrule/preview', TagRuleRunResult, { method: 'POST', json: id === undefined ? { rule } : { rule, id } }),
  run: (body: { ruleIds?: number[]; dryRun: boolean }) => request('/tagrule/run', TagRuleRunResult, { method: 'POST', json: body }),
  options: () => request('/tagrule/options', TagRuleOptions),
  applied: (entityType: TagEntityType, entityId: number) =>
    request('/tagrule/applied', TagApplication.array(), { query: { entityType, entityId } }),
  tags: {
    usage: () => request('/tag/usage', TagUsage.array()),
    rename: (id: number, label: string) => request(`/tag/${id}`, Tag, { method: 'PUT', json: { label } }),
    remove: (id: number) => request(`/tag/${id}`, null, { method: 'DELETE' }),
    merge: (id: number, intoId: number) => request(`/tag/${id}/merge`, Tag, { method: 'POST', json: { intoId } }),
    bulkDelete: (ids: readonly number[], force: boolean) => request('/tag/delete', TagBulkDeleteResult, { method: 'POST', json: { ids, force } }),
  },
};
