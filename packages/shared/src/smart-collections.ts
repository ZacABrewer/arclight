import { z } from 'zod';

// Collections Arclight keeps in Jellyfin/Emby: "Leaving Soon" (titles retention will remove
// within N days) and rule-based smart collections. Arclight creates and syncs them through the
// server's own collection API (Jellyfin and Emby share it). Behaviour: docs/using/library.md
// ("Smart collections").

/** Stored form of the `collections` section; also the GET/PUT body of /settings/collections. */
export const CollectionsSettings = z.object({
  leavingSoon: z
    .object({
      /** Keep a "Leaving Soon" collection on the media servers. */
      enabled: z.boolean().default(false),
      /** Titles whose removal is due within this many days. */
      days: z.number().int().min(1).max(90).default(14),
      name: z.string().trim().min(1).max(100).default('Leaving Soon'),
      /** Discover row in the Jellyfin plugin (works without the collection). */
      showInJellyfin: z.boolean().default(true),
    })
    .default({ enabled: false, days: 14, name: 'Leaving Soon', showInJellyfin: true }),
  /** Media server connection ids to keep collections on; [] = every enabled Jellyfin/Emby server. */
  serverIds: z.array(z.string().max(64)).default([]),
});
export type CollectionsSettings = z.infer<typeof CollectionsSettings>;

export const SmartCollectionMediaType = z.enum(['movie', 'series', 'all']);
export type SmartCollectionMediaType = z.infer<typeof SmartCollectionMediaType>;

/** TMDB lists a rule can follow (the library titles on them). */
export const SmartCollectionList = z.enum(['trending', 'popular', 'topRated']);
export type SmartCollectionList = z.infer<typeof SmartCollectionList>;

/** Server-wide watch status (collections are shared by every user of the server). */
export const SmartCollectionWatchStatus = z.enum(['any', 'unwatched', 'watched', 'inProgress']);
export type SmartCollectionWatchStatus = z.infer<typeof SmartCollectionWatchStatus>;

export const SmartCollectionSort = z.enum(['added', 'title', 'year', 'rating', 'plays', 'list']);
export type SmartCollectionSort = z.infer<typeof SmartCollectionSort>;

/** Every set criterion must hold (AND); list fields match any of their values. */
export const SmartCollectionCriteria = z.object({
  genres: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  /** any: at least one of `genres`; all: every one. */
  genreMatch: z.enum(['any', 'all']).default('any'),
  excludeGenres: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  /** Release year range (a decade is 1990-1999). */
  yearFrom: z.number().int().min(1800).max(2200).nullable().default(null),
  yearTo: z.number().int().min(1800).max(2200).nullable().default(null),
  /** Movie studio or series network, case-insensitive. */
  studios: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  /** TMDB collection ids (movies). */
  tmdbCollectionIds: z.array(z.number().int().positive()).max(50).default([]),
  list: SmartCollectionList.nullable().default(null),
  /** Minimum rating 0-10 (TMDB, else IMDb). */
  minRating: z.number().min(0).max(10).nullable().default(null),
  /** Added to the library within this many days. */
  addedWithinDays: z.number().int().min(1).max(3650).nullable().default(null),
  watchStatus: SmartCollectionWatchStatus.default('any'),
});
export type SmartCollectionCriteria = z.infer<typeof SmartCollectionCriteria>;

export const SmartCollectionInput = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  mediaType: SmartCollectionMediaType.default('movie'),
  criteria: SmartCollectionCriteria.default(SmartCollectionCriteria.parse({})),
  sort: SmartCollectionSort.default('added'),
  /** Keep at most this many titles (after sorting); null = all. */
  limit: z.number().int().min(1).max(1000).nullable().default(null),
});
export type SmartCollectionInput = z.input<typeof SmartCollectionInput>;
export type SmartCollectionInputParsed = z.infer<typeof SmartCollectionInput>;

export const CollectionSyncState = z.object({
  serverId: z.string(),
  serverName: z.string(),
  /** The collection's id on the server (null until first created). */
  remoteId: z.string().nullable(),
  itemCount: z.number().int(),
  /** Titles that matched but are not on that server. */
  missing: z.number().int(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type CollectionSyncState = z.infer<typeof CollectionSyncState>;

export const SmartCollection = SmartCollectionInput.extend({
  id: z.number().int(),
  limit: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sync: z.array(CollectionSyncState),
});
export type SmartCollection = z.infer<typeof SmartCollection>;

export const CollectionItem = z.object({
  mediaType: z.enum(['movie', 'series']),
  id: z.number().int(),
  tmdbId: z.number().int(),
  title: z.string(),
  year: z.number().int(),
  posterUrl: z.string().nullable(),
  /** Leaving Soon: when retention removes it. */
  removeAt: z.string().nullable(),
});
export type CollectionItem = z.infer<typeof CollectionItem>;

/** GET /collections/smart/:id/items and POST /collections/smart/preview. */
export const CollectionPreview = z.object({ total: z.number().int(), items: z.array(CollectionItem) });
export type CollectionPreview = z.infer<typeof CollectionPreview>;

/** GET /collections/leavingsoon (also the plugin's Discover row). */
export const LeavingSoon = z.object({
  enabled: z.boolean(),
  days: z.number().int(),
  name: z.string(),
  items: z.array(CollectionItem),
  sync: z.array(CollectionSyncState),
});
export type LeavingSoon = z.infer<typeof LeavingSoon>;

export const CollectionSyncResult = z.object({
  collections: z.number().int(),
  servers: z.number().int(),
  added: z.number().int(),
  removed: z.number().int(),
  created: z.number().int(),
  deleted: z.number().int(),
  errors: z.array(z.string()),
});
export type CollectionSyncResult = z.infer<typeof CollectionSyncResult>;
