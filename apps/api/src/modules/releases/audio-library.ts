import { and, eq, inArray } from 'drizzle-orm';
import type { AlbumTypeProfile, QualityModel } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import {
  albumReleases,
  albums,
  albumTypeProfiles,
  artists,
  audioFiles,
  authors,
  bookAuthors,
  books,
  bookSeries,
  bookSeriesEntries,
} from '../../db/schema.js';
import { musicEnabled } from '../music/service.js';
import { albumStatistics } from '../music/statistics.js';
import { getSection } from '../settings/service.js';
import type {
  AlbumTypeFilter,
  AudioAlbum,
  AudioArtist,
  AudioAuthor,
  AudioBook,
  AudioBookSeries,
  AudioLibrarySnapshot,
  BookLibrarySnapshot,
} from './audio-matcher.js';

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

// ---- audiobooks ---------------------------------------------------------------------

/** `features.audiobooks` is on. */
export function audiobooksEnabled(db: Db): boolean {
  return getSection(db, 'features').audiobooks;
}

export interface BookFileRow {
  id: number;
  bookId: number;
  quality: QualityModel;
  releaseGroup: string | null;
  sceneName: string | null;
  relativePath: string;
  sizeBytes: number;
  dateAdded: string;
}

/**
 * The audiobook library as the release pipeline reads it: authors (with the
 * `audiobookMetadata.languages` default when they keep none), the books they own or are linked
 * to, their series entries and files. Read straight from the audiobooks tables, lazily per batch.
 */
export class BookLibrary implements BookLibrarySnapshot {
  private authorList?: AudioAuthor[];
  private bookList?: AudioBook[];
  private links?: Map<number, number[]>;
  private readonly fileCache = new Map<number, BookFileRow[]>();
  private enabledFlag?: boolean;

  constructor(private readonly db: Db) {}

  enabled(): boolean {
    this.enabledFlag ??= audiobooksEnabled(this.db);
    return this.enabledFlag;
  }

  authors(): readonly AudioAuthor[] {
    if (!this.authorList) {
      const fallback = getSection(this.db, 'audiobookMetadata').languages;
      this.authorList = this.db
        .select()
        .from(authors)
        .all()
        .map((r) => ({
          id: r.id,
          name: r.name,
          sortName: r.sortName,
          aliases: r.aliases,
          monitored: r.monitored,
          qualityProfileId: r.qualityProfileId,
          tags: r.tags,
          path: r.path,
          languages: r.languages.length > 0 ? r.languages : fallback,
        }));
    }
    return this.authorList;
  }

  author(id: number): AudioAuthor | undefined {
    return this.authors().find((a) => a.id === id);
  }

  /** Every book in the library (one read per batch; libraries hold thousands at most). */
  private all(): AudioBook[] {
    if (!this.bookList) {
      const entries = this.db
        .select({ e: bookSeriesEntries, name: bookSeries.name })
        .from(bookSeriesEntries)
        .innerJoin(bookSeries, eq(bookSeries.id, bookSeriesEntries.seriesId))
        .all();
      const seriesOf = new Map<number, AudioBookSeries[]>();
      for (const { e, name } of entries) {
        const list = seriesOf.get(e.bookId) ?? [];
        list.push({ seriesId: e.seriesId, name, position: e.position, positionSort: e.positionSort, isPrimary: e.isPrimary });
        seriesOf.set(e.bookId, list);
      }
      this.bookList = this.db
        .select()
        .from(books)
        .all()
        .map((b) => ({
          id: b.id,
          authorId: b.authorId,
          asin: b.asin,
          title: b.title,
          subtitle: b.subtitle,
          language: b.language,
          releaseDate: b.releaseDate,
          year: b.year,
          runtimeMinutes: b.runtimeMinutes,
          formatType: b.formatType,
          monitored: b.monitored,
          hasFile: b.hasFile,
          credits: b.authorCredits.map((c) => c.name),
          series: seriesOf.get(b.id) ?? [],
        }));
    }
    return this.bookList;
  }

  books(authorId: number): readonly AudioBook[] {
    this.links ??= this.db
      .select()
      .from(bookAuthors)
      .all()
      .reduce((m, l) => m.set(l.authorId, [...(m.get(l.authorId) ?? []), l.bookId]), new Map<number, number[]>());
    const linked = new Set(this.links.get(authorId) ?? []);
    return this.all().filter((b) => b.authorId === authorId || linked.has(b.id));
  }

  /** Books the author owns (not co-authored ones). */
  ownBooks(authorId: number): readonly AudioBook[] {
    return this.all().filter((b) => b.authorId === authorId);
  }

  book(id: number): AudioBook | undefined {
    return this.all().find((b) => b.id === id);
  }

  /** Audio files of the author's own books. */
  files(authorId: number): readonly BookFileRow[] {
    let list = this.fileCache.get(authorId);
    if (!list) {
      const ids = this.ownBooks(authorId).map((b) => b.id);
      list =
        ids.length === 0
          ? []
          : this.db
              .select()
              .from(audioFiles)
              .where(and(eq(audioFiles.mediaType, 'audiobook'), inArray(audioFiles.bookId, ids)))
              .all()
              .flatMap((f) =>
                f.bookId === null
                  ? []
                  : [
                      {
                        id: f.id,
                        bookId: f.bookId,
                        quality: f.quality,
                        releaseGroup: f.releaseGroup,
                        sceneName: f.sceneName,
                        relativePath: f.relativePath,
                        sizeBytes: f.sizeBytes,
                        dateAdded: f.dateAdded,
                      },
                    ],
              );
      this.fileCache.set(authorId, list);
    }
    return list;
  }
}
