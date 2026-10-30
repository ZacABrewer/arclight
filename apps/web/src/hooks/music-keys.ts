import type { WantedReleaseFilter } from '@arclight/shared';

// Query keys for the music pages. Everything library-side lives under ['music'] so one
// invalidation (live.ts: a `library`/`import` event with mediaType 'music', or a finished
// artist job) refetches artists, albums and their details together. Settings-side keys sit
// under ['settings'] so a settings event refreshes them like every other settings page.
export const musicKeys = {
  all: ['music'] as const,
  artists: {
    all: ['music', 'artist'] as const,
    list: () => ['music', 'artist', 'list'] as const,
    detail: (id: number) => ['music', 'artist', 'detail', id] as const,
  },
  albums: {
    all: ['music', 'album'] as const,
    detail: (id: number) => ['music', 'album', 'detail', id] as const,
    /** One artist's albums (activity rows resolve album titles through it). */
    list: (artistId: number) => ['music', 'album', 'list', artistId] as const,
  },
  /** MusicBrainz search results: a snapshot, kept out of ['music'] so library events leave them alone. */
  lookup: (term: string) => ['musicLookup', term] as const,
  wanted: (mode: 'missing' | 'cutoff', page: number, pageSize: number, q = '', release: WantedReleaseFilter = {}) =>
    ['wanted', mode, 'albums', page, pageSize, q, release] as const,
  features: ['settings', 'features'] as const,
  metadata: ['settings', 'musicmetadata'] as const,
  audio: ['settings', 'audio'] as const,
  albumTypeProfiles: ['settings', 'albumtypeprofiles'] as const,
  qualityProfiles: ['settings', 'qualityprofiles', 'domain', 'music'] as const,
};

/** Job names whose end changes artists or albums (refresh, add, rescan). */
export function isMusicJob(name: string): boolean {
  return /artist|album|music/i.test(name);
}
