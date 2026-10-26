import {
  CustomFormatSpec,
  PROFILE_LANGUAGES,
  QualityModifier,
  type CustomFormat,
  type CustomFormatInput,
  type QualitySource,
  type ReleaseIndexerFlag,
  type ReleaseKind,
} from '@arclight/shared';

// Import/export of custom formats as JSON. Accepts our own export and the community format
// shared by TRaSH-guides and *arr exports: `{ name, includeCustomFormatWhenRenaming,
// specifications: [{ name, implementation: "ReleaseTitleSpecification", negate, required,
// fields: { value } }] }` (fields may also be the API's `[{ name, value }]` array). Numeric
// enum values in those files are app specific (Sonarr vs Radarr), so the caller says which.

export type SourceApp = 'sonarr' | 'radarr';

export interface ImportResult {
  formats: CustomFormatInput[];
  /** Specs or formats that were skipped, with the reason. */
  warnings: string[];
}

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `fields` as a plain object whether it came as `{ value }` or `[{ name, value }]`. */
export function normalizeFields(fields: unknown): Raw {
  if (Array.isArray(fields)) {
    const out: Raw = {};
    for (const f of fields) if (isObj(f) && typeof f.name === 'string') out[f.name] = f.value;
    return out;
  }
  return isObj(fields) ? fields : {};
}

// Language ids used by the *arr apps (data, not code): -1 original, 0 unknown, then ids.
const LANGUAGE_IDS: Record<number, string> = {
  [-1]: 'original',
  0: 'unknown',
  1: 'en',
  2: 'fr',
  3: 'es',
  4: 'de',
  5: 'it',
  6: 'da',
  7: 'nl',
  8: 'ja',
  9: 'is',
  10: 'zh',
  11: 'ru',
  12: 'pl',
  13: 'vi',
  14: 'sv',
  15: 'no',
  16: 'fi',
  17: 'tr',
  18: 'pt',
  20: 'el',
  21: 'ko',
  22: 'hu',
  23: 'he',
  24: 'lt',
  25: 'cs',
  26: 'ar',
  27: 'hi',
};

const SOURCE_IDS: Record<SourceApp, Record<number, QualitySource>> = {
  sonarr: { 0: 'unknown', 1: 'television', 2: 'televisionRaw', 3: 'web', 4: 'webRip', 5: 'dvd', 6: 'bluray', 7: 'blurayRaw' },
  radarr: { 0: 'unknown', 1: 'cam', 2: 'telesync', 3: 'telecine', 4: 'workprint', 5: 'dvd', 6: 'television', 7: 'web', 8: 'webRip', 9: 'bluray' },
};

const FLAG_IDS: Record<SourceApp, Record<number, ReleaseIndexerFlag>> = {
  sonarr: { 1: 'freeleech', 2: 'halfleech', 4: 'doubleUpload', 8: 'internal', 16: 'scene', 32: 'freeleech75', 64: 'freeleech25', 128: 'nuked' },
  radarr: { 1: 'freeleech', 2: 'halfleech', 4: 'doubleUpload', 32: 'internal', 128: 'scene', 256: 'freeleech75', 512: 'freeleech25', 1024: 'nuked' },
};

const RELEASE_TYPE_IDS: Record<number, ReleaseKind> = { 1: 'single', 2: 'multi', 3: 'seasonPack' };

function language(value: unknown): string | undefined {
  if (typeof value === 'number') return LANGUAGE_IDS[value];
  if (typeof value === 'string' && PROFILE_LANGUAGES.some((l) => l.code === value)) return value;
  return undefined;
}

/** Map one foreign spec to ours; returns a reason string when it cannot be mapped. */
function mapSpec(raw: Raw, app: SourceApp): CustomFormatSpec | string {
  // Already in our vocabulary (our own export): validate and keep.
  const native = CustomFormatSpec.safeParse(raw);
  if (native.success) return native.data;

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : String(raw.implementation ?? 'spec');
  const impl = String(raw.implementation ?? '').replace(/Specification$/, '');
  const base = { name, negate: raw.negate === true, required: raw.required === true };
  const f = normalizeFields(raw.fields);
  const value = f.value;

  let candidate: unknown;
  switch (impl) {
    case 'ReleaseTitle':
      candidate = { ...base, implementation: 'releaseTitle', fields: { pattern: value } };
      break;
    case 'ReleaseGroup':
      candidate = { ...base, implementation: 'releaseGroup', fields: { pattern: value } };
      break;
    case 'Edition':
      candidate = { ...base, implementation: 'edition', fields: { pattern: value } };
      break;
    case 'Language': {
      const code = language(value);
      if (!code) return `${name}: unknown language ${JSON.stringify(value)}`;
      candidate = { ...base, implementation: 'language', fields: { language: code, exceptLanguage: f.exceptLanguage === true } };
      break;
    }
    case 'Source': {
      const source = typeof value === 'number' ? SOURCE_IDS[app][value] : undefined;
      if (!source) return `${name}: unknown ${app} source ${JSON.stringify(value)}`;
      candidate = { ...base, implementation: 'source', fields: { source } };
      break;
    }
    case 'Resolution':
      candidate = { ...base, implementation: 'resolution', fields: { resolution: Number(value) } };
      break;
    case 'QualityModifier': {
      const modifier = typeof value === 'number' ? QualityModifier.options[value] : undefined;
      if (!modifier) return `${name}: unknown quality modifier ${JSON.stringify(value)}`;
      candidate = { ...base, implementation: 'qualityModifier', fields: { modifier } };
      break;
    }
    case 'Size':
      candidate = { ...base, implementation: 'size', fields: { minGb: Number(f.min ?? 0), maxGb: Number(f.max) } };
      break;
    case 'IndexerFlag': {
      const flag = typeof value === 'number' ? FLAG_IDS[app][value] : undefined;
      if (!flag) return `${name}: unknown ${app} indexer flag ${JSON.stringify(value)}`;
      candidate = { ...base, implementation: 'indexerFlag', fields: { flag } };
      break;
    }
    case 'Year':
      candidate = { ...base, implementation: 'year', fields: { min: Number(f.min), max: Number(f.max) } };
      break;
    case 'ReleaseType': {
      const releaseType = typeof value === 'number' ? RELEASE_TYPE_IDS[value] : undefined;
      if (!releaseType) return `${name}: unknown release type ${JSON.stringify(value)}`;
      candidate = { ...base, implementation: 'releaseType', fields: { releaseType } };
      break;
    }
    default:
      return `${name}: unsupported implementation "${String(raw.implementation)}"`;
  }
  const parsed = CustomFormatSpec.safeParse(candidate);
  return parsed.success ? parsed.data : `${name}: ${parsed.error.issues[0]?.message ?? 'invalid fields'}`;
}

function mapFormat(raw: unknown, app: SourceApp, warnings: string[]): CustomFormatInput | null {
  if (!isObj(raw) || typeof raw.name !== 'string' || !raw.name.trim()) {
    warnings.push('Skipped an entry without a name');
    return null;
  }
  const specs = Array.isArray(raw.specifications) ? raw.specifications : [];
  const specifications: CustomFormatSpec[] = [];
  for (const s of specs) {
    if (!isObj(s)) continue;
    const mapped = mapSpec(s, app);
    if (typeof mapped === 'string') warnings.push(`${raw.name} → ${mapped}`);
    else specifications.push(mapped);
  }
  const includeWhenRenaming = raw.includeCustomFormatWhenRenaming === true || raw.includeWhenRenaming === true;
  return { name: raw.name.trim(), includeWhenRenaming, specifications };
}

/** Parse pasted/uploaded JSON: one format or an array of them. Throws on malformed JSON. */
export function parseCustomFormatJson(text: string, app: SourceApp = 'sonarr'): ImportResult {
  const data: unknown = JSON.parse(text);
  const warnings: string[] = [];
  const list = Array.isArray(data) ? data : [data];
  const formats = list.map((raw) => mapFormat(raw, app, warnings)).filter((f): f is CustomFormatInput => f !== null);
  return { formats, warnings };
}

/** Export shape: our specs, with the community key for the rename flag so either side can read it. */
export function exportCustomFormat(cf: CustomFormat | CustomFormatInput) {
  return {
    name: cf.name,
    includeCustomFormatWhenRenaming: cf.includeWhenRenaming,
    specifications: cf.specifications,
  };
}
