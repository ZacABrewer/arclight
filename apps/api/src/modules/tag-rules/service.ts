import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  ALL_QUALITIES,
  BEHAVIOUR_TAG_KINDS,
  QualitySource,
  TAG_ENTITY_TYPES,
  TagRuleInput,
  templateVariables,
  sanitizeTagLabel,
  type Tag,
  type TagApplication,
  type TagBehaviourUse,
  type TagEntityType,
  type TagRule,
  type TagRuleOptions,
  type TagRuleRunResult,
  type TagRuleRunSummary,
  type TagRuleSampleItem,
  type TagUsage,
  type TagUsageKind,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import * as s from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { diffPlan, isEmptyDiff, planItem, type EngineRule, type EvalContext } from './engine.js';
import { itemsByIds, loadFacts, loadLookups, pageItems, type TaggedItem } from './facts.js';
import { rewriteTagReferences, tagUsageCounts } from './references.js';
import { STARTER_RULES } from './starters.js';
import type { TagRuleRow } from './schema.js';

export type TagRulesErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT';

export class TagRulesError extends Error {
  constructor(
    readonly code: TagRulesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TagRulesError';
  }
}

export interface TagRulesServiceOptions {
  db: Db;
  bus?: EventBus;
  log?: Logger;
  now?: () => Date;
  /** Items per page (facts loaded and diffs written per page). */
  batchSize?: number;
}

/** Settings row that records the starter rules were added once (deleting them keeps them gone). */
const STARTERS_KEY = 'tagRules.starters';
/** Items changed by one run above which no per-item library events are published. */
const MAX_ITEM_EVENTS = 50;
const MAX_SAMPLES = 25;

interface RunRule extends EngineRule {
  name: string;
}

interface RunScope {
  /** Only these items (event-triggered runs); all items of the rules' types when absent. */
  items?: Partial<Record<TagEntityType, readonly number[]>>;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const nowIso = (d: Date) => d.toISOString();

export class TagRulesService {
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(private readonly opts: TagRulesServiceOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
    this.batchSize = opts.batchSize ?? 500;
  }

  // -------------------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------------------

  listRules(): TagRule[] {
    const rows = this.db.select().from(s.tagRules).orderBy(asc(s.tagRules.sortOrder), asc(s.tagRules.id)).all();
    const counts = new Map(
      this.db
        .select({ ruleId: s.tagRuleApplications.ruleId, n: sql<number>`count(DISTINCT ${s.tagRuleApplications.entityType} || ':' || ${s.tagRuleApplications.entityId})` })
        .from(s.tagRuleApplications)
        .groupBy(s.tagRuleApplications.ruleId)
        .all()
        .map((r) => [r.ruleId, Number(r.n)]),
    );
    return rows.map((r) => this.toRule(r, counts.get(r.id) ?? 0));
  }

  getRule(id: number): TagRule {
    const row = this.row(id);
    const n = this.db
      .select({ n: sql<number>`count(DISTINCT ${s.tagRuleApplications.entityType} || ':' || ${s.tagRuleApplications.entityId})` })
      .from(s.tagRuleApplications)
      .where(eq(s.tagRuleApplications.ruleId, id))
      .get();
    return this.toRule(row, Number(n?.n ?? 0));
  }

  createRule(input: TagRuleInput): TagRule {
    this.checkTagIds(input);
    const at = nowIso(this.now());
    const max = this.db.select({ m: sql<number | null>`max(${s.tagRules.sortOrder})` }).from(s.tagRules).get();
    const row = this.db
      .insert(s.tagRules)
      .values({ ...this.columns(input), sortOrder: (max?.m ?? -1) + 1, starterKey: null, createdAt: at, updatedAt: at })
      .returning()
      .get();
    return this.toRule(row, 0);
  }

  updateRule(id: number, input: TagRuleInput): TagRule {
    this.row(id);
    this.checkTagIds(input);
    this.db
      .update(s.tagRules)
      .set({ ...this.columns(input), updatedAt: nowIso(this.now()) })
      .where(eq(s.tagRules.id, id))
      .run();
    return this.getRule(id);
  }

  /** Deletes a rule; `removeTags` first takes off the tags only this rule added. */
  deleteRule(id: number, opts: { removeTags: boolean }): void {
    this.row(id);
    this.db.transaction((tx) => {
      if (opts.removeTags) {
        const mine = tx.select().from(s.tagRuleApplications).where(eq(s.tagRuleApplications.ruleId, id)).all();
        for (const type of TAG_ENTITY_TYPES) {
          const rows = mine.filter((a) => a.entityType === type);
          if (rows.length === 0) continue;
          const others = new Set(
            tx
              .select({ entityId: s.tagRuleApplications.entityId, tagId: s.tagRuleApplications.tagId, ruleId: s.tagRuleApplications.ruleId })
              .from(s.tagRuleApplications)
              .where(and(eq(s.tagRuleApplications.entityType, type), inArray(s.tagRuleApplications.tagId, [...new Set(rows.map((r) => r.tagId))])))
              .all()
              .filter((a) => a.ruleId !== id)
              .map((a) => `${a.entityId}:${a.tagId}`),
          );
          const byItem = new Map<number, number[]>();
          for (const r of rows) {
            if (others.has(`${r.entityId}:${r.tagId}`)) continue;
            byItem.set(r.entityId, [...(byItem.get(r.entityId) ?? []), r.tagId]);
          }
          for (const [entityId, tagIds] of byItem) writeItemTags(tx, type, entityId, [], tagIds);
        }
      }
      tx.delete(s.tagRules).where(eq(s.tagRules.id, id)).run();
    });
  }

  reorder(ids: readonly number[]): TagRule[] {
    const existing = this.db.select({ id: s.tagRules.id }).from(s.tagRules).orderBy(asc(s.tagRules.sortOrder), asc(s.tagRules.id)).all().map((r) => r.id);
    const unknown = ids.filter((id) => !existing.includes(id));
    if (unknown.length > 0) throw new TagRulesError('VALIDATION', `unknown rule ids: ${unknown.join(', ')}`);
    // Listed rules first in the given order, then any the caller left out, in their old order.
    const order = [...new Set(ids), ...existing.filter((id) => !ids.includes(id))];
    this.db.transaction((tx) => {
      order.forEach((id, i) => tx.update(s.tagRules).set({ sortOrder: i }).where(eq(s.tagRules.id, id)).run());
    });
    return this.listRules();
  }

  /** Adds the shipped starter rules (disabled) once per database. */
  seedStarterRules(): number {
    const seeded = this.db.select().from(s.settings).where(eq(s.settings.key, STARTERS_KEY)).get();
    if (seeded) return 0;
    const at = nowIso(this.now());
    let n = 0;
    this.db.transaction((tx) => {
      const max = tx.select({ m: sql<number | null>`max(${s.tagRules.sortOrder})` }).from(s.tagRules).get();
      let order = (max?.m ?? -1) + 1;
      for (const starter of STARTER_RULES) {
        const input = TagRuleInput.parse(starter.rule);
        tx.insert(s.tagRules)
          .values({ ...this.columns(input), sortOrder: order++, starterKey: starter.key, createdAt: at, updatedAt: at })
          .run();
        n++;
      }
      tx.insert(s.settings).values({ key: STARTERS_KEY, value: { seededAt: at, keys: STARTER_RULES.map((r) => r.key) }, updatedAt: at }).run();
    });
    return n;
  }

  // -------------------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------------------

  /** Dry run of one rule as edited. `id`: the saved rule it replaces (its ownership drives removals). */
  preview(input: TagRuleInput, id?: number): TagRuleRunResult {
    this.checkTagIds(input);
    const ruleId = id ?? -1;
    if (id !== undefined) this.row(id);
    const labels = this.tagLabels();
    const rule: RunRule = { ...this.engineRule({ ...this.columns(input), id: ruleId }, labels), name: input.name };
    return this.execute([rule], {}, true);
  }

  /** Runs every enabled rule, or the listed ones (enabled or not), in rule order. */
  run(opts: { ruleIds?: readonly number[] | undefined; dryRun?: boolean } = {}): TagRuleRunResult {
    const rows = this.db.select().from(s.tagRules).orderBy(asc(s.tagRules.sortOrder), asc(s.tagRules.id)).all();
    let chosen: TagRuleRow[];
    if (opts.ruleIds && opts.ruleIds.length > 0) {
      const missing = opts.ruleIds.filter((id) => !rows.some((r) => r.id === id));
      if (missing.length > 0) throw new TagRulesError('NOT_FOUND', `tag rule ${missing.join(', ')} not found`);
      chosen = rows.filter((r) => opts.ruleIds!.includes(r.id));
    } else {
      chosen = rows.filter((r) => r.enabled);
    }
    const labels = this.tagLabels();
    return this.execute(
      chosen.map((r) => ({ ...this.engineRule(r, labels), name: r.name })),
      {},
      opts.dryRun ?? false,
    );
  }

  /** Event-triggered: every enabled rule over just these items. */
  runForItems(items: Partial<Record<TagEntityType, readonly number[]>>): TagRuleRunResult | null {
    const rows = this.db.select().from(s.tagRules).where(eq(s.tagRules.enabled, true)).orderBy(asc(s.tagRules.sortOrder), asc(s.tagRules.id)).all();
    if (rows.length === 0) return null;
    const labels = this.tagLabels();
    return this.execute(
      rows.map((r) => ({ ...this.engineRule(r, labels), name: r.name })),
      { items },
      false,
      { recordLastRun: false },
    );
  }

  /** Forgets ownership rows of items that no longer exist. */
  pruneOrphans(): number {
    let n = 0;
    for (const type of TAG_ENTITY_TYPES) {
      const table = { movie: 'movies', series: 'series', artist: 'artists', author: 'authors' }[type];
      const r = this.db.run(sql.raw(`DELETE FROM tag_rule_applications WHERE entity_type = '${type}' AND entity_id NOT IN (SELECT id FROM "${table}")`));
      n += Number(r.changes ?? 0);
    }
    return n;
  }

  private execute(rules: RunRule[], scope: RunScope, dryRun: boolean, opts: { recordLastRun?: boolean } = {}): TagRuleRunResult {
    const started = Date.now();
    const now = this.now();
    const tagRows = this.db.select().from(s.tags).all();
    const labelById = new Map(tagRows.map((t) => [t.id, t.label]));
    const ctx: EvalContext = { now, tagLabels: labelById };
    const lookups = loadLookups(this.db);
    const ruleIds = new Set(rules.map((r) => r.id));

    const addCounts = new Map<string, number>();
    const removeCounts = new Map<string, number>();
    const matchedByType: Record<string, number> = {};
    const samples: TagRuleSampleItem[] = [];
    const perRule = new Map<number, { evaluated: number; changed: number; added: number; removed: number }>(
      rules.map((r) => [r.id, { evaluated: 0, changed: 0, added: 0, removed: 0 }]),
    );
    const changedItems: Array<{ type: TagEntityType; id: number }> = [];
    let evaluated = 0;
    let matchedItems = 0;
    let changed = 0;

    const types = TAG_ENTITY_TYPES.filter((t) => rules.some((r) => r.appliesTo.includes(t)) && (!scope.items || (scope.items[t]?.length ?? 0) > 0));
    for (const type of types) {
      const typeRules = rules.filter((r) => r.appliesTo.includes(type));
      const pages = this.pagesOf(type, scope.items?.[type]);
      for (const page of pages) {
        const facts = loadFacts(this.db, type, page.map((p) => p.id), lookups);
        const tagsById = new Map(page.map((p) => [p.id, p.tags]));
        const owners = this.ownersOf(type, page.map((p) => p.id), labelById);
        const writes: Array<{ id: number; add: string[]; remove: string[]; own: Array<[string, number]>; disown: Array<[string, number]> }> = [];
        for (const f of facts) {
          evaluated++;
          for (const r of typeRules) perRule.get(r.id)!.evaluated++;
          const labels = new Set((tagsById.get(f.id) ?? []).map((id) => labelById.get(id)).filter((l): l is string => l !== undefined));
          const state = { labels, owners: owners.get(f.id) ?? new Map<string, Set<number>>() };
          const plan = planItem(typeRules, f, state, ctx);
          if (plan.matched.length > 0) {
            matchedItems++;
            matchedByType[type] = (matchedByType[type] ?? 0) + 1;
          }
          const diff = diffPlan(state, plan);
          // Ownership rows of rules outside this run are never touched.
          diff.own = diff.own.filter(([, id]) => ruleIds.has(id));
          diff.disown = diff.disown.filter(([label, id]) => ruleIds.has(id) || !plan.labels.has(label));
          if (isEmptyDiff(diff)) continue;
          for (const l of diff.add) addCounts.set(l, (addCounts.get(l) ?? 0) + 1);
          for (const l of diff.remove) removeCounts.set(l, (removeCounts.get(l) ?? 0) + 1);
          const touched = new Set<number>();
          for (const [, id] of diff.own) {
            const pr = perRule.get(id);
            if (pr) (pr.added++, touched.add(id));
          }
          for (const [, id] of diff.disown) {
            const pr = perRule.get(id);
            if (pr) (pr.removed++, touched.add(id));
          }
          for (const id of touched) perRule.get(id)!.changed++;
          if (diff.add.length > 0 || diff.remove.length > 0) {
            changed++;
            changedItems.push({ type, id: f.id });
            if (samples.length < MAX_SAMPLES) samples.push({ entityType: type, id: f.id, title: f.title, add: diff.add, remove: diff.remove });
          }
          writes.push({ id: f.id, ...diff });
        }
        if (!dryRun && writes.length > 0) this.writePage(type, writes, now);
      }
    }

    const existing = new Set(tagRows.map((t) => t.label));
    const toChanges = (m: Map<string, number>) =>
      [...m]
        .map(([label, count]) => ({ label, count, isNew: !existing.has(label) }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    const result: TagRuleRunResult = {
      dryRun,
      itemsEvaluated: evaluated,
      itemsMatched: matchedItems,
      itemsChanged: changed,
      matchedByType,
      add: toChanges(addCounts),
      remove: toChanges(removeCounts),
      samples,
      behaviour: this.behaviourOf([...addCounts.keys(), ...removeCounts.keys()]),
      durationMs: Date.now() - started,
    };

    if (!dryRun) {
      if (opts.recordLastRun !== false) {
        const at = nowIso(now);
        for (const r of rules) {
          if (r.id < 0) continue;
          const pr = perRule.get(r.id)!;
          const summary: TagRuleRunSummary = { at, itemsEvaluated: pr.evaluated, itemsChanged: pr.changed, tagsAdded: pr.added, tagsRemoved: pr.removed };
          this.db.update(s.tagRules).set({ lastRun: summary }).where(eq(s.tagRules.id, r.id)).run();
        }
      }
      if (changed > 0) {
        if (changedItems.length <= MAX_ITEM_EVENTS) {
          for (const item of changedItems) {
            if (item.type === 'movie' || item.type === 'series') this.opts.bus?.publish({ type: 'library', action: 'updated', mediaType: item.type, id: item.id });
          }
        }
        this.opts.bus?.publish({ type: 'settings', section: 'tags' });
        this.opts.log?.info({ itemsChanged: changed, rules: rules.length }, 'tag rules applied');
      }
    }
    return result;
  }

  private *pagesOf(type: TagEntityType, ids: readonly number[] | undefined): Generator<TaggedItem[]> {
    if (ids) {
      const unique = [...new Set(ids)];
      for (let i = 0; i < unique.length; i += this.batchSize) yield itemsByIds(this.db, type, unique.slice(i, i + this.batchSize));
      return;
    }
    let after = 0;
    for (;;) {
      const page = pageItems(this.db, type, after, this.batchSize);
      if (page.length === 0) return;
      yield page;
      after = page[page.length - 1]!.id;
      if (page.length < this.batchSize) return;
    }
  }

  /** item id → label → owning rule ids. */
  private ownersOf(type: TagEntityType, ids: readonly number[], labelById: ReadonlyMap<number, string>): Map<number, Map<string, Set<number>>> {
    const out = new Map<number, Map<string, Set<number>>>();
    if (ids.length === 0) return out;
    const rows = this.db
      .select({ entityId: s.tagRuleApplications.entityId, tagId: s.tagRuleApplications.tagId, ruleId: s.tagRuleApplications.ruleId })
      .from(s.tagRuleApplications)
      .where(and(eq(s.tagRuleApplications.entityType, type), inArray(s.tagRuleApplications.entityId, [...ids])))
      .all();
    for (const r of rows) {
      const label = labelById.get(r.tagId);
      if (label === undefined) continue;
      const m = out.get(r.entityId) ?? new Map<string, Set<number>>();
      const set = m.get(label) ?? new Set<number>();
      set.add(r.ruleId);
      m.set(label, set);
      out.set(r.entityId, m);
    }
    return out;
  }

  /** Writes one page of diffs in a transaction: creates missing tags, applies add/remove to the item's current tags, records ownership. */
  private writePage(
    type: TagEntityType,
    writes: ReadonlyArray<{ id: number; add: string[]; remove: string[]; own: Array<[string, number]>; disown: Array<[string, number]> }>,
    now: Date,
  ): void {
    const at = nowIso(now);
    this.db.transaction((tx) => {
      const ids = new Map(tx.select().from(s.tags).all().map((t) => [t.label, t.id]));
      const idOf = (label: string): number => {
        const known = ids.get(label);
        if (known !== undefined) return known;
        const row = tx.insert(s.tags).values({ label }).returning().get();
        ids.set(label, row.id);
        return row.id;
      };
      for (const w of writes) {
        const addIds = w.add.map(idOf);
        const removeIds = w.remove.map((l) => ids.get(l)).filter((id): id is number => id !== undefined);
        if (addIds.length > 0 || removeIds.length > 0) writeItemTags(tx, type, w.id, addIds, removeIds);
        for (const [label, ruleId] of w.disown) {
          const tagId = ids.get(label);
          if (tagId === undefined) continue;
          tx.delete(s.tagRuleApplications)
            .where(
              and(
                eq(s.tagRuleApplications.ruleId, ruleId),
                eq(s.tagRuleApplications.entityType, type),
                eq(s.tagRuleApplications.entityId, w.id),
                eq(s.tagRuleApplications.tagId, tagId),
              ),
            )
            .run();
        }
        for (const [label, ruleId] of w.own) {
          if (ruleId < 0) continue;
          tx.insert(s.tagRuleApplications).values({ ruleId, entityType: type, entityId: w.id, tagId: idOf(label), appliedAt: at }).onConflictDoNothing().run();
        }
      }
    });
  }

  // -------------------------------------------------------------------------------------
  // Item markers and editor options
  // -------------------------------------------------------------------------------------

  applied(entityType: TagEntityType, entityId: number): TagApplication[] {
    return this.db
      .select({ tagId: s.tagRuleApplications.tagId, ruleId: s.tagRuleApplications.ruleId, ruleName: s.tagRules.name })
      .from(s.tagRuleApplications)
      .innerJoin(s.tagRules, eq(s.tagRules.id, s.tagRuleApplications.ruleId))
      .where(and(eq(s.tagRuleApplications.entityType, entityType), eq(s.tagRuleApplications.entityId, entityId)))
      .orderBy(asc(s.tagRuleApplications.tagId), asc(s.tagRules.sortOrder))
      .all();
  }

  options(): TagRuleOptions {
    const distinct = (query: string): string[] =>
      this.db
        .all<{ v: unknown }>(sql.raw(query))
        .map((r) => (r.v === null || r.v === undefined ? '' : String(r.v).trim()))
        .filter((v) => v !== '');
    const merge = (...lists: string[][]): string[] => {
      const seen = new Map<string, string>();
      for (const l of lists) for (const v of l) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
      return [...seen.values()].sort((a, b) => a.localeCompare(b)).slice(0, 1000);
    };
    const genres = merge(
      distinct(`SELECT DISTINCT j.value AS v FROM movies m, json_each(m.genres) j`),
      distinct(`SELECT DISTINCT j.value AS v FROM series m, json_each(m.genres) j`),
      distinct(`SELECT DISTINCT j.value AS v FROM artists m, json_each(m.genres) j`),
      distinct(`SELECT DISTINCT j.value AS v FROM authors m, json_each(m.genres) j`),
      distinct(`SELECT DISTINCT j.value AS v FROM books m, json_each(m.genres) j`),
    );
    const values: Record<string, string[]> = {
      genre: genres,
      resolution: ['2160p', '1440p', '1080p', '720p', '576p', '480p', '360p'],
      quality: merge(ALL_QUALITIES.map((q) => q.name).filter((n) => n !== 'Unknown')),
      source: QualitySource.options.filter((o) => o !== 'unknown'),
      hdr: ['dv', 'hdr10+', 'hdr10', 'hlg', 'pq', 'hdr'],
      videoCodec: ['hevc', 'h264', 'av1', 'vp9', 'vc1', 'mpeg2', 'xvid'],
      audioCodec: merge(
        distinct(`SELECT DISTINCT lower(json_extract(media_info, '$.audioCodec')) AS v FROM media_files WHERE media_info IS NOT NULL`),
        distinct(`SELECT DISTINCT lower(codec) AS v FROM audio_files`),
      ),
      audioLanguage: merge(
        distinct(`SELECT DISTINCT lower(j.value) AS v FROM media_files f, json_each(f.media_info, '$.audioLanguages') j WHERE f.media_info IS NOT NULL`),
        distinct(`SELECT DISTINCT lower(j.value) AS v FROM media_files f, json_each(f.languages) j`),
      ),
      originalLanguage: merge(distinct(`SELECT DISTINCT original_language AS v FROM movies`), distinct(`SELECT DISTINCT original_language AS v FROM series`)),
      certification: merge(distinct(`SELECT DISTINCT certification AS v FROM movies`), distinct(`SELECT DISTINCT certification AS v FROM series`)),
      network: merge(distinct(`SELECT DISTINCT network AS v FROM series`)),
      studio: merge(distinct(`SELECT DISTINCT studio AS v FROM movies`)),
      status: ['continuing', 'ended', 'upcoming', 'tba', 'announced', 'inCinemas', 'released'],
      seriesType: ['standard', 'daily', 'anime'],
      rootFolder: merge(distinct(`SELECT path AS v FROM root_folders`)),
      collection: merge(distinct(`SELECT DISTINCT json_extract(collection, '$.title') AS v FROM movies WHERE collection IS NOT NULL`)),
      releaseGroup: merge(distinct(`SELECT DISTINCT release_group AS v FROM media_files`), distinct(`SELECT DISTINCT release_group AS v FROM audio_files`)),
      albumType: merge(
        ['Album', 'EP', 'Single', 'Broadcast', 'Other'],
        distinct(`SELECT DISTINCT primary_type AS v FROM albums`),
        distinct(`SELECT DISTINCT j.value AS v FROM albums a, json_each(a.secondary_types) j`),
      ),
      artistType: merge(distinct(`SELECT DISTINCT artist_type AS v FROM artists`)),
      author: merge(distinct(`SELECT name AS v FROM authors`)),
      narrator: merge(distinct(`SELECT DISTINCT j.value AS v FROM books b, json_each(b.narrators) j`)),
      bookSeries: merge(distinct(`SELECT DISTINCT name AS v FROM book_series`)),
    };
    const users = this.db
      .select({ id: s.users.id, username: s.users.username, displayName: s.users.displayName })
      .from(s.users)
      .orderBy(asc(s.users.username))
      .all()
      .map((u) => ({ id: u.id, name: u.displayName || u.username }));
    const qualityProfiles = this.db
      .select({ id: s.qualityProfiles.id, name: s.qualityProfiles.name, domain: s.qualityProfiles.mediaDomain })
      .from(s.qualityProfiles)
      .orderBy(asc(s.qualityProfiles.name))
      .all();
    return { values, users, qualityProfiles };
  }

  // -------------------------------------------------------------------------------------
  // Tag management
  // -------------------------------------------------------------------------------------

  usage(): TagUsage[] {
    const tags = this.db.select().from(s.tags).orderBy(asc(s.tags.label)).all();
    const counts = tagUsageCounts(this.db);
    const auto = new Map(
      this.db
        .select({ tagId: s.tagRuleApplications.tagId, n: sql<number>`count(DISTINCT ${s.tagRuleApplications.entityType} || ':' || ${s.tagRuleApplications.entityId})` })
        .from(s.tagRuleApplications)
        .groupBy(s.tagRuleApplications.tagId)
        .all()
        .map((r) => [r.tagId, Number(r.n)]),
    );
    const owners = new Map<number, Set<number>>();
    for (const r of this.db.selectDistinct({ tagId: s.tagRuleApplications.tagId, ruleId: s.tagRuleApplications.ruleId }).from(s.tagRuleApplications).all()) {
      owners.set(r.tagId, (owners.get(r.tagId) ?? new Set()).add(r.ruleId));
    }
    const rules = this.db.select({ id: s.tagRules.id, name: s.tagRules.name, addTags: s.tagRules.addTags }).from(s.tagRules).orderBy(asc(s.tagRules.sortOrder)).all();
    const fixed = new Map<string, Set<number>>();
    for (const r of rules) {
      for (const tpl of r.addTags) {
        if (templateVariables(tpl).length > 0) continue;
        const label = sanitizeTagLabel(tpl);
        fixed.set(label, (fixed.get(label) ?? new Set()).add(r.id));
      }
    }
    return tags.map((t) => {
      const perKind = counts.get(t.id) ?? new Map<TagUsageKind, number>();
      const ruleIds = new Set([...(owners.get(t.id) ?? []), ...(fixed.get(t.label) ?? [])]);
      let total = 0;
      let behaviourUses = 0;
      for (const [kind, n] of perKind) {
        total += n;
        if (BEHAVIOUR_TAG_KINDS.has(kind)) behaviourUses += n;
      }
      return {
        id: t.id,
        label: t.label,
        counts: Object.fromEntries(perKind),
        total,
        behaviourUses,
        autoApplied: auto.get(t.id) ?? 0,
        rules: rules.filter((r) => ruleIds.has(r.id)).map((r) => ({ id: r.id, name: r.name })),
      };
    });
  }

  /** Moves every use of `id` to `intoId`, then deletes `id`. */
  mergeTag(id: number, intoId: number): Tag {
    if (id === intoId) throw new TagRulesError('VALIDATION', 'a tag cannot be merged into itself');
    const from = this.tag(id);
    const into = this.tag(intoId);
    this.db.transaction((tx) => {
      rewriteTagReferences(tx, { from: id, into: intoId });
      // Fixed labels in rules follow the merge; templates are left alone.
      for (const r of tx.select({ id: s.tagRules.id, addTags: s.tagRules.addTags }).from(s.tagRules).all()) {
        if (!r.addTags.some((tpl) => templateVariables(tpl).length === 0 && sanitizeTagLabel(tpl) === from.label)) continue;
        const next = [...new Set(r.addTags.map((tpl) => (templateVariables(tpl).length === 0 && sanitizeTagLabel(tpl) === from.label ? into.label : tpl)))];
        tx.update(s.tagRules).set({ addTags: next, updatedAt: nowIso(this.now()) }).where(eq(s.tagRules.id, r.id)).run();
      }
      tx.delete(s.tags).where(eq(s.tags.id, id)).run();
    });
    this.opts.bus?.publish({ type: 'settings', section: 'tags' });
    return into;
  }

  /** Deletes tags and every reference to them. Without `force`, tags still in use are refused. */
  deleteTags(ids: readonly number[], force: boolean): { deleted: number } {
    const unique = [...new Set(ids)];
    const found = this.db.select().from(s.tags).where(inArray(s.tags.id, unique)).all();
    const missing = unique.filter((id) => !found.some((t) => t.id === id));
    if (missing.length > 0) throw new TagRulesError('NOT_FOUND', `tag ${missing.join(', ')} not found`);
    if (!force) {
      const counts = tagUsageCounts(this.db);
      const inUse = found.filter((t) => (counts.get(t.id)?.size ?? 0) > 0);
      if (inUse.length > 0) throw new TagRulesError('CONFLICT', `tags in use: ${inUse.map((t) => t.label).join(', ')}`);
    }
    this.db.transaction((tx) => {
      rewriteTagReferences(tx, { remove: unique });
      tx.delete(s.tags).where(inArray(s.tags.id, unique)).run();
    });
    this.opts.bus?.publish({ type: 'settings', section: 'tags' });
    return { deleted: found.length };
  }

  // -------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------

  private behaviourOf(labels: readonly string[]): TagBehaviourUse[] {
    if (labels.length === 0) return [];
    const tags = this.db.select().from(s.tags).where(inArray(s.tags.label, [...new Set(labels)])).all();
    if (tags.length === 0) return [];
    const counts = tagUsageCounts(this.db);
    const out: TagBehaviourUse[] = [];
    for (const t of tags) {
      const uses: Record<string, number> = {};
      for (const [kind, n] of counts.get(t.id) ?? []) if (BEHAVIOUR_TAG_KINDS.has(kind)) uses[kind] = n;
      if (Object.keys(uses).length > 0) out.push({ label: t.label, uses });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  private tagLabels(): Map<number, string> {
    return new Map(this.db.select().from(s.tags).all().map((t) => [t.id, t.label]));
  }

  private tag(id: number): Tag {
    const row = this.db.select().from(s.tags).where(eq(s.tags.id, id)).get();
    if (!row) throw new TagRulesError('NOT_FOUND', `tag ${id} not found`);
    return row;
  }

  private row(id: number): TagRuleRow {
    const row = this.db.select().from(s.tagRules).where(eq(s.tagRules.id, id)).get();
    if (!row) throw new TagRulesError('NOT_FOUND', `tag rule ${id} not found`);
    return row;
  }

  private checkTagIds(input: TagRuleInput): void {
    const ids = [...input.removeTagIds, ...input.conditions.flatMap((c) => (c.kind === 'ids' && c.field === 'tag' ? c.ids : []))];
    if (ids.length === 0) return;
    const known = new Set(this.db.select({ id: s.tags.id }).from(s.tags).where(inArray(s.tags.id, [...new Set(ids)])).all().map((r) => r.id));
    const missing = [...new Set(ids)].filter((id) => !known.has(id));
    if (missing.length > 0) throw new TagRulesError('VALIDATION', `unknown tag ids: ${missing.join(', ')}`);
  }

  private columns(input: TagRuleInput) {
    return {
      name: input.name,
      enabled: input.enabled,
      appliesTo: TAG_ENTITY_TYPES.filter((t) => input.appliesTo.includes(t)),
      match: input.match,
      conditions: input.conditions,
      addTags: [...new Set(input.addTags)],
      removeTagIds: [...new Set(input.removeTagIds)],
      removeWhenUnmatched: input.removeWhenUnmatched,
    };
  }

  private engineRule(
    r: Pick<TagRuleRow, 'id' | 'appliesTo' | 'match' | 'conditions' | 'addTags' | 'removeTagIds' | 'removeWhenUnmatched'>,
    labels: ReadonlyMap<number, string>,
  ): EngineRule {
    return {
      id: r.id,
      appliesTo: r.appliesTo,
      match: r.match,
      conditions: r.conditions,
      addTags: r.addTags,
      removeLabels: r.removeTagIds.map((id) => labels.get(id)).filter((l): l is string => l !== undefined),
      removeWhenUnmatched: r.removeWhenUnmatched,
    };
  }

  private toRule(r: TagRuleRow, appliedCount: number): TagRule {
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      appliesTo: r.appliesTo,
      match: r.match,
      conditions: r.conditions,
      addTags: r.addTags,
      removeTagIds: r.removeTagIds,
      removeWhenUnmatched: r.removeWhenUnmatched,
      sortOrder: r.sortOrder,
      starterKey: r.starterKey,
      appliedCount,
      lastRun: r.lastRun ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

/** Applies an add/remove to an item's tags as stored now (re-read inside the transaction). */
export function writeItemTags(tx: Tx | Db, type: TagEntityType, id: number, addIds: readonly number[], removeIds: readonly number[]): void {
  const update = (current: number[] | undefined) => {
    if (!current) return null;
    const next = new Set(current.filter((t) => !removeIds.includes(t)));
    for (const t of addIds) next.add(t);
    const sorted = [...next].sort((a, b) => a - b);
    return sorted.length === current.length && sorted.every((t, i) => t === [...current].sort((a, b) => a - b)[i]) ? null : sorted;
  };
  switch (type) {
    case 'movie': {
      const next = update(tx.select({ tags: s.movies.tags }).from(s.movies).where(eq(s.movies.id, id)).get()?.tags);
      if (next) tx.update(s.movies).set({ tags: next }).where(eq(s.movies.id, id)).run();
      return;
    }
    case 'series': {
      const next = update(tx.select({ tags: s.series.tags }).from(s.series).where(eq(s.series.id, id)).get()?.tags);
      if (next) tx.update(s.series).set({ tags: next }).where(eq(s.series.id, id)).run();
      return;
    }
    case 'artist': {
      const next = update(tx.select({ tags: s.artists.tags }).from(s.artists).where(eq(s.artists.id, id)).get()?.tags);
      if (next) tx.update(s.artists).set({ tags: next }).where(eq(s.artists.id, id)).run();
      return;
    }
    case 'author': {
      const next = update(tx.select({ tags: s.authors.tags }).from(s.authors).where(eq(s.authors.id, id)).get()?.tags);
      if (next) tx.update(s.authors).set({ tags: next }).where(eq(s.authors.id, id)).run();
      return;
    }
  }
}
