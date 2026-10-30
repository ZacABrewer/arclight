import { z } from 'zod';

// Tag management and tag rules: rules that add (and optionally remove) tags on library items
// from what the library knows about them (genres, files, requests ...). Conditions are plain,
// Zod-validated JSON; nothing user-supplied is ever executed. Routes under /api/v1/tagrule and
// the tag management routes under /api/v1/tag (usage, merge, bulk delete).

/** The library items that carry tags. */
export const TagEntityType = z.enum(['movie', 'series', 'artist', 'author']);
export type TagEntityType = z.infer<typeof TagEntityType>;
export const TAG_ENTITY_TYPES: readonly TagEntityType[] = TagEntityType.options;

// ---------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------

/** Fields whose value is a set of strings (a movie has several genres, a series several files ...). */
export const TagRuleSetField = z.enum([
  'genre',
  'resolution',
  'quality',
  'source',
  'hdr',
  'videoCodec',
  'audioCodec',
  'audioLanguage',
  'originalLanguage',
  'certification',
  'network',
  'studio',
  'status',
  'seriesType',
  'rootFolder',
  'collection',
  'releaseGroup',
  'albumType',
  'artistType',
  'author',
  'narrator',
  'bookSeries',
]);
export type TagRuleSetField = z.infer<typeof TagRuleSetField>;

/** Fields with one number (null when unknown; a range condition never matches an unknown value). */
export const TagRuleRangeField = z.enum(['year', 'rating', 'audioChannels', 'sizeGb', 'addedDays', 'runtime']);
export type TagRuleRangeField = z.infer<typeof TagRuleRangeField>;

export const TagRuleBoolField = z.enum(['monitored', 'hasFile']);
export type TagRuleBoolField = z.infer<typeof TagRuleBoolField>;

/** Fields holding ids of other records (quality profiles, users, tags). */
export const TagRuleIdField = z.enum(['qualityProfile', 'requestedBy', 'tag']);
export type TagRuleIdField = z.infer<typeof TagRuleIdField>;

export type TagRuleField = TagRuleSetField | TagRuleRangeField | TagRuleBoolField | TagRuleIdField;
export type TagRuleFieldKind = 'set' | 'range' | 'bool' | 'ids';

const ALL: readonly TagEntityType[] = TAG_ENTITY_TYPES;
const VIDEO: readonly TagEntityType[] = ['movie', 'series'];

export interface TagRuleFieldInfo {
  kind: TagRuleFieldKind;
  /** Item types the field has values for; on other types it is always empty / unknown. */
  entities: readonly TagEntityType[];
}

/** The condition catalogue: every field, its kind and the item types it applies to. */
export const TAG_RULE_FIELDS: Readonly<Record<TagRuleField, TagRuleFieldInfo>> = {
  genre: { kind: 'set', entities: ALL },
  resolution: { kind: 'set', entities: VIDEO },
  quality: { kind: 'set', entities: ALL },
  source: { kind: 'set', entities: VIDEO },
  hdr: { kind: 'set', entities: VIDEO },
  videoCodec: { kind: 'set', entities: VIDEO },
  audioCodec: { kind: 'set', entities: ALL },
  audioLanguage: { kind: 'set', entities: VIDEO },
  originalLanguage: { kind: 'set', entities: VIDEO },
  certification: { kind: 'set', entities: VIDEO },
  network: { kind: 'set', entities: ['series'] },
  studio: { kind: 'set', entities: ['movie'] },
  status: { kind: 'set', entities: ['movie', 'series', 'artist'] },
  seriesType: { kind: 'set', entities: ['series'] },
  rootFolder: { kind: 'set', entities: ALL },
  collection: { kind: 'set', entities: ['movie'] },
  releaseGroup: { kind: 'set', entities: ALL },
  albumType: { kind: 'set', entities: ['artist'] },
  artistType: { kind: 'set', entities: ['artist'] },
  author: { kind: 'set', entities: ['author'] },
  narrator: { kind: 'set', entities: ['author'] },
  bookSeries: { kind: 'set', entities: ['author'] },
  year: { kind: 'range', entities: VIDEO },
  rating: { kind: 'range', entities: VIDEO },
  audioChannels: { kind: 'range', entities: ALL },
  sizeGb: { kind: 'range', entities: ALL },
  addedDays: { kind: 'range', entities: ALL },
  runtime: { kind: 'range', entities: ['movie', 'series', 'author'] },
  monitored: { kind: 'bool', entities: ALL },
  hasFile: { kind: 'bool', entities: ALL },
  qualityProfile: { kind: 'ids', entities: ALL },
  requestedBy: { kind: 'ids', entities: ALL },
  tag: { kind: 'ids', entities: ALL },
};

export const TAG_RULE_FIELD_NAMES = Object.keys(TAG_RULE_FIELDS) as TagRuleField[];

// ---------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------

/**
 * Set operators. `any`: the item has at least one of the values. `all`: every value.
 * `none`: none of them. `present`: the field has any value at all. `absent`: it has none.
 * String values compare case-insensitively.
 */
export const TagRuleSetOp = z.enum(['any', 'all', 'none', 'present', 'absent']);
export type TagRuleSetOp = z.infer<typeof TagRuleSetOp>;

const opNeedsValues = (op: TagRuleSetOp) => op === 'any' || op === 'all' || op === 'none';

export const TagRuleCondition = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('set'),
    field: TagRuleSetField,
    op: TagRuleSetOp,
    values: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  }),
  /** Inclusive bounds; at least one is set. */
  z.object({
    kind: z.literal('range'),
    field: TagRuleRangeField,
    min: z.number().finite().nullable().default(null),
    max: z.number().finite().nullable().default(null),
  }),
  z.object({ kind: z.literal('bool'), field: TagRuleBoolField, value: z.boolean() }),
  z.object({
    kind: z.literal('ids'),
    field: TagRuleIdField,
    op: TagRuleSetOp,
    ids: z.array(z.number().int().positive()).max(200).default([]),
  }),
]);
export type TagRuleCondition = z.infer<typeof TagRuleCondition>;
export type TagRuleConditionInput = z.input<typeof TagRuleCondition>;

/** Problems with one condition, or null. Shared by the API (validation) and the editor (inline errors). */
export function conditionProblem(c: TagRuleCondition): string | null {
  if (c.kind === 'set' && opNeedsValues(c.op) && c.values.length === 0) return 'pick at least one value';
  if (c.kind === 'ids' && opNeedsValues(c.op) && c.ids.length === 0) return 'pick at least one value';
  if (c.kind === 'range') {
    if (c.min === null && c.max === null) return 'set a minimum, a maximum or both';
    if (c.min !== null && c.max !== null && c.min > c.max) return 'the minimum is above the maximum';
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Templates and labels
// ---------------------------------------------------------------------------------------

/**
 * Template variables: `{genre}` in an add-tag label makes one tag per genre. A template whose
 * variable has no value for an item adds nothing to that item.
 */
export const TAG_TEMPLATE_VARIABLES = {
  genre: { entities: ALL },
  resolution: { entities: VIDEO },
  quality: { entities: ALL },
  source: { entities: VIDEO },
  hdr: { entities: VIDEO },
  codec: { entities: VIDEO },
  audiocodec: { entities: ALL },
  language: { entities: VIDEO },
  originallanguage: { entities: VIDEO },
  certification: { entities: VIDEO },
  network: { entities: ['series'] },
  studio: { entities: ['movie'] },
  status: { entities: ['movie', 'series', 'artist'] },
  seriestype: { entities: ['series'] },
  rootfolder: { entities: ALL },
  collection: { entities: ['movie'] },
  releasegroup: { entities: ALL },
  albumtype: { entities: ['artist'] },
  artisttype: { entities: ['artist'] },
  author: { entities: ['author'] },
  narrator: { entities: ['author'] },
  bookseries: { entities: ['author'] },
  requester: { entities: ALL },
  qualityprofile: { entities: ALL },
  year: { entities: VIDEO },
  decade: { entities: VIDEO },
  channels: { entities: ALL },
} as const satisfies Record<string, { entities: readonly TagEntityType[] }>;
export type TagTemplateVariable = keyof typeof TAG_TEMPLATE_VARIABLES;
export const TAG_TEMPLATE_VARIABLE_NAMES = Object.keys(TAG_TEMPLATE_VARIABLES) as TagTemplateVariable[];

/** Most tags one template may make for one item (a cross product of two big sets is cut here). */
export const MAX_TAGS_PER_TEMPLATE = 25;
export const MAX_TAG_LABEL_LENGTH = 100;

const TEMPLATE_VAR = /\{([^{}]*)\}/g;

/** The variable names a template uses, lower-cased, in order of appearance (duplicates kept once). */
export function templateVariables(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(TEMPLATE_VAR)) {
    const name = (m[1] ?? '').trim().toLowerCase();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Unknown variables of a template, or an empty list. */
export function unknownTemplateVariables(template: string): string[] {
  return templateVariables(template).filter((v) => !(v in TAG_TEMPLATE_VARIABLES));
}

/**
 * Tag label rules: lower case, spaces become `-`, only letters, digits and `- _ . : + &` stay,
 * repeated `-` collapse, no leading/trailing separators, at most 100 characters. Returns '' when
 * nothing is left.
 */
export function sanitizeTagLabel(raw: string): string {
  const s = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_.:+&]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.:]+|[-_.:]+$/g, '');
  return s.slice(0, MAX_TAG_LABEL_LENGTH).replace(/[-_.:]+$/g, '');
}

// ---------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------

export const TagRuleMatch = z.enum(['all', 'any']);
export type TagRuleMatch = z.infer<typeof TagRuleMatch>;

export const TagRuleInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    appliesTo: z.array(TagEntityType).min(1).max(4),
    /** `all`: every condition must hold. `any`: one is enough. No conditions: every item matches. */
    match: TagRuleMatch.default('all'),
    conditions: z.array(TagRuleCondition).max(50).default([]),
    /** Labels or templates (`genre:{genre}`), sanitised to the tag label rules when applied. */
    addTags: z.array(z.string().trim().min(1).max(MAX_TAG_LABEL_LENGTH)).max(20).default([]),
    /** Tags to take off matching items (whoever added them). */
    removeTagIds: z.array(z.number().int().positive()).max(50).default([]),
    /** Take this rule's tags off items it no longer matches (tags added by hand are never touched). */
    removeWhenUnmatched: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    if (r.addTags.length === 0 && r.removeTagIds.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['addTags'], message: 'add or remove at least one tag' });
    }
    r.conditions.forEach((c, i) => {
      const problem = conditionProblem(c);
      if (problem) ctx.addIssue({ code: 'custom', path: ['conditions', i], message: problem });
    });
    r.addTags.forEach((tpl, i) => {
      const unknown = unknownTemplateVariables(tpl);
      if (unknown.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['addTags', i], message: `unknown template variable: ${unknown.map((u) => `{${u}}`).join(', ')}` });
      } else if (sanitizeTagLabel(tpl.replace(TEMPLATE_VAR, 'x')) === '') {
        ctx.addIssue({ code: 'custom', path: ['addTags', i], message: 'the label is empty after sanitising' });
      }
    });
  });
export type TagRuleInput = z.infer<typeof TagRuleInput>;
export type TagRuleInputRaw = z.input<typeof TagRuleInput>;

export const TagRuleRunSummary = z.object({
  at: z.string(),
  itemsEvaluated: z.number().int(),
  itemsChanged: z.number().int(),
  tagsAdded: z.number().int(),
  tagsRemoved: z.number().int(),
});
export type TagRuleRunSummary = z.infer<typeof TagRuleRunSummary>;

export const TagRule = z.object({
  id: z.number().int(),
  name: z.string(),
  enabled: z.boolean(),
  appliesTo: z.array(TagEntityType),
  match: TagRuleMatch,
  conditions: z.array(TagRuleCondition),
  addTags: z.array(z.string()),
  removeTagIds: z.array(z.number().int()),
  removeWhenUnmatched: z.boolean(),
  /** Run order (ascending). Results are additive; see docs/using/tags.md. */
  sortOrder: z.number().int(),
  /** Set on the shipped starter rules (`genre`, `resolution` ...). */
  starterKey: z.string().nullable(),
  /** Items this rule currently owns a tag on. */
  appliedCount: z.number().int(),
  lastRun: TagRuleRunSummary.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TagRule = z.infer<typeof TagRule>;

export const TagRuleOrderRequest = z.object({ ids: z.array(z.number().int().positive()).min(1) });
export type TagRuleOrderRequest = z.infer<typeof TagRuleOrderRequest>;

export const TagRuleDeleteQuery = z.object({
  /** Also take the tags this rule added off the items (unless another rule also added them). */
  removeTags: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .default(false),
});
export type TagRuleDeleteQuery = z.infer<typeof TagRuleDeleteQuery>;

// ---------------------------------------------------------------------------------------
// Preview / run
// ---------------------------------------------------------------------------------------

export const TagRuleTagChange = z.object({
  label: z.string(),
  /** Items that get / lose it. */
  count: z.number().int(),
  /** The tag does not exist yet; a run creates it. */
  isNew: z.boolean(),
});
export type TagRuleTagChange = z.infer<typeof TagRuleTagChange>;

export const TagRuleSampleItem = z.object({
  entityType: TagEntityType,
  id: z.number().int(),
  title: z.string(),
  add: z.array(z.string()),
  remove: z.array(z.string()),
});
export type TagRuleSampleItem = z.infer<typeof TagRuleSampleItem>;

/** Settings that use a tag the run would add or remove (tags drive behaviour). */
export const TagBehaviourUse = z.object({
  label: z.string(),
  uses: z.record(z.string(), z.number().int()),
});
export type TagBehaviourUse = z.infer<typeof TagBehaviourUse>;

export const TagRuleRunResult = z.object({
  dryRun: z.boolean(),
  itemsEvaluated: z.number().int(),
  /** Items at least one evaluated rule matched. */
  itemsMatched: z.number().int(),
  itemsChanged: z.number().int(),
  matchedByType: z.record(z.string(), z.number().int()),
  add: z.array(TagRuleTagChange),
  remove: z.array(TagRuleTagChange),
  /** Up to 25 changed items. */
  samples: z.array(TagRuleSampleItem),
  behaviour: z.array(TagBehaviourUse),
  durationMs: z.number().int(),
});
export type TagRuleRunResult = z.infer<typeof TagRuleRunResult>;

/** Preview a rule as edited (not saved yet). `id`: the saved rule it replaces (for its removals). */
export const TagRulePreviewRequest = z.object({
  rule: TagRuleInput,
  id: z.number().int().positive().optional(),
});
export type TagRulePreviewRequest = z.infer<typeof TagRulePreviewRequest>;

/** Run every enabled rule, or the listed rules (enabled or not), in rule order. */
export const TagRuleRunRequest = z.object({
  ruleIds: z.array(z.number().int().positive()).optional(),
  dryRun: z.boolean().default(false),
});
export type TagRuleRunRequest = z.infer<typeof TagRuleRunRequest>;

/** A tag a rule put on an item (detail pages mark these). */
export const TagApplication = z.object({
  tagId: z.number().int(),
  ruleId: z.number().int(),
  ruleName: z.string(),
});
export type TagApplication = z.infer<typeof TagApplication>;

export const TagApplicationQuery = z.object({
  entityType: TagEntityType,
  entityId: z.coerce.number().int().positive(),
});
export type TagApplicationQuery = z.infer<typeof TagApplicationQuery>;

/** Values the editor offers in its pickers, from what is in the library. */
export const TagRuleOptions = z.object({
  values: z.record(z.string(), z.array(z.string())),
  users: z.array(z.object({ id: z.number().int(), name: z.string() })),
  qualityProfiles: z.array(z.object({ id: z.number().int(), name: z.string(), domain: z.string() })),
});
export type TagRuleOptions = z.infer<typeof TagRuleOptions>;

// ---------------------------------------------------------------------------------------
// Tag management
// ---------------------------------------------------------------------------------------

/** What can carry a tag. Everything but the library items and requests changes behaviour. */
export const TagUsageKind = z.enum([
  'movie',
  'series',
  'artist',
  'author',
  'request',
  'indexer',
  'indexerProxy',
  'downloadClient',
  'importList',
  'notification',
  'delayProfile',
  'releaseProfile',
  'overrideRule',
  'retentionRule',
  'transcodeRule',
  'tagRule',
  'settings',
]);
export type TagUsageKind = z.infer<typeof TagUsageKind>;

/** Kinds where a tag changes how items are searched, grabbed, imported or announced. */
export const BEHAVIOUR_TAG_KINDS: ReadonlySet<TagUsageKind> = new Set<TagUsageKind>([
  'indexer',
  'indexerProxy',
  'downloadClient',
  'importList',
  'notification',
  'delayProfile',
  'releaseProfile',
  'overrideRule',
  'retentionRule',
  'transcodeRule',
  'settings',
]);

export const TagUsage = z.object({
  id: z.number().int(),
  label: z.string(),
  /** Count per kind; kinds with no use are left out. */
  counts: z.record(z.string(), z.number().int()),
  total: z.number().int(),
  /** Uses that change behaviour (profiles, indexers, clients ...). */
  behaviourUses: z.number().int(),
  /** Items that carry the tag because a rule added it. */
  autoApplied: z.number().int(),
  /** Rules that own the tag on some item or add it as a fixed label. */
  rules: z.array(z.object({ id: z.number().int(), name: z.string() })),
});
export type TagUsage = z.infer<typeof TagUsage>;

export const TagMergeRequest = z.object({ intoId: z.number().int().positive() });
export type TagMergeRequest = z.infer<typeof TagMergeRequest>;

export const TagBulkDeleteRequest = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1000),
  /** false: refuse (409) when any of them is in use. */
  force: z.boolean().default(false),
});
export type TagBulkDeleteRequest = z.infer<typeof TagBulkDeleteRequest>;

export const TagBulkDeleteResult = z.object({ deleted: z.number().int() });
export type TagBulkDeleteResult = z.infer<typeof TagBulkDeleteResult>;

export const TagRuleErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type TagRuleErrorResponse = z.infer<typeof TagRuleErrorResponse>;
