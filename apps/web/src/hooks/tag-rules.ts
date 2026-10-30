import { useQuery } from '@tanstack/react-query';
import type { TagEntityType, TagRuleInputRaw } from '@arclight/shared';
import { tagRulesApi } from '../api/tag-rules.js';
import { libraryKeys } from './library-keys.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

export const tagRuleKeys = {
  all: ['tagrules'] as const,
  rules: ['tagrules', 'rules'] as const,
  usage: ['tagrules', 'usage'] as const,
  options: ['tagrules', 'options'] as const,
  applied: (entityType: TagEntityType, entityId: number) => ['tagrules', 'applied', entityType, entityId] as const,
};

/** Everything that shows tags: the tag list, usage, rule ownership and the library rows. */
const TAG_CHANGES = [tagRuleKeys.all, libraryKeys.library.tags, libraryKeys.series.all, libraryKeys.movie.all, ['music'], ['audiobook']] as const;

export function useTagRules() {
  return useQuery({ queryKey: tagRuleKeys.rules, queryFn: tagRulesApi.rules.list, retry: false });
}

export function useTagUsage() {
  return useQuery({ queryKey: tagRuleKeys.usage, queryFn: tagRulesApi.tags.usage, retry: false });
}

export function useTagRuleOptions() {
  return useQuery({ queryKey: tagRuleKeys.options, queryFn: tagRulesApi.options, staleTime: 60_000, retry: false });
}

/** Which tags of an item a rule added (detail pages). Fails quietly for users without access. */
export function useTagApplications(entityType: TagEntityType, entityId: number | undefined) {
  return useQuery({
    queryKey: tagRuleKeys.applied(entityType, entityId ?? 0),
    queryFn: () => tagRulesApi.applied(entityType, entityId ?? 0),
    enabled: entityId !== undefined && entityId > 0,
    retry: false,
  });
}

/** Create (no id) or replace a rule. Errors render inline in the editor. */
export function useSaveTagRule() {
  return useInvalidatingMutation(
    ({ id, body }: { id: number | null; body: TagRuleInputRaw }) => (id === null ? tagRulesApi.rules.create(body) : tagRulesApi.rules.update(id, body)),
    [tagRuleKeys.all],
    { silent: true },
  );
}

export function useDeleteTagRule() {
  return useInvalidatingMutation(
    ({ id, removeTags }: { id: number; removeTags: boolean }) => tagRulesApi.rules.remove(id, removeTags),
    TAG_CHANGES,
    { silent: true },
  );
}

export function useOrderTagRules() {
  return useInvalidatingMutation((ids: readonly number[]) => tagRulesApi.rules.order(ids), [tagRuleKeys.rules], {
    errorTitle: t('settings.tags.couldNotReorder'),
  });
}

export function useToggleTagRule() {
  return useInvalidatingMutation(({ id, body }: { id: number; body: TagRuleInputRaw }) => tagRulesApi.rules.update(id, body), [tagRuleKeys.rules], {
    errorTitle: t('settings.tags.couldNotSaveRule'),
  });
}

/** Dry runs change nothing, so they refetch nothing; real runs refresh every tag view. */
export function useRunTagRules() {
  return useInvalidatingMutation((body: { ruleIds?: number[]; dryRun: boolean }) => tagRulesApi.run(body), TAG_CHANGES, { silent: true });
}

export function useRenameTag() {
  return useInvalidatingMutation(({ id, label }: { id: number; label: string }) => tagRulesApi.tags.rename(id, label), TAG_CHANGES, { silent: true });
}

export function useDeleteTag() {
  return useInvalidatingMutation((id: number) => tagRulesApi.tags.remove(id), TAG_CHANGES, { silent: true });
}

export function useMergeTag() {
  return useInvalidatingMutation(({ id, intoId }: { id: number; intoId: number }) => tagRulesApi.tags.merge(id, intoId), TAG_CHANGES, { silent: true });
}

export function useBulkDeleteTags() {
  return useInvalidatingMutation(({ ids, force }: { ids: readonly number[]; force: boolean }) => tagRulesApi.tags.bulkDelete(ids, force), TAG_CHANGES, {
    silent: true,
  });
}
