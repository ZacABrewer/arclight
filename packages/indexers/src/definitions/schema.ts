/**
 * Zod schema for YAML site definitions (spec S2, S3, S5, S7-S11) plus the post-parse
 * normalisation the spec requires (default settings, `search.path` sugar, trailing-slash
 * links, login method default, schema version check, template validation).
 *
 * Structural keys are matched case-insensitively with `_`/`-` removed (S2.1); user maps
 * (inputs, fields, case, headers, options) keep their keys verbatim.
 */
import { z } from 'zod';
import { isSupportedEncoding } from './encoding.js';
import { isValidTimeZone } from './dates.js';
import { TemplateError, validateTemplate } from './template.js';

/** Highest definition format version this engine understands (S2.13). */
export const DEFINITION_SCHEMA_VERSION = 1;

export type DefinitionErrorCode =
  | 'invalid_yaml'
  | 'missing_key'
  | 'invalid_value'
  | 'unsupported_setting_type'
  | 'unsupported_schema_version'
  | 'template_syntax'
  | 'id_mismatch';

export class DefinitionError extends Error {
  readonly code: DefinitionErrorCode;
  readonly path: string;
  constructor(code: DefinitionErrorCode, message: string, path = '') {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'DefinitionError';
    this.code = code;
    this.path = path;
  }
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function normalizeKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const nk = normalizeKey(k);
    if (!(nk in out)) out[nk] = v;
  }
  return out;
}

/** An object schema whose input keys are normalised first. */
function obj<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess(normalizeKeys, z.object(shape));
}

const rawScalar = z.union([z.string(), z.number(), z.boolean()]);
/** Any YAML scalar, kept as its string form. */
const scalar = rawScalar.transform((v) => String(v));
const boolish = z.union([z.boolean(), z.string(), z.number()]).transform((v) =>
  typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : ['true', 'yes', '1', 'on'].includes(v.trim().toLowerCase()),
);
const nullableScalar = z.union([rawScalar, z.null()]).transform((v) => (v === null ? null : String(v)));

const filterSchema = obj({
  name: z.string(),
  args: z.union([rawScalar, z.array(rawScalar), z.null()]).optional(),
});

const headersSchema = z
  .record(z.string(), z.union([rawScalar, z.array(rawScalar)]))
  .transform((h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).map(String)])));

const inputsSchema = z
  .union([z.record(z.string(), nullableScalar), z.null()])
  .transform((v) => (v === null ? {} : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x ?? '']))));

const selectorShape = {
  selector: scalar.optional(),
  attribute: z.string().optional(),
  text: nullableScalar.optional(),
  case: z.record(z.string(), scalar).optional(),
  remove: z.string().optional(),
  default: nullableScalar.optional(),
  optional: boolish.optional(),
  filters: z.array(filterSchema).optional(),
};

export const selectorBlockSchema = obj(selectorShape);

const rowsSchema = obj({
  ...selectorShape,
  after: z.number().int().min(0).optional(),
  dateheaders: selectorBlockSchema.optional(),
  count: selectorBlockSchema.optional(),
  multiple: boolish.optional(),
  missingattributeequalsnoresults: boolish.optional(),
});

const errorBlockSchema = obj({
  selector: scalar,
  message: selectorBlockSchema.optional(),
});

export const SETTING_TYPES = [
  'text',
  'password',
  'checkbox',
  'select',
  'multi-select',
  'info',
  'info_cookie',
  'info_flaresolverr',
  'info_useragent',
  'info_category_8000',
  'cardigannCaptcha',
] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

const settingSchema = obj({
  name: z.string().min(1),
  type: z.string(),
  label: z.string().optional(),
  default: z.union([rawScalar, z.null()]).optional(),
  defaults: z.array(rawScalar).optional(),
  options: z.record(z.string(), scalar).optional(),
});

const categoryMappingSchema = obj({
  id: scalar,
  cat: z.string().optional(),
  desc: scalar.optional(),
  default: boolish.optional(),
});

const capsSchema = obj({
  categorymappings: z.array(categoryMappingSchema).optional(),
  categories: z.record(z.string(), z.string()).optional(),
  modes: z.record(z.string(), z.union([z.array(z.string()), z.string(), z.null()])),
  allowrawsearch: boolish.optional(),
  limits: obj({ default: z.number().int().positive().optional(), max: z.number().int().positive().optional() }).optional(),
});

const loginSchema = obj({
  method: z.string().optional(),
  path: scalar.optional(),
  submitpath: scalar.optional(),
  form: z.string().optional(),
  selectors: boolish.optional(),
  cookies: z.array(z.string()).optional(),
  headers: headersSchema.optional(),
  inputs: inputsSchema.optional(),
  selectorinputs: z.record(z.string(), selectorBlockSchema).optional(),
  getselectorinputs: z.record(z.string(), selectorBlockSchema).optional(),
  error: z.array(errorBlockSchema).optional(),
  test: obj({ path: scalar.optional(), selector: scalar.optional() }).optional(),
  captcha: obj({
    type: z.string().optional(),
    selector: z.string().optional(),
    input: z.string().optional(),
    image: z.unknown().optional(),
  }).optional(),
});

const pathSchema = obj({
  path: scalar,
  method: z.string().optional(),
  inputs: inputsSchema.optional(),
  inheritinputs: boolish.optional(),
  categories: z.array(scalar).optional(),
  followredirect: boolish.optional(),
  response: obj({ type: z.string().optional(), noresultsmessage: nullableScalar.optional() }).optional(),
  queryseparator: z.string().optional(),
});

const searchSchema = obj({
  path: scalar.optional(),
  paths: z.array(pathSchema).optional(),
  headers: headersSchema.optional(),
  keywordsfilters: z.array(filterSchema).optional(),
  allowemptyinputs: boolish.optional(),
  inputs: inputsSchema.optional(),
  preprocessingfilters: z.array(filterSchema).optional(),
  error: z.array(errorBlockSchema).optional(),
  rows: rowsSchema,
  fields: z.record(z.string(), selectorBlockSchema),
});

const downloadSelectorSchema = obj({ ...selectorShape, usebeforeresponse: boolish.optional() });

const downloadSchema = obj({
  method: z.string().optional(),
  headers: headersSchema.optional(),
  before: obj({
    path: scalar.optional(),
    method: z.string().optional(),
    inputs: inputsSchema.optional(),
    queryseparator: z.string().optional(),
    pathselector: selectorBlockSchema.optional(),
  }).optional(),
  selectors: z.array(downloadSelectorSchema).optional(),
  infohash: obj({
    hash: selectorBlockSchema,
    title: selectorBlockSchema,
    usebeforeresponse: boolish.optional(),
  }).optional(),
});

export const definitionSchema = obj({
  schemaversion: z.number().int().optional(),
  schema: z.number().int().optional(),
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  language: z.string().optional(),
  type: z.string().optional(),
  encoding: z.string().optional(),
  followredirect: boolish.optional(),
  requestdelay: z.number().min(0).optional(),
  testlinktorrent: boolish.optional(),
  tested: boolish.optional(),
  timezone: z.string().optional(),
  links: z.array(z.string().min(1)).min(1),
  legacylinks: z.array(z.string()).optional(),
  certificates: z.array(z.unknown()).optional(),
  settings: z.array(settingSchema).optional(),
  caps: capsSchema,
  login: loginSchema.optional(),
  ratio: z.unknown().optional(),
  search: searchSchema,
  download: downloadSchema.optional(),
});

type RawDefinition = z.output<typeof definitionSchema>;
export type SelectorBlock = z.output<typeof selectorBlockSchema>;
export type DownloadSelector = z.output<typeof downloadSelectorSchema>;
export type RowsBlock = z.output<typeof rowsSchema>;
export type ErrorBlock = z.output<typeof errorBlockSchema>;
export type FilterBlock = z.output<typeof filterSchema>;
export type SettingDefinition = Omit<z.output<typeof settingSchema>, 'type'> & { type: SettingType };
export type CategoryMappingDefinition = z.output<typeof categoryMappingSchema>;
export type SearchPathDefinition = Omit<z.output<typeof pathSchema>, 'method'> & { method: 'get' | 'post' };
export type LoginMethod = 'form' | 'post' | 'cookie' | 'get' | 'oneurl';
export type LoginDefinition = Omit<z.output<typeof loginSchema>, 'method'> & { method: LoginMethod };
export type SearchDefinition = Omit<z.output<typeof searchSchema>, 'paths' | 'path'> & { paths: SearchPathDefinition[] };
export type DownloadDefinition = z.output<typeof downloadSchema>;
export type CapsDefinition = Omit<z.output<typeof capsSchema>, 'modes'> & { modes: Record<SearchModeName, string[]> };
export type SiteType = 'public' | 'semi-private' | 'private';
export type SearchModeName = 'search' | 'tv-search' | 'movie-search' | 'music-search' | 'book-search';

/** A validated, normalised definition. */
export interface Definition
  extends Omit<RawDefinition, 'id' | 'type' | 'settings' | 'login' | 'search' | 'caps' | 'schema' | 'schemaversion'> {
  id: string;
  schemaVersion: number;
  type: SiteType;
  encoding: string;
  settings: SettingDefinition[];
  caps: CapsDefinition;
  login?: LoginDefinition;
  search: SearchDefinition;
  /** Non-fatal problems found while loading. */
  warnings: string[];
}

const MODE_PARAMS: Record<SearchModeName, readonly string[]> = {
  search: ['q'],
  'tv-search': ['q', 'season', 'ep', 'imdbid', 'tvdbid', 'rid', 'tvmazeid', 'traktid', 'tmdbid', 'doubanid', 'genre', 'year'],
  'movie-search': ['q', 'imdbid', 'tmdbid', 'imdbtitle', 'imdbyear', 'traktid', 'genre', 'doubanid', 'year'],
  'music-search': ['q', 'album', 'artist', 'label', 'year', 'genre', 'track'],
  'book-search': ['q', 'title', 'author', 'publisher', 'genre', 'year'],
};

const LOGIN_METHODS: readonly LoginMethod[] = ['form', 'post', 'cookie', 'get', 'oneurl'];

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function zodPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '');
}

function validateTemplates(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return;
    try {
      validateTemplate(value);
    } catch (err) {
      if (err instanceof TemplateError) throw new DefinitionError('template_syntax', err.message, path);
      throw err;
    }
    return;
  }
  if (Array.isArray(value)) value.forEach((v, i) => validateTemplates(v, `${path}[${i}]`));
  else if (typeof value === 'object' && value !== null)
    for (const [k, v] of Object.entries(value)) validateTemplates(v, path ? `${path}.${k}` : k);
}

export interface ParseDefinitionOptions {
  /** File name without extension; fills a missing `id` and must match a present one. */
  fileKey?: string;
}

/** Validate and normalise an already YAML-parsed definition object. */
export function parseDefinition(input: unknown, options: ParseDefinitionOptions = {}): Definition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue ? zodPath(issue.path) : '';
    const missing = issue?.code === 'invalid_type' && /received undefined/i.test(issue.message);
    throw new DefinitionError(missing ? 'missing_key' : 'invalid_value', issue?.message ?? 'Invalid definition', path);
  }
  const raw = parsed.data;
  const warnings: string[] = [];

  const schemaVersion = raw.schemaversion ?? raw.schema ?? 1;
  if (schemaVersion > DEFINITION_SCHEMA_VERSION || schemaVersion < 1) {
    throw new DefinitionError(
      'unsupported_schema_version',
      `Definition schema version ${schemaVersion} is not supported (max ${DEFINITION_SCHEMA_VERSION})`,
      'schemaVersion',
    );
  }

  const id = raw.id ?? options.fileKey;
  if (!id) throw new DefinitionError('missing_key', 'Definition has no id', 'id');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new DefinitionError('invalid_value', `Invalid id "${id}"`, 'id');
  if (options.fileKey && raw.id && raw.id !== options.fileKey) {
    throw new DefinitionError('id_mismatch', `id "${raw.id}" does not match file name "${options.fileKey}"`, 'id');
  }

  const type: SiteType = raw.type === 'public' || raw.type === 'private' || raw.type === 'semi-private' ? raw.type : 'semi-private';
  if (raw.type !== undefined && raw.type !== type) warnings.push(`Unknown type "${raw.type}" treated as semi-private`);

  const encoding = raw.encoding ?? 'UTF-8';
  if (!isSupportedEncoding(encoding)) throw new DefinitionError('invalid_value', `Unknown encoding "${encoding}"`, 'encoding');
  if (raw.timezone !== undefined && !isValidTimeZone(raw.timezone)) {
    throw new DefinitionError('invalid_value', `Unknown time zone "${raw.timezone}"`, 'timezone');
  }

  // Settings (S2.8, S3.1)
  const settings: SettingDefinition[] = (
    raw.settings ?? [
      { name: 'username', type: 'text', label: 'Username' },
      { name: 'password', type: 'password', label: 'Password' },
    ]
  ).map((s, i) => {
    if (!(SETTING_TYPES as readonly string[]).includes(s.type)) {
      throw new DefinitionError('unsupported_setting_type', `Unsupported setting type "${s.type}"`, `settings[${i}].type`);
    }
    return { ...s, type: s.type as SettingType };
  });

  // Caps (S7.1, S7.2)
  const modes = {} as Record<SearchModeName, string[]>;
  for (const [rawKey, rawParams] of Object.entries(raw.caps.modes)) {
    const key = rawKey.toLowerCase() as SearchModeName;
    const allowed = MODE_PARAMS[key];
    if (!allowed) throw new DefinitionError('invalid_value', `Unknown search mode "${rawKey}"`, `caps.modes.${rawKey}`);
    const params = (Array.isArray(rawParams) ? rawParams : (rawParams ?? '').split(/[\s,]+/))
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    const seen = new Set<string>();
    for (const p of params) {
      if (!allowed.includes(p)) {
        throw new DefinitionError('invalid_value', `Unknown parameter "${p}" for mode ${key}`, `caps.modes.${rawKey}`);
      }
      if (seen.has(p)) throw new DefinitionError('invalid_value', `Duplicate parameter "${p}"`, `caps.modes.${rawKey}`);
      seen.add(p);
    }
    modes[key] = params;
  }
  if (!modes.search) throw new DefinitionError('missing_key', 'caps.modes.search is required', 'caps.modes.search');
  if (modes.search.join(',') !== 'q') warnings.push('caps.modes.search should be exactly [q]');

  // Login (S2.12, S8.13, S8.16)
  let login: LoginDefinition | undefined;
  if (raw.login) {
    const method = (raw.login.method ?? 'form').toLowerCase() as LoginMethod;
    if (!LOGIN_METHODS.includes(method)) {
      throw new DefinitionError('invalid_value', `Unknown login method "${raw.login.method}"`, 'login.method');
    }
    if (raw.login.captcha?.image !== undefined) {
      throw new DefinitionError('invalid_value', 'login.captcha.image is invalid; use selector', 'login.captcha.image');
    }
    if (raw.login.captcha) {
      warnings.push(`login.captcha (${raw.login.captcha.type ?? 'unknown'}) is not supported; login proceeds without it`);
    }
    login = { ...raw.login, method };
  }

  // Search paths (S2.11)
  const { path: singlePath, paths: rawPaths, ...searchRest } = raw.search;
  const paths: SearchPathDefinition[] = (rawPaths ?? []).map((p) => ({
    ...p,
    method: (p.method ?? 'get').toLowerCase() === 'post' ? 'post' : 'get',
  }));
  if (singlePath !== undefined) paths.push({ path: singlePath, method: 'get', inheritinputs: true });
  if (paths.length === 0) throw new DefinitionError('missing_key', 'search.paths is empty', 'search.paths');

  if (raw.certificates?.length) warnings.push('certificates are parsed and ignored');

  const { schema: _schema, schemaversion: _sv, id: _id, type: _type, settings: _settings, caps, login: _login, search: _search, ...rest } = raw;
  const definition: Definition = {
    ...rest,
    id,
    schemaVersion,
    type,
    encoding,
    links: raw.links.map(withSlash),
    ...(raw.legacylinks ? { legacylinks: raw.legacylinks.map(withSlash) } : {}),
    settings,
    caps: { ...caps, modes },
    ...(login ? { login } : {}),
    search: { ...searchRest, paths },
    warnings,
  };
  validateTemplates({ login: definition.login, search: definition.search, download: definition.download }, '');
  return definition;
}
