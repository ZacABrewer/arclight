import {
  BEHAVIOUR_TAG_KINDS,
  TAG_ENTITY_TYPES,
  TAG_RULE_FIELDS,
  TAG_RULE_FIELD_NAMES,
  TAG_TEMPLATE_VARIABLES,
  TAG_TEMPLATE_VARIABLE_NAMES,
  TagUsageKind,
  sanitizeTagLabel,
  templateVariables,
  type Tag,
  type TagEntityType,
  type TagRule,
  type TagRuleCondition,
  type TagRuleField,
  type TagRuleInput,
  type TagRuleSetOp,
  type TagTemplateVariable,
  type TagUsage,
} from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Pure helpers for Settings → Tags: labels, the condition builder's field lists and defaults,
// template examples and "Show items" links.

export const USAGE_KINDS = TagUsageKind.options;

export function entityLabel(e: TagEntityType): string {
  return t(`settings.tags.entity.${e}`);
}

export function usageKindLabel(kind: string): string {
  return (USAGE_KINDS as readonly string[]).includes(kind) ? t(`settings.tags.kind.${kind}`) : kind;
}

export function fieldLabel(field: TagRuleField): string {
  return t(`settings.tags.field.${field}`);
}

export function opLabel(op: TagRuleSetOp): string {
  return t(`settings.tags.op.${op}`);
}

/** Unit shown after range inputs. */
export function rangeUnit(field: TagRuleField): string | undefined {
  if (field === 'sizeGb') return 'GB';
  if (field === 'addedDays') return t('settings.tags.unitDays');
  if (field === 'runtime') return t('settings.tags.unitMinutes');
  return undefined;
}

/** Fields that have values for at least one of the selected item types, in catalogue order. */
export function fieldsFor(appliesTo: readonly TagEntityType[]): TagRuleField[] {
  return TAG_RULE_FIELD_NAMES.filter((f) => TAG_RULE_FIELDS[f].entities.some((e) => appliesTo.includes(e)));
}

/** Template variables that have values for at least one of the selected item types. */
export function templateVariablesFor(appliesTo: readonly TagEntityType[]): TagTemplateVariable[] {
  return TAG_TEMPLATE_VARIABLE_NAMES.filter((v) => (TAG_TEMPLATE_VARIABLES[v].entities as readonly TagEntityType[]).some((e) => appliesTo.includes(e)));
}

/** A fresh condition of a field's kind. */
export function defaultCondition(field: TagRuleField): TagRuleCondition {
  const kind = TAG_RULE_FIELDS[field].kind;
  if (kind === 'set') return { kind: 'set', field, op: 'any', values: [] } as TagRuleCondition;
  if (kind === 'ids') return { kind: 'ids', field, op: 'any', ids: [] } as TagRuleCondition;
  if (kind === 'bool') return { kind: 'bool', field, value: true } as TagRuleCondition;
  return { kind: 'range', field, min: null, max: null } as TagRuleCondition;
}

export function emptyRule(): TagRuleInput {
  return {
    name: '',
    enabled: true,
    appliesTo: ['movie', 'series'],
    match: 'all',
    conditions: [],
    addTags: [''],
    removeTagIds: [],
    removeWhenUnmatched: true,
  };
}

export function ruleToInput(r: TagRule): TagRuleInput {
  return {
    name: r.name,
    enabled: r.enabled,
    appliesTo: [...r.appliesTo],
    match: r.match,
    conditions: r.conditions.map((c) => ({ ...c }) as TagRuleCondition),
    addTags: r.addTags.length ? [...r.addTags] : [],
    removeTagIds: [...r.removeTagIds],
    removeWhenUnmatched: r.removeWhenUnmatched,
  };
}

/** What gets sent: empty add-tag rows dropped. */
export function normaliseRule(r: TagRuleInput): TagRuleInput {
  return { ...r, name: r.name.trim(), addTags: r.addTags.map((s) => s.trim()).filter(Boolean) };
}

/** Example of the label a template makes, with sample values in place of each variable. */
const SAMPLES: Partial<Record<TagTemplateVariable, string>> = {
  genre: 'Science Fiction',
  resolution: '2160p',
  quality: 'Bluray-1080p',
  source: 'bluray',
  hdr: 'dv',
  codec: 'hevc',
  audiocodec: 'eac3',
  language: 'eng',
  originallanguage: 'ja',
  certification: 'PG-13',
  network: 'HBO',
  studio: 'A24',
  status: 'ended',
  seriestype: 'anime',
  rootfolder: 'tv',
  collection: 'Alien Collection',
  releasegroup: 'GROUP',
  albumtype: 'album',
  artisttype: 'group',
  author: 'Jane Doe',
  narrator: 'Sam Reader',
  bookseries: 'The Long Road',
  requester: 'alex',
  qualityprofile: 'HD-1080p',
  year: '1994',
  decade: '1990s',
  channels: '5.1',
};

export function templateExample(template: string): string {
  const filled = template.replace(/\{([^{}]*)\}/g, (_, name: string) => SAMPLES[name.trim().toLowerCase() as TagTemplateVariable] ?? name);
  return sanitizeTagLabel(filled);
}

export function isTemplate(label: string): boolean {
  return templateVariables(label).length > 0;
}

/** Short text for a condition chip in the rules list. */
export function conditionSummary(c: TagRuleCondition, tags: readonly Tag[] | undefined, names: { users: Map<number, string>; profiles: Map<number, string> }): string {
  const f = fieldLabel(c.field);
  if (c.kind === 'bool') return `${f}: ${c.value ? t('common.yes') : t('common.no')}`;
  if (c.kind === 'range') {
    const unit = rangeUnit(c.field) ?? '';
    if (c.min !== null && c.max !== null) return `${f} ${c.min}–${c.max}${unit ? ` ${unit}` : ''}`;
    if (c.min !== null) return `${f} ≥ ${c.min}${unit ? ` ${unit}` : ''}`;
    return `${f} ≤ ${c.max ?? ''}${unit ? ` ${unit}` : ''}`;
  }
  if (c.op === 'present' || c.op === 'absent') return `${f} ${opLabel(c.op)}`;
  const values =
    c.kind === 'set'
      ? c.values
      : c.ids.map((id) =>
          c.field === 'tag' ? (tags?.find((x) => x.id === id)?.label ?? `#${id}`) : c.field === 'requestedBy' ? (names.users.get(id) ?? `#${id}`) : (names.profiles.get(id) ?? `#${id}`),
        );
  const shown = values.length > 3 ? `${values.slice(0, 3).join(', ')} +${values.length - 3}` : values.join(', ');
  return `${f} ${opLabel(c.op)} ${shown}`;
}

/** Library list pages that can filter by a tag, for the kinds that use it. */
export function showItemsLinks(u: TagUsage): Array<{ to: '/library/movies' | '/library/tv'; label: string }> {
  const out: Array<{ to: '/library/movies' | '/library/tv'; label: string }> = [];
  if ((u.counts['movie'] ?? 0) > 0) out.push({ to: '/library/movies', label: t('settings.tags.showMovies') });
  if ((u.counts['series'] ?? 0) > 0) out.push({ to: '/library/tv', label: t('settings.tags.showSeries') });
  return out;
}

/** "3 movies, 1 indexer" for the delete warning; behaviour kinds first. */
export function usageLines(u: TagUsage): Array<{ kind: string; count: number; behaviour: boolean }> {
  return USAGE_KINDS.filter((k) => (u.counts[k] ?? 0) > 0)
    .map((k) => ({ kind: k, count: u.counts[k] ?? 0, behaviour: BEHAVIOUR_TAG_KINDS.has(k) }))
    .sort((a, b) => Number(b.behaviour) - Number(a.behaviour));
}

export const ENTITY_TYPES = TAG_ENTITY_TYPES;

/** Moves item `index` by `delta` (−1 up, +1 down); returns the new id order or null at an edge. */
export function moveId(ids: readonly number[], index: number, delta: -1 | 1): number[] | null {
  const to = index + delta;
  if (to < 0 || to >= ids.length) return null;
  const next = [...ids];
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved!);
  return next;
}
