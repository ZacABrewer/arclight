import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import type { Db } from './index.js';
import * as schema from './schema.js';

// Test databases are built straight from the drizzle table definitions instead of the
// shipped migrations, so a module can test tables that have not been through
// `pnpm db:generate` yet. Pass the module's own tables alongside the aggregate schema.
export async function createTestDb(extraTables: Record<string, unknown> = {}): Promise<Db> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');

  const empty = await generateSQLiteDrizzleJson({});
  const target = await generateSQLiteDrizzleJson({ ...schema, ...extraTables });
  for (const statement of await generateSQLiteMigration(empty, target)) {
    sqlite.exec(statement);
  }

  return drizzle(sqlite, { schema });
}
