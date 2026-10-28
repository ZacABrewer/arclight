import type {
  AudioVbrPreset,
  CustomFormat,
  CustomFormatSpec,
  FormatScoreResult,
  MediaDomain,
  QualityProfile,
  ReleaseAudioEvaluation,
  ReleaseEvaluation,
  ReleaseKind,
} from '@arclight/shared';

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

/** Nominal average bitrate of a LAME VBR preset, for bitrate bands when none is stated. */
const VBR_NOMINAL_KBPS: Record<AudioVbrPreset, number> = { V0: 245, V1: 225, V2: 190, APS: 190, APX: 245 };

/** The bitrate an audio spec compares: stated, else the VBR preset's nominal rate. */
export function effectiveBitrateKbps(audio: ReleaseAudioEvaluation): number | undefined {
  if (audio.bitrateKbps !== undefined) return audio.bitrateKbps;
  return audio.vbrPreset ? VBR_NOMINAL_KBPS[audio.vbrPreset] : undefined;
}

function ripLogMatches(fields: { requireLog: boolean; minScore: number; requireCue: boolean }, audio: ReleaseAudioEvaluation): boolean {
  const needsLog = fields.requireLog || fields.minScore > 0;
  if (!needsLog && !fields.requireCue) return audio.hasLog || audio.hasCue;
  if (needsLog && !audio.hasLog) return false;
  if (fields.minScore > 0 && (audio.logScore === undefined || audio.logScore < fields.minScore)) return false;
  if (fields.requireCue && !audio.hasCue) return false;
  return true;
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
    // Audio specs: false without an audio block, and false when the value is unknown.
    case 'audioCodec':
      return ev.audio !== undefined && ev.audio.codec === spec.fields.codec;
    case 'audioBitrate': {
      const kbps = ev.audio ? effectiveBitrateKbps(ev.audio) : undefined;
      return kbps !== undefined && kbps >= spec.fields.minKbps && kbps <= spec.fields.maxKbps;
    }
    case 'bitDepth':
      return ev.audio?.bitDepth !== undefined && ev.audio.bitDepth === spec.fields.bitDepth;
    case 'sampleRate': {
      const hz = ev.audio?.sampleRateHz;
      // Compare in Hz so 44.1 kHz bounds are exact.
      return hz !== undefined && hz >= Math.round(spec.fields.minKhz * 1000) && hz <= Math.round(spec.fields.maxKhz * 1000);
    }
    case 'audioSource':
      return ev.audio?.source !== undefined && ev.audio.source === spec.fields.source;
    case 'ripLog':
      return ev.audio !== undefined && ripLogMatches(spec.fields, ev.audio);
    // Audiobook specs (evaluated from wave 3 on, when the audiobook parser fills these in).
    case 'fileLayout':
      return ev.audio?.fileLayout !== undefined && ev.audio.fileLayout === spec.fields.layout;
    case 'formatType':
      return ev.audio?.formatType !== undefined && ev.audio.formatType === spec.fields.formatType;
    case 'narrator':
      return (ev.audio?.narrators ?? []).some((n) => matchString(spec.fields.pattern, n));
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
      case 'narrator':
        if (!isValidPattern(spec.fields.pattern)) issues.push({ path, message: `invalid regex: ${spec.fields.pattern}` });
        break;
      case 'size':
        if (spec.fields.maxGb <= spec.fields.minGb) issues.push({ path, message: 'maxGb must be greater than minGb' });
        break;
      case 'year':
        if (spec.fields.max < spec.fields.min) issues.push({ path, message: 'max year must be >= min year' });
        break;
      case 'audioBitrate':
        if (spec.fields.maxKbps < spec.fields.minKbps) issues.push({ path, message: 'maxKbps must be >= minKbps' });
        break;
      case 'sampleRate':
        if (spec.fields.maxKhz < spec.fields.minKhz) issues.push({ path, message: 'maxKhz must be >= minKhz' });
        break;
      default:
        break;
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------------------
// Domains: which kind of profile a format belongs to

/** The media domain a custom format is used in, derived from its specifications. */
export type CustomFormatDomain = MediaDomain | 'any';

const ALL_DOMAINS: ReadonlyArray<MediaDomain> = ['video', 'music', 'audiobook'];

const RELEASE_KIND_DOMAINS: Record<ReleaseKind, ReadonlyArray<MediaDomain>> = {
  // A single release is a movie, an episode, an album or a book.
  single: ALL_DOMAINS,
  multi: ['video'],
  seasonPack: ['video'],
  discography: ['music'],
  multiAlbum: ['music'],
  bookPack: ['audiobook'],
};

/** Domains in which one specification can ever match. */
export function specDomains(spec: CustomFormatSpec): ReadonlyArray<MediaDomain> {
  switch (spec.implementation) {
    case 'releaseTitle':
    case 'releaseGroup':
    case 'edition':
    case 'size':
    case 'indexerFlag':
    case 'year':
      return ALL_DOMAINS;
    case 'releaseType':
      return RELEASE_KIND_DOMAINS[spec.fields.releaseType];
    case 'language':
    case 'source':
    case 'resolution':
    case 'qualityModifier':
    case 'releaseExtras':
      return ['video'];
    case 'audioCodec':
    case 'audioBitrate':
    case 'bitDepth':
    case 'sampleRate':
      return ['music', 'audiobook'];
    case 'audioSource':
    case 'ripLog':
      return ['music'];
    case 'fileLayout':
    case 'formatType':
    case 'narrator':
      return ['audiobook'];
  }
}

/**
 * Every domain the format can match in: the intersection over its specifications. Only
 * domain-neutral specs (title, group, edition, size, flag, year, single release) fit all
 * three. A negated spec still reads its domain's data, so it narrows the same way. An empty
 * result means the specs contradict each other (a video and a music spec).
 */
export function customFormatDomains(format: Pick<CustomFormat, 'specifications'>): MediaDomain[] {
  let domains: MediaDomain[] = [...ALL_DOMAINS];
  for (const spec of format.specifications) {
    const allowed = specDomains(spec);
    domains = domains.filter((d) => allowed.includes(d));
  }
  return domains;
}

/**
 * One label for the format: `any` when it fits every domain, otherwise the first domain it
 * fits. A format that fits both audio domains (codec, bitrate, bit depth, sample rate only) is
 * labelled `music`; filter with `customFormatFitsDomain`, which offers it to audiobook
 * profiles too. A contradictory format is labelled by its first domain-specific spec.
 */
export function customFormatDomain(format: Pick<CustomFormat, 'specifications'>): CustomFormatDomain {
  const domains = customFormatDomains(format);
  if (domains.length === ALL_DOMAINS.length) return 'any';
  if (domains[0] !== undefined) return domains[0];
  for (const spec of format.specifications) {
    const d = specDomains(spec);
    if (d.length < ALL_DOMAINS.length && d[0] !== undefined) return d[0];
  }
  return 'any';
}

/** Should a profile of `domain` list this format? */
export function customFormatFitsDomain(format: Pick<CustomFormat, 'specifications'>, domain: MediaDomain): boolean {
  return customFormatDomains(format).includes(domain);
}
