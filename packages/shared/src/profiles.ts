import { z } from 'zod';
import { QualityModel, QualityModifier, QualitySource, Resolution } from './quality.js';

// Profiles: everything that decides "how good is this release and is it good enough".
// Quality profiles rank qualities, custom formats score releases, delay profiles hold a
// grab back, release profiles reject or demand terms in a title. The pure evaluation
// logic lives in @arclight/profiles-engine; these are the shapes it speaks and the API
// serves.

export const EvaluationMediaType = z.enum(['series', 'movie']);
export type EvaluationMediaType = z.infer<typeof EvaluationMediaType>;

export const ReleaseProtocol = z.enum(['usenet', 'torrent']);
export type ReleaseProtocol = z.infer<typeof ReleaseProtocol>;

/** Flags an indexer can attach to a release; normalized to this vocabulary by the indexers package. */
export const ReleaseIndexerFlag = z.enum([
  'freeleech',
  'halfleech',
  'doubleUpload',
  'internal',
  'scene',
  'nuked',
  'freeleech75',
  'freeleech25',
]);
export type ReleaseIndexerFlag = z.infer<typeof ReleaseIndexerFlag>;

/** Single episode, several episodes in one file, or a whole season. Movies are always `single`. */
export const ReleaseKind = z.enum(['single', 'multi', 'seasonPack']);
export type ReleaseKind = z.infer<typeof ReleaseKind>;

/** Extra material (not the feature/episode itself) detected in a release title. */
export const ReleaseExtraKind = z.enum([
  'featurette',
  'behindTheScenes',
  'deletedScene',
  'interview',
  'trailer',
  'short',
  'sample',
  'other',
]);
export type ReleaseExtraKind = z.infer<typeof ReleaseExtraKind>;

/** Language codes are ISO 639-1 (`en`, `fr`); `original` means "the title's original language". */
export const LanguageCode = z.string().min(2).max(16);
export type LanguageCode = z.infer<typeof LanguageCode>;

export const PROFILE_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'original', name: 'Original' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ja', name: 'Japanese' },
  { code: 'is', name: 'Icelandic' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ru', name: 'Russian' },
  { code: 'pl', name: 'Polish' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'sv', name: 'Swedish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'el', name: 'Greek' },
  { code: 'ko', name: 'Korean' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'he', name: 'Hebrew' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'cs', name: 'Czech' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'th', name: 'Thai' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'ro', name: 'Romanian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'unknown', name: 'Unknown' },
];

// ---------------------------------------------------------------------------------------
// Quality profiles

/** Group ids live above this so they never collide with quality ids from the vocabulary. */
export const QUALITY_GROUP_ID_BASE = 1000;

export const QualityProfileQualityItem = z.object({
  kind: z.literal('quality'),
  qualityId: z.number().int().min(0),
  allowed: z.boolean(),
});
export type QualityProfileQualityItem = z.infer<typeof QualityProfileQualityItem>;

export const QualityProfileGroupItem = z.object({
  kind: z.literal('group'),
  /** Stable id for the group; must be >= QUALITY_GROUP_ID_BASE. Usable as `cutoff`. */
  id: z.number().int().min(QUALITY_GROUP_ID_BASE),
  name: z.string().min(1),
  qualityIds: z.array(z.number().int().min(0)).min(1),
  allowed: z.boolean(),
});
export type QualityProfileGroupItem = z.infer<typeof QualityProfileGroupItem>;

/** Items are ordered worst → best; members of a group rank equal. */
export const QualityProfileItem = z.discriminatedUnion('kind', [QualityProfileQualityItem, QualityProfileGroupItem]);
export type QualityProfileItem = z.infer<typeof QualityProfileItem>;

export const ProfileFormatItem = z.object({
  formatId: z.number().int().min(1),
  score: z.number().int(),
});
export type ProfileFormatItem = z.infer<typeof ProfileFormatItem>;

export const QualityProfileInput = z.object({
  name: z.string().min(1).max(200),
  upgradeAllowed: z.boolean().default(true),
  /** A quality id or a group id; must refer to an allowed item. */
  cutoff: z.number().int().min(0),
  items: z.array(QualityProfileItem).min(1),
  minFormatScore: z.number().int().default(0),
  cutoffFormatScore: z.number().int().default(0),
  minUpgradeFormatScore: z.number().int().min(1).default(1),
  formatItems: z.array(ProfileFormatItem).default([]),
  /** Accepted languages; empty means any. */
  languages: z.array(LanguageCode).default([]),
});
export type QualityProfileInput = z.infer<typeof QualityProfileInput>;

export const QualityProfile = QualityProfileInput.extend({ id: z.number().int().min(1) });
export type QualityProfile = z.infer<typeof QualityProfile>;

// ---------------------------------------------------------------------------------------
// Custom formats

const regexFields = z.object({ pattern: z.string().min(1) });

export const CustomFormatSpec = z.discriminatedUnion('implementation', [
  z.object({
    implementation: z.literal('releaseTitle'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    fields: regexFields,
  }),
  z.object({
    implementation: z.literal('releaseGroup'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    fields: regexFields,
  }),
  z.object({
    implementation: z.literal('edition'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    fields: regexFields,
  }),
  z.object({
    implementation: z.literal('language'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    fields: z.object({
      language: LanguageCode,
      /** Match when the release has any language other than `language`. */
      exceptLanguage: z.boolean().default(false),
    }),
  }),
  z.object({
    implementation: z.literal('source'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    fields: z.object({ source: QualitySource }),
  }),
  z.object({
    implementation: z.literal('resolution'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    fields: z.object({ resolution: Resolution }),
  }),
  z.object({
    implementation: z.literal('qualityModifier'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    fields: z.object({ modifier: QualityModifier }),
  }),
  z.object({
    implementation: z.literal('size'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    /** Matches when minGb < size <= maxGb. */
    fields: z.object({ minGb: z.number().min(0), maxGb: z.number().positive() }),
  }),
  z.object({
    implementation: z.literal('indexerFlag'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    fields: z.object({ flag: ReleaseIndexerFlag }),
  }),
  z.object({
    implementation: z.literal('year'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    fields: z.object({ min: z.number().int().min(1800), max: z.number().int().min(1800) }),
  }),
  z.object({
    implementation: z.literal('releaseType'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    fields: z.object({ releaseType: ReleaseKind }),
  }),
  z.object({
    implementation: z.literal('releaseExtras'),
    name: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(false),
    /** Empty `kinds` matches any extra material. */
    fields: z.object({ kinds: z.array(ReleaseExtraKind).default([]) }),
  }),
]);
export type CustomFormatSpec = z.infer<typeof CustomFormatSpec>;
export type CustomFormatSpecImplementation = CustomFormatSpec['implementation'];

export const CustomFormatInput = z.object({
  name: z.string().min(1).max(200),
  includeWhenRenaming: z.boolean().default(false),
  specifications: z.array(CustomFormatSpec).default([]),
});
export type CustomFormatInput = z.infer<typeof CustomFormatInput>;

export const CustomFormat = CustomFormatInput.extend({ id: z.number().int().min(1) });
export type CustomFormat = z.infer<typeof CustomFormat>;

/** Describes one spec implementation so the UI can render its editor. */
export const SpecFieldDefinition = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'regex', 'number', 'select', 'multiSelect', 'checkbox']),
  helpText: z.string().optional(),
  unit: z.string().optional(),
  options: z.array(z.object({ value: z.union([z.string(), z.number()]), label: z.string() })).optional(),
  default: z.unknown().optional(),
});
export type SpecFieldDefinition = z.infer<typeof SpecFieldDefinition>;

export const SpecImplementationDefinition = z.object({
  implementation: z.string(),
  label: z.string(),
  mediaTypes: z.array(EvaluationMediaType),
  fields: z.array(SpecFieldDefinition),
});
export type SpecImplementationDefinition = z.infer<typeof SpecImplementationDefinition>;

// ---------------------------------------------------------------------------------------
// Release evaluation input (the normalized view of a release the engine scores)

export const ReleaseEvaluation = z.object({
  title: z.string(),
  releaseGroup: z.string().optional(),
  languages: z.array(LanguageCode).default([]),
  /** The item's original language, if known; lets `original` resolve in language specs. */
  originalLanguage: LanguageCode.optional(),
  quality: QualityModel,
  sizeBytes: z.number().int().min(0).optional(),
  indexerFlags: z.array(ReleaseIndexerFlag).optional(),
  edition: z.string().optional(),
  year: z.number().int().optional(),
  releaseKind: ReleaseKind.optional(),
  extras: z.array(ReleaseExtraKind).optional(),
  mediaType: EvaluationMediaType,
});
export type ReleaseEvaluation = z.infer<typeof ReleaseEvaluation>;

export const FormatScoreResult = z.object({
  score: z.number().int(),
  matchedFormatIds: z.array(z.number().int()),
});
export type FormatScoreResult = z.infer<typeof FormatScoreResult>;

/** POST /customformat/test: a title plus whatever else is known; the rest defaults. */
export const CustomFormatTestRequest = z.object({
  title: z.string().min(1),
  mediaType: EvaluationMediaType.default('movie'),
  releaseGroup: z.string().optional(),
  languages: z.array(LanguageCode).default([]),
  qualityId: z.number().int().min(0).default(0),
  sizeBytes: z.number().int().min(0).optional(),
  indexerFlags: z.array(ReleaseIndexerFlag).optional(),
  edition: z.string().optional(),
  year: z.number().int().optional(),
  releaseKind: ReleaseKind.optional(),
});
export type CustomFormatTestRequest = z.infer<typeof CustomFormatTestRequest>;

export const CustomFormatTestResponse = z.object({
  matchedFormats: z.array(CustomFormat),
  scores: z.array(z.object({ profileId: z.number().int(), profileName: z.string(), score: z.number().int() })),
});
export type CustomFormatTestResponse = z.infer<typeof CustomFormatTestResponse>;

// ---------------------------------------------------------------------------------------
// Delay profiles

export const DelayProfileInput = z.object({
  /** Empty tags = the default profile that applies to everything. */
  tags: z.array(z.number().int()).default([]),
  preferredProtocol: ReleaseProtocol.default('usenet'),
  usenetDelayMinutes: z.number().int().min(0).default(0),
  torrentDelayMinutes: z.number().int().min(0).default(0),
  bypassIfHighestQuality: z.boolean().default(false),
  bypassIfAboveCustomFormatScore: z.boolean().default(false),
  minimumCustomFormatScore: z.number().int().default(0),
});
export type DelayProfileInput = z.infer<typeof DelayProfileInput>;

export const DelayProfile = DelayProfileInput.extend({
  id: z.number().int().min(1),
  /** 1 = first consulted. The default (untagged) profile always sorts last. */
  order: z.number().int().min(1),
});
export type DelayProfile = z.infer<typeof DelayProfile>;

export const DelayProfileReorderRequest = z.object({
  id: z.number().int().min(1),
  /** Place after this profile; omit to move to the front. */
  afterId: z.number().int().min(1).optional(),
});
export type DelayProfileReorderRequest = z.infer<typeof DelayProfileReorderRequest>;

// ---------------------------------------------------------------------------------------
// Release profiles

export const ReleaseProfileInput = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  /** At least one term must appear in the title. Plain text (case-insensitive) or /regex/. */
  required: z.array(z.string().min(1)).default([]),
  /** Any term appearing in the title rejects it. */
  ignored: z.array(z.string().min(1)).default([]),
  /** Restrict to one indexer; omit for all. */
  indexerId: z.number().int().min(1).optional(),
  /** Empty tags = applies to every item. */
  tags: z.array(z.number().int()).default([]),
});
export type ReleaseProfileInput = z.infer<typeof ReleaseProfileInput>;

export const ReleaseProfile = ReleaseProfileInput.extend({ id: z.number().int().min(1) });
export type ReleaseProfile = z.infer<typeof ReleaseProfile>;

// ---------------------------------------------------------------------------------------
// Quality definitions (vocabulary + optional size limits)

export const QualityDefinitionLimits = z.object({
  /** MB per minute; null = no limit. */
  minSize: z.number().min(0).nullable().default(null),
  maxSize: z.number().min(0).nullable().default(null),
  preferredSize: z.number().min(0).nullable().default(null),
});
export type QualityDefinitionLimits = z.infer<typeof QualityDefinitionLimits>;

export const QualityDefinitionItem = QualityDefinitionLimits.extend({
  qualityId: z.number().int().min(0),
  title: z.string(),
  source: QualitySource,
  resolution: Resolution,
  modifier: QualityModifier,
  weight: z.number().int(),
  mediaTypes: z.array(EvaluationMediaType),
});
export type QualityDefinitionItem = z.infer<typeof QualityDefinitionItem>;

export const ProfilesErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type ProfilesErrorResponse = z.infer<typeof ProfilesErrorResponse>;
