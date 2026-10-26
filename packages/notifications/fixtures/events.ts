/** Hand-written sample events shared by the agent tests. */

import type {
  GrabEvent,
  HealthIssueEvent,
  HealthRestoredEvent,
  ImportEvent,
  ManualInteractionRequiredEvent,
  MediaDeletedEvent,
  MediaFileInfo,
  MediaInfo,
  RenameEvent,
  UpgradeEvent,
} from '../src/types.js';

export const SERIES: MediaInfo = {
  id: 7,
  mediaType: 'series',
  title: 'Signal Lost',
  year: 2023,
  tmdbId: 123456,
  imdbId: 'tt1234567',
  tvdbId: 424242,
  path: '/tv/Signal Lost (2023)',
  overview: 'A radio operator hears a broadcast from a station that burned down forty years ago.',
  genres: ['Drama', 'Mystery', 'Sci-Fi'],
  tags: ['anime-free'],
  rating: 8.1,
  images: [
    { coverType: 'poster', url: 'https://img.example/poster.jpg' },
    { coverType: 'fanart', url: 'https://img.example/fanart.jpg' },
  ],
};

export const MOVIE: MediaInfo = {
  id: 42,
  mediaType: 'movie',
  title: 'Harbour Lights',
  year: 2021,
  tmdbId: 98765,
  imdbId: 'tt7654321',
  path: '/movies/Harbour Lights (2021)',
  genres: ['Thriller'],
  tags: [],
  images: [{ coverType: 'poster', url: 'https://img.example/harbour.jpg' }],
};

const BASE = {
  instanceName: 'Media-Tron',
  applicationUrl: 'https://mt.example.com',
  timestamp: '2026-10-25T12:00:00.000Z',
};

export const GRAB: GrabEvent = {
  type: 'grab',
  ...BASE,
  media: SERIES,
  episodes: [
    { id: 701, seasonNumber: 2, episodeNumber: 3, title: 'Dead Air', airDate: '2026-10-24', overview: 'Episode overview.' },
    { id: 702, seasonNumber: 2, episodeNumber: 4, title: 'Carrier Wave', airDate: '2026-10-24' },
  ],
  release: {
    title: 'Signal.Lost.S02E03E04.1080p.WEB.H264-GRP',
    quality: 'WEBDL-1080p',
    qualityVersion: 1,
    indexer: 'Example Indexer',
    size: 3_221_225_472,
    releaseGroup: 'GRP',
    customFormats: ['x264', 'Streaming Service'],
    customFormatScore: 150,
  },
  downloadClient: 'qBittorrent',
  downloadClientType: 'qbittorrent',
  downloadId: 'abc123def456',
};

export const NEW_FILE: MediaFileInfo = {
  id: 9001,
  path: '/movies/Harbour Lights (2021)/Harbour Lights (2021) Bluray-1080p.mkv',
  relativePath: 'Harbour Lights (2021) Bluray-1080p.mkv',
  quality: 'Bluray-1080p',
  qualityVersion: 1,
  releaseGroup: 'GRP',
  sceneName: 'Harbour.Lights.2021.1080p.BluRay.x264-GRP',
  size: 8_589_934_592,
  dateAdded: '2026-10-25T11:59:00.000Z',
  languages: ['English'],
  mediaInfo: {
    videoCodec: 'x264',
    audioCodec: 'DTS',
    audioChannels: 5.1,
    width: 1920,
    height: 1080,
    audioLanguages: ['English'],
    subtitleLanguages: ['English', 'French'],
  },
  sourcePath: '/downloads/Harbour.Lights.2021.1080p.BluRay.x264-GRP/harbour.mkv',
};

export const IMPORT: ImportEvent = {
  type: 'import',
  ...BASE,
  media: MOVIE,
  file: NEW_FILE,
  release: {
    title: 'Harbour.Lights.2021.1080p.BluRay.x264-GRP',
    quality: 'Bluray-1080p',
    qualityVersion: 1,
    indexer: 'Example Indexer',
    size: 8_600_000_000,
    releaseGroup: 'GRP',
    customFormats: [],
    customFormatScore: 0,
  },
  downloadClient: 'qBittorrent',
  downloadClientType: 'qbittorrent',
  downloadId: 'fedcba987654',
};

export const UPGRADE: UpgradeEvent = {
  ...IMPORT,
  type: 'upgrade',
  oldFiles: [
    {
      id: 8000,
      path: '/movies/Harbour Lights (2021)/Harbour Lights (2021) WEBDL-720p.mkv',
      relativePath: 'Harbour Lights (2021) WEBDL-720p.mkv',
      quality: 'WEBDL-720p',
      qualityVersion: 1,
      size: 2_000_000_000,
      dateAdded: '2025-01-01T00:00:00.000Z',
      languages: ['English'],
      recycleBinPath: '/recycle/Harbour Lights (2021) WEBDL-720p.mkv',
    },
  ],
};

export const RENAME: RenameEvent = {
  type: 'rename',
  ...BASE,
  media: SERIES,
  renamedFiles: [
    {
      fileId: 1,
      previousPath: '/tv/Signal Lost (2023)/old.mkv',
      previousRelativePath: 'old.mkv',
      path: '/tv/Signal Lost (2023)/Season 02/Signal Lost - S02E03 - Dead Air.mkv',
      relativePath: 'Season 02/Signal Lost - S02E03 - Dead Air.mkv',
    },
  ],
};

export const MEDIA_DELETED: MediaDeletedEvent = {
  type: 'mediaDeleted',
  ...BASE,
  media: MOVIE,
  deletedFiles: true,
};

export const HEALTH_ISSUE: HealthIssueEvent = {
  type: 'healthIssue',
  ...BASE,
  health: {
    source: 'downloadClients',
    status: 'error',
    message: 'Unable to communicate with qBittorrent.',
    wikiUrl: 'https://mt.example.com/wiki/health#download-clients',
  },
};

export const HEALTH_RESTORED: HealthRestoredEvent = {
  type: 'healthRestored',
  ...BASE,
  health: { source: 'downloadClients', status: 'error', message: 'Unable to communicate with qBittorrent.' },
};

export const MANUAL_INTERACTION: ManualInteractionRequiredEvent = {
  type: 'manualInteractionRequired',
  ...BASE,
  media: SERIES,
  episodes: GRAB.episodes ?? [],
  release: GRAB.release,
  downloadTitle: 'Signal.Lost.S02E03E04.1080p.WEB.H264-GRP',
  downloadStatus: 'warning',
  statusMessages: [{ title: 'Signal.Lost.S02E03E04.1080p.WEB.H264-GRP', messages: ['No files found are eligible for import'] }],
  downloadClient: 'qBittorrent',
  downloadId: 'abc123def456',
};
