import type { PodcastEpisodeQuery, PodcastSearchSource, PodcastSuggestionListQuery } from '@arclight/shared';

// Query keys for the podcast pages. Subscriptions, episodes and suggestions live under ['podcast']
// so one `podcast` server event (live.ts) refetches them together. Directory searches are
// snapshots kept outside it; the settings section sits under ['settings'] like every other page.
export const podcastKeys = {
  all: ['podcast'] as const,
  list: () => ['podcast', 'list'] as const,
  detail: (id: number) => ['podcast', 'detail', id] as const,
  episodes: (query: PodcastEpisodeQuery) => ['podcast', 'episodes', query] as const,
  suggestions: (query: PodcastSuggestionListQuery = {}) => ['podcast', 'suggestions', query] as const,
  lookup: (term: string, source: PodcastSearchSource | undefined) => ['podcastLookup', 'admin', term, source ?? null] as const,
  search: (term: string) => ['podcastLookup', 'portal', term] as const,
  settings: ['settings', 'podcasts'] as const,
};
