import type {
  CustomFormat,
  CustomFormatSpec,
  FormatScoreResult,
  QualityProfile,
  ReleaseEvaluation,
} from '@media-tron/shared';

const GIGABYTE = 1024 ** 3;

const regexCache = new Map<string, RegExp | null>();

/** Compile a user pattern once; an invalid pattern never matches rather than throwing mid-evaluation. */
export function compilePattern(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern, 'i');
  } catch {
    compiled = null;
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

export function isValidPattern(pattern: string): boolean {
  return compilePattern(pattern) !== null;
}

function matchString(pattern: string, value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const re = compilePattern(pattern);
  return re !== null && re.test(value);
}

/** Raw match of one specification, before `negate` is applied. */
export function specMatchesRaw(spec: CustomFormatSpec, ev: ReleaseEvaluation): boolean {
  switch (spec.implementation) {
    case 'releaseTitle':
      return matchString(spec.fields.pattern, ev.title);
    case 'releaseGroup':
      return matchString(spec.fields.pattern, ev.releaseGroup);
    case 'edition':
      return matchString(spec.fields.pattern, ev.edition);
    case 'language': {
      const wanted =
        spec.fields.language === 'original' && ev.originalLanguage && ev.originalLanguage !== 'unknown'
          ? ev.originalLanguage
          : spec.fields.language;
      return spec.fields.exceptLanguage ? ev.languages.some((l) => l !== wanted) : ev.languages.includes(wanted);
    }
    case 'source':
      return ev.quality.quality.source === spec.fields.source;
    case 'resolution':
      return ev.quality.quality.resolution === spec.fields.resolution;
    case 'qualityModifier':
      return ev.quality.quality.modifier === spec.fields.modifier;
    case 'size': {
      if (ev.sizeBytes === undefined) return false;
      return ev.sizeBytes > spec.fields.minGb * GIGABYTE && ev.sizeBytes <= spec.fields.maxGb * GIGABYTE;
    }
    case 'indexerFlag':
      return ev.indexerFlags?.includes(spec.fields.flag) ?? false;
    case 'year':
      return ev.year !== undefined && ev.year >= spec.fields.min && ev.year <= spec.fields.max;
    case 'releaseType':
      return ev.releaseKind === spec.fields.releaseType;
    case 'releaseExtras': {
      const extras = ev.extras ?? [];
      if (extras.length === 0) return false;
      if (spec.fields.kinds.length === 0) return true;
      return extras.some((e) => spec.fields.kinds.includes(e));
    }
  }
}

/** Match of one specification with `negate` applied. */
export function specMatches(spec: CustomFormatSpec, ev: ReleaseEvaluation): boolean {
  const raw = specMatchesRaw(spec, ev);
  return spec.negate ? !raw : raw;
}

/**
 * A format matches when every implementation group matches. Within a group (all specs of
 * one implementation) at least one spec must match, and every spec flagged `required`
 * must match. A format with no specifications matches nothing.
 */
export function formatMatches(format: CustomFormat, ev: ReleaseEvaluation): boolean {
  if (format.specifications.length === 0) return false;

  const groups = new Map<string, boolean[]>();
  const requiredFailed = { value: false };

  for (const spec of format.specifications) {
    const matched = specMatches(spec, ev);
    if (spec.required && !matched) requiredFailed.value = true;
    const group = groups.get(spec.implementation) ?? [];
    group.push(matched);
    groups.set(spec.implementation, group);
  }

  if (requiredFailed.value) return false;
  for (const results of groups.values()) {
    if (!results.some(Boolean)) return false;
  }
  return true;
}

/** Every format that matches the release, in the order given. */
export function matchCustomFormats(formats: ReadonlyArray<CustomFormat>, ev: ReleaseEvaluation): CustomFormat[] {
  return formats.filter((f) => formatMatches(f, ev));
}

/** Sum of the profile's scores for the given format ids; unscored formats count 0. */
export function calculateFormatScore(profile: QualityProfile, formatIds: ReadonlyArray<number>): number {
  let score = 0;
  for (const item of profile.formatItems) {
    if (formatIds.includes(item.formatId)) score += item.score;
  }
  return score;
}

/** Match formats against the release and total their scores under the profile. */
export function scoreRelease(
  profile: QualityProfile,
  formats: ReadonlyArray<CustomFormat>,
  ev: ReleaseEvaluation,
): FormatScoreResult {
  const matchedFormatIds = matchCustomFormats(formats, ev).map((f) => f.id);
  return { score: calculateFormatScore(profile, matchedFormatIds), matchedFormatIds };
}

/** Does the release clear the profile's minimum custom format score? */
export function meetsMinFormatScore(profile: QualityProfile, score: number): boolean {
  return score >= profile.minFormatScore;
}

export type SpecValidationIssue = { path: string; message: string };

/** Checks beyond the Zod shape: regexes compile, ranges are ordered. */
export function validateCustomFormat(format: Omit<CustomFormat, 'id'>): SpecValidationIssue[] {
  const issues: SpecValidationIssue[] = [];
  format.specifications.forEach((spec, i) => {
    const path = `specifications[${i}]`;
    switch (spec.implementation) {
      case 'releaseTitle':
      case 'releaseGroup':
      case 'edition':
        if (!isValidPattern(spec.fields.pattern)) issues.push({ path, message: `invalid regex: ${spec.fields.pattern}` });
        break;
      case 'size':
        if (spec.fields.maxGb <= spec.fields.minGb) issues.push({ path, message: 'maxGb must be greater than minGb' });
        break;
      case 'year':
        if (spec.fields.max < spec.fields.min) issues.push({ path, message: 'max year must be >= min year' });
        break;
      default:
        break;
    }
  });
  return issues;
}
