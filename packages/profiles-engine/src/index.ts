// Pure evaluation logic for quality profiles, custom formats, delay profiles and release
// profiles. No database, no HTTP: the decision engine and the UI preview both call this.

export {
  allowedQualities,
  compareQuality,
  compareRevision,
  effectiveCutoff,
  findItem,
  highestAllowedItem,
  isCutoffMet,
  isFormatCutoffMet,
  isLanguageAllowed,
  isQualityAllowed,
  isQualityCutoffMet,
  isRevisionUpgrade,
  isUpgrade,
  itemId,
  itemQualityIds,
  lowestAllowedItem,
  qualityIndex,
  validateQualityProfile,
  type EvaluatedQuality,
  type ProfileValidationIssue,
  type QualityRef,
  type UpgradeDecision,
  type UpgradeRejection,
} from './quality-profile.js';

export {
  calculateFormatScore,
  compilePattern,
  formatMatches,
  isValidPattern,
  matchCustomFormats,
  meetsMinFormatScore,
  scoreRelease,
  specMatches,
  specMatchesRaw,
  validateCustomFormat,
  type SpecValidationIssue,
} from './custom-format.js';

export {
  computeDelay,
  protocolDelay,
  reorderDelayProfiles,
  selectDelayProfile,
  type DelayBypass,
  type DelayCandidate,
  type DelayDecision,
} from './delay-profile.js';

export {
  applicableReleaseProfiles,
  isValidTerm,
  matchesReleaseProfiles,
  matchesTerm,
  matchingTerms,
  termMatcher,
  type ReleaseProfileResult,
  type ReleaseProfileSubject,
} from './release-profile.js';

export { specImplementations } from './spec-definitions.js';

export { fileFit, isStrictlyBetter, violatesProfile, type FileFit, type FileFitReason, type FileFitStatus } from './profile-fit.js';

export {
  DEFAULT_GROUPS,
  buildItems,
  defaultCustomFormats,
  defaultDelayProfile,
  defaultQualityProfiles,
  defaultMusicProfiles,
  qualitiesByWeight,
} from './defaults.js';
