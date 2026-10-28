import { eq, inArray } from 'drizzle-orm';
import type { AlbumTypeProfile, QualityModel } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { albumReleases, albums, albumTypeProfiles, artists, audioFiles } from '../../db/schema.js';
import { musicEnabled } from '../music/service.js';
import { albumStatistics } from '../music/statistics.js';
import type { AlbumTypeFilter, AudioAlbum, AudioArtist, AudioLibrarySnapshot } from './audio-matcher.js';

// The music library as the release pipeline reads it: one lazily filled snapshot per decision
// batch (artists, their albums with durations and file counts, album-type profiles, files).

export interface AlbumFileRow {
  id: number;
  albumId: number;
  quality: QualityModel;
  releaseGroup: string | null;
  sceneName: string | null;
  relativePath: string;
  sizeBytes: number;
  dateAdded: string;
}

export class MusicLibrary implements AudioLibrarySnapshot {
  private artistList?: AudioArtist[];
  private readonly albumCache = new Map<number, AudioAlbum[]>();
  private readonly fileCache = new Map<number, AlbumFileRow[]>();
  private profiles?: Map<number, AlbumTypeFilter>;
  private enabledFlag?: boolean;

  constructor(private readonly db: Db) {}

  /** `features.music` is on. */
  enabled(): boolean {
    this.enabledFlag ??= musicEnabled(this.db);
    return this.enabledFlag;
  }

  artists(): readonly AudioArtist[] {
    this.artistList ??= this.db
      .select()
      .from(artists)
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        aliases: r.aliases,
        monitored: r.monitored,
        qualityProfileId: r.qualityProfileId,
        albumTypeProfileId: r.albumTypeProfileId,
        tags: r.tags,
        path: r.path,
      }));
    return this.artistList;
  }

  artist(id: number): AudioArtist | undefined {
    return this.artists().find((a) => a.id === id);
  }

  albums(artistId: number): readonly AudioAlbum[] {
    let list = this.albumCache.get(artistId);
    if (!list) {
      const rows = this.db
        .select({ album: albums, durationMs: albumReleases.durationMs })
        .from(albums)
        .leftJoin(albumReleases, eq(albumReleases.id, albums.selectedReleaseId))
        .where(eq(albums.artistId, artistId))
        .all();
      const stats = albumStatistics(
        this.db,
        rows.map((r) => r.album.id),
      );
      list = rows.map(({ album, durationMs }) => {
        const s = stats.get(album.id);
        return {
          id: album.id,
          artistId: album.artistId,
          title: album.title,
          year: album.year,
          releaseDate: album.releaseDate,
          primaryType: album.primaryType,
          secondaryTypes: album.secondaryTypes,
          monitored: album.monitored,
          durationMs: durationMs ?? null,
          trackCount: s?.totalTrackCount ?? 0,
          trackFileCount: s?.trackFileCount ?? 0,
        };
      });
      this.albumCache.set(artistId, list);
    }
    return list;
  }

  /** Album by id (any artist), loading its artist's albums. */
  album(albumId: number): AudioAlbum | undefined {
    const row = this.db.select({ artistId: albums.artistId }).from(albums).where(eq(albums.id, albumId)).get();
    return row ? this.albums(row.artistId).find((a) => a.id === albumId) : undefined;
  }

  albumTypeProfile(id: number): AlbumTypeFilter | undefined {
    this.profiles ??= new Map(
      this.db
        .select()
        .from(albumTypeProfiles)
        .all()
        .map((p): [number, Pick<AlbumTypeProfile, 'primaryTypes' | 'secondaryTypes' | 'releaseStatuses'>] => [
          p.id,
          { primaryTypes: p.primaryTypes, secondaryTypes: p.secondaryTypes, releaseStatuses: p.releaseStatuses },
        ]),
    );
    return this.profiles.get(id);
  }

  /** Track files of the artist's albums. */
  files(artistId: number): readonly AlbumFileRow[] {
    let list = this.fileCache.get(artistId);
    if (!list) {
      const ids = this.albums(artistId).map((a) => a.id);
      list =
        ids.length === 0
          ? []
          : this.db
              .select()
              .from(audioFiles)
              .where(inArray(audioFiles.albumId, ids))
              .all()
              .flatMap((f) =>
                f.albumId === null
                  ? []
                  : [
                      {
                        id: f.id,
                        albumId: f.albumId,
                        quality: f.quality,
                        releaseGroup: f.releaseGroup,
                        sceneName: f.sceneName,
                        relativePath: f.relativePath,
                        sizeBytes: f.sizeBytes,
                        dateAdded: f.dateAdded,
                      },
                    ],
              );
      this.fileCache.set(artistId, list);
    }
    return list;
  }
}
