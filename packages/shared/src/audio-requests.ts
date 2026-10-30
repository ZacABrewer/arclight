import { z } from 'zod';
import { AudibleRegion } from './audiobooks.js';
import { MediaStatus, PageInfo, RequestStatus, RequestUser } from './requests.js';
import { ListSearchParam } from './list-search.js';

// Music and audiobook requests and their Discover catalogue (design music-audiobooks.md
// section 11). Kept apart from `media_requests`, which is keyed on TMDB ids: audio requests live
// in `audio_requests` and are keyed on MusicBrainz ids (albums, artists) or Audible ASINs
// (books, authors). Every route answers 404 MUSIC_DISABLED / AUDIOBOOKS_DISABLED while the
// matching feature flag is off. Behaviour: docs/API.md "Music and audiobook requests".

export const AudioRequestKind = z.enum(['album', 'artist', 'book', 'author']);
export type AudioRequestKind = z.infer<typeof AudioRequestKind>;

/** The domain a request kind belongs to (and the feature flag that gates it). */
export function audioRequestDomain(kind: AudioRequestKind): 'music' | 'audiobook' {
  return kind === 'album' || kind === 'artist' ? 'music' : 'audiobook';
}

// ---------------------------------------------------------------------------------------
// Discover catalogue
// ---------------------------------------------------------------------------------------

/**
 * One card in the music/audiobook Discover pages. `foreignId` is the MusicBrainz release-group
 * id (album), MusicBrainz artist id (artist), or Audible ASIN (book, author).
 */
export const AudioDiscoverItem = z.object({
  kind: AudioRequestKind,
  foreignId: z.string(),
  title: z.string(),
  /** Artist name (album), author names (book), disambiguation (artist). */
  subtitle: z.string().nullish(),
  year: z.number().int().nullish(),
  releaseDate: z.string().nullish(),
  coverUrl: z.string().nullish(),
  /** Album: primary type (Album, EP, Single...). Book: narrators joined, when known. */
  detail: z.string().nullish(),
  /** Album: the artist's MusicBrainz id. Book: the primary author's ASIN, when known. */
  parentForeignId: z.string().nullish(),
  /** Audible marketplace for books and authors. */
  region: AudibleRegion.nullish(),
  /** Library availability: available (all files), partiallyAvailable, processing (in library, monitored, missing files), pending (request awaiting approval), unknown. */
  mediaStatus: MediaStatus,
  /** Newest active request for this item, if any. */
  requestId: z.number().int().nullish(),
  requestStatus: RequestStatus.nullish(),
  /** Library id (artist, album, book or author row) when present in the library. */
  libraryId: z.number().int().nullish(),
});
export type AudioDiscoverItem = z.infer<typeof AudioDiscoverItem>;

export const AudioDiscoverSection = z.object({
  /** Stable id, e.g. 'music-fresh', 'music-top', 'book-bestsellers', 'book-new'. */
  id: z.string(),
  title: z.string(),
  items: z.array(AudioDiscoverItem),
});
export type AudioDiscoverSection = z.infer<typeof AudioDiscoverSection>;

/** GET /discover/music and /discover/audiobooks: the home sliders for that domain. */
export const AudioDiscoverHome = z.object({ sections: z.array(AudioDiscoverSection) });
export type AudioDiscoverHome = z.infer<typeof AudioDiscoverHome>;

/** GET /discover/music/search and /discover/audiobooks/search. */
export const AudioDiscoverSearchQuery = z.object({
  query: z.string().trim().min(1).max(200),
  region: AudibleRegion.optional(),
});
export type AudioDiscoverSearchQuery = z.infer<typeof AudioDiscoverSearchQuery>;

/** Music search returns artists and albums; audiobook search returns books and authors. */
export const AudioDiscoverSearchResult = z.object({
  /** Artists (music) or authors (audiobooks). */
  people: z.array(AudioDiscoverItem),
  /** Albums (music) or books (audiobooks). */
  titles: z.array(AudioDiscoverItem),
});
export type AudioDiscoverSearchResult = z.infer<typeof AudioDiscoverSearchResult>;

export const AudioTrackEntry = z.object({
  position: z.string(),
  title: z.string(),
  durationMs: z.number().int().nullish(),
});
export type AudioTrackEntry = z.infer<typeof AudioTrackEntry>;

/** GET /discover/music/album/:mbid (release-group id). */
export const AudioAlbumDetail = z.object({
  item: AudioDiscoverItem,
  artistName: z.string(),
  artistForeignId: z.string(),
  overview: z.string().nullish(),
  genres: z.array(z.string()),
  tracks: z.array(AudioTrackEntry),
  /** Other albums by the same artist (cards, max 20). */
  moreByArtist: z.array(AudioDiscoverItem),
});
export type AudioAlbumDetail = z.infer<typeof AudioAlbumDetail>;

/** GET /discover/music/artist/:mbid. */
export const AudioArtistDetail = z.object({
  item: AudioDiscoverItem,
  overview: z.string().nullish(),
  genres: z.array(z.string()),
  country: z.string().nullish(),
  /** Studio albums and EPs first, newest first; compilations/live last. */
  albums: z.array(AudioDiscoverItem),
});
export type AudioArtistDetail = z.infer<typeof AudioArtistDetail>;

/** GET /discover/audiobooks/book/:asin. */
export const AudioBookDetail = z.object({
  item: AudioDiscoverItem,
  authors: z.array(z.object({ name: z.string(), foreignId: z.string().nullish() })),
  narrators: z.array(z.string()),
  overview: z.string().nullish(),
  runtimeMinutes: z.number().int().nullish(),
  publisher: z.string().nullish(),
  series: z.array(z.object({ name: z.string(), position: z.string().nullish(), foreignId: z.string().nullish() })),
  genres: z.array(z.string()),
  abridged: z.boolean().nullish(),
  language: z.string().nullish(),
  /** Other books by the primary author (cards, max 20). */
  moreByAuthor: z.array(AudioDiscoverItem),
});
export type AudioBookDetail = z.infer<typeof AudioBookDetail>;

/** GET /discover/audiobooks/author/:asin. */
export const AudioAuthorDetail = z.object({
  item: AudioDiscoverItem,
  overview: z.string().nullish(),
  genres: z.array(z.string()),
  books: z.array(AudioDiscoverItem),
});
export type AudioAuthorDetail = z.infer<typeof AudioAuthorDetail>;

export const AudioDetailQuery = z.object({ region: AudibleRegion.optional() });
export type AudioDetailQuery = z.infer<typeof AudioDetailQuery>;

// ---------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------

export const AudioRequest = z.object({
  id: z.number().int(),
  kind: AudioRequestKind,
  status: RequestStatus,
  foreignId: z.string(),
  parentForeignId: z.string().nullish(),
  region: AudibleRegion.nullish(),
  title: z.string(),
  subtitle: z.string().nullish(),
  year: z.number().int().nullish(),
  coverUrl: z.string().nullish(),
  requestedBy: RequestUser,
  modifiedBy: RequestUser.nullable(),
  declineReason: z.string().nullish(),
  failureReason: z.string().nullish(),
  /** Library row (artist/album/book/author id) once approved and added. */
  libraryId: z.number().int().nullish(),
  mediaStatus: MediaStatus,
  /** The caller may delete this request (own pending request, or MANAGE_REQUESTS). */
  canRemove: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AudioRequest = z.infer<typeof AudioRequest>;

/** POST /audiorequest. Needs REQUEST, or REQUEST_MUSIC / REQUEST_AUDIOBOOK for the domain. */
export const CreateAudioRequest = z.object({
  kind: AudioRequestKind,
  foreignId: z.string().trim().min(1).max(64),
  region: AudibleRegion.optional(),
  /** Request on behalf of another user (MANAGE_USERS). */
  userId: z.number().int().positive().optional(),
});
export type CreateAudioRequest = z.infer<typeof CreateAudioRequest>;

export const AudioRequestListQuery = z.object({
  take: z.coerce.number().int().min(1).max(500).default(20),
  skip: z.coerce.number().int().min(0).default(0),
  filter: z.enum(['all', 'pending', 'approved', 'declined', 'failed', 'completed', 'processing', 'available']).default('all'),
  /** music: albums + artists; audiobook: books + authors. */
  domain: z.enum(['all', 'music', 'audiobook']).default('all'),
  requestedBy: z.coerce.number().int().positive().optional(),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  /** Text search (list-search.ts): every word must match. */
  q: ListSearchParam,
});
export type AudioRequestListQuery = z.input<typeof AudioRequestListQuery>;

export const AudioRequestPage = z.object({ pageInfo: PageInfo, results: z.array(AudioRequest) });
export type AudioRequestPage = z.infer<typeof AudioRequestPage>;

export const AudioRequestCount = z.object({
  total: z.number().int(),
  music: z.number().int(),
  audiobook: z.number().int(),
  pending: z.number().int(),
});
export type AudioRequestCount = z.infer<typeof AudioRequestCount>;

/**
 * Where approved requests land (requests settings section `audioRequests`). null fields fall back
 * to the first root folder of the type and the first quality profile of the domain.
 */
export const AudioRequestDefaults = z.object({
  music: z
    .object({
      rootFolderPath: z.string().min(1).nullable().default(null),
      qualityProfileId: z.number().int().nullable().default(null),
    })
    .default({ rootFolderPath: null, qualityProfileId: null }),
  audiobook: z
    .object({
      rootFolderPath: z.string().min(1).nullable().default(null),
      qualityProfileId: z.number().int().nullable().default(null),
    })
    .default({ rootFolderPath: null, qualityProfileId: null }),
});
export type AudioRequestDefaults = z.infer<typeof AudioRequestDefaults>;
