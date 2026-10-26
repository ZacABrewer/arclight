import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Push module tables. `user_id` is a plain integer (modules do not reference each other's
// tables); subscriptions of deleted users are removed when a push to them is attempted.

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    /** Push service URL; unique per browser profile. */
    endpoint: text('endpoint').notNull(),
    /** Client public key (base64url). */
    p256dh: text('p256dh').notNull(),
    /** Client auth secret (base64url). */
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('push_subscriptions_endpoint_idx').on(t.endpoint), index('push_subscriptions_user_idx').on(t.userId)],
);
