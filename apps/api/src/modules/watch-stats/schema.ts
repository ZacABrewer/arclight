import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from '../auth/schema.js';

// Watch-stats tables. The stats themselves are computed from the watch-history tables at read
// time; only share links and the newsletter log are stored.

/**
 * Share links to a user's Year in review. The token is the link (it is meant to be passed on),
 * so it is stored as is; links stop working at `expires_at` or when revoked (row deleted).
 */
export const wrappedShares = sqliteTable(
  'wrapped_shares',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    token: text('token').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [uniqueIndex('wrapped_shares_token_idx').on(t.token), index('wrapped_shares_user_idx').on(t.userId)],
);

/** One row per newsletter send (scheduled or manual), newest kept for the settings card. */
export const newsletterRuns = sqliteTable('newsletter_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sentAt: text('sent_at').notNull(),
  trigger: text('trigger', { enum: ['scheduled', 'manual'] }).notNull(),
  recipients: integer('recipients').notNull().default(0),
  items: integer('items').notNull().default(0),
  error: text('error'),
});

export type WrappedShareRow = typeof wrappedShares.$inferSelect;
export type NewsletterRunRow = typeof newsletterRuns.$inferSelect;
