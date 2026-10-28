// Canned sample data for previews (spec section 10).

import type {
  NamingAlbum,
  NamingArtist,
  NamingAuthor,
  NamingBook,
  NamingCustomFormat,
  NamingEpisode,
  NamingExtras,
  NamingFile,
  NamingMovie,
  NamingSeries,
  NamingTrack,
} from './types.js';

const series: NamingSeries = {
  title: "The Series Title's!",
  year: 2010,
  seriesType: 'standard',
  imdbId: 'tt12345',
  tvdbId: 12345,
  tmdbId: 54321,
  tvMazeId: 2345,
};

const episode = (n: number): NamingEpisode => ({
  seasonNumber: 1,
  episodeNumber: n,
  absoluteEpisodeNumber: n,
  title: `Episode Title (${n})`,
  airDate: '2013-10-30',
});

const customFormats: NamingCustomFormat[] = [
  { name: 'Surround Sound', includeInRenaming: true },
  { name: 'x264', includeInRenaming: true },
];

const file: NamingFile = {
  id: 1,
  relativePath: "Season 01/The.Series.Title's!.S01E01.1080p.WEBDL.x264-EVOLVE.mkv",
  sceneName: "The.Series.Title's!.S01E01.1080p.WEBDL.x264-EVOLVE",
  releaseGroup: 'RlsGrp',
  quality: { quality: { id: 3, name: 'WEBDL-1080p' }, revision: { version: 2, real: 0 } },
  mediaInfo: {
    videoFormat: 'h264',
    videoBitDepth: 10,
    videoDynamicRangeType: 'HLG',
    audioFormat: 'dts',
    audioChannelPositions: '5.1',
    audioChannels: 6,
    audioLanguages: ['ger'],
    subtitles: ['eng', 'ger'],
  },
};

const animeFile: NamingFile = {
  ...file,
  relativePath: "Season 01/[RlsGroup] The Series Title's! - 001 [1080p].mkv",
  sceneName: "[RlsGroup] The Series Title's! - 001 [1080p]",
  releaseGroup: 'RlsGrp',
  releaseHash: 'ABCDEFGH',
  mediaInfo: { ...file.mediaInfo, audioLanguages: ['jpn'], subtitles: ['eng'] },
};

const movie: NamingMovie = {
  title: 'The Movie: Title',
  year: 2010,
  originalTitle: 'The Original Movie Title',
  collection: { title: 'The Movie Collection' },
  certification: 'R',
  imdbId: 'tt0123456',
  tmdbId: 345691,
};

const movieFile: NamingFile = {
  id: 1,
  relativePath: 'The.Movie.Title.2010.1080p.BluRay.DTS.x264-EVOLVE.mkv',
  sceneName: 'The.Movie.Title.2010.1080p.BluRay.DTS.x264-EVOLVE',
  releaseGroup: 'EVOLVE',
  edition: 'Ultimate extended edition',
  quality: { quality: { id: 7, name: 'Bluray-1080p' }, revision: { version: 2, real: 0 } },
  mediaInfo: {
    videoFormat: 'h264',
    videoBitDepth: 8,
    audioFormat: 'dts',
    audioChannelPositions: '5.1',
    audioLanguages: ['eng'],
    subtitles: ['eng', 'ger'],
  },
};

const extras: NamingExtras = { customFormats };

const artist: NamingArtist = { name: 'The Artist Name', disambiguation: 'UK band' };

const album: NamingAlbum = { title: 'The Album Title: Deluxe', albumType: 'Album', releaseDate: '2020-05-01' };

const track: NamingTrack = { title: 'Track Title', trackNumber: 3, mediumNumber: 1, artistName: 'The Artist Name feat. Guest' };

const trackFile: NamingFile = {
  id: 1,
  relativePath: '03 track title.flac',
  sceneName: 'The_Artist_Name-The_Album_Title-WEB-FLAC-2020-GRP',
  releaseGroup: 'GRP',
  quality: { quality: { name: 'FLAC' }, revision: { version: 1, real: 0 } },
};

const author: NamingAuthor = { name: 'Author Name' };

const book: NamingBook = { title: 'Book Title', subtitle: 'A Subtitle', narrators: ['Narrator Name'], releaseDate: '2019-03-05' };

const bookFile: NamingFile = {
  id: 1,
  relativePath: 'Book Title (Unabridged).m4b',
  quality: { quality: { name: 'M4B' }, revision: { version: 1, real: 0 } },
};

export const SAMPLES = {
  series,
  dailySeries: { ...series, seriesType: 'daily' } satisfies NamingSeries,
  animeSeries: { ...series, seriesType: 'anime' } satisfies NamingSeries,
  episode1: episode(1),
  episodes: [episode(1), episode(2), episode(3)],
  file,
  animeFile,
  movie,
  movieFile,
  extras,
  artist,
  album,
  track,
  discTrack: { ...track, mediumNumber: 2 } satisfies NamingTrack,
  trackFile,
  author,
  book,
  seriesBook: { ...book, seriesTitle: 'Series Title', seriesPosition: 3 } satisfies NamingBook,
  bookFile,
} as const;
