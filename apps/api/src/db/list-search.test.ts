import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { listSearchCondition } from './list-search.js';

const rows = sqliteTable('rows', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  indexer: text('indexer'),
});

function db() {
  const sqlite = new Database(':memory:');
  sqlite.exec('create table rows (id integer primary key, title text not null, indexer text)');
  const d = drizzle(sqlite);
  d.insert(rows)
    .values([
      { id: 1, title: 'The.Office.S01E01.1080p.WEB-DL', indexer: 'Nyaa' },
      { id: 2, title: 'Andor.S01E01.2160p', indexer: 'TorrentLeech' },
      { id: 3, title: '100% Wolf', indexer: null },
      { id: 4, title: '100 Wolves', indexer: null },
      { id: 5, title: 'snake_case_name', indexer: null },
    ])
    .run();
  return d;
}

const ids = (d: ReturnType<typeof db>, q: string) =>
  d
    .select({ id: rows.id })
    .from(rows)
    .where(listSearchCondition(q, [rows.title, rows.indexer]))
    .orderBy(rows.id)
    .all()
    .map((r) => r.id);

describe('listSearchCondition', () => {
  it('is undefined for a blank search (no filter)', () => {
    expect(listSearchCondition('  ', [rows.title])).toBeUndefined();
    expect(listSearchCondition('x', [])).toBeUndefined();
    expect(ids(db(), '')).toEqual([1, 2, 3, 4, 5]);
  });
  it('matches case-insensitively, ignoring release separators', () => {
    const d = db();
    expect(ids(d, 'the office')).toEqual([1]);
    expect(ids(d, 'WEB-DL')).toEqual([1]);
    expect(ids(d, 'office.s01e01')).toEqual([1]);
  });
  it('needs every word, each from any column', () => {
    const d = db();
    expect(ids(d, 's01e01 nyaa')).toEqual([1]);
    expect(ids(d, 's01e01 leech')).toEqual([2]);
    expect(ids(d, 's01e01 missing')).toEqual([]);
  });
  it('escapes LIKE wildcards', () => {
    const d = db();
    expect(ids(d, '100%')).toEqual([3]);
    expect(ids(d, '%')).toEqual([3]);
    // `_` is a separator, so "snake_case" is two words, not a wildcard.
    expect(ids(d, 'snake_case')).toEqual([5]);
  });
  it('takes SQL expressions as columns', () => {
    const d = db();
    expect(
      d
        .select({ id: rows.id })
        .from(rows)
        .where(listSearchCondition('wol', [sql`${rows.title} || ' ' || coalesce(${rows.indexer}, '')`]))
        .all()
        .map((r) => r.id),
    ).toEqual([3, 4]);
  });
});
