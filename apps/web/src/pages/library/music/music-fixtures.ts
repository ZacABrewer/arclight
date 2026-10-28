import { QUALITIES, type Album, type AlbumDetails, type AlbumRelease, type Artist, type ArtistDetails, type AudioFile, type Track } from '@arclight/shared';

// Test fixtures for the music pages (only imported by *.test.ts[x]).

export const MBID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function makeArtist(over: Partial<Artist> & { id: number; name: string }): Artist {
  return {
    mbArtistId: MBID(over.id),
    sortName: over.name,
    cleanName: over.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    status: 'continuing',
    overview: '',
    genres: [],
    images: [],
    links: [],
    aliases: [],
    path: `/music/${over.name}`,
    rootFolderPath: '/music',
    qualityProfileId: 11,
    albumTypeProfileId: 1,
    monitored: true,
    monitorNewAlbums: 'all',
    tags: [],
    added: '2026-01-01T00:00:00.000Z',
    lastRefreshed: '2026-01-02T00:00:00.000Z',
    statistics: {
      trackCount: 20,
      trackFileCount: 10,
      totalTrackCount: 20,
      sizeOnDisk: 500 * 1024 ** 2,
      percentOfTracks: 50,
      albumCount: 2,
      monitoredAlbumCount: 2,
      completeAlbumCount: 1,
    },
    ...over,
  };
}

export function makeAlbum(over: Partial<Album> & { id: number; title: string }): Album {
  return {
    artistId: 1,
    mbReleaseGroupId: MBID(1000 + over.id),
    cleanTitle: over.title.toLowerCase().replace(/[^a-z0-9]/g, ''),
    primaryType: 'Album',
    secondaryTypes: [],
    releaseDate: '2020-01-01',
    year: 2020,
    overview: '',
    genres: [],
    images: [],
    ratings: {},
    monitored: true,
    anyReleaseOk: true,
    selectedReleaseId: null,
    added: '2026-01-01T00:00:00.000Z',
    statistics: { trackCount: 10, trackFileCount: 5, totalTrackCount: 10, sizeOnDisk: 100 * 1024 ** 2, percentOfTracks: 50 },
    ...over,
  };
}

export function makeArtistDetails(artist: Artist, albums: Album[]): ArtistDetails {
  return { ...artist, albums };
}

export function makeRelease(over: Partial<AlbumRelease> & { id: number; title: string }): AlbumRelease {
  return {
    albumId: 1,
    mbReleaseId: MBID(5000 + over.id),
    status: 'Official',
    country: 'XW',
    date: '2020-01-01',
    labels: [],
    formats: ['Digital Media'],
    mediumCount: 1,
    trackCount: 2,
    media: [{ position: 1, format: 'Digital Media', trackCount: 2 }],
    ...over,
  };
}

export function makeTrack(over: Partial<Track> & { id: number; title: string }): Track {
  return {
    albumId: 1,
    albumReleaseId: 1,
    mediumNumber: 1,
    absoluteNumber: over.id,
    trackNumber: over.id,
    durationMs: 200_000,
    hasFile: false,
    ...over,
  };
}

export function makeAudioFile(over: Partial<AudioFile> & { id: number }): AudioFile {
  return {
    mediaType: 'music',
    artistId: 1,
    albumId: 1,
    path: `/music/Artist/Album/0${over.id}.flac`,
    relativePath: `Album/0${over.id}.flac`,
    sizeBytes: 30 * 1024 ** 2,
    dateAdded: '2026-01-03T00:00:00.000Z',
    quality: { quality: { ...QUALITIES.FLAC }, revision: { version: 1, real: 0, isRepack: false } },
    codec: 'FLAC',
    bitDepth: 16,
    sampleRateHz: 44_100,
    channels: 2,
    durationMs: 200_000,
    discNumber: 1,
    trackNumber: over.id,
    ...over,
  } as AudioFile;
}

export function makeAlbumDetails(album: Album, extra: Partial<Pick<AlbumDetails, 'releases' | 'tracks' | 'files'>> & { artist?: Artist } = {}): AlbumDetails {
  const artist = extra.artist ?? makeArtist({ id: album.artistId, name: 'Artist' });
  return {
    ...album,
    artist: { id: artist.id, mbArtistId: artist.mbArtistId, name: artist.name, sortName: artist.sortName, path: artist.path, images: artist.images },
    releases: extra.releases ?? [],
    tracks: extra.tracks ?? [],
    files: extra.files ?? [],
  };
}

/** Music-domain quality profiles (as the api returns them for ?mediaDomain=music). */
export const musicProfiles = [
  { id: 11, name: 'Lossless', upgradeAllowed: true, cutoff: 131, items: [{ kind: 'quality', qualityId: 131, allowed: true }], minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [], languages: [], mediaDomain: 'music' },
  { id: 12, name: 'Any MP3', upgradeAllowed: true, cutoff: 106, items: [{ kind: 'quality', qualityId: 106, allowed: true }], minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [], languages: [], mediaDomain: 'music' },
];

export const albumTypeProfiles = [
  { id: 1, name: 'Studio albums', primaryTypes: ['Album', 'EP'], secondaryTypes: [], releaseStatuses: ['Official'], isDefault: true },
  { id: 2, name: 'Everything', primaryTypes: ['Album', 'EP', 'Single', 'Broadcast', 'Other'], secondaryTypes: ['Live'], releaseStatuses: ['Official'], isDefault: false },
];

export const musicRoots = [
  { id: 1, path: '/data/tv', mediaType: 'series', accessible: true, freeSpaceBytes: 1e12 },
  { id: 4, path: '/data/music', mediaType: 'music', accessible: true, freeSpaceBytes: 1e12 },
];

export const FEATURES_ON = { music: true, audiobooks: false };
export const FEATURES_OFF = { music: false, audiobooks: false };
