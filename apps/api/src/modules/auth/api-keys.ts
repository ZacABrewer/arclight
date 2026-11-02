import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { ApiKeyScope, UserApiKey, UserApiKeyAdminRecord, UserApiKeyCreated } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { userApiKeys, users } from '../../db/schema.js';
import { hashToken } from './hash.js';

// Per-user API keys (alu_…): named, scoped, revocable, with a last-used time. They sit next to
// the install-wide key (security settings), the Jellyfin plugin keys (alj_…) and sessions; the
// auth hook enforces the scope (hook.ts, apiKeyScopeAllows).

export const USER_KEY_PREFIX = 'alu_';
/** lastUsedAt is written at most this often per key. */
const TOUCH_MS = 60_000;

export function generateUserKey(): string {
  return `${USER_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

type KeyRow = typeof userApiKeys.$inferSelect;

function toKey(row: KeyRow): UserApiKey {
  const key: UserApiKey = { id: row.id, name: row.name, scope: row.scope, prefix: row.prefix, createdAt: row.createdAt };
  if (row.lastUsedAt) key.lastUsedAt = row.lastUsedAt;
  if (row.expiresAt) key.expiresAt = row.expiresAt;
  return key;
}

export class ApiKeyNotFoundError extends Error {}

export class UserApiKeyService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
  ) {}

  list(userId: number): UserApiKey[] {
    return this.db.select().from(userApiKeys).where(eq(userApiKeys.userId, userId)).orderBy(userApiKeys.id).all().map(toKey);
  }

  listAll(): UserApiKeyAdminRecord[] {
    return this.db
      .select({ key: userApiKeys, username: users.username })
      .from(userApiKeys)
      .innerJoin(users, eq(users.id, userApiKeys.userId))
      .orderBy(userApiKeys.id)
      .all()
      .map((r) => ({ ...toKey(r.key), userId: r.key.userId, username: r.username }));
  }

  /** The new key is returned once; only its hash is kept. */
  create(userId: number, input: { name: string; scope: ApiKeyScope; expiresInDays?: number | undefined }): UserApiKeyCreated {
    const key = generateUserKey();
    const now = this.now();
    const expiresAt = input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString() : null;
    const row = this.db
      .insert(userApiKeys)
      .values({ userId, name: input.name, scope: input.scope, keyHash: hashToken(key), prefix: key.slice(0, 10), createdAt: now.toISOString(), expiresAt })
      .returning()
      .get();
    return { ...toKey(row), key };
  }

  /** Revokes a key of `userId` (or any user's, when `userId` is null: admins). */
  revoke(id: number, userId: number | null): void {
    const where = userId === null ? eq(userApiKeys.id, id) : and(eq(userApiKeys.id, id), eq(userApiKeys.userId, userId));
    const row = this.db.delete(userApiKeys).where(where).returning().get();
    if (!row) throw new ApiKeyNotFoundError(`API key ${id} not found`);
  }

  /** The key row for a presented alu_ key, when it exists and has not expired (lastUsedAt refreshed, throttled). */
  verify(candidate: string | undefined): KeyRow | null {
    if (!candidate?.startsWith(USER_KEY_PREFIX)) return null;
    const row = this.db.select().from(userApiKeys).where(eq(userApiKeys.keyHash, hashToken(candidate))).get();
    if (!row) return null;
    const now = this.now();
    if (row.expiresAt && Date.parse(row.expiresAt) <= now.getTime()) return null;
    if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) > TOUCH_MS) {
      this.db.update(userApiKeys).set({ lastUsedAt: now.toISOString() }).where(eq(userApiKeys.id, row.id)).run();
    }
    return row;
  }
}
