import type { RetentionCondition, RetentionRuleInput } from '@arclight/shared';

// Pure rule evaluation: given what the library knows about an item and what the media servers
// say about who watched it, does a rule match, and why. No database, no clock of its own.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LibraryItemFacts {
  mediaType: 'movie' | 'series';
  id: number;
  tmdbId: number;
  tvdbId: number | null;
  imdbId: string | null;
  title: string;
  year: number | null;
  tags: number[];
  rootFolderPath: string;
  path: string;
  /** ISO-8601. */
  added: string;
  /** Bytes of every media file. */
  sizeBytes: number;
  hasFiles: boolean;
  monitored: boolean;
  /** Movies: part of a TMDB collection. */
  inCollection: boolean;
}

export interface UserWatch {
  /** The Arclight username for linked accounts, else the name the server reports. */
  name: string;
  played: boolean;
  lastPlayedAt: string | null;
  /** Arclight user id when the server account is linked to one. */
  userId?: number | null;
  /** Other names `watchedByUsers` matches (display name, server account names). */
  aliases?: string[];
}

/** What the retention servers know about one item. */
export interface WatchFacts {
  /** The item was matched on at least one server. */
  found: boolean;
  /** One entry per user who can see the item (linked accounts merged into their Arclight user). */
  users: UserWatch[];
  /** Latest play by anyone. */
  lastPlayedAt: string | null;
}

export interface EvaluationContext {
  now: Date;
  /** null when no watch data is available (no server, or a server failed). */
  watch: WatchFacts | null;
  /** Latest request for the item (ISO-8601), if any. */
  lastRequestedAt: string | null;
  /** Who requested the item and when (declined requests left out). */
  requesters?: Array<{ userId: number; requestedAt: string }>;
}

export type RuleForEvaluation = Pick<
  RetentionRuleInput,
  'mediaType' | 'scope' | 'conditions' | 'action' | 'keepIfRequestedWithinDays' | 'keepIfInCollection'
> &
  Partial<Pick<RetentionRuleInput, 'keepIfRequesterHasNotWatched'>>;

export interface Evaluation {
  match: boolean;
  /** One reason per satisfied condition (all of them when `match`). */
  reasons: string[];
  /** Why a keep option or a no-op saved the item, when it would otherwise match. */
  keptBy?: string;
  /** Users who watched it (names). */
  watchedBy: string[];
}

export function normalisePath(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

export function inScope(rule: Pick<RuleForEvaluation, 'scope' | 'mediaType'>, item: LibraryItemFacts): boolean {
  if (rule.mediaType !== item.mediaType) return false;
  const scope = rule.scope;
  switch (scope.type) {
    case 'all':
      return true;
    case 'tags':
      return item.tags.some((t) => scope.tagIds.includes(t));
    case 'rootFolders': {
      const root = normalisePath(item.rootFolderPath);
      const path = normalisePath(item.path);
      return scope.paths.some((p) => {
        const want = normalisePath(p);
        return root === want || path.startsWith(`${want}/`);
      });
    }
  }
}

function daysBetween(fromIso: string, now: Date): number {
  const t = Date.parse(fromIso);
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / DAY_MS) : 0;
}

export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function names(list: string[]): string {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Reason when the condition holds, null otherwise. */
export function checkCondition(condition: RetentionCondition, item: LibraryItemFacts, ctx: EvaluationContext): string | null {
  const watch = ctx.watch;
  const watchers = watch ? watch.users.filter((u) => u.played).map((u) => u.name) : [];
  switch (condition.type) {
    case 'watchedByAll': {
      if (!watch?.found || watch.users.length === 0) return null;
      return watch.users.every((u) => u.played) ? `watched by all ${watch.users.length} user${watch.users.length === 1 ? '' : 's'}` : null;
    }
    case 'watchedByAny':
      if (!watch?.found) return null;
      return watchers.length > 0 ? `watched by ${names(watchers)}` : null;
    case 'watchedByUsers': {
      if (!watch?.found) return null;
      const byName = new Map<string, UserWatch>();
      for (const u of watch.users) for (const n of [u.name, ...(u.aliases ?? [])]) byName.set(n.toLowerCase(), u);
      const ok = condition.users.every((n) => byName.get(n.toLowerCase())?.played === true);
      return ok ? `watched by ${names(condition.users)}` : null;
    }
    case 'addedOlderThanDays': {
      const age = daysBetween(item.added, ctx.now);
      return age > condition.days ? `added ${age} days ago` : null;
    }
    case 'notWatchedWithinDays': {
      // Unknown on every server: no evidence either way, so never "not watched".
      if (!watch?.found) return null;
      const age = daysBetween(item.added, ctx.now);
      if (age <= condition.days) return null;
      if (!watch.lastPlayedAt) return `never watched, added ${age} days ago`;
      const since = daysBetween(watch.lastPlayedAt, ctx.now);
      return since > condition.days ? `last watched ${since} days ago` : null;
    }
    case 'sizeAbove':
      return item.sizeBytes > condition.bytes ? `${formatSize(item.sizeBytes)} on disk (over ${formatSize(condition.bytes)})` : null;
    case 'notWatchedByRequesterWithinDays': {
      const due = (ctx.requesters ?? []).filter((r) => daysBetween(r.requestedAt, ctx.now) > condition.days);
      if (!watch || due.length === 0) return null;
      const states = due.map((r) => watch.users.find((u) => u.userId === r.userId));
      // A requester the history knows nothing about is no evidence either way.
      if (states.some((u) => u === undefined)) return null;
      const recent = states.some((u) => u!.lastPlayedAt !== null && daysBetween(u!.lastPlayedAt, ctx.now) <= condition.days);
      if (recent) return null;
      const who = names(states.map((u) => u!.name));
      return `requested by ${who}, not watched by them in ${condition.days} days`;
    }
  }
}

export function evaluateRule(rule: RuleForEvaluation, item: LibraryItemFacts, ctx: EvaluationContext): Evaluation {
  const watchedBy = ctx.watch ? ctx.watch.users.filter((u) => u.played).map((u) => u.name) : [];
  if (!inScope(rule, item)) return { match: false, reasons: [], watchedBy };
  const reasons: string[] = [];
  for (const condition of rule.conditions) {
    const reason = checkCondition(condition, item, ctx);
    if (reason === null) return { match: false, reasons, watchedBy };
    reasons.push(reason);
  }
  if (rule.keepIfRequestedWithinDays && ctx.lastRequestedAt) {
    const age = daysBetween(ctx.lastRequestedAt, ctx.now);
    if (age < rule.keepIfRequestedWithinDays) return { match: false, reasons, keptBy: `requested ${age} days ago`, watchedBy };
  }
  if (rule.keepIfRequesterHasNotWatched && (ctx.requesters ?? []).length > 0) {
    const waiting = (ctx.requesters ?? []).filter((r) => !ctx.watch?.users.some((u) => u.userId === r.userId && u.played));
    if (waiting.length > 0) return { match: false, reasons, keptBy: 'a requester has not watched it yet', watchedBy };
  }
  if (rule.keepIfInCollection && item.mediaType === 'movie' && item.inCollection) {
    return { match: false, reasons, keptBy: 'part of a collection', watchedBy };
  }
  // Nothing left to do: an unmonitored item cannot be unmonitored, an empty one has no files.
  if (rule.action === 'unmonitor' && !item.monitored) return { match: false, reasons, keptBy: 'already unmonitored', watchedBy };
  if (rule.action === 'deleteFiles' && !item.hasFiles) return { match: false, reasons, keptBy: 'no files on disk', watchedBy };
  return { match: true, reasons, watchedBy };
}
