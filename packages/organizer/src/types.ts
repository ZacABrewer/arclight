// Input shapes for the name builder. They are deliberately the *subset* of the shared library
// types (`Series`, `Episode`, `Movie`, `MediaFile`) that naming needs, so the api can pass
// shared records straight in, while tests and previews can pass small literals.
//
// `NamingMediaInfo` is wider than the shared `MediaInfo` (which does not yet carry format/codec
// ids, bit depth, channel positions or multi-view count). Every field is optional; the shared
// field names (`videoCodec`, `audioCodec`, `videoDynamicRange`, `subtitles`, ...) are accepted
// as fallbacks for the richer probe fields.

export type NamingSeriesType = 'standard' | 'daily' | 'anime';

type Opt<T> = T | null | undefined;

export interface NamingSeries {
  title: string;
  year: number;
  seriesType: NamingSeriesType;
  imdbId?: Opt<string>;
  tvdbId?: Opt<number>;
  tmdbId?: Opt<number>;
  tvMazeId?: Opt<number>;
}

export interface NamingEpisode {
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: Opt<number>;
  title: string;
  /** `YYYY-MM-DD`. */
  airDate?: Opt<string>;
}

export interface NamingQuality {
  quality: {
    id?: number;
    name: string;
    /** User-editable display title of the quality definition; falls back to `name`. */
    title?: Opt<string>;
  };
  revision: { version: number; real: number };
}

export interface NamingMediaInfo {
  /** Container/probe video format id, e.g. `h264`, `hevc`. Falls back to `videoCodec`. */
  videoFormat?: Opt<string>;
  videoCodec?: Opt<string>;
  /** Codec id/tag, e.g. `x264`, `xvid`. */
  videoCodecId?: Opt<string>;
  videoBitDepth?: Opt<number>;
  /** `DV`, `DV HDR10`, `HDR10`, `HDR10Plus`, `HLG`, `PQ`, `HDR`, `SDR`... Falls back to `videoDynamicRange`. */
  videoDynamicRangeType?: Opt<string>;
  videoDynamicRange?: Opt<string>;
  videoMultiViewCount?: Opt<number>;
  /** Primary audio stream format id, e.g. `dts`, `eac3`. Falls back to `audioCodec`. */
  audioFormat?: Opt<string>;
  audioCodec?: Opt<string>;
  audioCodecId?: Opt<string>;
  audioProfile?: Opt<string>;
  /** e.g. `5.1`, `3/2/0.1`. */
  audioChannelPositions?: Opt<string>;
  audioChannels?: Opt<number>;
  audioLanguages?: Opt<readonly string[]>;
  /** Subtitle languages. */
  subtitles?: Opt<readonly string[]>;
}

export interface NamingFile {
  /** Absent/0 means "not yet saved" (still being imported) - relaxes the original-name fallback. */
  id?: Opt<number>;
  relativePath?: Opt<string>;
  path?: Opt<string>;
  sceneName?: Opt<string>;
  releaseGroup?: Opt<string>;
  releaseHash?: Opt<string>;
  edition?: Opt<string>;
  /** Multi-version library slot (`4K`, `HDR`, `Remux`), rendered by `{Version}`. */
  versionTag?: Opt<string>;
  quality?: Opt<NamingQuality>;
  mediaInfo?: Opt<NamingMediaInfo>;
}

export interface NamingMovieTranslation {
  /** ISO 639-1 or 639-2 code. */
  language: string;
  title: string;
}

export interface NamingMovie {
  title: string;
  year: number;
  originalTitle?: Opt<string>;
  collection?: Opt<{ title: string }>;
  certification?: Opt<string>;
  imdbId?: Opt<string>;
  tmdbId?: Opt<number>;
  translations?: Opt<readonly NamingMovieTranslation[]>;
}

export interface NamingCustomFormat {
  name: string;
  includeInRenaming: boolean;
}

export interface NamingExtras {
  /** Custom formats the file matches, in stored order. */
  customFormats?: readonly NamingCustomFormat[];
  /** Season name from metadata, for `{Season Title}`. */
  seasonTitle?: string;
  /** e.g. `.mkv`. When given it is appended to the result and reserved in the length budget. */
  extension?: string;
  /** Folder the file will be placed in; its length is deducted from the path budget. */
  seasonPath?: string;
  /** Default 255 (bytes). */
  maxFileNameBytes?: number;
  /** Default 4096 (bytes). */
  maxPathBytes?: number;
  /** `{Release Group}` text when the file has none (and the token has no prefix/suffix). Default `Arclight`. */
  releaseGroupFallback?: string;
  /** Joins path components. Default `/`. */
  pathSeparator?: string;
}

// ---------------------------------------------------------------------------------------
// Music (docs/design/music-audiobooks.md 9.4)
// ---------------------------------------------------------------------------------------

export interface NamingArtist {
  name: string;
  /** MusicBrainz disambiguation comment, for `{Artist Disambiguation}`. */
  disambiguation?: Opt<string>;
  mbArtistId?: Opt<string>;
}

export interface NamingAlbum {
  title: string;
  /** Primary type: `Album`, `EP`, `Single`, `Compilation`, `Live`... */
  albumType?: Opt<string>;
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; `{Release Year}` takes the year from it. */
  releaseDate?: Opt<string>;
  /** Used when `releaseDate` is absent. */
  year?: Opt<number>;
  disambiguation?: Opt<string>;
  mbReleaseGroupId?: Opt<string>;
}

export interface NamingTrack {
  title: string;
  /** Position on its medium, 1-based. */
  trackNumber: number;
  /** Disc number, 1-based. Default 1. */
  mediumNumber?: Opt<number>;
  /** Track artist when it differs from the album artist (features, compilations). */
  artistName?: Opt<string>;
}

export interface NamingTrackExtras extends NamingExtras {
  /**
   * Media on the selected release. Above 1 the multi-disc style applies (`prefix` format or
   * `Disc {medium}/` sub-folder). Default 1.
   */
  mediumCount?: number;
}

// ---------------------------------------------------------------------------------------
// Audiobooks (docs/design/music-audiobooks.md 9.4)
// ---------------------------------------------------------------------------------------

export interface NamingAuthor {
  name: string;
}

export interface NamingBook {
  title: string;
  subtitle?: Opt<string>;
  /** Series the book belongs to; picks `seriesBookFolderFormat` over `bookFolderFormat`. */
  seriesTitle?: Opt<string>;
  /** `3`, `3.5`, `1-2`. Integers honour a padding modifier (`{Series Position:00}`). */
  seriesPosition?: Opt<string | number>;
  /** First narrator is `{Narrator}`; `{Narrators}` joins them all. */
  narrators?: Opt<readonly string[]>;
  /** `YYYY...` publish date; `{Release Year}`. */
  releaseDate?: Opt<string>;
  year?: Opt<number>;
}

export interface NamingBookExtras extends NamingExtras {
  /** 1-based part of a multi-file book, for `{Part}`. */
  part?: number;
  /** Files in the book. Above 1 `bookPartFormat` is used. Default 1. */
  partCount?: number;
}
