import type {
  PlayableItem,
  PlayerEpisode,
  PlayerMovie,
  PlayerMovieDetails,
  PlayerSeries,
  PlayerSeriesDetails,
  VideoHome,
  VideoSession,
} from '@arclight/shared';

// Movies & TV fixtures for the tests (example data only).

export function movie(id: number, over: Partial<PlayerMovie> = {}): PlayerMovie {
  return {
    id,
    itemKey: `movie:${id}`,
    title: `Movie ${id}`,
    year: 2021,
    posterUrl: null,
    backdropUrl: null,
    runtimeMinutes: 112,
    certification: 'PG-13',
    rating: 7.4,
    genres: ['Drama'],
    addedAt: '2026-10-01T00:00:00.000Z',
    progress: null,
    played: false,
    badges: [],
    ...over,
  } as PlayerMovie;
}

export function movieDetails(id: number, over: Partial<PlayerMovieDetails> = {}): PlayerMovieDetails {
  return {
    ...movie(id),
    originalTitle: null,
    overview: 'An example overview.',
    logoUrl: null,
    ratings: { tmdb: 7.4, imdb: null, rottenTomatoes: null },
    studio: 'Example Studio',
    collection: null,
    versions: [
      {
        versionTag: null,
        label: '1080p',
        mediaFileId: 501,
        badges: [],
        description: 'H.264 · AAC 2.0 · 1080p',
        sizeBytes: 4_000_000_000,
        audioLanguages: ['eng'],
        subtitleLanguages: ['eng', 'spa'],
      },
    ],
    ...over,
  } as PlayerMovieDetails;
}

export function series(id: number, over: Partial<PlayerSeries> = {}): PlayerSeries {
  return {
    id,
    title: `Show ${id}`,
    year: 2019,
    posterUrl: null,
    backdropUrl: null,
    certification: null,
    rating: 8.1,
    genres: ['Comedy'],
    network: 'Example Network',
    status: 'continuing',
    addedAt: '2026-10-01T00:00:00.000Z',
    episodeCount: 3,
    playedCount: 1,
    badges: [],
    ...over,
  };
}

export function episode(id: number, season: number, number: number, over: Partial<PlayerEpisode> = {}): PlayerEpisode {
  return {
    itemKey: `episode:${id}`,
    id,
    seasonNumber: season,
    episodeNumber: number,
    title: `Episode title ${id}`,
    overview: null,
    airDate: null,
    runtimeMinutes: 30,
    thumbUrl: null,
    progress: null,
    played: false,
    ...over,
  } as PlayerEpisode;
}

export function seriesDetails(id: number, over: Partial<PlayerSeriesDetails> = {}): PlayerSeriesDetails {
  return {
    ...series(id),
    originalTitle: null,
    overview: null,
    logoUrl: null,
    seasons: [
      { seasonNumber: 1, title: 'Season 1', episodeCount: 2, playedCount: 1, episodes: [episode(41, 1, 1, { played: true }), episode(42, 1, 2)] },
      { seasonNumber: 2, title: 'Season 2', episodeCount: 1, playedCount: 0, episodes: [episode(43, 2, 1)] },
    ],
    nextUp: 'episode:42',
    ...over,
  } as PlayerSeriesDetails;
}

export function emptyHome(over: Partial<VideoHome> = {}): VideoHome {
  return { continueWatching: [], nextUp: [], recentMovies: [], recentEpisodes: [], genres: [], ...over };
}

export function videoItem(over: Partial<PlayableItem> = {}): PlayableItem {
  return {
    itemKey: 'movie:7',
    kind: 'movie',
    title: 'Movie 7',
    subtitle: null,
    context: null,
    artworkUrl: null,
    durationMs: 600_000,
    parts: [],
    chapters: [],
    albumId: null,
    artistId: null,
    bookId: null,
    replayGain: null,
    movieId: 7,
    video: {
      mediaFileId: 501,
      versionTag: null,
      container: 'mkv',
      videoCodec: 'h264',
      videoProfile: null,
      bitDepth: 8,
      width: 1920,
      height: 1080,
      fps: 24,
      dynamicRange: 'sdr',
      sizeBytes: 1_000_000,
      bitrateKbps: 8000,
      audioTracks: [
        { index: 0, codec: 'aac', channels: 2, language: 'eng', title: null, default: true },
        { index: 1, codec: 'ac3', channels: 6, language: 'spa', title: null, default: false },
      ],
      subtitleTracks: [
        { id: 'e0', source: 'embedded', codec: 'subrip', language: 'eng', title: null, forced: false, hearingImpaired: false, default: false, text: true },
        { id: 'e1', source: 'embedded', codec: 'hdmv_pgs_subtitle', language: 'fra', title: null, forced: false, hearingImpaired: false, default: false, text: false },
      ],
    },
    versions: [{ versionTag: null, label: '1080p', mediaFileId: 501 }],
    segments: [],
    ...over,
  } as PlayableItem;
}

export function session(over: Partial<VideoSession> = {}): VideoSession {
  return {
    itemKey: 'movie:7',
    mediaFileId: 501,
    method: 'direct',
    reasons: [],
    url: 'http://localhost/stream/video/501?sig=x',
    mimeType: 'video/x-matroska',
    streamStartMs: 0,
    seekable: true,
    durationMs: 600_000,
    audioTrack: 0,
    subtitles: [],
    burnedSubtitle: null,
    expiresAt: '2026-11-02T12:00:00.000Z',
    ...over,
  } as VideoSession;
}
