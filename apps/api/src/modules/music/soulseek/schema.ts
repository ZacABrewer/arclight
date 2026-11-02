import { sqliteTable, integer, text, real, index } from 'drizzle-orm/sqlite-core';
import type { SoulseekDownloadStatus } from '@arclight/shared';
import { albums, artists } from '../schema.js';

// Soulseek (slskd) grabs: one row per album folder queued from one peer. The monitor job
// follows the slskd transfers of `files` and imports the folder when every file finished.

export interface SoulseekFileState {
  filename: string;
  size: number;
  /** slskd transfer id, once seen in its transfer list. */
  transferId?: string;
  state?: string;
  bytesTransferred?: number;
}

export const soulseekDownloads = sqliteTable(
  'soulseek_downloads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    albumId: integer('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    artistId: integer('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    directory: text('directory').notNull(),
    files: text('files', { mode: 'json' }).$type<SoulseekFileState[]>().notNull(),
    qualityName: text('quality_name'),
    status: text('status').$type<SoulseekDownloadStatus>().notNull().default('queued'),
    progress: real('progress').notNull().default(0),
    message: text('message'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('soulseek_downloads_status_idx').on(t.status), index('soulseek_downloads_album_idx').on(t.albumId)],
);

export type SoulseekDownloadRow = typeof soulseekDownloads.$inferSelect;
