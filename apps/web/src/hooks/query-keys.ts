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
