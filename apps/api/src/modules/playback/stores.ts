import { and, asc, desc, eq } from 'drizzle-orm';
import { BookmarkInput, type Bookmark, type BookmarkUpdate, type PlayQueue, type UserPlaylistDetails, type UserPlaylistInput, type UserPlaylistSummary } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { tracksByIds, type BrowseContext } from './browse.js';
import { playbackBookmarks, playbackQueue, userPlaylists, userPlaylistTracks, type PlaybackBookmarkRow, type UserPlaylistRow } from './schema.js';

// The per-user stores of the player: the play queue, audiobook bookmarks and user playlists.
// Every method takes the owner's id; rows of other users read as missing (404), never 403, so
// ids do not leak whether something exists.

export class PlayerNotFound extends Error {
  readonly code = 'NOT_FOUND';
}

// ---------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------

const EMPTY_QUEUE: Omit<PlayQueue, 'updatedAt' | 'deviceId'> = { items: [], index: 0, positionMs: 0, shuffle: false, order: null, repeat: 'off', source: null };

export class QueueStore {
  constructor(private readonly db: Db) {}

  get(userId: number): PlayQueue {
    const row = this.db.select().from(playbackQueue).where(eq(playbackQueue.userId, userId)).get();
    if (!row) return { ...EMPTY_QUEUE };
    return { ...row.queue, updatedAt: row.updatedAt, ...(row.deviceId ? { deviceId: row.deviceId } : {}) };
  }

  /**
   * Last write wins by `updatedAt`: a queue older than the stored one is ignored and the stored
   * queue comes back. Without `updatedAt` the server's clock is used.
   */
  put(userId: number, input: PlayQueue, nowMs = Date.now()): PlayQueue {
    const { updatedAt, deviceId, ...queue } = input;
    const given = updatedAt ? Date.parse(updatedAt) : NaN;
    const at = Number.isFinite(given) ? Math.min(given, nowMs) : nowMs;
    const stored = this.db.select().from(playbackQueue).where(eq(playbackQueue.userId, userId)).get();
    if (stored && at < Date.parse(stored.updatedAt)) return this.get(userId);
    const index = queue.items.length === 0 ? 0 : Math.min(queue.index, queue.items.length - 1);
    const order = queue.order ? queue.order.filter((i) => i < queue.items.length) : null;
    const values = { queue: { ...queue, index, order }, deviceId: deviceId ?? null, updatedAt: new Date(at).toISOString() };
    this.db
      .insert(playbackQueue)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: playbackQueue.userId, set: values })
      .run();
    return this.get(userId);
  }
}

// ---------------------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------------------

function toBookmark(r: PlaybackBookmarkRow): Bookmark {
  return { id: r.id, itemKey: r.itemKey, positionMs: r.positionMs, note: r.note, createdAt: r.createdAt };
}

export class BookmarkStore {
  constructor(private readonly db: Db) {}

  private own(userId: number, id: number): PlaybackBookmarkRow {
    const row = this.db
      .select()
      .from(playbackBookmarks)
      .where(and(eq(playbackBookmarks.id, id), eq(playbackBookmarks.userId, userId)))
      .get();
    if (!row) throw new PlayerNotFound(`bookmark ${id} not found`);
    return row;
  }

  list(userId: number, key: string): Bookmark[] {
    return this.db
      .select()
      .from(playbackBookmarks)
      .where(and(eq(playbackBookmarks.userId, userId), eq(playbackBookmarks.itemKey, key)))
      .orderBy(asc(playbackBookmarks.positionMs), asc(playbackBookmarks.id))
      .all()
      .map(toBookmark);
  }

  create(userId: number, input: BookmarkInput, nowMs = Date.now()): Bookmark {
    const b = BookmarkInput.parse(input);
    const row = this.db
      .insert(playbackBookmarks)
      .values({ userId, itemKey: b.itemKey, positionMs: b.positionMs, note: b.note, createdAt: new Date(nowMs).toISOString() })
      .returning()
      .get();
    return toBookmark(row);
  }

  update(userId: number, id: number, patch: BookmarkUpdate): Bookmark {
    this.own(userId, id);
    const set: Partial<PlaybackBookmarkRow> = {};
    if (patch.positionMs !== undefined) set.positionMs = patch.positionMs;
    if (patch.note !== undefined) set.note = patch.note;
    if (Object.keys(set).length > 0) this.db.update(playbackBookmarks).set(set).where(eq(playbackBookmarks.id, id)).run();
    return toBookmark(this.own(userId, id));
  }

  remove(userId: number, id: number): void {
    this.own(userId, id);
    this.db.delete(playbackBookmarks).where(eq(playbackBookmarks.id, id)).run();
  }
}

// ---------------------------------------------------------------------------------------
// User playlists
// ---------------------------------------------------------------------------------------

export class PlaylistStore {
  constructor(private readonly ctx: BrowseContext) {}

  private get db(): Db {
    return this.ctx.db;
  }

  private own(userId: number, id: number): UserPlaylistRow {
    const row = this.db
      .select()
      .from(userPlaylists)
      .where(and(eq(userPlaylists.id, id), eq(userPlaylists.userId, userId)))
      .get();
    if (!row) throw new PlayerNotFound(`playlist ${id} not found`);
    return row;
  }

  private trackIds(playlistId: number): number[] {
    return this.db
      .select({ trackId: userPlaylistTracks.trackId })
      .from(userPlaylistTracks)
      .where(eq(userPlaylistTracks.playlistId, playlistId))
      .orderBy(asc(userPlaylistTracks.position))
      .all()
      .map((r) => r.trackId);
  }

  private summary(row: UserPlaylistRow, tracks = tracksByIds(this.ctx, this.trackIds(row.id))): UserPlaylistSummary {
    const covers: string[] = [];
    for (const t of tracks) {
      if (t.artworkUrl && !covers.includes(t.artworkUrl)) covers.push(t.artworkUrl);
      if (covers.length === 4) break;
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      trackCount: tracks.length,
      durationMs: tracks.reduce((s, t) => s + t.durationMs, 0),
      artworkUrls: covers,
      updatedAt: row.updatedAt,
    };
  }

  list(userId: number): UserPlaylistSummary[] {
    return this.db
      .select()
      .from(userPlaylists)
      .where(eq(userPlaylists.userId, userId))
      .orderBy(desc(userPlaylists.updatedAt), desc(userPlaylists.id))
      .all()
      .map((r) => this.summary(r));
  }

  get(userId: number, id: number): UserPlaylistDetails {
    const row = this.own(userId, id);
    const tracks = tracksByIds(this.ctx, this.trackIds(id));
    return { ...this.summary(row, tracks), tracks };
  }

  private setTracks(playlistId: number, trackIds: readonly number[]): void {
    this.db.delete(userPlaylistTracks).where(eq(userPlaylistTracks.playlistId, playlistId)).run();
    for (let i = 0; i < trackIds.length; i += 500) {
      const chunk = trackIds.slice(i, i + 500).map((trackId, j) => ({ playlistId, trackId, position: i + j }));
      if (chunk.length > 0) this.db.insert(userPlaylistTracks).values(chunk).run();
    }
  }

  create(userId: number, input: UserPlaylistInput, nowMs = Date.now()): UserPlaylistDetails {
    const now = new Date(nowMs).toISOString();
    const id = this.db.transaction((tx) => {
      const row = tx
        .insert(userPlaylists)
        .values({ userId, name: input.name, description: input.description ?? null, createdAt: now, updatedAt: now })
        .returning({ id: userPlaylists.id })
        .get();
      return row.id;
    });
    if (input.trackIds) this.db.transaction(() => this.setTracks(id, input.trackIds!));
    return this.get(userId, id);
  }

  /** Replaces the name, the description (when given) and the tracks (when given). */
  update(userId: number, id: number, input: UserPlaylistInput, nowMs = Date.now()): UserPlaylistDetails {
    this.own(userId, id);
    this.db.transaction((tx) => {
      tx.update(userPlaylists)
        .set({ name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), updatedAt: new Date(nowMs).toISOString() })
        .where(eq(userPlaylists.id, id))
        .run();
      if (input.trackIds) this.setTracks(id, input.trackIds);
    });
    return this.get(userId, id);
  }

  remove(userId: number, id: number): void {
    this.own(userId, id);
    this.db.delete(userPlaylists).where(eq(userPlaylists.id, id)).run();
  }
}
