// Cover Art Archive URL builders. Nothing is fetched: the archive redirects these URLs to the
// image (or answers 404 when there is no front cover), so callers hand them to the browser
// or image cache and show a placeholder on 404.

export const COVER_ART_ARCHIVE_BASE_URL = 'https://coverartarchive.org';

/** Thumbnail widths the archive serves for front images. */
export type CoverArtSize = 250 | 500 | 1200;

export const COVER_ART_SIZES: readonly CoverArtSize[] = [250, 500, 1200];

export interface CoverArtUrls {
  small: string;
  medium: string;
  large: string;
}

export interface CoverArtUrlBuilder {
  /** Front image of a release group (the archive picks a representative release). */
  releaseGroupFront(releaseGroupMbid: string, size?: CoverArtSize): string;
  /** Front image of one specific release. */
  releaseFront(releaseMbid: string, size?: CoverArtSize): string;
  /** 250/500/1200 URLs of a release group's front image. */
  releaseGroupFrontSet(releaseGroupMbid: string): CoverArtUrls;
  releaseFrontSet(releaseMbid: string): CoverArtUrls;
}

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SIZE: CoverArtSize = 500;

function checkMbid(mbid: string): string {
  if (!MBID_RE.test(mbid)) throw new RangeError(`"${mbid}" is not a MusicBrainz id`);
  return mbid.toLowerCase();
}

function checkSize(size: number): CoverArtSize {
  if (!(COVER_ART_SIZES as readonly number[]).includes(size)) {
    throw new RangeError(`Cover Art Archive has no ${size}px thumbnails (use 250, 500 or 1200)`);
  }
  return size as CoverArtSize;
}

export function createCoverArtUrlBuilder(
  options: { baseUrl?: string } = {},
): CoverArtUrlBuilder {
  const root = (options.baseUrl ?? COVER_ART_ARCHIVE_BASE_URL).replace(/\/+$/, '');
  const front = (kind: 'release' | 'release-group', mbid: string, size: CoverArtSize) =>
    `${root}/${kind}/${checkMbid(mbid)}/front-${checkSize(size)}`;
  const set = (kind: 'release' | 'release-group', mbid: string): CoverArtUrls => ({
    small: front(kind, mbid, 250),
    medium: front(kind, mbid, 500),
    large: front(kind, mbid, 1200),
  });
  return {
    releaseGroupFront: (mbid, size = DEFAULT_SIZE) => front('release-group', mbid, size),
    releaseFront: (mbid, size = DEFAULT_SIZE) => front('release', mbid, size),
    releaseGroupFrontSet: (mbid) => set('release-group', mbid),
    releaseFrontSet: (mbid) => set('release', mbid),
  };
}

const defaultBuilder = createCoverArtUrlBuilder();

/** `https://coverartarchive.org/release-group/{mbid}/front-{size}` */
export function coverArtReleaseGroupFrontUrl(mbid: string, size: CoverArtSize = DEFAULT_SIZE): string {
  return defaultBuilder.releaseGroupFront(mbid, size);
}

/** `https://coverartarchive.org/release/{mbid}/front-{size}` */
export function coverArtReleaseFrontUrl(mbid: string, size: CoverArtSize = DEFAULT_SIZE): string {
  return defaultBuilder.releaseFront(mbid, size);
}
