// @arclight/organizer: pure file/folder name building from naming templates.
// Spec: docs/spec/naming.md.

export {
  NamingFormatError,
  buildEpisodeFileName,
  buildSeasonFolder,
  buildSeriesFolder,
  buildMovieFileName,
  buildMovieFolder,
  buildArtistFolder,
  buildAlbumFolder,
  buildTrackFileName,
  trackFormatFor,
  buildAuthorFolder,
  buildBookFolder,
  buildBookFileName,
  requiresEpisodeTitle,
  requiresAbsoluteNumber,
  getSamples,
} from './build.js';
export { releaseYearOf, seriesPositionText } from './tokens.js';
export { parseFormat, normalizeTokenName, hasVersionToken, type FormatPart, type Token, type Literal } from './tokens.js';
export { cleanTitle, titleThe } from './text.js';
export { SAMPLES } from './samples.js';
export type * from './types.js';
export {
  COMIC_TOKENS,
  EBOOK_TOKENS,
  comicRelativePath,
  ebookRelativePath,
  validateBookFormat,
  type BookNamingFormats,
  type ComicNamingInput,
  type EbookNamingInput,
} from './books.js';
