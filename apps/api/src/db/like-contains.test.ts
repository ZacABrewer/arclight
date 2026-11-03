import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { likeContains } from './like-contains.js';

describe('likeContains', () => {
  it('matches % and _ literally and stays case-insensitive', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('100% Pure'), ('a_b'), ('axb'), ('Plain'), ('back\\slash')");
    const db = drizzle(sqlite);
    const find = (needle: string) =>
      db.all<{ v: string }>(sql`SELECT v FROM t WHERE ${likeContains(sql.raw('v'), needle)} ORDER BY v`).map((r) => r.v);
    expect(find('%')).toEqual(['100% Pure']);
    expect(find('_')).toEqual(['a_b']);
    expect(find('a_b')).toEqual(['a_b']);
    expect(find('PLAIN')).toEqual(['Plain']);
    expect(find('\\')).toEqual(['back\\slash']);
    expect(find('zzz')).toEqual([]);
  });
});
