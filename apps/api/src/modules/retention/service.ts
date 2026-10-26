import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { RetentionEvent, RetentionLine } from '@arclight/notifications';
import type { MediaKind } from '@arclight/media-servers';
import {
  RetentionRuleInput,
  WATCH_CONDITIONS,
  type RetentionCandidate,
  type RetentionCandidateQuery,
  type RetentionRule,
  type RetentionRuleInputRaw,
  type RetentionSweepPreview,
  type RetentionSweepResult,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { mediaFiles, mediaRequests, movies, series } from '../../db/schema.js';
import { LibraryError } from '../library/index.js';
import type { ConfiguredClient } from '../media-servers/index.js';
import type { ApplyAction } from './actions.js';
import { evaluateRule, type LibraryItemFacts, type UserWatch, type WatchFacts } from './evaluate.js';
import { retentionCandidates, retentionRules, type RetentionCandidateRow, type RetentionRuleRow } from './schema.js';

// Watched-based retention. Rules are evaluated by RetentionSweep against the library and the
// play state of every server flagged `usedForRetention`; matches are staged as candidates and
// applied once their grace period is over, unless an admin kept them. Rules that need play
// state are skipped (candidates untouched, nothing applied) whenever a server cannot answer,
// so an outage never looks like "nobody watched anything".

const DAY_MS = 24 * 60 * 60 * 1000;
/** Lines per list in the summary notification. */
const SUMMARY_LINES = 15;

export type RetentionErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT';

export class RetentionError extends Error {
  constructor(
    readonly code: RetentionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RetentionError';
  }
}

export interface RetentionServiceOptions {
  db: Db;
  /** Clients for the servers flagged `usedForRetention` (fresh per call). */
  servers: () => ConfiguredClient[];
  apply: ApplyAction;
  /** Delivers the admin summary (notifications dispatch). */
  notify?: (event: RetentionEvent) => Promise<unknown>;
  now?: () => Date;
  log?: Logger;
  instanceName?: string;
  applicationUrl?: string;
}

type WatchMap = Map<number, WatchFacts>;

export class RetentionService {
  private readonly db: Db;
  private readonly servers: () => ConfiguredClient[];
  private readonly applyAction: ApplyAction;
  private readonly notify: ((event: RetentionEvent) => Promise<unknown>) | undefined;
  private readonly now: () => Date;
  private readonly log: Logger | undefined;
  private readonly instanceName: string;
  private readonly applicationUrl: string | undefined;
  private sweeping: Promise<RetentionSweepResult> | null = null;

  constructor(opts: RetentionServiceOptions) {
    this.db = opts.db;
    this.servers = opts.servers;
    this.applyAction = opts.apply;
    this.notify = opts.notify;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log;
    this.instanceName = opts.instanceName ?? 'Arclight';
    this.applicationUrl = opts.applicationUrl;
  }

  // ---- rules -----------------------------------------------------------------------------

  listRules(): RetentionRule[] {
    return this.db.select().from(retentionRules).orderBy(asc(retentionRules.id)).all().map(toRule);
  }

  getRule(id: number): RetentionRule {
    return toRule(this.requireRule(id));
  }

  createRule(raw: RetentionRuleInputRaw): RetentionRule {
    const input = parseRule(raw);
    this.assertUniqueName(input.name, null);
    const now = this.now().toISOString();
    const row = this.db
      .insert(retentionRules)
      .values({ ...input, createdAt: now, updatedAt: now })
      .returning()
      .get();
    return toRule(row);
  }

  updateRule(id: number, raw: RetentionRuleInputRaw): RetentionRule {
    this.requireRule(id);
    const input = parseRule(raw);
    this.assertUniqueName(input.name, id);
    const row = this.db
      .update(retentionRules)
      .set({ ...input, updatedAt: this.now().toISOString() })
      .where(eq(retentionRules.id, id))
      .returning()
      .get();
    if (!row) throw ruleNotFound(id);
    // Waiting candidates follow the rule's action; the next sweep re-checks whether they still match.
    this.db
      .update(retentionCandidates)
      .set({ action: row.action })
      .where(and(eq(retentionCandidates.ruleId, id), inArray(retentionCandidates.status, ['pending', 'failed'])))
      .run();
    return toRule(row);
  }

  deleteRule(id: number): void {
    this.requireRule(id);
    this.db.delete(retentionCandidates).where(eq(retentionCandidates.ruleId, id)).run();
    this.db.delete(retentionRules).where(eq(retentionRules.id, id)).run();
  }

  // ---- candidates ------------------------------------------------------------------------

  listCandidates(query: Partial<RetentionCandidateQuery> = {}): RetentionCandidate[] {
    const where = [];
    if (query.status) where.push(eq(retentionCandidates.status, query.status));
    if (query.ruleId !== undefined) where.push(eq(retentionCandidates.ruleId, query.ruleId));
    if (query.mediaType) where.push(eq(retentionCandidates.mediaType, query.mediaType));
    const rules = new Map(this.db.select().from(retentionRules).all().map((r) => [r.id, r]));
    return this.db
      .select()
      .from(retentionCandidates)
      .where(and(...where))
      .orderBy(asc(retentionCandidates.applyAfter), asc(retentionCandidates.id))
      .all()
      .map((row) => toCandidate(row, rules.get(row.ruleId)));
  }

  getCandidate(id: number): RetentionCandidate {
    const row = this.requireCandidate(id);
    return toCandidate(row, this.db.select().from(retentionRules).where(eq(retentionRules.id, row.ruleId)).get());
  }

  /** Pins a candidate: it is never applied automatically (DELETE the candidate to unpin). */
  keep(id: number): RetentionCandidate {
    const row = this.requireCandidate(id);
    if (row.status === 'applied') throw new RetentionError('CONFLICT', `Candidate ${id} was already applied`);
    this.db
      .update(retentionCandidates)
      .set({ status: 'kept', keptAt: this.now().toISOString(), error: null })
      .where(eq(retentionCandidates.id, id))
      .run();
    return this.getCandidate(id);
  }

  /** Removes a candidate (unpins a kept one); a later sweep may stage the item again. */
  deleteCandidate(id: number): void {
    this.requireCandidate(id);
    this.db.delete(retentionCandidates).where(eq(retentionCandidates.id, id)).run();
  }

  /** Applies a candidate now, regardless of grace period, pin or dry-run rule. */
  async applyCandidate(id: number): Promise<RetentionCandidate> {
    const row = this.requireCandidate(id);
    if (row.status === 'applied') throw new RetentionError('CONFLICT', `Candidate ${id} was already applied`);
    const rule = this.requireRule(row.ruleId);
    await this.runApply(row, rule);
    return this.getCandidate(id);
  }

  private async runApply(row: RetentionCandidateRow, rule: RetentionRuleRow): Promise<{ ok: boolean; freedBytes: number; error?: string }> {
    const now = this.now().toISOString();
    try {
      const outcome = await this.applyAction(rule.action, row.mediaType, row.mediaId, { addExclusion: rule.addExclusion });
      this.db
        .update(retentionCandidates)
        .set({ status: 'applied', appliedAt: now, error: null, action: rule.action })
        .where(eq(retentionCandidates.id, row.id))
        .run();
      this.log?.info({ candidate: row.id, title: row.title, action: rule.action }, 'retention action applied');
      return { ok: true, freedBytes: outcome.freedBytes };
    } catch (err) {
      const message =
        err instanceof LibraryError && err.code === 'NOT_FOUND' ? 'no longer in the library' : err instanceof Error ? err.message : String(err);
      this.db.update(retentionCandidates).set({ status: 'failed', error: message }).where(eq(retentionCandidates.id, row.id)).run();
      this.log?.warn({ err, candidate: row.id, title: row.title }, 'retention action failed');
      return { ok: false, freedBytes: 0, error: message };
    }
  }

  // ---- sweep -----------------------------------------------------------------------------

  /** One sweep at a time; a second caller gets the running sweep's result. */
  sweep(opts: { dryRun?: boolean } = {}): Promise<RetentionSweepResult> {
    if (this.sweeping) return this.sweeping;
    const run = this.runSweep(opts.dryRun ?? false).finally(() => {
      this.sweeping = null;
    });
    this.sweeping = run;
    return run;
  }

  private async runSweep(dryRun: boolean): Promise<RetentionSweepResult> {
    const now = this.now();
    const nowIso = now.toISOString();
    const allRules = this.db.select().from(retentionRules).orderBy(asc(retentionRules.id)).all();
    const rules = allRules.filter((r) => r.enabled);
    const result: RetentionSweepResult = {
      dryRun,
      rulesEvaluated: 0,
      rulesSkipped: [],
      serverErrors: [],
      staged: 0,
      dropped: 0,
      applied: 0,
      failed: 0,
      matches: [],
    };

    if (!dryRun) {
      // Candidates of disabled rules would never be applied; drop the waiting ones.
      const disabled = allRules.filter((r) => !r.enabled).map((r) => r.id);
      if (disabled.length > 0) {
        result.dropped += this.db
          .delete(retentionCandidates)
          .where(and(inArray(retentionCandidates.ruleId, disabled), inArray(retentionCandidates.status, ['pending', 'failed'])))
          .returning()
          .all().length;
      }
    }
    if (rules.length === 0) return result;

    const types = [...new Set(rules.map((r) => r.mediaType))];
    const items = new Map(types.map((t) => [t, this.libraryItems(t)] as const));
    const requested = new Map(types.map((t) => [t, this.lastRequests(t)] as const));

    // Play state, per media type, only when some rule needs it.
    const watchTypes = [...new Set(rules.filter(needsWatch).map((r) => r.mediaType))];
    const watch = new Map<MediaKind, WatchMap | null>();
    let watchProblem: string | null = null;
    if (watchTypes.length > 0) {
      const servers = this.servers();
      if (servers.length === 0) watchProblem = 'no enabled media server is flagged for retention';
      for (const type of watchTypes) {
        if (watchProblem) {
          watch.set(type, null);
          continue;
        }
        const map = await this.watchFacts(type, items.get(type) ?? [], servers, result.serverErrors);
        watch.set(type, map);
        if (!map) watchProblem = 'a media server could not be read';
      }
    }

    const staged: RetentionLine[] = [];
    const evaluated = new Set<number>();
    for (const rule of rules) {
      const watchMap = watch.get(rule.mediaType);
      if (needsWatch(rule) && !watchMap) {
        result.rulesSkipped.push({ ruleId: rule.id, ruleName: rule.name, reason: watchProblem ?? 'no play state available' });
        continue;
      }
      evaluated.add(rule.id);
      result.rulesEvaluated++;
      const ruleInput = toRule(rule);
      const matched = new Set<number>();
      for (const item of items.get(rule.mediaType) ?? []) {
        const facts: WatchFacts | null = watchMap ? (watchMap.get(item.id) ?? { found: false, users: [], lastPlayedAt: null }) : null;
        const ev = evaluateRule(ruleInput, item, { now, watch: facts, lastRequestedAt: requested.get(rule.mediaType)?.get(item.tmdbId) ?? null });
        if (!ev.match) continue;
        matched.add(item.id);
        const preview: RetentionSweepPreview = {
          ruleId: rule.id,
          ruleName: rule.name,
          mediaType: item.mediaType,
          mediaId: item.id,
          title: item.title,
          action: rule.action,
          reasons: ev.reasons,
          sizeBytes: item.sizeBytes,
        };
        result.matches.push(preview);
        if (dryRun) continue;
        const line = this.stage(rule, item, ev.reasons, ev.watchedBy, now);
        if (line) {
          result.staged++;
          staged.push(line);
        }
      }
      if (!dryRun) result.dropped += this.dropUnmatched(rule.id, matched);
    }

    if (dryRun) return result;

    // Apply what is due: waiting (or previously failed) candidates of rules evaluated just now.
    const applied: RetentionLine[] = [];
    const failed: RetentionLine[] = [];
    let freedBytes = 0;
    const byId = new Map(rules.map((r) => [r.id, r]));
    const due = this.db
      .select()
      .from(retentionCandidates)
      .where(inArray(retentionCandidates.status, ['pending', 'failed']))
      .orderBy(asc(retentionCandidates.applyAfter))
      .all()
      .filter((c) => c.applyAfter <= nowIso && evaluated.has(c.ruleId) && byId.get(c.ruleId)?.dryRun === false);
    for (const candidate of due) {
      const rule = byId.get(candidate.ruleId)!;
      const outcome = await this.runApply(candidate, rule);
      const line = lineOf(candidate, rule, false);
      if (outcome.ok) {
        result.applied++;
        freedBytes += outcome.freedBytes;
        applied.push(line);
      } else {
        result.failed++;
        failed.push({ ...line, ...(outcome.error ? { error: outcome.error } : {}) });
      }
    }

    if (this.notify && (staged.length > 0 || applied.length > 0 || failed.length > 0)) {
      const event: RetentionEvent = {
        type: 'retention',
        instanceName: this.instanceName,
        ...(this.applicationUrl ? { applicationUrl: this.applicationUrl } : {}),
        timestamp: nowIso,
        staged: staged.slice(0, SUMMARY_LINES),
        applied: applied.slice(0, SUMMARY_LINES),
        failed: failed.slice(0, SUMMARY_LINES),
        totalStaged: staged.length,
        totalApplied: applied.length,
        totalFailed: failed.length,
        freedBytes,
      };
      await this.notify(event).catch((err: unknown) => this.log?.warn({ err }, 'retention summary notification failed'));
    }
    return result;
  }

  /** Inserts or refreshes the candidate; returns a summary line when it is newly staged. */
  private stage(rule: RetentionRuleRow, item: LibraryItemFacts, reasons: string[], watchedBy: string[], now: Date): RetentionLine | null {
    const nowIso = now.toISOString();
    const applyAfter = new Date(now.getTime() + rule.graceDays * DAY_MS).toISOString();
    const existing = this.db
      .select()
      .from(retentionCandidates)
      .where(and(eq(retentionCandidates.ruleId, rule.id), eq(retentionCandidates.mediaType, item.mediaType), eq(retentionCandidates.mediaId, item.id)))
      .get();
    const facts = { tmdbId: item.tmdbId, title: item.title, year: item.year, sizeBytes: item.sizeBytes, reasons, watchedBy, lastSeenAt: nowIso };
    if (!existing) {
      const row = this.db
        .insert(retentionCandidates)
        .values({
          ruleId: rule.id,
          mediaType: item.mediaType,
          mediaId: item.id,
          action: rule.action,
          status: 'pending',
          firstSeenAt: nowIso,
          applyAfter,
          ...facts,
        })
        .returning()
        .get();
      return lineOf(row, rule);
    }
    if (existing.status === 'applied') {
      // Applied before and matching again (re-monitored, re-downloaded): a new cycle.
      const row = this.db
        .update(retentionCandidates)
        .set({ ...facts, status: 'pending', action: rule.action, firstSeenAt: nowIso, applyAfter, appliedAt: null, error: null })
        .where(eq(retentionCandidates.id, existing.id))
        .returning()
        .get();
      return row ? lineOf(row, rule) : null;
    }
    // Pending/failed follow grace changes from their first sighting; kept rows only refresh facts.
    const patch =
      existing.status === 'kept'
        ? facts
        : { ...facts, action: rule.action, applyAfter: new Date(Date.parse(existing.firstSeenAt) + rule.graceDays * DAY_MS).toISOString() };
    this.db.update(retentionCandidates).set(patch).where(eq(retentionCandidates.id, existing.id)).run();
    return null;
  }

  private dropUnmatched(ruleId: number, matched: Set<number>): number {
    const waiting = this.db
      .select({ id: retentionCandidates.id, mediaId: retentionCandidates.mediaId })
      .from(retentionCandidates)
      .where(and(eq(retentionCandidates.ruleId, ruleId), inArray(retentionCandidates.status, ['pending', 'failed'])))
      .all()
      .filter((c) => !matched.has(c.mediaId))
      .map((c) => c.id);
    if (waiting.length === 0) return 0;
    this.db.delete(retentionCandidates).where(inArray(retentionCandidates.id, waiting)).run();
    return waiting.length;
  }

  // ---- inputs ----------------------------------------------------------------------------

  /** Library facts for every series or movie. */
  libraryItems(mediaType: MediaKind): LibraryItemFacts[] {
    const sizes = new Map<number, number>();
    const files = this.db
      .select({ seriesId: mediaFiles.seriesId, movieId: mediaFiles.movieId, sizeBytes: mediaFiles.sizeBytes })
      .from(mediaFiles)
      .where(eq(mediaFiles.mediaType, mediaType))
      .all();
    const counts = new Map<number, number>();
    for (const f of files) {
      const owner = mediaType === 'series' ? f.seriesId : f.movieId;
      if (owner === null) continue;
      sizes.set(owner, (sizes.get(owner) ?? 0) + f.sizeBytes);
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    const base = (r: { id: number; tmdbId: number; imdbId: string | null; title: string; year: number; tags: number[]; rootFolderPath: string; path: string; added: string; monitored: boolean }) => ({
      id: r.id,
      tmdbId: r.tmdbId,
      imdbId: r.imdbId,
      title: r.title,
      year: r.year || null,
      tags: r.tags,
      rootFolderPath: r.rootFolderPath,
      path: r.path,
      added: r.added,
      monitored: r.monitored,
      sizeBytes: sizes.get(r.id) ?? 0,
      hasFiles: (counts.get(r.id) ?? 0) > 0,
    });
    if (mediaType === 'series') {
      return this.db
        .select()
        .from(series)
        .all()
        .map((r) => ({ ...base(r), mediaType: 'series' as const, tvdbId: r.tvdbId, inCollection: false }));
    }
    return this.db
      .select()
      .from(movies)
      .all()
      .map((r) => ({ ...base(r), mediaType: 'movie' as const, tvdbId: null, inCollection: r.collection !== null && r.collection !== undefined }));
  }

  /** Latest request date per TMDB id. */
  private lastRequests(mediaType: MediaKind): Map<number, string> {
    const out = new Map<number, string>();
    for (const r of this.db
      .select({ tmdbId: mediaRequests.tmdbId, createdAt: mediaRequests.createdAt })
      .from(mediaRequests)
      .where(eq(mediaRequests.type, mediaType))
      .all()) {
      const prev = out.get(r.tmdbId);
      if (!prev || r.createdAt > prev) out.set(r.tmdbId, r.createdAt);
    }
    return out;
  }

  /**
   * Who watched what, merged across servers by user name. Returns null when any server
   * failed (the caller skips watch rules then); errors are appended to `errors`.
   */
  private async watchFacts(
    mediaType: MediaKind,
    items: LibraryItemFacts[],
    servers: ConfiguredClient[],
    errors: Array<{ server: string; message: string }>,
  ): Promise<WatchMap | null> {
    const byKey = new Map<string, number>();
    for (const item of items) {
      byKey.set(`tmdb:${item.tmdbId}`, item.id);
      if (item.tvdbId) byKey.set(`tvdb:${item.tvdbId}`, item.id);
      if (item.imdbId) byKey.set(`imdb:${item.imdbId.toLowerCase()}`, item.id);
    }
    const lookup = (ids: { tmdbId: number | null; tvdbId: number | null; imdbId: string | null }): number | undefined =>
      (ids.tmdbId !== null ? byKey.get(`tmdb:${ids.tmdbId}`) : undefined) ??
      (ids.tvdbId !== null ? byKey.get(`tvdb:${ids.tvdbId}`) : undefined) ??
      (ids.imdbId !== null ? byKey.get(`imdb:${ids.imdbId.toLowerCase()}`) : undefined);

    const merged = new Map<number, { found: boolean; users: Map<string, UserWatch>; lastPlayedAt: string | null }>();
    let ok = true;
    for (const { config, client } of servers) {
      try {
        const users = (await client.users()).filter((u) => !u.isDisabled);
        for (const user of users) {
          for (const { item, state } of await client.listPlayStates(user.id, mediaType)) {
            const id = lookup(item.ids);
            if (id === undefined) continue;
            let entry = merged.get(id);
            if (!entry) {
              entry = { found: true, users: new Map(), lastPlayedAt: null };
              merged.set(id, entry);
            }
            const key = user.name.toLowerCase();
            const watch = entry.users.get(key) ?? { name: user.name, played: false, lastPlayedAt: null };
            watch.played ||= state.played;
            watch.lastPlayedAt = later(watch.lastPlayedAt, state.lastPlayedAt);
            entry.users.set(key, watch);
            entry.lastPlayedAt = later(entry.lastPlayedAt, state.lastPlayedAt);
          }
        }
      } catch (err) {
        ok = false;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ server: config.name, message });
        this.log?.warn({ err, server: config.name }, 'retention: media server could not be read');
      }
    }
    if (!ok) return null;
    return new Map([...merged].map(([id, e]) => [id, { found: e.found, users: [...e.users.values()], lastPlayedAt: e.lastPlayedAt }]));
  }

  // ---- helpers ---------------------------------------------------------------------------

  private requireRule(id: number): RetentionRuleRow {
    const row = this.db.select().from(retentionRules).where(eq(retentionRules.id, id)).get();
    if (!row) throw ruleNotFound(id);
    return row;
  }

  private requireCandidate(id: number): RetentionCandidateRow {
    const row = this.db.select().from(retentionCandidates).where(eq(retentionCandidates.id, id)).get();
    if (!row) throw new RetentionError('NOT_FOUND', `Retention candidate ${id} not found`);
    return row;
  }

  private assertUniqueName(name: string, selfId: number | null): void {
    const clash = this.db
      .select({ id: retentionRules.id, name: retentionRules.name })
      .from(retentionRules)
      .all()
      .find((r) => r.id !== selfId && r.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new RetentionError('CONFLICT', `A retention rule named "${name}" already exists`);
  }
}

function needsWatch(rule: Pick<RetentionRuleRow, 'conditions'>): boolean {
  return rule.conditions.some((c) => WATCH_CONDITIONS.has(c.type));
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function ruleNotFound(id: number): RetentionError {
  return new RetentionError('NOT_FOUND', `Retention rule ${id} not found`);
}

function parseRule(raw: RetentionRuleInputRaw): RetentionRuleInput {
  const parsed = RetentionRuleInput.safeParse(raw);
  if (!parsed.success) throw new RetentionError('VALIDATION', z.prettifyError(parsed.error));
  return parsed.data;
}

function toRule(row: RetentionRuleRow): RetentionRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    mediaType: row.mediaType,
    scope: row.scope,
    conditions: row.conditions,
    graceDays: row.graceDays,
    action: row.action,
    addExclusion: row.addExclusion,
    keepIfRequestedWithinDays: row.keepIfRequestedWithinDays,
    keepIfInCollection: row.keepIfInCollection,
    dryRun: row.dryRun,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCandidate(row: RetentionCandidateRow, rule: RetentionRuleRow | undefined): RetentionCandidate {
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: rule?.name ?? '',
    mediaType: row.mediaType,
    mediaId: row.mediaId,
    tmdbId: row.tmdbId,
    title: row.title,
    year: row.year,
    sizeBytes: row.sizeBytes,
    action: row.action,
    reasons: row.reasons,
    watchedBy: row.watchedBy,
    status: row.status,
    dryRun: rule?.dryRun ?? false,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    applyAfter: row.applyAfter,
    appliedAt: row.appliedAt,
    keptAt: row.keptAt,
    error: row.error,
  };
}

function lineOf(row: RetentionCandidateRow, rule: RetentionRuleRow, withApplyAfter = row.status === 'pending'): RetentionLine {
  return {
    mediaType: row.mediaType,
    title: row.title,
    ...(row.year ? { year: row.year } : {}),
    rule: rule.name,
    action: rule.action,
    sizeBytes: row.sizeBytes,
    reasons: row.reasons,
    ...(withApplyAfter ? { applyAfter: row.applyAfter } : {}),
  };
}
