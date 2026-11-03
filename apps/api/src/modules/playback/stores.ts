import { and, asc, desc, eq } from 'drizzle-orm';
import {
  BookmarkInput,
  MAX_PLAYLIST_TRACKS,
  type Bookmark,
  type BookmarkUpdate,
  type PlaylistTrackMove,
  type PlaylistTracksAdd,
  type PlayQueue,
  type UserPlaylistDetails,
  type UserPlaylistInput,
  type UserPlaylistSummary,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { tracksByIds, type BrowseContext } from './browse.js';
import { playbackBookmarks, userPlaylists, userPlaylistTracks, type PlaybackBookmarkRow, type UserPlaylistRow } from './schema.js';
import { profilePlaybackQueue } from '../households/schema.js';
import type { PlaybackOwner } from './progress.js';

// The per-profile stores of the player: the play queue, audiobook bookmarks and user playlists.
// Every method takes the owner (account + household profile); rows of other profiles read as
// missing (404), never 403, so ids do not leak whether something exists.

export class PlayerNotFound extends Error {
  readonly code = 'NOT_FOUND';
}

/** A playlist edit would go over MAX_PLAYLIST_TRACKS (400). */
export class PlaylistFull extends Error {
  readonly code = 'PLAYLIST_FULL';
}

// ---------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------

const EMPTY_QUEUE: Omit<PlayQueue, 'updatedAt' | 'deviceId'> = { items: [], index: 0, positionMs: 0, shuffle: false, order: null, repeat: 'off', source: null };

export class QueueStore {
  constructor(private readonly db: Db) {}

  get(owner: PlaybackOwner): PlayQueue {
    const row = this.db.select().from(profilePlaybackQueue).where(eq(profilePlaybackQueue.profileId, owner.profileId)).get();
    if (!row) return { ...EMPTY_QUEUE };
    return { ...row.queue, updatedAt: row.updatedAt, ...(row.deviceId ? { deviceId: row.deviceId } : {}) };
  }

  /**
   * Last write wins by `updatedAt`: a queue older than the stored one is ignored and the stored
   * queue comes back. Without `updatedAt` the server's clock is used.
   */
  put(owner: PlaybackOwner, input: PlayQueue, nowMs = Date.now()): PlayQueue {
    const { updatedAt, deviceId, ...queue } = input;
    const given = updatedAt ? Date.parse(updatedAt) : NaN;
    const at = Number.isFinite(given) ? Math.min(given, nowMs) : nowMs;
    const stored = this.db.select().from(profilePlaybackQueue).where(eq(profilePlaybackQueue.profileId, owner.profileId)).get();
    if (stored && at < Date.parse(stored.updatedAt)) return this.get(owner);
    const index = queue.items.length === 0 ? 0 : Math.min(queue.index, queue.items.length - 1);
    const order = queue.order ? queue.order.filter((i) => i < queue.items.length) : null;
    const values = { queue: { ...queue, index, order }, deviceId: deviceId ?? null, updatedAt: new Date(at).toISOString() };
    this.db
      .insert(profilePlaybackQueue)
      .values({ profileId: owner.profileId, userId: owner.userId, ...values })
      .onConflictDoUpdate({ target: profilePlaybackQueue.profileId, set: values })
      .run();
    return this.get(owner);
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

  private own(owner: PlaybackOwner, id: number): PlaybackBookmarkRow {
    const row = this.db
      .select()
      .from(playbackBookmarks)
      .where(and(eq(playbackBookmarks.id, id), eq(playbackBookmarks.profileId, owner.profileId)))
      .get();
    if (!row) throw new PlayerNotFound(`bookmark ${id} not found`);
    return row;
  }

  list(owner: PlaybackOwner, key: string): Bookmark[] {
    return this.db
      .select()
      .from(playbackBookmarks)
      .where(and(eq(playbackBookmarks.profileId, owner.profileId), eq(playbackBookmarks.itemKey, key)))
      .orderBy(asc(playbackBookmarks.positionMs), asc(playbackBookmarks.id))
      .all()
      .map(toBookmark);
  }

  create(owner: PlaybackOwner, input: BookmarkInput, nowMs = Date.now()): Bookmark {
    const b = BookmarkInput.parse(input);
    const row = this.db
      .insert(playbackBookmarks)
      .values({ userId: owner.userId, profileId: owner.profileId, itemKey: b.itemKey, positionMs: b.positionMs, note: b.note, createdAt: new Date(nowMs).toISOString() })
      .returning()
      .get();
    return toBookmark(row);
  }

  update(owner: PlaybackOwner, id: number, patch: BookmarkUpdate): Bookmark {
    this.own(owner, id);
    const set: Partial<PlaybackBookmarkRow> = {};
    if (patch.positionMs !== undefined) set.positionMs = patch.positionMs;
    if (patch.note !== undefined) set.note = patch.note;
    if (Object.keys(set).length > 0) this.db.update(playbackBookmarks).set(set).where(eq(playbackBookmarks.id, id)).run();
    return toBookmark(this.own(owner, id));
  }

  remove(owner: PlaybackOwner, id: number): void {
    this.own(owner, id);
    this.db.delete(playbackBookmarks).where(eq(playbackBookmarks.id, id)).run();
  }
}

// ---------------------------------------------------------------------------------------
// User playlists
// ---------------------------------------------------------------------------------------

interface Entry {
  id: number;
  trackId: number;
}

export class PlaylistStore {
  constructor(private readonly ctx: BrowseContext) {}

  private get db(): Db {
    return this.ctx.db;
  }

  private own(owner: PlaybackOwner, id: number): UserPlaylistRow {
    const row = this.db
      .select()
      .from(userPlaylists)
      .where(and(eq(userPlaylists.id, id), eq(userPlaylists.profileId, owner.profileId)))
      .get();
    if (!row) throw new PlayerNotFound(`playlist ${id} not found`);
    return row;
  }

  /** Every entry of a playlist in order (tracks without a file included). */
  private entries(playlistId: number): Entry[] {
    return this.db
      .select({ id: userPlaylistTracks.id, trackId: userPlaylistTracks.trackId })
      .from(userPlaylistTracks)
      .where(eq(userPlaylistTracks.playlistId, playlistId))
      .orderBy(asc(userPlaylistTracks.position))
      .all();
  }

  private summary(row: UserPlaylistRow, tracks = tracksByIds(this.ctx, this.entries(row.id).map((e) => e.trackId))): UserPlaylistSummary {
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

  list(owner: PlaybackOwner): UserPlaylistSummary[] {
    return this.db
      .select()
      .from(userPlaylists)
      .where(eq(userPlaylists.profileId, owner.profileId))
      .orderBy(desc(userPlaylists.updatedAt), desc(userPlaylists.id))
      .all()
      .map((r) => this.summary(r));
  }

  get(owner: PlaybackOwner, id: number): UserPlaylistDetails {
    const row = this.own(owner, id);
    const entries = this.entries(id);
    const trackIds = entries.map((e) => e.trackId);
    // tracksByIds keeps the order and drops ids without a playable file, the same for every repeat.
    const tracks = tracksByIds(this.ctx, trackIds);
    const playable = new Set(tracks.map((t) => t.id));
    return { ...this.summary(row, tracks), tracks, entryIds: entries.filter((e) => playable.has(e.trackId)).map((e) => e.id), trackIds };
  }

  /**
   * Rewrites the entries in this order. Entries that carry an id keep it (so ids stay stable
   * across moves); new ones get fresh ids. Runs inside the caller's transaction.
   */
  private writeEntries(playlistId: number, list: ReadonlyArray<{ id?: number; trackId: number }>): void {
    if (list.length > MAX_PLAYLIST_TRACKS) throw new PlaylistFull(`a playlist holds at most ${MAX_PLAYLIST_TRACKS} tracks`);
    this.db.delete(userPlaylistTracks).where(eq(userPlaylistTracks.playlistId, playlistId)).run();
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500).map((e, j) => ({ ...(e.id !== undefined ? { id: e.id } : {}), playlistId, trackId: e.trackId, position: i + j }));
      if (chunk.length > 0) this.db.insert(userPlaylistTracks).values(chunk).run();
    }
  }

  private touch(id: number, nowMs: number): void {
    this.db.update(userPlaylists).set({ updatedAt: new Date(nowMs).toISOString() }).where(eq(userPlaylists.id, id)).run();
  }

  create(owner: PlaybackOwner, input: UserPlaylistInput, nowMs = Date.now()): UserPlaylistDetails {
    const now = new Date(nowMs).toISOString();
    const id = this.db.transaction((tx) => {
      const row = tx
        .insert(userPlaylists)
        .values({ userId: owner.userId, profileId: owner.profileId, name: input.name, description: input.description ?? null, createdAt: now, updatedAt: now })
        .returning({ id: userPlaylists.id })
        .get();
      if (input.trackIds) this.writeEntries(row.id, input.trackIds.map((trackId) => ({ trackId })));
      return row.id;
    });
    return this.get(owner, id);
  }

  /** Replaces the name, the description (when given) and every entry (when `trackIds` is given). */
  update(owner: PlaybackOwner, id: number, input: UserPlaylistInput, nowMs = Date.now()): UserPlaylistDetails {
    this.own(owner, id);
    this.db.transaction((tx) => {
      tx.update(userPlaylists)
        .set({ name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), updatedAt: new Date(nowMs).toISOString() })
        .where(eq(userPlaylists.id, id))
        .run();
      if (input.trackIds) this.writeEntries(id, input.trackIds.map((trackId) => ({ trackId })));
    });
    return this.get(owner, id);
  }

  /** Inserts tracks at `position` (index into the entries; default and past the end: append). */
  addTracks(owner: PlaybackOwner, id: number, input: PlaylistTracksAdd, nowMs = Date.now()): UserPlaylistDetails {
    this.own(owner, id);
    this.db.transaction(() => {
      const list: Array<{ id?: number; trackId: number }> = this.entries(id);
      if (list.length + input.trackIds.length > MAX_PLAYLIST_TRACKS) throw new PlaylistFull(`a playlist holds at most ${MAX_PLAYLIST_TRACKS} tracks`);
      const at = Math.min(input.position ?? list.length, list.length);
      list.splice(at, 0, ...input.trackIds.map((trackId) => ({ trackId })));
      this.writeEntries(id, list);
      this.touch(id, nowMs);
    });
    return this.get(owner, id);
  }

  /** Removes one entry (404 when it is not in this playlist). */
  removeEntry(owner: PlaybackOwner, id: number, entryId: number, nowMs = Date.now()): UserPlaylistDetails {
    this.own(owner, id);
    this.db.transaction(() => {
      const gone = this.db
        .delete(userPlaylistTracks)
        .where(and(eq(userPlaylistTracks.playlistId, id), eq(userPlaylistTracks.id, entryId)))
        .returning({ id: userPlaylistTracks.id })
        .all();
      if (gone.length === 0) throw new PlayerNotFound(`entry ${entryId} is not in playlist ${id}`);
      this.touch(id, nowMs);
    });
    return this.get(owner, id);
  }

  /** Moves one entry right before or after another entry of the same playlist. */
  moveEntry(owner: PlaybackOwner, id: number, entryId: number, move: PlaylistTrackMove, nowMs = Date.now()): UserPlaylistDetails {
    this.own(owner, id);
    this.db.transaction(() => {
      const list = this.entries(id);
      const from = list.findIndex((e) => e.id === entryId);
      if (from < 0) throw new PlayerNotFound(`entry ${entryId} is not in playlist ${id}`);
      const anchorId = move.beforeEntryId ?? move.afterEntryId!;
      if (anchorId === entryId) return;
      const [entry] = list.splice(from, 1);
      const anchor = list.findIndex((e) => e.id === anchorId);
      if (anchor < 0) throw new PlayerNotFound(`entry ${anchorId} is not in playlist ${id}`);
      list.splice(move.beforeEntryId !== undefined ? anchor : anchor + 1, 0, entry!);
      this.writeEntries(id, list);
      this.touch(id, nowMs);
    });
    return this.get(owner, id);
  }

  remove(owner: PlaybackOwner, id: number): void {
    this.own(owner, id);
    this.db.delete(userPlaylists).where(eq(userPlaylists.id, id)).run();
  }
}
