import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AudioDiscoverItem, AudioRequestKind, MediaStatus, RequestStatus } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { albums, artists, authors, books } from '../../db/schema.js';
import { authorStatistics } from '../audiobooks/statistics.js';
import { albumStatistics, artistStatistics } from '../music/statistics.js';
import { audioRequests } from './schema.js';

// Library availability of music and audiobook items (the audio counterpart of status.ts),
// computed fresh from the library tables on every call:
//
// * album (release group): every track of the selected release has a file → available, some →
//   partiallyAvailable, monitored without files → processing.
// * artist: every wanted track (monitored albums) has a file → available, some →
//   partiallyAvailable, monitored without files → processing.
// * book: has a file → available, monitored without → processing.
// * author: every monitored released book has a file → available, some books → partiallyAvailable,
//   monitored without files → processing.
//
// An item in the library that is neither monitored nor on disk is `unknown` (with its library
// id), so it can still be requested.

export interface AudioLibraryEntry {
  status: MediaStatus;
  libraryId: number;
}

/** MusicBrainz ids are stored lower case, ASINs upper case. */
export function normalizeForeignId(kind: AudioRequestKind, id: string): string {
  const trimmed = id.trim();
  return kind === 'album' || kind === 'artist' ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

const idle = (monitored: boolean): MediaStatus => (monitored ? 'processing' : 'unknown');

/** Availability of library items of one kind, keyed by normalized foreign id. Absent ids are not in the library. */
export function audioLibraryStatus(db: Db, kind: AudioRequestKind, foreignIds: readonly string[]): Map<string, AudioLibraryEntry> {
  const out = new Map<string, AudioLibraryEntry>();
  const ids = [...new Set(foreignIds.map((id) => normalizeForeignId(kind, id)))];
  if (ids.length === 0) return out;
  switch (kind) {
    case 'album': {
      const rows = db.select({ id: albums.id, key: albums.mbReleaseGroupId, monitored: albums.monitored }).from(albums).where(inArray(albums.mbReleaseGroupId, ids)).all();
      const stats = albumStatistics(
        db,
        rows.map((r) => r.id),
      );
      for (const r of rows) {
        const s = stats.get(r.id);
        const files = s?.trackFileCount ?? 0;
        const status: MediaStatus = files > 0 && files >= (s?.trackCount ?? 0) ? 'available' : files > 0 ? 'partiallyAvailable' : idle(r.monitored);
        out.set(r.key.toLowerCase(), { status, libraryId: r.id });
      }
      break;
    }
    case 'artist': {
      const rows = db.select({ id: artists.id, key: artists.mbArtistId, monitored: artists.monitored }).from(artists).where(inArray(artists.mbArtistId, ids)).all();
      const stats = artistStatistics(
        db,
        rows.map((r) => r.id),
      );
      for (const r of rows) {
        const s = stats.get(r.id);
        const files = s?.trackFileCount ?? 0;
        const status: MediaStatus = files > 0 && files >= (s?.trackCount ?? 0) ? 'available' : files > 0 ? 'partiallyAvailable' : idle(r.monitored);
        out.set(r.key.toLowerCase(), { status, libraryId: r.id });
      }
      break;
    }
    case 'book': {
      const rows = db.select({ id: books.id, key: books.asin, monitored: books.monitored, hasFile: books.hasFile }).from(books).where(inArray(books.asin, ids)).all();
      for (const r of rows) {
        if (!r.key) continue;
        out.set(r.key.toUpperCase(), { status: r.hasFile ? 'available' : idle(r.monitored), libraryId: r.id });
      }
      break;
    }
    case 'author': {
      const rows = db.select({ id: authors.id, key: authors.asin, monitored: authors.monitored }).from(authors).where(inArray(authors.asin, ids)).all();
      const stats = authorStatistics(
        db,
        rows.map((r) => r.id),
      );
      for (const r of rows) {
        if (!r.key) continue;
        const s = stats.get(r.id);
        const have = s?.availableBookCount ?? 0;
        const status: MediaStatus = have > 0 && (s?.missingBookCount ?? 0) === 0 ? 'available' : have > 0 ? 'partiallyAvailable' : idle(r.monitored);
        out.set(r.key.toUpperCase(), { status, libraryId: r.id });
      }
      break;
    }
  }
  return out;
}

/**
 * The status a card shows: the library's, else `pending` / `processing` from an open request
 * (pending awaiting approval, approved = on its way).
 */
export function overlayAudioRequest(library: MediaStatus, request: RequestStatus | null | undefined): MediaStatus {
  if (library !== 'unknown') return library;
  if (request === 'pending') return 'pending';
  if (request === 'approved') return 'processing';
  return library;
}

/** A Discover card before the per-caller status is overlaid (what the catalogue cache keeps). */
export type RawAudioItem = Omit<AudioDiscoverItem, 'mediaStatus' | 'requestId' | 'requestStatus' | 'libraryId'>;

/** Requests that still show on a card (a failed one too, so managers see it). */
export const OPEN_AUDIO_STATUSES: RequestStatus[] = ['pending', 'approved', 'failed'];

/** Overlays library availability and the newest open request on catalogue cards (fresh, never cached). */
export function withAudioStatus(db: Db, items: readonly RawAudioItem[]): AudioDiscoverItem[] {
  const library = new Map<string, AudioLibraryEntry>();
  const requests = new Map<string, typeof audioRequests.$inferSelect>();
  for (const kind of ['album', 'artist', 'book', 'author'] as const) {
    const ids = [...new Set(items.filter((i) => i.kind === kind).map((i) => normalizeForeignId(kind, i.foreignId)))];
    if (ids.length === 0) continue;
    for (const [id, entry] of audioLibraryStatus(db, kind, ids)) library.set(`${kind}:${id}`, entry);
    const rows = db
      .select()
      .from(audioRequests)
      .where(and(eq(audioRequests.kind, kind), inArray(audioRequests.foreignId, ids), inArray(audioRequests.status, OPEN_AUDIO_STATUSES)))
      .orderBy(desc(audioRequests.id))
      .all();
    for (const r of rows) if (!requests.has(`${kind}:${r.foreignId}`)) requests.set(`${kind}:${r.foreignId}`, r);
  }
  return items.map((item) => {
    const key = `${item.kind}:${normalizeForeignId(item.kind, item.foreignId)}`;
    const entry = library.get(key);
    const request = requests.get(key);
    return {
      ...item,
      mediaStatus: overlayAudioRequest(entry?.status ?? 'unknown', request?.status),
      requestId: request?.id ?? null,
      requestStatus: request?.status ?? null,
      libraryId: entry?.libraryId ?? null,
    };
  });
}
