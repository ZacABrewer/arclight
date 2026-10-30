// Every query key lives here so the live layer and the hooks can never disagree.
// Keys are hierarchical: invalidating ['jobs'] hits both recent and scheduled.
export const queryKeys = {
  systemStatus: ['system', 'status'] as const,
  health: ['health'] as const,
  jobs: {
    all: ['jobs'] as const,
    recent: ['jobs', 'recent'] as const,
    scheduled: ['jobs', 'scheduled'] as const,
  },
};

/** How many recent job runs the cache keeps (matches the api's default list size). */
export const RECENT_JOBS_LIMIT = 50;

/** Subtitles (Phase 3). live.ts invalidates ['subtitles'] on a subtitle event, ['languageProfiles'] on action 'profiles'. */
export const subtitleKeys = {
  all: ['subtitles'] as const,
  languageProfiles: ['languageProfiles'] as const,
  languages: ['subtitles', 'languages'] as const,
  settings: ['subtitles', 'settings'] as const,
  providers: ['subtitles', 'providers'] as const,
  wanted: (mediaType: string, page: number, pageSize: number, q = '') => ['subtitles', 'wanted', mediaType, page, pageSize, q] as const,
  history: (filter: unknown) => ['subtitles', 'history', filter] as const,
  blacklist: (page: number, pageSize: number) => ['subtitles', 'blacklist', page, pageSize] as const,
  files: (scope: unknown) => ['subtitles', 'files', scope] as const,
  /** Manual search results are a snapshot: never invalidated by events (separate family). */
  manualSearch: (mediaFileId: number, language: string) => ['subtitleSearch', mediaFileId, language] as const,
};
