import {
  applicableReleaseProfiles,
  compareQuality,
  compareRevision,
  highestAllowedItem,
  isFormatCutoffMet,
  isQualityAllowed,
  isQualityCutoffMet,
  isRevisionUpgrade,
  isStrictlyBetter,
  itemId,
  matchingTerms,
  protocolDelay,
  qualityIndex,
  scoreRelease,
} from '@arclight/profiles-engine';
import type { ParsedRelease } from '@arclight/parser';
import {
  indexerFlagsFromVolumeFactors,
  PROFILE_LANGUAGES,
  type CustomFormat,
  type DelayProfile,
  type Indexer,
  type ProfileMismatchAction,
  type QualityDefinition,
  type QualityDefinitionLimits,
  type QualityModel,
  type QualityProfile,
  type ReleaseDecision,
  type ReleaseIndexerFlag,
  type ReleaseKind,
  type ReleaseProfile,
  type ReleaseRejection,
  type ReleaseResource,
  type ReleaseSource,
  type TrackedDownloadState,
} from '@arclight/shared';
import type { DownloadPropersAndRepacks, HistoryEventSummary, ReleaseSettings } from './deps.js';
import { detectHardcodedSubs, isWhitelistedHardcodedSubs } from './hardcoded-subs.js';
import type { MatchCriteria, MatchResult, MovieMatch, SeriesMatch, Unmatched } from './matcher.js';

// The decision engine (decision-engine spec §4–§11). Every specification is a pure
// function of a prepared `DecisionContext` and the `Candidate`; the service gathers the
// context (profiles, files, queue, history, blocklist) from the database and hooks.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

// ---- inputs -------------------------------------------------------------------------

export interface ExistingFile {
  id: number;
  quality: QualityModel;
  formatScore: number;
  releaseGroup: string | null;
  /** ISO-8601. */
  dateAdded: string;
  episodeIds: number[];
  sizeBytes: number;
  /** Multi-version library: the version slot the file fills (null = unversioned). */
  versionTag?: string | null;
}

export interface QueuedItem {
  title: string;
  quality: QualityModel;
  formatScore: number;
  state: TrackedDownloadState;
  downloadId: string;
  episodeIds?: number[];
  movieId?: number;
}

export interface PendingItem {
  id: number;
  guid: string;
  indexerId: number;
  episodeIds?: number[];
  movieId?: number;
  /** ISO-8601. */
  addedAt: string;
}

export interface HistoryItem {
  event: HistoryEventSummary;
  /** Custom-format score of the event's source title under the current profile. */
  formatScore: number;
}

export interface SearchCriteria extends MatchCriteria {
  /** A user asked for this search (manual or interactive): delay, pending and monitored specs relax. */
  userInvoked: boolean;
}

export interface DecisionContext {
  source: ReleaseSource;
  now: Date;
  settings: ReleaseSettings;
  propers: DownloadPropersAndRepacks;
  profile: QualityProfile;
  delayProfile: DelayProfile | undefined;
  releaseProfiles: readonly ReleaseProfile[];
  qualityLimits: (qualityId: number) => QualityDefinitionLimits | undefined;
  indexer: Indexer | undefined;
  indexerDisabledTill: string | undefined;
  existingFiles: readonly ExistingFile[];
  queue: readonly QueuedItem[];
  pending: readonly PendingItem[];
  /** Most recent history event per mapped episode / the movie (nulls omitted). */
  latestHistory: readonly HistoryItem[];
  /** Grab → import pairs whose recorded quality differed (already-imported spec). */
  importedGrabs: ReadonlyArray<{ grab: HistoryEventSummary; imported: HistoryEventSummary }>;
  blocklisted: boolean;
  criteria: SearchCriteria | undefined;
  /** Free bytes at the item's folder; null = unknown (free-space spec accepts). */
  freeSpaceBytes: number | null;
  minimumFreeSpaceMb: number;
  /** Indexer release filter verdict for this candidate (tracker freeleech-only); null/absent = pass. */
  releaseFilter?: SpecResult | null;
  /**
   * The profile's rule for existing files it does not allow (profile migration). `replace` and
   * `replaceIfBetter` let an acceptable release replace such a file even when it ranks higher or
   * already meets the cutoff; absent/`none` keeps the classic upgrade rules.
   */
  mismatchAction?: ProfileMismatchAction;
}

export interface Candidate {
  release: ReleaseResource;
  parsed: ParsedRelease;
  match: SeriesMatch | MovieMatch;
  quality: QualityModel;
  languages: string[];
  customFormats: CustomFormat[];
  formatScore: number;
  releaseGroup: string | undefined;
  /** Minutes since publish, measured against the context clock. */
  ageMinutes: number;
}

export interface SpecResult {
  reason: string;
  message: string;
  /** Delay spec: minutes still to wait. */
  remainingMinutes?: number;
}

export interface Specification {
  id: string;
  tier: 0 | 1;
  type: 'permanent' | 'temporary';
  appliesTo: 'series' | 'movie' | 'both';
  evaluate(ctx: DecisionContext, c: Candidate): SpecResult | SpecResult[] | null;
}

// ---- helpers ------------------------------------------------------------------------

const LANGUAGE_CODES = new Map(PROFILE_LANGUAGES.map((l) => [l.name.toLowerCase(), l.code]));

/** Parser language names ("English", "Unknown") → profile codes ("en", "unknown"). */
export function toLanguageCodes(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => LANGUAGE_CODES.get(n.toLowerCase()) ?? n.toLowerCase()))];
}

/**
 * Indexer flags of a release: those the indexer reported plus the ones implied by its
 * Torznab volume factors (a release pushed or cached without `indexerFlags` still counts).
 */
export function releaseIndexerFlags(r: {
  indexerFlags?: readonly ReleaseIndexerFlag[] | undefined;
  downloadVolumeFactor?: number | undefined;
  uploadVolumeFactor?: number | undefined;
}): ReleaseIndexerFlag[] {
  return [...new Set([...(r.indexerFlags ?? []), ...indexerFlagsFromVolumeFactors(r)])];
}

const FLAG_WEIGHT: Partial<Record<ReleaseIndexerFlag, number>> = {
  freeleech: 4,
  freeleech75: 3,
  halfleech: 2,
  freeleech25: 1,
  doubleUpload: 1,
};

/** Higher is better: how much a release's flags save on ratio (preferIndexerFlags). */
export function indexerFlagScore(flags: readonly ReleaseIndexerFlag[]): number {
  return flags.reduce((sum, f) => sum + (FLAG_WEIGHT[f] ?? 0), 0);
}

export function releaseKindOf(match: SeriesMatch | MovieMatch): ReleaseKind {
  if (match.mediaType === 'movie') return 'single';
  if (match.fullSeason) return 'seasonPack';
  return match.episodes.length > 1 ? 'multi' : 'single';
}

/** Custom formats + score of a title under a profile (§6.2). */
export function evaluateFormats(
  profile: QualityProfile,
  formats: readonly CustomFormat[],
  input: {
    title: string;
    quality: QualityModel;
    mediaType: 'series' | 'movie';
    sizeBytes?: number;
    languages?: string[];
    releaseGroup?: string | null;
    year?: number;
    releaseKind?: ReleaseKind;
    indexerFlags?: ReleaseIndexerFlag[];
  },
): { formats: CustomFormat[]; score: number } {
  const result = scoreRelease(profile, formats, {
    title: input.title,
    quality: input.quality,
    mediaType: input.mediaType,
    languages: input.languages ?? [],
    ...(input.releaseGroup ? { releaseGroup: input.releaseGroup } : {}),
    ...(input.sizeBytes ? { sizeBytes: input.sizeBytes } : {}),
    ...(input.year ? { year: input.year } : {}),
    ...(input.releaseKind ? { releaseKind: input.releaseKind } : {}),
    ...(input.indexerFlags?.length ? { indexerFlags: input.indexerFlags } : {}),
  });
  return { formats: formats.filter((f) => result.matchedFormatIds.includes(f.id)), score: result.score };
}

export type UpgradableResult =
  | 'none'
  | 'betterQuality'
  | 'betterRevision'
  | 'qualityCutoff'
  | 'customFormatCutoff'
  | 'customFormatScore'
  | 'minCustomFormatScore'
  | 'upgradesNotAllowed';

/** §6.1: may `next` replace `current`? `none` means yes. */
export function isUpgradable(
  profile: QualityProfile,
  current: { quality: QualityModel; formatScore: number },
  next: { quality: QualityModel; formatScore: number },
  propers: DownloadPropersAndRepacks,
): UpgradableResult {
  const qc = compareQuality(profile, next.quality, current.quality);
  if (qc > 0 && !isQualityCutoffMet(profile, current.quality)) return 'none';
  if (qc < 0) return 'betterQuality';
  const rc = qc === 0 ? compareRevision(next.quality.revision, current.quality.revision) : 0;
  if (propers !== 'doNotPrefer' && rc > 0) return 'none';
  if (!profile.upgradeAllowed) return 'upgradesNotAllowed';
  if (propers !== 'doNotPrefer' && rc < 0) return 'betterRevision';
  if (qc > 0) return 'qualityCutoff';
  if (next.formatScore <= current.formatScore) return 'customFormatScore';
  if (current.formatScore >= profile.cutoffFormatScore) return 'customFormatCutoff';
  if (next.formatScore < current.formatScore + profile.minUpgradeFormatScore) return 'minCustomFormatScore';
  return 'none';
}

/** §6.5: true while the current item is still wanted for upgrade. */
export function cutoffNotMet(
  profile: QualityProfile,
  current: { quality: QualityModel; formatScore: number },
  next?: QualityModel,
): boolean {
  const qualityNotMet = !isQualityCutoffMet(profile, current.quality) || (next !== undefined && isRevisionUpgrade(current.quality, next));
  return qualityNotMet || !isFormatCutoffMet(profile, current.formatScore);
}

/** §6.6 */
export function isUpgradeAllowed(
  profile: QualityProfile,
  current: { quality: QualityModel; formatScore: number },
  next: { quality: QualityModel; formatScore: number },
): boolean {
  if (isRevisionUpgrade(current.quality, next.quality)) return true;
  const qc = compareQuality(profile, next.quality, current.quality);
  const qualityUpgrade = qc > 0;
  const formatUpgrade = next.formatScore > current.formatScore;
  if (qualityUpgrade || formatUpgrade) return profile.upgradeAllowed;
  return true;
}

const UPGRADE_SUFFIX: Record<Exclude<UpgradableResult, 'none'>, string> = {
  betterQuality: 'HigherPreference',
  betterRevision: 'HigherRevision',
  qualityCutoff: 'CutoffMet',
  customFormatCutoff: 'CustomFormatCutoffMet',
  customFormatScore: 'CustomFormatScore',
  minCustomFormatScore: 'CustomFormatScoreIncrement',
  upgradesNotAllowed: 'UpgradesNotAllowed',
};

const UPGRADE_MESSAGE: Record<Exclude<UpgradableResult, 'none'>, string> = {
  betterQuality: 'is of higher preference',
  betterRevision: 'has a higher revision',
  qualityCutoff: 'already meets the quality cutoff',
  customFormatCutoff: 'already meets the custom format cutoff',
  customFormatScore: 'has an equal or higher custom format score',
  minCustomFormatScore: 'is not improved upon by the minimum custom format score increment',
  upgradesNotAllowed: 'cannot be upgraded: profile does not allow upgrades',
};

function upgradeRejection(prefix: 'disk' | 'queue' | 'history', what: string, result: Exclude<UpgradableResult, 'none'>): SpecResult {
  return { reason: `${prefix}${UPGRADE_SUFFIX[result]}`, message: `${what} ${UPGRADE_MESSAGE[result]}` };
}

function qualityName(q: QualityModel): string {
  const r = q.revision;
  return r.version > 1 || r.real > 0 ? `${q.quality.name} v${r.version}${r.real > 0 ? ` real${r.real}` : ''}` : q.quality.name;
}

function isSearch(ctx: DecisionContext): boolean {
  return ctx.criteria !== undefined;
}

function isUserInvoked(ctx: DecisionContext): boolean {
  return ctx.criteria?.userInvoked === true || ctx.source === 'userInvokedSearch' || ctx.source === 'interactiveSearch';
}

function episodesOf(c: Candidate) {
  return c.match.mediaType === 'series' ? c.match.episodes : [];
}

function filesFor(ctx: DecisionContext, c: Candidate): ExistingFile[] {
  if (c.match.mediaType === 'movie') return [...ctx.existingFiles];
  const ids = new Set(c.match.episodes.map((e) => e.id));
  const seen = new Set<number>();
  return ctx.existingFiles.filter((f) => f.episodeIds.some((id) => ids.has(id)) && !seen.has(f.id) && (seen.add(f.id), true));
}

/**
 * Profile migration: may `next` replace an existing file the profile does not allow (quality not
 * allowed, or score below the minimum)? Only under a `replace` / `replaceIfBetter` rule; the
 * candidate itself still has to pass every other spec (allowed quality, minimum score, ...).
 */
export function replacesDisallowedFile(
  ctx: Pick<DecisionContext, 'profile' | 'mismatchAction'>,
  file: { quality: QualityModel; formatScore: number },
  next: { quality: QualityModel; formatScore: number },
): boolean {
  const action = ctx.mismatchAction ?? 'none';
  if (action === 'none') return false;
  const allowed = isQualityAllowed(ctx.profile, file.quality.quality) && file.formatScore >= ctx.profile.minFormatScore;
  if (allowed) return false;
  return action === 'replace' || isStrictlyBetter(ctx.profile, file, next);
}

function itemTags(c: Candidate): number[] {
  return c.match.mediaType === 'series' ? c.match.series.tags : c.match.movie.tags;
}

/** Runtime in minutes used for size checks; 0 = unknown. */
export function runtimeMinutes(c: Candidate, now: Date): number {
  if (c.match.mediaType === 'movie') return c.match.movie.runtimeMinutes || 110;
  const series = c.match.series;
  const seriesRuntime = series.runtimeMinutes ?? 0;
  let total = 0;
  for (const e of c.match.episodes) total += (e.runtimeMinutes ?? 0) > 0 ? e.runtimeMinutes! : seriesRuntime;
  if (total > 0) return total;
  if (seriesRuntime === 0 && c.match.seasonNumber === 1) {
    const pilot = c.match.episodes.find((e) => e.episodeNumber === 1);
    const anchor = pilot?.airDateUtc ? Date.parse(pilot.airDateUtc) : Date.parse(c.release.publishDate);
    const allClose = c.match.episodes.every((e) => !e.airDateUtc || Math.abs(Date.parse(e.airDateUtc) - anchor) <= DAY);
    if (allClose && Number.isFinite(anchor) && anchor <= now.getTime() + DAY) return 45 * c.match.episodes.length;
  }
  return 0;
}

function sameItem(c: Candidate, item: { episodeIds?: number[] | undefined; movieId?: number | undefined }): boolean {
  if (c.match.mediaType === 'movie') return item.movieId === c.match.movie.id;
  const ids = new Set(c.match.episodes.map((e) => e.id));
  return (item.episodeIds ?? []).some((id) => ids.has(id));
}

const RAW_DISC = [
  /\bdis[ck][ ._-]?\d+\b.*\bblu[ ._-]?ray\b/i,
  /\b(?:1080|2160|720)[pi]?[ ._-]+full[ ._-]+blu[ ._-]?ray\b/i,
  /\b(?:dvd[ ._-]?r|dvd[59]|mdvd)\b/i,
  /\bcomplete[ ._-]+(?:uhd[ ._-]+)?blu[ ._-]?ray\b/i,
];

// ---- specifications -----------------------------------------------------------------

export const specifications: readonly Specification[] = [
  {
    id: 'qualityAllowed',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) =>
      isQualityAllowed(ctx.profile, c.quality)
        ? null
        : { reason: 'qualityNotWanted', message: `${c.quality.quality.name} is not wanted in profile` },
  },
  {
    id: 'customFormatMinimumScore',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) =>
      c.formatScore >= ctx.profile.minFormatScore
        ? null
        : {
            reason: 'customFormatMinimumScore',
            message: `Custom Formats score ${c.formatScore} is below the profile minimum ${ctx.profile.minFormatScore}`,
          },
  },
  {
    // Profile language list (empty = any). An untagged release ("unknown") is accepted: the
    // parser only tags languages it sees, and most single-language releases carry none.
    id: 'language',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const wanted = ctx.profile.languages;
      if (wanted.length === 0) return null;
      const langs = c.languages.filter((l) => l !== 'unknown');
      if (langs.length === 0) return null;
      const original = c.match.mediaType === 'movie' ? c.match.movie.originalLanguage : c.match.series.originalLanguage;
      const resolved = wanted.map((w) => (w === 'original' ? original : w));
      if (langs.some((l) => resolved.includes(l) || (l === 'original' && wanted.includes('original')))) return null;
      return { reason: 'wantedLanguage', message: `${resolved.join(', ')} is wanted, but found ${langs.join(', ')}` };
    },
  },
  {
    id: 'maximumSize',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const max = ctx.settings.maximumSizeMb;
      if (max <= 0 || c.release.size <= 0) return null;
      return c.release.size > max * MB
        ? { reason: 'maximumSizeExceeded', message: `${mb(c.release.size)} exceeds the maximum size of ${max} MB` }
        : null;
    },
  },
  {
    id: 'sizeLimits',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      if (c.release.size <= 0) return null;
      if (c.match.mediaType === 'series' && c.match.special) return null;
      const runtime = runtimeMinutes(c, ctx.now);
      if (runtime <= 0) {
        return { reason: 'unknownRuntime', message: 'Runtime of all episodes is 0, unable to validate size until it is available' };
      }
      const limits = ctx.qualityLimits(c.quality.quality.id);
      if (!limits) return null;
      if (limits.minSize && limits.minSize > 0) {
        const min = limits.minSize * runtime * MB;
        if (c.release.size < min) {
          return { reason: 'belowMinimumSize', message: `${mb(c.release.size)} is smaller than minimum allowed ${mb(min)}` };
        }
      }
      if (limits.maxSize && limits.maxSize > 0) {
        const max = limits.maxSize * runtime * MB;
        if (c.release.size > max) {
          return { reason: 'aboveMaximumSize', message: `${mb(c.release.size)} is larger than maximum allowed ${mb(max)}` };
        }
      }
      return null;
    },
  },
  {
    id: 'sample',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (_ctx, c) =>
      /sample/i.test(c.release.title) && c.release.size > 0 && c.release.size < 70 * MB
        ? { reason: 'sample', message: 'Sample' }
        : null,
  },
  {
    // Untouched discs are only fine when the profile explicitly allows BR-DISK / Raw-HD.
    id: 'raw',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const looksRaw = RAW_DISC.some((re) => re.test(c.release.title));
      const rawQuality = c.quality.quality.modifier === 'brdisk' || c.quality.quality.modifier === 'rawhd';
      if (!looksRaw && !rawQuality) return null;
      if (rawQuality && isQualityAllowed(ctx.profile, c.quality)) return null;
      return { reason: 'raw', message: /dvd/i.test(c.release.title) ? 'Raw DVD release' : 'Raw Bluray release' };
    },
  },
  {
    // Settings → Indexers: burned-in subtitles are refused unless allowed or whitelisted.
    id: 'hardcodedSubs',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      if (ctx.settings.allowHardcodedSubs) return null;
      const found = detectHardcodedSubs(c.release.title, c.releaseGroup);
      if (!found || isWhitelistedHardcodedSubs(found, ctx.settings.whitelistedHardcodedSubs)) return null;
      return {
        reason: 'hardcodedSubs',
        message: found.generic ? 'Hardcoded subs found' : `Hardcoded subs found: ${found.tag}`,
      };
    },
  },
  {
    id: 'minimumAge',
    tier: 0,
    type: 'temporary',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const min = ctx.settings.minimumAgeMinutes;
      if (c.release.protocol !== 'usenet' || min <= 0) return null;
      return c.ageMinutes < min
        ? {
            reason: 'minimumAge',
            message: `Only ${Math.floor(c.ageMinutes)} minutes old, minimum age is ${min} minutes`,
            remainingMinutes: Math.ceil(min - c.ageMinutes),
          }
        : null;
    },
  },
  {
    id: 'retention',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const days = ctx.settings.retentionDays;
      if (c.release.protocol !== 'usenet' || days <= 0) return null;
      return Math.floor(c.ageMinutes / (24 * 60)) > days ? { reason: 'maximumAge', message: 'Older than configured retention' } : null;
    },
  },
  {
    id: 'minimumSeeders',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      if (c.release.protocol !== 'torrent' || !ctx.indexer || c.release.seeders === undefined) return null;
      const min = ctx.indexer.settings.minimumSeeders ?? 0;
      return c.release.seeders < min
        ? { reason: 'minimumSeeders', message: `Not enough seeders: ${c.release.seeders}. Minimum seeders: ${min}` }
        : null;
    },
  },
  {
    id: 'indexerTags',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const tags = ctx.indexer?.tags ?? [];
      if (tags.length === 0) return null;
      const item = itemTags(c);
      return tags.some((t) => item.includes(t))
        ? null
        : { reason: 'noMatchingTag', message: 'Item does not have a matching tag with the indexer' };
    },
  },
  {
    id: 'indexerBlocked',
    tier: 0,
    type: 'temporary',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const till = ctx.indexerDisabledTill;
      if (!till || Date.parse(till) <= ctx.now.getTime()) return null;
      return {
        reason: 'indexerDisabled',
        message: `Indexer ${c.release.indexerName} is blocked till ${till} due to failures, cannot grab release.`,
      };
    },
  },
  {
    id: 'releaseProfiles',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const out: SpecResult[] = [];
      const profiles = applicableReleaseProfiles(ctx.releaseProfiles, { tags: itemTags(c), indexerId: c.release.indexerId });
      for (const p of profiles) {
        if (p.required.length > 0 && matchingTerms(p.required, c.release.title).length === 0) {
          out.push({ reason: 'mustContainMissing', message: `[${p.name}] does not contain one of the required terms: ${p.required.join(', ')}` });
        }
        const hits = matchingTerms(p.ignored, c.release.title);
        if (hits.length > 0) {
          out.push({ reason: 'mustNotContainPresent', message: `[${p.name}] contains one or more ignored terms: ${hits.join(', ')}` });
        }
      }
      return out;
    },
  },
  {
    // Single/multi-episode releases must not predate the air time (tolerance configurable).
    id: 'notYetAired',
    tier: 0,
    type: 'permanent',
    appliesTo: 'series',
    evaluate: (ctx, c) => {
      if (c.match.mediaType !== 'series' || c.match.fullSeason || ctx.settings.allowUnairedEpisodes) return null;
      const limit = ctx.now.getTime() + ctx.settings.unairedToleranceMinutes * MINUTE;
      const unaired = c.match.episodes.filter((e) => e.airDateUtc && Date.parse(e.airDateUtc) > limit);
      if (unaired.length === 0) return null;
      return { reason: 'beforeAirDate', message: `Episode has not aired yet (airs ${unaired[0]!.airDateUtc})` };
    },
  },
  {
    id: 'fullSeasonAired',
    tier: 0,
    type: 'permanent',
    appliesTo: 'series',
    evaluate: (ctx, c) => {
      if (c.match.mediaType !== 'series' || !c.match.fullSeason) return null;
      const limit = ctx.now.getTime() + DAY;
      const bad = c.match.episodes.some((e) => !e.airDateUtc || Date.parse(e.airDateUtc) > limit);
      return bad ? { reason: 'fullSeasonNotAired', message: 'Full season pack contains episodes that have not aired' } : null;
    },
  },
  {
    id: 'multiSeason',
    tier: 0,
    type: 'permanent',
    appliesTo: 'series',
    evaluate: (ctx, c) =>
      c.parsed.series?.isMultiSeason && !ctx.settings.allowMultiSeason
        ? { reason: 'multiSeason', message: 'Multi-season releases are not supported' }
        : null,
  },
  {
    id: 'splitEpisode',
    tier: 0,
    type: 'permanent',
    appliesTo: 'series',
    evaluate: (_ctx, c) =>
      c.parsed.series?.isSplitEpisode ? { reason: 'splitEpisode', message: 'Split episodes are not supported' } : null,
  },
  {
    id: 'animeSameGroup',
    tier: 0,
    type: 'permanent',
    appliesTo: 'series',
    evaluate: (ctx, c) => {
      if (c.match.mediaType !== 'series' || c.match.series.seriesType !== 'anime' || ctx.propers === 'doNotPrefer') return null;
      for (const f of filesFor(ctx, c)) {
        if (!isRevisionUpgrade(f.quality, c.quality)) continue;
        if (!f.releaseGroup || !c.releaseGroup) {
          return { reason: 'unknownReleaseGroup', message: 'Release group unknown for the existing file or the release' };
        }
        if (f.releaseGroup.toLowerCase() !== c.releaseGroup.toLowerCase()) {
          return { reason: 'releaseGroupDoesNotMatch', message: `Existing release group ${f.releaseGroup} does not match ${c.releaseGroup}` };
        }
      }
      return null;
    },
  },
  {
    id: 'sameEpisodes',
    tier: 0,
    type: 'permanent',
    appliesTo: 'series',
    evaluate: (ctx, c) => {
      if (c.match.mediaType !== 'series') return null;
      const ids = new Set(c.match.episodes.map((e) => e.id));
      return filesFor(ctx, c).some((f) => f.episodeIds.some((id) => !ids.has(id)))
        ? { reason: 'existingFileHasMoreEpisodes', message: 'Episode file on disk contains more episodes than this release contains' }
        : null;
    },
  },
  {
    id: 'availability',
    tier: 0,
    type: 'permanent',
    appliesTo: 'movie',
    evaluate: (ctx, c) => {
      if (c.match.mediaType !== 'movie' || isUserInvoked(ctx)) return null;
      const m = c.match.movie;
      const date = availabilityDate(m.minimumAvailability, m.inCinemas, m.digitalRelease, m.physicalRelease);
      if (date === 'always') return null;
      if (date !== 'never' && ctx.now.getTime() >= date + ctx.settings.availabilityDelayDays * DAY) return null;
      return { reason: 'availability', message: `Movie is not available yet (minimum availability: ${m.minimumAvailability})` };
    },
  },
  {
    id: 'monitored',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      if (isUserInvoked(ctx)) return null;
      if (c.match.mediaType === 'movie') {
        return c.match.movie.monitored ? null : { reason: 'movieNotMonitored', message: 'Movie is not monitored' };
      }
      if (!c.match.series.monitored) return { reason: 'seriesNotMonitored', message: 'Series is not monitored' };
      const unmonitored = c.match.episodes.filter((e) => !e.monitored);
      if (unmonitored.length === 0) return null;
      return {
        reason: 'episodeNotMonitored',
        message: c.match.episodes.length === 1 ? 'Episode is not monitored' : 'One or more episodes is not monitored',
      };
    },
  },
  {
    id: 'alreadyImported',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      for (const { grab } of ctx.importedGrabs) {
        if (compareQualityModels(grab.quality, c.quality)) continue;
        if (c.release.protocol === 'torrent' && c.release.infoHash && grab.downloadId?.toUpperCase() === c.release.infoHash.toUpperCase()) {
          return { reason: 'alreadyImportedSameHash', message: 'Has same torrent hash as a grab in history that was already imported' };
        }
        if (grab.sourceTitle.toLowerCase() === c.release.title.toLowerCase()) {
          return { reason: 'alreadyImportedSameName', message: 'Has same release name as a grab in history that was already imported' };
        }
      }
      return null;
    },
  },
  {
    id: 'recentGrabHistory',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      if (isSearch(ctx)) return null;
      for (const { event, formatScore } of ctx.latestHistory) {
        if (event.eventType !== 'grabbed') continue;
        const recent = ctx.now.getTime() - Date.parse(event.date) < 12 * HOUR;
        if (!recent) continue; // completed download handling is always on
        const grabbed = { quality: event.quality, formatScore };
        if (!cutoffNotMet(ctx.profile, grabbed, c.quality)) {
          return { reason: 'historyRecentCutoffMet', message: 'Recent grab event in history already meets cutoff' };
        }
        const result = isUpgradable(ctx.profile, grabbed, { quality: c.quality, formatScore: c.formatScore }, ctx.propers);
        if (result !== 'none') return upgradeRejection('history', 'Recent grab event in history', result);
      }
      return null;
    },
  },
  {
    id: 'queue',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const next = { quality: c.quality, formatScore: c.formatScore };
      for (const q of ctx.queue) {
        if (q.state === 'failedPending' || !sameItem(c, q)) continue;
        const hash = c.release.infoHash?.toLowerCase();
        if ((hash && q.downloadId.toLowerCase() === hash) || q.title.toLowerCase() === c.release.title.toLowerCase()) {
          return { reason: 'alreadyInQueue', message: 'Release is already in the download queue' };
        }
        const queued = { quality: q.quality, formatScore: q.formatScore };
        if (!cutoffNotMet(ctx.profile, queued, c.quality)) {
          return { reason: 'queueCutoffMet', message: `Queued release ${qualityName(q.quality)} already meets cutoff` };
        }
        const result = isUpgradable(ctx.profile, queued, next, ctx.propers);
        if (result !== 'none') return upgradeRejection('queue', `Queued release ${qualityName(q.quality)}`, result);
        if (ctx.propers === 'doNotUpgrade' && isRevisionUpgrade(q.quality, c.quality)) {
          return { reason: 'queuePropersDisabled', message: 'Proper downloading is disabled' };
        }
      }
      return null;
    },
  },
  {
    id: 'upgradeAllowed',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const next = { quality: c.quality, formatScore: c.formatScore };
      for (const f of filesFor(ctx, c)) {
        if (replacesDisallowedFile(ctx, f, next)) continue;
        if (!isUpgradeAllowed(ctx.profile, f, next)) {
          return { reason: 'qualityUpgradesDisabled', message: 'Quality profile does not allow upgrades' };
        }
      }
      return null;
    },
  },
  {
    id: 'upgradeDisk',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const files = filesFor(ctx, c);
      if (files.length === 0) return null;
      const next = { quality: c.quality, formatScore: c.formatScore };
      if (c.match.mediaType === 'series' && c.match.fullSeason) {
        const total = c.match.episodes.length;
        let upgraded = 0;
        for (const e of c.match.episodes) {
          const file = files.find((f) => f.episodeIds.includes(e.id));
          if (!file || replacesDisallowedFile(ctx, file, next)) {
            upgraded++;
            continue;
          }
          if (!cutoffNotMet(ctx.profile, file, c.quality)) continue;
          if (isUpgradable(ctx.profile, file, next, ctx.propers) === 'none') upgraded++;
        }
        const percent = total === 0 ? 0 : (upgraded / total) * 100;
        const mode = ctx.settings.seasonPackUpgrade;
        const ok = mode === 'any' ? upgraded >= 1 : mode === 'all' ? upgraded === total : percent >= ctx.settings.seasonPackUpgradeThreshold;
        return ok ? null : { reason: 'diskNotUpgrade', message: `Season pack upgrades only ${upgraded} of ${total} episodes` };
      }
      for (const f of files) {
        if (replacesDisallowedFile(ctx, f, next)) continue;
        if (!cutoffNotMet(ctx.profile, f, c.quality)) {
          return { reason: 'diskCutoffMet', message: `Existing file ${qualityName(f.quality)} meets cutoff` };
        }
        const result = isUpgradable(ctx.profile, f, next, ctx.propers);
        if (result !== 'none') return upgradeRejection('disk', `Existing file ${qualityName(f.quality)}`, result);
      }
      return null;
    },
  },
  {
    id: 'properInRss',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      if (isSearch(ctx) || ctx.propers === 'doNotPrefer') return null;
      const midnight = new Date(ctx.now);
      midnight.setUTCHours(0, 0, 0, 0);
      const cutoff = midnight.getTime() - 7 * DAY;
      for (const f of filesFor(ctx, c)) {
        if (!isRevisionUpgrade(f.quality, c.quality)) continue;
        if (ctx.propers === 'doNotUpgrade') return { reason: 'propersDisabled', message: 'Proper downloading is disabled' };
        if (Date.parse(f.dateAdded) < cutoff) return { reason: 'properForOldFile', message: 'Proper for old file' };
      }
      return null;
    },
  },
  {
    id: 'repackSameGroup',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      if (!c.quality.revision.isRepack || ctx.propers === 'doNotPrefer') return null;
      for (const f of filesFor(ctx, c)) {
        if (!isRevisionUpgrade(f.quality, c.quality)) continue;
        if (ctx.propers === 'doNotUpgrade') return { reason: 'repackDisabled', message: 'Repack downloading is disabled' };
        if (!f.releaseGroup || !c.releaseGroup) {
          return { reason: 'repackUnknownReleaseGroup', message: 'Release group unknown for the existing file or the repack' };
        }
        if (f.releaseGroup.toLowerCase() !== c.releaseGroup.toLowerCase()) {
          return { reason: 'repackReleaseGroupDoesNotMatch', message: `Existing release group ${f.releaseGroup} does not match ${c.releaseGroup}` };
        }
      }
      return null;
    },
  },
  {
    id: 'blocklist',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx) => (ctx.blocklisted ? { reason: 'blocklisted', message: 'Release is blocklisted' } : null),
  },
  {
    id: 'indexerReleaseFilter',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx) => ctx.releaseFilter ?? null,
  },
  {
    id: 'delay',
    tier: 0,
    type: 'temporary',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      if (isUserInvoked(ctx) || !ctx.delayProfile) return null;
      const dp = ctx.delayProfile;
      const delay = protocolDelay(dp, c.release.protocol);
      if (delay <= 0) return null;
      const preferred = c.release.protocol === dp.preferredProtocol;
      if (preferred && ctx.propers === 'preferAndUpgrade' && filesFor(ctx, c).some((f) => isRevisionUpgrade(f.quality, c.quality))) {
        return null;
      }
      if (preferred && dp.bypassIfHighestQuality) {
        const best = highestAllowedItem(ctx.profile);
        if (best && compareQuality(ctx.profile, c.quality, itemId(best)) >= 0) return null;
      }
      if (preferred && dp.bypassIfAboveCustomFormatScore && c.formatScore >= dp.minimumCustomFormatScore) return null;
      const oldestPending = ctx.pending
        .filter((p) => sameItem(c, p) && !(p.guid === c.release.guid && p.indexerId === c.release.indexerId))
        .map((p) => Date.parse(p.addedAt))
        .sort((a, b) => a - b)[0];
      if (oldestPending !== undefined && ctx.now.getTime() - oldestPending >= delay * MINUTE) return null;
      if (c.ageMinutes < delay) {
        return {
          reason: 'minimumAgeDelay',
          message: 'Waiting for better quality release',
          remainingMinutes: Math.ceil(delay - c.ageMinutes),
        };
      }
      return null;
    },
  },
  {
    id: 'pendingPushed',
    tier: 0,
    type: 'temporary',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      if (ctx.source === 'rss' || isUserInvoked(ctx)) return null;
      const blocking = ctx.pending.some((p) => sameItem(c, p) && !(p.guid === c.release.guid && p.indexerId === c.release.indexerId));
      return blocking ? { reason: 'minimumAgeDelayPushed', message: 'Release for the same item is already pending' } : null;
    },
  },
  {
    id: 'searchItem',
    tier: 0,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      const cr = ctx.criteria;
      if (!cr) return null;
      if (c.match.mediaType === 'movie') {
        return cr.movieId !== undefined && cr.movieId !== c.match.movie.id ? { reason: 'wrongMovie', message: 'Wrong movie' } : null;
      }
      if (cr.seriesId !== undefined && cr.seriesId !== c.match.series.id) return { reason: 'wrongSeries', message: 'Wrong series' };
      const parsedSeasons = c.parsed.series?.seasons.length ? c.parsed.series.seasons : [c.match.seasonNumber ?? -1];
      const requested = cr.episodeIds ?? [];
      if (requested.length === 1) {
        // Single-episode search (§8.4).
        const wanted = requested[0]!;
        const wantedEpisode = c.match.episodes.find((e) => e.id === wanted);
        if (c.match.fullSeason) return { reason: 'fullSeason', message: 'Full season pack' };
        if (!wantedEpisode) {
          return c.match.seasonNumber !== undefined && cr.seasonNumber !== undefined && c.match.seasonNumber !== cr.seasonNumber
            ? { reason: 'wrongSeason', message: 'Wrong season' }
            : { reason: 'wrongEpisode', message: 'Wrong episode' };
        }
        return null;
      }
      if (requested.length > 1) {
        return c.match.episodes.some((e) => requested.includes(e.id)) ? null : { reason: 'wrongEpisode', message: 'Episode wasn\'t requested' };
      }
      if (cr.seasonNumber !== undefined && !parsedSeasons.includes(cr.seasonNumber)) {
        return { reason: 'wrongSeason', message: 'Wrong season' };
      }
      return null;
    },
  },
  {
    id: 'freeSpace',
    tier: 1,
    type: 'permanent',
    appliesTo: 'both',
    evaluate: (ctx, c) => {
      if (ctx.freeSpaceBytes === null) return null;
      const remaining = ctx.freeSpaceBytes - c.release.size;
      if (remaining <= 0 || remaining < ctx.minimumFreeSpaceMb * MB) {
        return { reason: 'minimumFreeSpace', message: `Not enough free space: ${mb(ctx.freeSpaceBytes)} free` };
      }
      return null;
    },
  },
];

function compareQualityModels(a: QualityModel, b: QualityModel): boolean {
  return a.quality.id === b.quality.id && compareRevision(a.revision, b.revision) === 0;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}

/** §4.24 availability date: 'always', 'never' or epoch ms. */
export function availabilityDate(
  minimum: 'announced' | 'inCinemas' | 'released',
  inCinemas: string | null | undefined,
  digital: string | null | undefined,
  physical: string | null | undefined,
): number | 'always' | 'never' {
  if (minimum === 'announced') return 'always';
  const parse = (d: string | null | undefined) => (d ? Date.parse(d) : NaN);
  const cinema = parse(inCinemas);
  if (minimum === 'inCinemas' && Number.isFinite(cinema)) return cinema;
  const home = [parse(digital), parse(physical)].filter(Number.isFinite);
  if (home.length > 0) return Math.min(...home);
  if (Number.isFinite(cinema)) return cinema + 90 * DAY;
  return 'never';
}

// ---- running the specs --------------------------------------------------------------

export interface Evaluation {
  rejections: ReleaseRejection[];
  remainingMinutes: number | undefined;
}

/** Run every applicable spec (§1.4): tier 0 always, tier 1 only when tier 0 is clean. */
export function evaluate(ctx: DecisionContext, c: Candidate, specs: readonly Specification[] = specifications): Evaluation {
  const rejections: ReleaseRejection[] = [];
  let remainingMinutes: number | undefined;
  for (const tier of [0, 1] as const) {
    if (tier === 1 && rejections.length > 0) break;
    for (const spec of specs) {
      if (spec.tier !== tier) continue;
      if (spec.appliesTo !== 'both' && spec.appliesTo !== c.match.mediaType) continue;
      let results: SpecResult[];
      try {
        const out = spec.evaluate(ctx, c);
        results = out === null ? [] : Array.isArray(out) ? out : [out];
      } catch (err) {
        results = [{ reason: 'decisionError', message: `${spec.id}: ${err instanceof Error ? err.message : String(err)}` }];
      }
      for (const r of results) {
        rejections.push({ reason: r.reason, message: r.message, type: r.reason === 'decisionError' ? 'permanent' : spec.type });
        if (r.remainingMinutes !== undefined) remainingMinutes = Math.max(remainingMinutes ?? 0, r.remainingMinutes);
      }
    }
  }
  return { rejections, remainingMinutes };
}

/** Build the decision resource for a mapped candidate. */
export function buildDecision(
  source: ReleaseSource,
  c: Candidate,
  ev: Evaluation,
): ReleaseDecision {
  const approved = ev.rejections.length === 0;
  const temporarilyRejected = !approved && ev.rejections.every((r) => r.type === 'temporary');
  const { rejections: _r, approved: _a, ...release } = c.release;
  const info = c.parsed.series;
  const base: ReleaseDecision = {
    ...release,
    rejections: ev.rejections,
    approved,
    temporarilyRejected,
    downloadAllowed: approved,
    source,
    mediaType: c.match.mediaType,
    quality: c.quality,
    languages: c.languages,
    customFormats: c.customFormats.map((f) => ({ id: f.id, name: f.name })),
    customFormatScore: c.formatScore,
    fullSeason: c.match.mediaType === 'series' ? c.match.fullSeason : false,
    ...(c.releaseGroup ? { releaseGroup: c.releaseGroup } : {}),
    ...(ev.remainingMinutes !== undefined && temporarilyRejected ? { delayMinutes: ev.remainingMinutes } : {}),
  };
  if (c.match.mediaType === 'series') {
    return {
      ...base,
      seriesId: c.match.series.id,
      seriesTitle: c.match.series.title,
      episodeIds: c.match.episodes.map((e) => e.id),
      ...(c.match.seasonNumber !== undefined ? { mappedSeasonNumber: c.match.seasonNumber } : {}),
      mappedEpisodeNumbers: c.match.episodes.map((e) => e.episodeNumber),
      ...(info?.absoluteEpisodes.length ? { mappedAbsoluteEpisodeNumbers: info.absoluteEpisodes } : {}),
    };
  }
  return { ...base, movieId: c.match.movie.id, movieTitle: c.match.movie.title };
}

/** Decision for a release that never reached the specs (unparseable / unknown item). */
export function unmatchedDecision(
  source: ReleaseSource,
  release: ReleaseResource,
  parsed: ParsedRelease | null,
  match: Unmatched | null,
  extra: ReleaseRejection | null = null,
): ReleaseDecision {
  const { rejections: _r, approved: _a, ...rest } = release;
  const rejection: ReleaseRejection =
    extra ?? { reason: match?.reason ?? 'unableToParse', message: match?.message ?? 'Unable to parse release', type: 'permanent' };
  return {
    ...rest,
    rejections: [rejection],
    approved: false,
    temporarilyRejected: rejection.type === 'temporary',
    downloadAllowed: false,
    source,
    ...(match?.mediaType ? { mediaType: match.mediaType } : {}),
    ...(match?.series ? { seriesId: match.series.id, seriesTitle: match.series.title } : {}),
    quality: parsed ? qualityModelOf(parsed.quality) : { quality: unknownQuality(), revision: { version: 1, real: 0, isRepack: false } },
    languages: parsed ? toLanguageCodes(parsed.languages) : [],
    customFormats: [],
    customFormatScore: 0,
    fullSeason: parsed?.series?.fullSeason ?? false,
    ...(parsed?.releaseGroup ? { releaseGroup: parsed.releaseGroup } : {}),
  };
}

/** Parser quality (readonly vocabulary entry) → contract QualityModel. */
export function qualityModelOf(pq: { quality: QualityDefinition; revision: QualityModel['revision'] }): QualityModel {
  return { quality: { ...pq.quality, mediaTypes: [...pq.quality.mediaTypes] }, revision: { ...pq.revision } };
}

function unknownQuality(): QualityModel['quality'] {
  return { id: 0, name: 'Unknown', source: 'unknown', resolution: 0, modifier: 'none', weight: 0, mediaTypes: ['series', 'movie'] };
}

// ---- prioritization (§11) -----------------------------------------------------------

export interface Ranked {
  decision: ReleaseDecision;
  /** Present when mapped; carries what the comparator needs. */
  rank?: {
    profile: QualityProfile;
    preferredProtocol: 'usenet' | 'torrent' | undefined;
    runtimeMinutes: number;
    preferredSizeMbPerMinute: number | null;
    isAnime: boolean;
    firstEpisodeNumber: number;
    /** Settings → Indexers `preferIndexerFlags`: flags break ties after indexer priority. */
    preferIndexerFlags?: boolean;
  };
}

/** Key of the library item a decision belongs to (series or movie), for grouping. */
export function itemKey(d: ReleaseDecision): string | undefined {
  // Multi-version items: each version slot is its own item (a 1080p and a 4K grab may both win).
  const v = d.versionTag ? `:${d.versionTag}` : '';
  if (d.mediaType === 'movie' && d.movieId !== undefined) return `movie:${d.movieId}${v}`;
  if (d.mediaType === 'series' && d.seriesId !== undefined && d.episodeIds?.length) return `series:${d.seriesId}${v}`;
  return undefined;
}

function log10Round(n: number | undefined): number {
  return n && n > 0 ? Math.round(Math.log10(n)) : 0;
}

function usenetAgeScore(ageHours: number): number {
  if (ageHours <= 1) return 1000;
  if (ageHours <= 24) return 100;
  if (ageHours <= 24 * 7) return 10;
  return -Math.round(Math.log10(ageHours / 24));
}

function sizeScore(r: Ranked): number {
  const unit = 200 * MB;
  const size = r.decision.size;
  const pref = r.rank?.preferredSizeMbPerMinute;
  const runtime = r.rank?.runtimeMinutes ?? 0;
  if (pref && runtime > 0) return -Math.round(Math.abs(size - pref * runtime * MB) / unit);
  return Math.round(size / unit);
}

/** Negative when `a` is better (sorts first). */
export function compareDecisions(a: Ranked, b: Ranked, propers: DownloadPropersAndRepacks): number {
  const ra = a.rank;
  const rb = b.rank;
  if (!ra || !rb) return 0;
  const da = a.decision;
  const db = b.decision;
  const profile = ra.profile;
  const steps: Array<() => number> = [
    () => qualityIndex(profile, db.quality) - qualityIndex(profile, da.quality),
    () => (propers === 'doNotPrefer' ? 0 : compareRevision(db.quality.revision, da.quality.revision)),
    () => db.customFormatScore - da.customFormatScore,
    () => {
      const pref = ra.preferredProtocol;
      if (!pref || da.protocol === db.protocol) return 0;
      return da.protocol === pref ? -1 : 1;
    },
    () => {
      if (da.mediaType !== 'series') return 0;
      if (da.fullSeason !== db.fullSeason) return da.fullSeason ? -1 : 1;
      const ca = da.episodeIds?.length ?? 0;
      const cb = db.episodeIds?.length ?? 0;
      return ra.isAnime ? cb - ca : ca - cb;
    },
    () => (da.mediaType === 'series' ? ra.firstEpisodeNumber - rb.firstEpisodeNumber : 0),
    () => da.indexerPriority - db.indexerPriority,
    () => (ra.preferIndexerFlags ? indexerFlagScore(releaseIndexerFlags(db)) - indexerFlagScore(releaseIndexerFlags(da)) : 0),
    () => {
      if (da.protocol !== 'torrent' || db.protocol !== 'torrent') return 0;
      return log10Round(db.seeders) - log10Round(da.seeders) || log10Round(db.peers ?? db.leechers) - log10Round(da.peers ?? da.leechers);
    },
    () => {
      if (da.protocol !== 'usenet' || db.protocol !== 'usenet') return 0;
      return usenetAgeScore(db.ageHours) - usenetAgeScore(da.ageHours);
    },
    () => sizeScore(b) - sizeScore(a),
  ];
  for (const step of steps) {
    const v = step();
    if (v !== 0) return Math.sign(v);
  }
  return 0;
}

/**
 * Group mapped decisions per series/movie, sort each group best-first (stable), keep the
 * groups in order of first appearance and append unmapped decisions unsorted.
 */
export function prioritize<T extends Ranked>(decisions: readonly T[], propers: DownloadPropersAndRepacks): T[] {
  const groups = new Map<string, T[]>();
  const unmapped: T[] = [];
  for (const d of decisions) {
    const key = d.rank ? itemKey(d.decision) : undefined;
    if (!key) {
      unmapped.push(d);
      continue;
    }
    const g = groups.get(key);
    if (g) g.push(d);
    else groups.set(key, [d]);
  }
  const out: T[] = [];
  for (const g of groups.values()) {
    const indexed = g.map((d, i) => ({ d, i }));
    indexed.sort((x, y) => compareDecisions(x.d, y.d, propers) || x.i - y.i);
    out.push(...indexed.map((x) => x.d));
  }
  return [...out, ...unmapped];
}

export type { MatchResult };
