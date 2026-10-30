import { eq, getTableName, inArray, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { TagRuleCondition, TagUsageKind } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import * as s from '../../db/schema.js';

// Every place that stores tag ids: the `tags` JSON column of library items and settings
// entities, the tag scopes of retention and transcode rules, tag rules themselves and two
// settings sections. Counting, deleting and merging all walk this one list so nothing is left
// pointing at a tag that is gone.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbLike = Db | Tx;

/** Tables with a `tags` JSON array column of tag ids. */
const TAG_COLUMNS: ReadonlyArray<{ kind: TagUsageKind; table: SQLiteTable }> = [
  { kind: 'movie', table: s.movies },
  { kind: 'series', table: s.series },
  { kind: 'artist', table: s.artists },
  { kind: 'author', table: s.authors },
  { kind: 'request', table: s.mediaRequests },
  { kind: 'indexer', table: s.indexers },
  { kind: 'indexerProxy', table: s.indexerProxies },
  { kind: 'downloadClient', table: s.downloadClients },
  { kind: 'importList', table: s.importLists },
  { kind: 'notification', table: s.notifications },
  { kind: 'delayProfile', table: s.delayProfiles },
  { kind: 'releaseProfile', table: s.releaseProfiles },
  { kind: 'overrideRule', table: s.overrideRules },
];

/** Settings sections holding tag ids: `requests.<target>.tags` and `importLists.cleanLibraryTags`. */
const REQUEST_TARGETS = ['movie', 'series', 'movie4k', 'series4k'] as const;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const idList = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);

function settingsTagLists(db: DbLike): Array<{ key: string; value: Rec; lists: Array<{ get: () => number[]; set: (ids: number[]) => void }> }> {
  const out: Array<{ key: string; value: Rec; lists: Array<{ get: () => number[]; set: (ids: number[]) => void }> }> = [];
  for (const row of db.select().from(s.settings).where(inArray(s.settings.key, ['requests', 'importLists'])).all()) {
    if (!isRec(row.value)) continue;
    const value = structuredClone(row.value);
    const lists: Array<{ get: () => number[]; set: (ids: number[]) => void }> = [];
    if (row.key === 'requests') {
      for (const target of REQUEST_TARGETS) {
        const node = value[target];
        if (isRec(node) && Array.isArray(node['tags'])) lists.push({ get: () => idList(node['tags']), set: (ids) => (node['tags'] = ids) });
      }
    } else if (Array.isArray(value['cleanLibraryTags'])) {
      lists.push({ get: () => idList(value['cleanLibraryTags']), set: (ids) => (value['cleanLibraryTags'] = ids) });
    }
    if (lists.length > 0) out.push({ key: row.key, value, lists });
  }
  return out;
}

function scopeTagIds(scope: unknown): number[] {
  if (!isRec(scope)) return [];
  if (scope['type'] === 'tags' || scope['kind'] === 'tags') return idList(scope['tagIds']);
  return [];
}

function ruleTagIds(rule: { conditions: TagRuleCondition[]; removeTagIds: number[] }): number[] {
  return [...rule.removeTagIds, ...rule.conditions.flatMap((c) => (c.kind === 'ids' && c.field === 'tag' ? c.ids : []))];
}

/** tag id → kind → number of records using it. */
export function tagUsageCounts(db: DbLike): Map<number, Map<TagUsageKind, number>> {
  const out = new Map<number, Map<TagUsageKind, number>>();
  const bump = (tagId: number, kind: TagUsageKind, n = 1) => {
    const m = out.get(tagId) ?? new Map<TagUsageKind, number>();
    m.set(kind, (m.get(kind) ?? 0) + n);
    out.set(tagId, m);
  };
  for (const { kind, table } of TAG_COLUMNS) {
    const name = getTableName(table);
    const rows = db.all<{ tagId: number; n: number }>(
      sql.raw(`SELECT CAST(j.value AS INTEGER) AS tagId, count(DISTINCT t.rowid) AS n FROM "${name}" t, json_each(t.tags) j GROUP BY j.value`),
    );
    for (const r of rows) bump(Number(r.tagId), kind, Number(r.n));
  }
  for (const r of db.select({ scope: s.retentionRules.scope }).from(s.retentionRules).all()) for (const id of new Set(scopeTagIds(r.scope))) bump(id, 'retentionRule');
  for (const r of db.select({ scope: s.transcodeRules.scope }).from(s.transcodeRules).all()) for (const id of new Set(scopeTagIds(r.scope))) bump(id, 'transcodeRule');
  for (const r of db.select({ conditions: s.tagRules.conditions, removeTagIds: s.tagRules.removeTagIds }).from(s.tagRules).all()) {
    for (const id of new Set(ruleTagIds(r))) bump(id, 'tagRule');
  }
  for (const entry of settingsTagLists(db)) for (const list of entry.lists) for (const id of new Set(list.get())) bump(id, 'settings');
  return out;
}

/**
 * Rewrites every stored reference: ids in `remove` disappear, `from` becomes `into` when
 * merging. Runs inside the caller's transaction.
 */
export function rewriteTagReferences(tx: DbLike, change: { remove: readonly number[] } | { from: number; into: number }): void {
  const ids = 'remove' in change ? [...change.remove] : [change.from];
  if (ids.length === 0) return;
  const idSql = ids.map((n) => String(Math.trunc(n))).join(',');
  const map = (list: number[]): number[] => {
    const next: number[] = [];
    for (const id of list) {
      const v = 'remove' in change ? (ids.includes(id) ? null : id) : id === change.from ? change.into : id;
      if (v !== null && !next.includes(v)) next.push(v);
    }
    return next;
  };

  for (const { table } of TAG_COLUMNS) {
    const name = getTableName(table);
    const replacement =
      'remove' in change
        ? `(SELECT json_group_array(j.value) FROM json_each("${name}".tags) j WHERE j.value NOT IN (${idSql}))`
        : `(SELECT json_group_array(DISTINCT CASE WHEN j.value = ${Math.trunc(change.from)} THEN ${Math.trunc(change.into)} ELSE j.value END) FROM json_each("${name}".tags) j)`;
    tx.run(sql.raw(`UPDATE "${name}" SET tags = ${replacement} WHERE EXISTS (SELECT 1 FROM json_each("${name}".tags) j WHERE j.value IN (${idSql}))`));
  }

  for (const r of tx.select({ id: s.retentionRules.id, scope: s.retentionRules.scope }).from(s.retentionRules).all()) {
    const tagIds = scopeTagIds(r.scope);
    if (!tagIds.some((id) => ids.includes(id))) continue;
    const next = map(tagIds);
    // A tag scope may not be empty, and widening it to the whole library would widen a deleting
    // rule, so a rule left without tags is switched off instead (its scope matches nothing now).
    if (next.length === 0) {
      tx.update(s.retentionRules).set({ enabled: false }).where(eq(s.retentionRules.id, r.id)).run();
      continue;
    }
    tx.update(s.retentionRules).set({ scope: { ...r.scope, tagIds: next } as typeof r.scope }).where(eq(s.retentionRules.id, r.id)).run();
  }
  for (const r of tx.select({ id: s.transcodeRules.id, scope: s.transcodeRules.scope }).from(s.transcodeRules).all()) {
    const tagIds = scopeTagIds(r.scope);
    if (!tagIds.some((id) => ids.includes(id))) continue;
    const next = map(tagIds);
    if (next.length === 0) {
      tx.update(s.transcodeRules).set({ enabled: false }).where(eq(s.transcodeRules.id, r.id)).run();
      continue;
    }
    tx.update(s.transcodeRules).set({ scope: { ...r.scope, tagIds: next } as typeof r.scope }).where(eq(s.transcodeRules.id, r.id)).run();
  }

  for (const r of tx.select().from(s.tagRules).all()) {
    if (!ruleTagIds(r).some((id) => ids.includes(id))) continue;
    const conditions = r.conditions.flatMap((c): TagRuleCondition[] => {
      if (c.kind !== 'ids' || c.field !== 'tag') return [c];
      const next = map(c.ids);
      // A tag condition left without tags would match differently; drop it only for present/absent.
      if (next.length === 0 && (c.op === 'any' || c.op === 'all' || c.op === 'none')) return [];
      return [{ ...c, ids: next }];
    });
    tx.update(s.tagRules)
      .set({ conditions, removeTagIds: map(r.removeTagIds), updatedAt: new Date().toISOString() })
      .where(eq(s.tagRules.id, r.id))
      .run();
  }

  for (const entry of settingsTagLists(tx)) {
    let changed = false;
    for (const list of entry.lists) {
      const before = list.get();
      if (!before.some((id) => ids.includes(id))) continue;
      list.set(map(before));
      changed = true;
    }
    if (changed) tx.update(s.settings).set({ value: entry.value, updatedAt: new Date().toISOString() }).where(eq(s.settings.key, entry.key)).run();
  }

  if (!('remove' in change)) {
    // Ownership moves to the surviving tag (duplicates collapse); the rest cascades with the tag row.
    tx.run(sql`UPDATE OR IGNORE tag_rule_applications SET tag_id = ${change.into} WHERE tag_id = ${change.from}`);
    tx.delete(s.tagRuleApplications).where(eq(s.tagRuleApplications.tagId, change.from)).run();
  }
}
