import { z } from 'zod';

// Watched-based retention: rules that stage library items for unmonitoring or deletion once
// they are watched (or stale), a grace period during which an admin can keep them, and the
// daily RetentionSweep that applies what is due. Routes under /api/v1/retentionrule and
// /api/v1/retention.

export const RetentionMediaType = z.enum(['movie', 'series']);
export type RetentionMediaType = z.infer<typeof RetentionMediaType>;

/** Which library items a rule looks at. */
export const RetentionScope = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  /** Items carrying any of these tag ids. */
  z.object({ type: z.literal('tags'), tagIds: z.array(z.number().int()).min(1) }),
  /** Items under any of these root folders. */
  z.object({ type: z.literal('rootFolders'), paths: z.array(z.string().min(1)).min(1) }),
]);
export type RetentionScope = z.infer<typeof RetentionScope>;

/**
 * One condition. A rule's conditions must all hold. Users are matched by name
 * (case-insensitive) across every server flagged `usedForRetention`; a user counts as having
 * watched an item when any of those servers says so. A series is watched when every episode
 * on the server is played.
 */
export const RetentionCondition = z.discriminatedUnion('type', [
  /** Every enabled server user has watched it. */
  z.object({ type: z.literal('watchedByAll') }),
  /** At least one user has watched it. */
  z.object({ type: z.literal('watchedByAny') }),
  /** Every listed user has watched it. */
  z.object({ type: z.literal('watchedByUsers'), users: z.array(z.string().trim().min(1)).min(1) }),
  /** Added to the library more than `days` ago. */
  z.object({ type: z.literal('addedOlderThanDays'), days: z.number().int().min(0) }),
  /** Nobody played it within `days` (and it was added longer ago than that). */
  z.object({ type: z.literal('notWatchedWithinDays'), days: z.number().int().min(1) }),
  /** Files on disk are larger than `bytes` in total. */
  z.object({ type: z.literal('sizeAbove'), bytes: z.number().int().min(0) }),
]);
export type RetentionCondition = z.infer<typeof RetentionCondition>;

/** Conditions that need play state from the media servers. */
export const WATCH_CONDITIONS: ReadonlySet<RetentionCondition['type']> = new Set(['watchedByAll', 'watchedByAny', 'watchedByUsers', 'notWatchedWithinDays']);

/**
 * `unmonitor`: stop searching. `deleteFiles`: move the files to the recycle bin and unmonitor
 * (so they are not downloaded again). `deleteItem`: remove the series/movie and its folder,
 * optionally adding an import-list exclusion.
 */
export const RetentionAction = z.enum(['unmonitor', 'deleteFiles', 'deleteItem']);
export type RetentionAction = z.infer<typeof RetentionAction>;

export const RetentionRuleInput = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  mediaType: RetentionMediaType,
  scope: RetentionScope.default({ type: 'all' }),
  conditions: z.array(RetentionCondition).min(1),
  /** Days between staging and applying. 0 applies on the sweep that stages it. */
  graceDays: z.number().int().min(0).max(3650).default(7),
  action: RetentionAction,
  /** deleteItem only: add an import exclusion so lists do not re-add it. */
  addExclusion: z.boolean().default(false),
  /** Keep items someone requested within this many days (null: off). */
  keepIfRequestedWithinDays: z.number().int().min(1).nullable().default(null),
  /** Movies only: keep movies that belong to a collection. */
  keepIfInCollection: z.boolean().default(false),
  /** Stage and report candidates, never apply them automatically. */
  dryRun: z.boolean().default(true),
});
export type RetentionRuleInput = z.infer<typeof RetentionRuleInput>;
export type RetentionRuleInputRaw = z.input<typeof RetentionRuleInput>;

export const RetentionRule = RetentionRuleInput.extend({
  id: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RetentionRule = z.infer<typeof RetentionRule>;

/**
 * `pending`: waiting for its grace period. `kept`: pinned by an admin, never applied.
 * `applied`: the action ran. `failed`: the action threw; retried on the next sweep.
 */
export const RetentionCandidateStatus = z.enum(['pending', 'kept', 'applied', 'failed']);
export type RetentionCandidateStatus = z.infer<typeof RetentionCandidateStatus>;

export const RetentionCandidate = z.object({
  id: z.number().int(),
  ruleId: z.number().int(),
  ruleName: z.string(),
  mediaType: RetentionMediaType,
  /** Series or movie id. */
  mediaId: z.number().int(),
  tmdbId: z.number().int(),
  title: z.string(),
  year: z.number().int().nullable(),
  sizeBytes: z.number().int(),
  action: RetentionAction,
  /** Human-readable reasons, one per matched condition. */
  reasons: z.array(z.string()),
  /** Users who watched it (names), when known. */
  watchedBy: z.array(z.string()),
  status: RetentionCandidateStatus,
  /** The rule is a dry run: shown, never applied automatically. */
  dryRun: z.boolean(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  /** When the sweep may apply it. */
  applyAfter: z.string(),
  appliedAt: z.string().nullable(),
  keptAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type RetentionCandidate = z.infer<typeof RetentionCandidate>;

export const RetentionCandidateQuery = z.object({
  status: RetentionCandidateStatus.optional(),
  ruleId: z.coerce.number().int().optional(),
  mediaType: RetentionMediaType.optional(),
});
export type RetentionCandidateQuery = z.infer<typeof RetentionCandidateQuery>;

/** POST /retention/sweep. `dryRun`: evaluate only; nothing is staged, applied or notified. */
export const RetentionSweepRequest = z.object({ dryRun: z.boolean().default(false) });
export type RetentionSweepRequest = z.infer<typeof RetentionSweepRequest>;

export const RetentionSweepPreview = z.object({
  ruleId: z.number().int(),
  ruleName: z.string(),
  mediaType: RetentionMediaType,
  mediaId: z.number().int(),
  title: z.string(),
  action: RetentionAction,
  reasons: z.array(z.string()),
  sizeBytes: z.number().int(),
});
export type RetentionSweepPreview = z.infer<typeof RetentionSweepPreview>;

export const RetentionSweepResult = z.object({
  dryRun: z.boolean(),
  rulesEvaluated: z.number().int(),
  /** Rules not evaluated this time, with why (server unreachable, ...). */
  rulesSkipped: z.array(z.object({ ruleId: z.number().int(), ruleName: z.string(), reason: z.string() })),
  serverErrors: z.array(z.object({ server: z.string(), message: z.string() })),
  /** Newly staged candidates. */
  staged: z.number().int(),
  /** Pending candidates that stopped matching and were dropped. */
  dropped: z.number().int(),
  applied: z.number().int(),
  failed: z.number().int(),
  /** Every match of this sweep. */
  matches: z.array(RetentionSweepPreview),
});
export type RetentionSweepResult = z.infer<typeof RetentionSweepResult>;

export const RetentionErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type RetentionErrorResponse = z.infer<typeof RetentionErrorResponse>;
