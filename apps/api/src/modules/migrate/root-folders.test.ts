import { describe, expect, it } from 'vitest';
import * as t from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { HANDLERS } from './areas.js';

describe('migrate root folders', () => {
  it('refuses a filesystem root or a relative path and writes nothing', async () => {
    const db = await createTestDb();
    const handler = HANDLERS.rootFolders!;
    const env = { db, warn: () => {} } as unknown as Parameters<typeof handler.create>[0];
    for (const path of ['/', 'relative/tv']) {
      const item = { sourceId: '1', name: path, payload: { path, mediaType: 'series' } } as unknown as Parameters<typeof handler.create>[1];
      expect(() => handler.create(env, item)).toThrow(/root folder/);
    }
    expect(db.select().from(t.rootFolders).all()).toEqual([]);
  });
});
