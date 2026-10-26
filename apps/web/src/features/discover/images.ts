// TMDB image sizes per slot. The api returns TMDB image URLs at one size
// (https://image.tmdb.org/t/p/<size>/<file>); pages pick the size the slot needs so a grid
// of posters does not download backdrop-sized files.

export type ImageSlot = 'poster' | 'posterLarge' | 'backdrop' | 'tile' | 'profile' | 'logo' | 'still';

const SIZES: Record<ImageSlot, string> = {
  /** Grid and slider posters (168px wide, 2x displays). */
  poster: 'w342',
  /** Hero poster on title pages. */
  posterLarge: 'w500',
  /** Title page backdrop. */
  backdrop: 'w1280',
  /** Genre tiles. */
  tile: 'w780',
  profile: 'w185',
  logo: 'w185',
  still: 'w300',
};

const TMDB_IMAGE = /^(https?:\/\/image\.tmdb\.org\/t\/p\/)[^/]+(\/.+)$/;

/** The URL at the size for `slot`; non-TMDB URLs (library artwork, fixtures) pass through. */
export function tmdbImage(url: string | null | undefined, slot: ImageSlot): string | null {
  if (!url) return null;
  const m = TMDB_IMAGE.exec(url);
  return m ? `${m[1]}${SIZES[slot]}${m[2]}` : url;
}
