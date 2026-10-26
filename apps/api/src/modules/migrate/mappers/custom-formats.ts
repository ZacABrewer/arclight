import type {
  CustomFormatInput,
  CustomFormatSpec,
  QualityModifier,
  QualitySource,
  ReleaseIndexerFlag,
  ReleaseKind,
  Resolution,
} from '@arclight/shared';
import { bool, field, int, num, str } from '../foreign-db.js';
import { mapLanguageId } from './languages.js';
import type { ArrApp } from './quality.js';

// Custom format specifications. Upstream stores a list of `{type, body}` objects in the
// database (the API/export format uses `{implementation, fields: [{name, value}]}`); both are
// normalised to (implementation, name, negate, required, values) and translated to
// Arclight's spec union. Specs with no equivalent are dropped and reported.

interface NormalizedSpec {
  implementation: string;
  name: string;
  negate: boolean;
  required: boolean;
  values: Record<string, unknown>;
}

function normalizeSpec(raw: unknown): NormalizedSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = str(field(obj, 'type', 'implementation')) ?? '';
  const bodyRaw = field(obj, 'body');
  const body = bodyRaw && typeof bodyRaw === 'object' ? (bodyRaw as Record<string, unknown>) : obj;
  const values: Record<string, unknown> = {};
  const fields = field(body, 'fields');
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (f && typeof f === 'object') {
        const name = str(field(f as Record<string, unknown>, 'name'));
        if (name) values[name.toLowerCase()] = field(f as Record<string, unknown>, 'value');
      }
    }
  } else if (fields && typeof fields === 'object') {
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) values[k.toLowerCase()] = v;
  }
  for (const [k, v] of Object.entries(body)) {
    const key = k.toLowerCase();
    if (!['name', 'negate', 'required', 'fields', 'implementation', 'type', 'body'].includes(key) && !(key in values)) values[key] = v;
  }
  return {
    implementation: type.replace(/Specification$/i, '').toLowerCase(),
    name: str(field(body, 'name')) ?? str(field(obj, 'name')) ?? type,
    negate: bool(field(body, 'negate') ?? field(obj, 'negate')),
    required: bool(field(body, 'required') ?? field(obj, 'required')),
    values,
  };
}

const SONARR_SOURCES: Record<number, QualitySource> = {
  0: 'unknown',
  1: 'television',
  2: 'televisionRaw',
  3: 'web',
  4: 'webRip',
  5: 'dvd',
  6: 'bluray',
  7: 'blurayRaw',
};

const RADARR_SOURCES: Record<number, QualitySource> = {
  0: 'unknown',
  1: 'cam',
  2: 'telesync',
  3: 'telecine',
  4: 'workprint',
  5: 'dvd',
  6: 'television',
  7: 'web',
  8: 'webRip',
  9: 'bluray',
};

const RADARR_MODIFIERS: Record<number, QualityModifier> = {
  0: 'none',
  1: 'regional',
  2: 'screener',
  3: 'rawhd',
  4: 'brdisk',
  5: 'remux',
};

const SONARR_FLAGS: Record<number, ReleaseIndexerFlag> = {
  1: 'freeleech',
  2: 'halfleech',
  4: 'doubleUpload',
  8: 'internal',
  16: 'scene',
  32: 'freeleech75',
  64: 'freeleech25',
  128: 'nuked',
};

const RADARR_FLAGS: Record<number, ReleaseIndexerFlag> = {
  1: 'freeleech',
  2: 'halfleech',
  4: 'doubleUpload',
  32: 'internal',
  64: 'internal',
  128: 'scene',
  256: 'freeleech75',
  512: 'freeleech25',
  2048: 'nuked',
};

const RELEASE_TYPES: Record<number, ReleaseKind> = { 1: 'single', 2: 'multi', 3: 'seasonPack' };
const RESOLUTIONS = new Set<number>([360, 480, 540, 576, 720, 1080, 2160]);

export function indexerFlagsFromBits(app: ArrApp, bits: number | null): ReleaseIndexerFlag[] {
  if (!bits) return [];
  const table = app === 'sonarr' ? SONARR_FLAGS : RADARR_FLAGS;
  const out: ReleaseIndexerFlag[] = [];
  for (const [bit, flag] of Object.entries(table)) if ((bits & Number(bit)) !== 0 && !out.includes(flag)) out.push(flag);
  return out;
}

export interface SpecMapResult {
  spec: CustomFormatSpec | null;
  /** Why the spec was dropped. */
  reason?: string;
}

export function mapSpec(app: ArrApp, raw: unknown): SpecMapResult {
  const s = normalizeSpec(raw);
  if (!s) return { spec: null, reason: 'unreadable specification' };
  const base = { name: s.name || s.implementation, negate: s.negate, required: s.required };
  const value = s.values['value'];
  switch (s.implementation) {
    case 'releasetitle':
    case 'releasegroup':
    case 'edition': {
      const pattern = str(value);
      if (!pattern) return { spec: null, reason: `${s.name}: empty pattern` };
      const implementation = s.implementation === 'releasetitle' ? 'releaseTitle' : s.implementation === 'releasegroup' ? 'releaseGroup' : 'edition';
      return { spec: { ...base, implementation, fields: { pattern } } };
    }
    case 'language': {
      const id = int(value);
      const language = id !== null ? mapLanguageId(app, id) : undefined;
      if (!language) return { spec: null, reason: `${s.name}: language ${String(value)} has no equivalent` };
      return { spec: { ...base, implementation: 'language', fields: { language, exceptLanguage: bool(s.values['exceptlanguage']) } } };
    }
    case 'source': {
      const id = int(value);
      const source = id !== null ? (app === 'sonarr' ? SONARR_SOURCES : RADARR_SOURCES)[id] : undefined;
      if (!source) return { spec: null, reason: `${s.name}: unknown source ${String(value)}` };
      return { spec: { ...base, implementation: 'source', fields: { source } } };
    }
    case 'resolution': {
      const r = int(value);
      if (r === null || !RESOLUTIONS.has(r)) return { spec: null, reason: `${s.name}: unknown resolution ${String(value)}` };
      return { spec: { ...base, implementation: 'resolution', fields: { resolution: r as Resolution } } };
    }
    case 'qualitymodifier': {
      const id = int(value);
      const modifier = id !== null ? RADARR_MODIFIERS[id] : undefined;
      if (!modifier) return { spec: null, reason: `${s.name}: unknown quality modifier ${String(value)}` };
      return { spec: { ...base, implementation: 'qualityModifier', fields: { modifier } } };
    }
    case 'size': {
      const minGb = num(s.values['min']) ?? 0;
      const maxGb = num(s.values['max']) ?? 0;
      if (maxGb <= minGb) return { spec: null, reason: `${s.name}: size range ${minGb}-${maxGb} GB is empty` };
      return { spec: { ...base, implementation: 'size', fields: { minGb, maxGb } } };
    }
    case 'indexerflag': {
      const flags = indexerFlagsFromBits(app, int(value));
      const flag = flags[0];
      if (!flag) return { spec: null, reason: `${s.name}: indexer flag ${String(value)} has no equivalent` };
      return { spec: { ...base, implementation: 'indexerFlag', fields: { flag } } };
    }
    case 'year': {
      const min = int(s.values['min']);
      const max = int(s.values['max']);
      if (min === null || max === null || min < 1800 || max < min) return { spec: null, reason: `${s.name}: invalid year range` };
      return { spec: { ...base, implementation: 'year', fields: { min, max } } };
    }
    case 'releasetype': {
      const id = int(value);
      const releaseType = id !== null ? RELEASE_TYPES[id] : undefined;
      if (!releaseType) return { spec: null, reason: `${s.name}: release type ${String(value)} has no equivalent` };
      return { spec: { ...base, implementation: 'releaseType', fields: { releaseType } } };
    }
    default:
      return { spec: null, reason: `${s.name}: unsupported specification type "${s.implementation || 'unknown'}"` };
  }
}

export interface CustomFormatMapResult {
  input: CustomFormatInput;
  dropped: string[];
}

export function mapCustomFormat(app: ArrApp, name: string, includeWhenRenaming: boolean, rawSpecs: unknown[]): CustomFormatMapResult {
  const specifications: CustomFormatSpec[] = [];
  const dropped: string[] = [];
  for (const raw of rawSpecs) {
    const r = mapSpec(app, raw);
    if (r.spec) specifications.push(r.spec);
    else dropped.push(r.reason ?? 'unsupported specification');
  }
  return { input: { name, includeWhenRenaming, specifications }, dropped };
}
