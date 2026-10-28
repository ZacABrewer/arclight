import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AlbumStatistics, ArtistStatistics } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { albumReleases, albums, audioFiles, tracks } from '../../db/schema.js';

// Album and artist statistics (design 4.3), computed with grouped SQL over the selected
// release's tracks and the album's audio files.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type MusicDb = Db | Tx;

const percent = (files: number, total: number) => (total > 0 ? Math.round((files / total) * 1000) / 10 : 0);

function emptyAlbum(): AlbumStatistics {
  return { trackCount: 0, trackFileCount: 0, totalTrackCount: 0, sizeOnDisk: 0, percentOfTracks: 0 };
}

/** Statistics per album id (every id gets an entry). Pass no ids for all albums. */
export function albumStatistics(db: MusicDb, albumIds?: readonly number[]): Map<number, AlbumStatistics> {
  const out = new Map<number, AlbumStatistics>();
  if (albumIds !== undefined && albumIds.length === 0) return out;
  const filter = albumIds ? inArray(albums.id, [...albumIds]) : undefined;

  const rows = db
    .select({
      id: albums.id,
      trackCount: sql<number>`count(${tracks.id})`,
      trackFileCount: sql<number>`coalesce(sum(case when ${tracks.hasFile} then 1 else 0 end), 0)`,
    })
    .from(albums)
    .leftJoin(tracks, and(eq(tracks.albumId, albums.id), eq(tracks.albumReleaseId, albums.selectedReleaseId)))
    .where(filter)
    .groupBy(albums.id)
    .all();
  for (const r of rows) out.set(r.id, { ...emptyAlbum(), trackCount: Number(r.trackCount), trackFileCount: Number(r.trackFileCount) });

  const totals = db
    .select({ id: albums.id, total: albumReleases.trackCount })
    .from(albums)
    .innerJoin(albumReleases, eq(albumReleases.id, albums.selectedReleaseId))
    .where(filter)
    .all();
  for (const r of totals) {
    const s = out.get(r.id);
    if (s) s.totalTrackCount = r.total;
  }

  const sizes = db
    .select({ id: audioFiles.albumId, size: sql<number>`coalesce(sum(${audioFiles.sizeBytes}), 0)` })
    .from(audioFiles)
    .where(albumIds ? inArray(audioFiles.albumId, [...albumIds]) : undefined)
    .groupBy(audioFiles.albumId)
    .all();
  for (const r of sizes) {
    const s = r.id !== null ? out.get(r.id) : undefined;
    if (s) s.sizeOnDisk = Number(r.size);
  }

  for (const s of out.values()) {
    s.totalTrackCount = Math.max(s.totalTrackCount, s.trackCount);
    s.percentOfTracks = percent(s.trackFileCount, s.trackCount);
  }
  return out;
}

/**
 * Statistics per artist id (every id gets an entry). `trackCount` counts the tracks of monitored
 * albums plus any track with a file (so percent stays at most 100); `totalTrackCount` and the
 * album counts cover every album.
 */
export function artistStatistics(db: MusicDb, artistIds: readonly number[]): Map<number, ArtistStatistics> {
  const out = new Map<number, ArtistStatistics>();
  for (const id of artistIds) {
    out.set(id, { ...emptyAlbum(), albumCount: 0, monitoredAlbumCount: 0, completeAlbumCount: 0 });
  }
  if (artistIds.length === 0) return out;
  const albumRows = db
    .select({ id: albums.id, artistId: albums.artistId, monitored: albums.monitored })
    .from(albums)
    .where(inArray(albums.artistId, [...artistIds]))
    .all();
  const perAlbum = albumStatistics(
    db,
    albumRows.map((a) => a.id),
  );
  const wantedTracks = new Map<number, number>();
  if (albumRows.length > 0) {
    const rows = db
      .select({ artistId: albums.artistId, n: sql<number>`count(${tracks.id})` })
      .from(tracks)
      .innerJoin(albums, and(eq(tracks.albumId, albums.id), eq(tracks.albumReleaseId, albums.selectedReleaseId)))
      .where(and(inArray(albums.artistId, [...artistIds]), sql`(${albums.monitored} = 1 or ${tracks.hasFile} = 1)`))
      .groupBy(albums.artistId)
      .all();
    for (const r of rows) wantedTracks.set(r.artistId, Number(r.n));
  }
  for (const a of albumRows) {
    const s = out.get(a.artistId);
    const st = perAlbum.get(a.id);
    if (!s || !st) continue;
    s.albumCount++;
    if (a.monitored) s.monitoredAlbumCount++;
    if (st.trackCount > 0 && st.trackFileCount >= st.trackCount) s.completeAlbumCount++;
    s.trackFileCount += st.trackFileCount;
    s.totalTrackCount += st.totalTrackCount;
    s.sizeOnDisk += st.sizeOnDisk;
  }
  for (const [id, s] of out) {
    s.trackCount = wantedTracks.get(id) ?? 0;
    s.percentOfTracks = percent(s.trackFileCount, s.trackCount);
  }
  return out;
}
