import { PodcastSettings, PodcastSubscriptionSettings, type Podcast, type PodcastEpisodeRow, type PodcastSuggestion } from '@arclight/shared';

// Test data for the podcast pages. Every title, author and URL is invented.

export const POD_FEATURES_ON = { music: false, audiobooks: false, podcasts: true };
export const POD_FEATURES_OFF = { music: false, audiobooks: false, podcasts: false };

export const podDefaults: PodcastSubscriptionSettings = PodcastSubscriptionSettings.parse({});

export function makePodcast(over: Partial<Podcast> & { id: number; title: string }): Podcast {
  return {
    sortTitle: over.title.toLowerCase(),
    author: 'Lantern Audio',
    description: '<p>Weekly talk about <b>tide pools</b>.</p>',
    feedUrl: `https://example.com/feeds/${over.id}.xml`,
    privateFeed: false,
    link: 'https://example.com/show',
    imageUrl: null,
    language: 'en',
    categories: ['Science'],
    explicit: false,
    feedType: 'episodic',
    podcastGuid: null,
    itunesId: null,
    podcastIndexId: null,
    funding: [],
    path: `/data/podcasts/${over.title}`,
    monitored: true,
    status: 'active',
    lastError: null,
    settings: podDefaults,
    tags: [],
    added: '2026-10-01T00:00:00.000Z',
    lastRefreshed: '2026-10-30T10:00:00.000Z',
    nextRefreshAt: '2026-10-30T11:00:00.000Z',
    ttlMinutes: null,
    statistics: { episodeCount: 12, downloadedCount: 4, playedCount: 2, wantedCount: 0, sizeOnDisk: 400 * 1024 ** 2, lastEpisodeAt: '2026-10-29T06:00:00.000Z' },
    ...over,
  };
}

export function makeEpisode(over: Partial<PodcastEpisodeRow> & { id: number; title: string }): PodcastEpisodeRow {
  return {
    podcastId: 1,
    guid: `guid-${over.id}`,
    description: '',
    publishedAt: '2026-10-29T06:00:00.000Z',
    durationSeconds: 2700,
    season: null,
    episodeNumber: over.id,
    episodeType: 'full',
    explicit: false,
    imageUrl: null,
    link: null,
    enclosure: { url: `https://example.com/audio/${over.id}.mp3`, type: 'audio/mpeg', length: 40_000_000 },
    alternateEnclosures: [],
    chaptersUrl: null,
    transcripts: [],
    persons: [],
    status: 'available',
    path: null,
    sizeBytes: null,
    downloadedAt: null,
    hasChapters: false,
    transcriptFiles: [],
    played: false,
    playedAt: null,
    playedSource: null,
    error: null,
    attempts: 0,
    added: '2026-10-29T07:00:00.000Z',
    podcastTitle: 'Tide Pool Hour',
    podcastImageUrl: null,
    ...over,
  };
}

export const episodePage = (records: PodcastEpisodeRow[], totalRecords = records.length) => ({ page: 1, pageSize: 50, totalRecords, records });

export function makeSuggestion(over: Partial<PodcastSuggestion> & { id: number; title: string }): PodcastSuggestion {
  return {
    userId: 7,
    username: 'river',
    feedUrl: `https://example.com/suggested/${over.id}.xml`,
    author: null,
    imageUrl: null,
    itunesId: null,
    podcastIndexId: null,
    note: null,
    status: 'pending',
    podcastId: null,
    declineReason: null,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...over,
  };
}

export const podSettings = (over: Partial<PodcastSettings> = {}): PodcastSettings => ({ ...PodcastSettings.parse({ rootFolder: '/data/podcasts' }), ...over });
