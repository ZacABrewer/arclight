import {
  MAX_TAGS_PER_TEMPLATE,
  sanitizeTagLabel,
  templateVariables,
  type TagEntityType,
  type TagRuleBoolField,
  type TagRuleCondition,
  type TagRuleMatch,
  type TagRuleRangeField,
  type TagRuleSetField,
  type TagTemplateVariable,
} from '@arclight/shared';

// The pure half of tag rules: given what the library knows about one item (its facts), its
// current tags and which rule added which of them, work out the tags it should end up with.
// No database, no clock of its own, no user code: conditions are data and templates only
// substitute known variables.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Everything a condition or template can look at, for one item. */
export interface ItemFacts {
  entityType: TagEntityType;
  id: number;
  title: string;
  /** ISO-8601; `addedDays` is computed from it and `now`. */
  addedAt: string | null;
  sets: Partial<Record<TagRuleSetField, readonly string[]>>;
  nums: Partial<Record<Exclude<TagRuleRangeField, 'addedDays'>, number | null>>;
  bools: Record<TagRuleBoolField, boolean>;
  qualityProfileIds: readonly number[];
  requestedByIds: readonly number[];
  /** Template variable values (display form; sanitised when the label is built). */
  vars: Partial<Record<TagTemplateVariable, readonly string[]>>;
}

/** A rule as the engine sees it: removals already resolved to labels. */
export interface EngineRule {
  id: number;
  appliesTo: readonly TagEntityType[];
  match: TagRuleMatch;
  conditions: readonly TagRuleCondition[];
  addTags: readonly string[];
  removeLabels: readonly string[];
  removeWhenUnmatched: boolean;
}

export interface EvalContext {
  now: Date;
  /** Tag id → label, for `tag` conditions. */
  tagLabels: ReadonlyMap<number, string>;
}

const lower = (s: string) => s.trim().toLowerCase();

function setOp(have: ReadonlySet<string | number>, op: string, wanted: readonly (string | number)[]): boolean {
  switch (op) {
    case 'present':
      return have.size > 0;
    case 'absent':
      return have.size === 0;
    case 'any':
      return wanted.some((w) => have.has(w));
    case 'all':
      return wanted.length > 0 && wanted.every((w) => have.has(w));
    case 'none':
      return !wanted.some((w) => have.has(w));
    default:
      return false;
  }
}

/** The item's number for a range field, or null when unknown. */
export function rangeValue(facts: ItemFacts, field: TagRuleRangeField, now: Date): number | null {
  if (field === 'addedDays') {
    if (!facts.addedAt) return null;
    const ms = Date.parse(facts.addedAt);
    if (Number.isNaN(ms)) return null;
    return Math.max(0, (now.getTime() - ms) / DAY_MS);
  }
  const v = facts.nums[field];
  return v === undefined || v === null || Number.isNaN(v) ? null : v;
}

/**
 * Does one condition hold? `currentLabels` are the item's tags at this point of the pass (a
 * `tag` condition sees tags added by earlier rules).
 */
export function evaluateCondition(c: TagRuleCondition, facts: ItemFacts, currentLabels: ReadonlySet<string>, ctx: EvalContext): boolean {
  switch (c.kind) {
    case 'set': {
      const have = new Set((facts.sets[c.field] ?? []).map(lower).filter((s) => s !== ''));
      return setOp(have, c.op, c.values.map(lower));
    }
    case 'range': {
      const v = rangeValue(facts, c.field, ctx.now);
      if (v === null) return false;
      if (c.min !== null && v < c.min) return false;
      if (c.max !== null && v > c.max) return false;
      return true;
    }
    case 'bool':
      return facts.bools[c.field] === c.value;
    case 'ids': {
      if (c.field === 'tag') {
        // Compare by label: tags added earlier in the same pass may not have an id yet.
        const wanted = c.ids.map((id) => ctx.tagLabels.get(id)).filter((l): l is string => l !== undefined);
        if ((c.op === 'any' || c.op === 'all') && wanted.length < (c.op === 'all' ? c.ids.length : 1)) return false;
        return setOp(currentLabels, c.op, wanted);
      }
      const have = new Set(c.field === 'qualityProfile' ? facts.qualityProfileIds : facts.requestedByIds);
      return setOp(have, c.op, c.ids);
    }
  }
}

/** Does a rule match an item? No conditions: every item of the rule's types matches. */
export function ruleMatches(rule: EngineRule, facts: ItemFacts, currentLabels: ReadonlySet<string>, ctx: EvalContext): boolean {
  if (!rule.appliesTo.includes(facts.entityType)) return false;
  if (rule.conditions.length === 0) return true;
  const test = (c: TagRuleCondition) => evaluateCondition(c, facts, currentLabels, ctx);
  return rule.match === 'any' ? rule.conditions.some(test) : rule.conditions.every(test);
}

/** Values of one template variable for an item (deduplicated case-insensitively, display form kept). */
export function variableValues(facts: ItemFacts, name: string): string[] {
  const raw = facts.vars[name as TagTemplateVariable] ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const key = lower(v);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * The labels a template makes for an item: one per value (one per combination when it uses
 * several variables), sanitised, at most MAX_TAGS_PER_TEMPLATE. A variable with no value makes
 * nothing; a template without variables is a fixed label.
 */
export function renderTemplate(template: string, facts: ItemFacts): string[] {
  const names = templateVariables(template);
  if (names.length === 0) {
    const label = sanitizeTagLabel(template);
    return label ? [label] : [];
  }
  let partials: Array<Record<string, string>> = [{}];
  for (const name of names) {
    const values = variableValues(facts, name);
    if (values.length === 0) return [];
    const next: Array<Record<string, string>> = [];
    for (const p of partials) {
      for (const v of values) {
        next.push({ ...p, [name]: v });
        if (next.length >= MAX_TAGS_PER_TEMPLATE) break;
      }
      if (next.length >= MAX_TAGS_PER_TEMPLATE) break;
    }
    partials = next;
  }
  const out: string[] = [];
  for (const p of partials) {
    const label = sanitizeTagLabel(template.replace(/\{([^{}]*)\}/g, (_, n: string) => p[n.trim().toLowerCase()] ?? ''));
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

export interface ItemState {
  /** Current tag labels. */
  labels: ReadonlySet<string>;
  /** label → ids of the rules that added it. Tags missing here were added by hand. */
  owners: ReadonlyMap<string, ReadonlySet<number>>;
}

export interface ItemPlan {
  labels: Set<string>;
  owners: Map<string, Set<number>>;
  /** Rules (of those evaluated) that matched. */
  matched: number[];
}

/**
 * Runs `rules` in order over one item. Rules not listed are not evaluated and their
 * ownership is left alone. Per rule:
 *  - matched: each rendered label is added (and owned by the rule) unless the item already
 *    carries it as a hand-added tag, which stays the user's;
 *  - labels the rule owned but no longer produces lose the rule as owner when
 *    `removeWhenUnmatched` is on; the tag comes off once no rule owns it;
 *  - matched with remove labels: those come off, whoever added them.
 * Later rules see the tags earlier ones added; the caller writes only the difference.
 */
export function planItem(rules: readonly EngineRule[], facts: ItemFacts, state: ItemState, ctx: EvalContext): ItemPlan {
  const labels = new Set(state.labels);
  const owners = new Map<string, Set<number>>();
  for (const [label, ids] of state.owners) owners.set(label, new Set(ids));
  const matched: number[] = [];

  for (const rule of rules) {
    if (!rule.appliesTo.includes(facts.entityType)) continue;
    const isMatch = ruleMatches(rule, facts, labels, ctx);
    if (isMatch) matched.push(rule.id);
    const desired = new Set<string>();
    if (isMatch) for (const tpl of rule.addTags) for (const l of renderTemplate(tpl, facts)) desired.add(l);

    for (const label of desired) {
      const own = owners.get(label);
      if (!labels.has(label)) {
        labels.add(label);
        owners.set(label, new Set([...(own ?? []), rule.id]));
      } else if (own && own.size > 0) {
        own.add(rule.id);
      }
      // else: the user added it by hand; it stays theirs.
    }

    if (rule.removeWhenUnmatched) {
      for (const [label, own] of owners) {
        if (!own.has(rule.id) || desired.has(label)) continue;
        own.delete(rule.id);
        if (own.size === 0) {
          owners.delete(label);
          labels.delete(label);
        }
      }
    }

    if (isMatch) {
      for (const label of rule.removeLabels) {
        labels.delete(label);
        owners.delete(label);
      }
    }
  }

  for (const label of [...owners.keys()]) if (!labels.has(label)) owners.delete(label);
  return { labels, owners, matched };
}

export interface ItemDiff {
  add: string[];
  remove: string[];
  /** [label, ruleId] pairs to record / forget. */
  own: Array<[string, number]>;
  disown: Array<[string, number]>;
}

export function diffPlan(state: ItemState, plan: ItemPlan): ItemDiff {
  const add = [...plan.labels].filter((l) => !state.labels.has(l)).sort();
  const remove = [...state.labels].filter((l) => !plan.labels.has(l)).sort();
  const own: Array<[string, number]> = [];
  const disown: Array<[string, number]> = [];
  for (const [label, ids] of plan.owners) {
    const before = state.owners.get(label);
    for (const id of ids) if (!before?.has(id)) own.push([label, id]);
  }
  for (const [label, ids] of state.owners) {
    const after = plan.owners.get(label);
    for (const id of ids) if (!after?.has(id)) disown.push([label, id]);
  }
  return { add, remove, own, disown };
}

export const isEmptyDiff = (d: ItemDiff) => d.add.length === 0 && d.remove.length === 0 && d.own.length === 0 && d.disown.length === 0;
