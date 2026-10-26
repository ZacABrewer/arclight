// @media-tron/organizer: pure file/folder name building from naming templates.
// Spec: docs/spec/naming.md.

export {
  NamingFormatError,
  buildEpisodeFileName,
  buildSeasonFolder,
  buildSeriesFolder,
  buildMovieFileName,
  buildMovieFolder,
  requiresEpisodeTitle,
  requiresAbsoluteNumber,
  getSamples,
} from './build.js';
export { parseFormat, normalizeTokenName, type FormatPart, type Token, type Literal } from './tokens.js';
export { cleanTitle, titleThe } from './text.js';
export { SAMPLES } from './samples.js';
export type * from './types.js';
