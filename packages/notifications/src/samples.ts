/**
 * One made-up event of every type, for the template preview and "what will this look like"
 * screens. Titles and URLs are fictional (example.com).
 */

import type { EpisodeInfo, MediaFileInfo, MediaInfo, NotificationEvent, NotificationEventType, ReleaseInfo } from './types.js';

const SERIES: MediaInfo = {
  id: 7,
  mediaType: 'series',
  title: 'Signal Lost',
  year: 2023,
  tmdbId: 123456,
  imdbId: 'tt1234567',
  path: '/tv/Signal Lost (2023)',
  overview: 'A radio operator hears a broadcast from a station that burned down forty years ago.',
  genres: ['Drama', 'Mystery'],
  tags: [],
  rating: 8.1,
  images: [
    { coverType: 'poster', url: 'https://image.tmdb.org/t/p/w500/example-poster.jpg' },
    { coverType: 'fanart', url: 'https://image.tmdb.org/t/p/w1280/example-fanart.jpg' },
  ],
};

const MOVIE: MediaInfo = {
  id: 42,
  mediaType: 'movie',
  title: 'Harbour Lights',
  year: 2021,
  tmdbId: 98765,
  path: '/movies/Harbour Lights (2021)',
  overview: 'A lighthouse keeper finds a message that should not exist.',
  genres: ['Thriller'],
  tags: [],
  images: [{ coverType: 'poster', url: 'https://image.tmdb.org/t/p/w500/example-movie.jpg' }],
};

const EPISODES: EpisodeInfo[] = [{ id: 701, seasonNumber: 2, episodeNumber: 3, title: 'Dead Air', airDate: '2026-10-24' }];

const RELEASE: ReleaseInfo = {
  title: 'Signal.Lost.S02E03.1080p.WEB.H264-GRP',
  quality: 'WEBDL-1080p',
  qualityVersion: 1,
  indexer: 'Example Indexer',
  size: 1_610_612_736,
  releaseGroup: 'GRP',
  customFormats: ['Streaming Service'],
  customFormatScore: 100,
};

const FILE: MediaFileInfo = {
  id: 9001,
  path: '/tv/Signal Lost (2023)/Season 02/Signal Lost - S02E03 - Dead Air.mkv',
  relativePath: 'Season 02/Signal Lost - S02E03 - Dead Air.mkv',
  quality: 'WEBDL-1080p',
  qualityVersion: 1,
  releaseGroup: 'GRP',
  size: 1_610_612_736,
  dateAdded: '2026-10-25T11:59:00.000Z',
  languages: ['English'],
};

const USER = { id: 2, username: 'alex' };
const PODCAST = { id: 3, title: 'Night Signals', author: 'Example Radio' };
const PODCAST_EPISODE = { id: 41, title: 'Static on the Line', publishedAt: '2026-10-24T06:00:00.000Z', durationSeconds: 2_940 };
const DOWNLOAD = { trackedDownloadId: 12, downloadId: 'abc123', title: RELEASE.title };
const HEALTH = { source: 'downloadClients', status: 'error' as const, message: 'Unable to communicate with the download client.' };

/** A sample of `type` sent from `instanceName`, linking to `applicationUrl` when given. */
export function sampleEvent(type: NotificationEventType, instanceName = 'Arclight', applicationUrl?: string, now: Date = new Date()): NotificationEvent {
  const base = { instanceName, timestamp: now.toISOString(), ...(applicationUrl ? { applicationUrl } : {}) };
  const series = { ...base, media: SERIES, episodes: EPISODES };
  const movie = { ...base, media: MOVIE };
  const request = { id: 31, requestedBy: USER, status: 'approved' as const, is4k: false };
  switch (type) {
    case 'test':
      return { ...base, type, message: `This is a test notification from ${instanceName}.` };
    case 'grab':
      return { ...series, type, release: RELEASE, downloadClient: 'qBittorrent' };
    case 'import':
      return { ...series, type, file: FILE, release: RELEASE, downloadClient: 'qBittorrent' };
    case 'upgrade':
      return { ...series, type, file: FILE, release: RELEASE, oldFiles: [{ ...FILE, id: 8000, quality: 'HDTV-720p' }] };
    case 'rename':
      return { ...series, type, renamedFiles: [{ fileId: 9001, previousPath: '/tv/old.mkv', previousRelativePath: 'old.mkv', path: FILE.path, relativePath: FILE.relativePath }] };
    case 'mediaAdded':
      return { ...movie, type, addMethod: 'manual' };
    case 'mediaDeleted':
      return { ...movie, type, deletedFiles: false };
    case 'fileDeleted':
      return { ...series, type, file: FILE, reason: 'manual' };
    case 'healthIssue':
      return { ...base, type, health: HEALTH };
    case 'healthRestored':
      return { ...base, type, health: HEALTH };
    case 'applicationUpdate':
      return { ...base, type, previousVersion: '0.19.0', newVersion: '0.20.0' };
    case 'manualInteractionRequired':
      return { ...series, type, release: RELEASE, downloadTitle: RELEASE.title, downloadStatus: 'warning', statusMessages: [{ title: RELEASE.title, messages: ['No eligible files found'] }] };
    case 'subtitleDownloaded':
      return { ...series, type, subtitle: { language: 'English', provider: 'Example Subtitles', path: '/tv/Signal Lost (2023)/Season 02/S02E03.en.srt', score: 93 } };
    case 'requestCreated':
      return { ...movie, type, request: { ...request, status: 'pending' } };
    case 'requestApproved':
      return { ...movie, type, request };
    case 'requestAvailable':
      return { ...movie, type, request: { ...request, status: 'available' } };
    case 'requestDeclined':
      return { ...movie, type, request: { ...request, status: 'declined' }, reason: 'Already in the library in 4K' };
    case 'issueCreated':
      return { ...series, type, issue: { id: 5, issueType: 'audio', status: 'open', reportedBy: USER, message: 'The audio is out of sync after ten minutes.' } };
    case 'issueUpdated':
      return {
        ...series,
        type,
        issue: { id: 5, issueType: 'audio', status: 'open', reportedBy: USER, message: 'The audio is out of sync.', change: 'comment', comment: { user: { id: 1, username: 'admin' }, message: 'Replaced the file, try again.' } },
      };
    case 'requestsDigest':
      return {
        ...base,
        type,
        pendingRequests: [{ id: 31, mediaType: 'movie', title: MOVIE.title, year: MOVIE.year, requestedBy: USER.username, is4k: false, createdAt: now.toISOString() }],
        openIssues: [],
        totalPendingRequests: 1,
        totalOpenIssues: 0,
      };
    case 'retention':
      return {
        ...base,
        type,
        staged: [{ mediaType: 'movie', title: MOVIE.title, year: MOVIE.year, rule: 'Watched and old', action: 'deleteFiles', sizeBytes: 8_000_000_000, reasons: ['Watched 200 days ago'] }],
        applied: [],
        failed: [],
        totalStaged: 1,
        totalApplied: 0,
        totalFailed: 0,
        freedBytes: 0,
      };
    case 'healthScan':
      return { ...base, type, findings: [{ title: 'Signal Lost S02E03', type: 'truncated', severity: 'error', details: 'The file ends early.' }], totalNew: 1, totalOpen: 1, filesChecked: 120 };
    case 'fileTranscoded':
      return { ...series, type, file: FILE, previousPath: '/tv/old.avi', action: 'remux', sizeBefore: 1_700_000_000, sizeAfter: 1_610_612_736 };
    case 'downloadStalled':
      return { ...base, type, download: DOWNLOAD, message: 'No data for 30 minutes' };
    case 'podcastEpisodes':
      return { ...base, type, podcast: PODCAST, items: [PODCAST_EPISODE], total: 1 };
    case 'podcastDownload':
      return { ...base, type, podcast: PODCAST, item: PODCAST_EPISODE, path: '/podcasts/Night Signals/2026/2026-10-24 - Static on the Line.mp3', sizeBytes: 48_234_496 };
    case 'downloadRejected':
      return { ...base, type, download: DOWNLOAD, message: 'Contains an executable file (setup.exe)' };
    case 'killSwitch':
      return { ...base, type, reason: 'VPN disconnected', since: now.toISOString(), pausedCount: 2, titles: [RELEASE.title] };
    case 'killSwitchResumed':
      return { ...base, type, reason: 'VPN reconnected', resumedCount: 2, durationMs: 300_000 };
    case 'importProblem':
      return { ...base, type, problem: 'failed', download: DOWNLOAD, message: 'No video files found' };
    case 'diskSpaceLow':
      return { ...base, type, health: { source: 'diskSpace', status: 'warning', message: '/tv has 4 GB free' } };
    case 'downloadUpdate':
      return { ...base, type, download: DOWNLOAD, timelineType: 'recovered', severity: 'ok', message: 'Download is moving again' };
    case 'dailySummary':
      return {
        ...base,
        type,
        summary: {
          id: 1,
          generatedAt: now.toISOString(),
          periodStart: new Date(now.getTime() - 86_400_000).toISOString(),
          periodEnd: now.toISOString(),
          counts: { grabbed: 4, imported: 3, failed: 0, stalled: 1, recovered: 1, replaced: 0 },
          killSwitch: { pauses: 0, totalMs: 0 },
          disk: [{ path: '/tv', kind: 'rootFolder', freeBytes: 500_000_000_000, changeBytes: -4_000_000_000 }],
          problems: [],
          healthIssues: [],
          downloading: { count: 1, items: [{ id: 12, title: RELEASE.title, progress: 0.4 }] },
        },
      };
    case 'heldAlerts':
      return { ...base, type, events: [sampleEvent('grab', instanceName, applicationUrl, now), sampleEvent('import', instanceName, applicationUrl, now)], heldSince: now.toISOString() };
  }
}
