import type {
  DefinitionFieldValue,
  DefinitionSettingField,
  Indexer,
  IndexerCreate,
  IndexerDefinitionSummary,
  IndexerPrivacy,
  IndexerProxy,
  IndexerTemplate,
  ReleaseProtocol,
} from '@arclight/shared';
import { INDEXER_PRIORITY_DEFAULT, INDEXER_PRIORITY_MAX, INDEXER_PRIORITY_MIN } from '@arclight/shared';
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import type { ChipTone } from '../../../arclight/index.js';
import { t } from '../../../i18n/index.js';

// Definition (catalogue) indexers: the editor's fields come from the definition's own
// `settings` list (served as `settingsFields`); values live under `settings.fields.<name>`.

/** Privacy is a fact, not a state: no accent or warning colours (rule 2). */
export const PRIVACY_TONES: Record<IndexerPrivacy, ChipTone> = { public: 'default', 'semi-private': 'neutral', private: 'neutral' };

export const PRIVACY_LABELS: Record<IndexerPrivacy, string> = { get public() { return t('settings.indexers.definitionFields.public'); }, get 'semi-private'() { return t('settings.indexers.definitionFields.semiPrivate'); }, get private() { return t('common.private'); } };

/** Field path for one definition setting. */
export const definitionFieldPath = (name: string) => `settings.fields.${name}`;

/** Help-only entries (`info`, `info_cookie`, ...) render as notes, not inputs. */
export function definitionNotes(def: Pick<IndexerDefinitionSummary, 'settingsFields'>): DefinitionSettingField[] {
  return def.settingsFields.filter((f) => f.informational);
}

const truthy = (v: unknown) => v === true || v === 'true' || v === 'True';

function settingField(f: DefinitionSettingField): FieldDefinition {
  const base = { name: definitionFieldPath(f.name), label: f.label || f.name, ...(f.default !== undefined ? { default: f.default } : {}) };
  switch (f.type) {
    case 'checkbox':
      return { ...base, type: 'checkbox', default: truthy(f.default) };
    case 'password':
      return { ...base, type: 'password' };
    case 'select':
      return { ...base, type: 'select', options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label })) };
    case 'multi-select':
      // Stored values are strings: multiple choices travel comma separated.
      return { ...base, type: 'text', helpText: t('settings.indexers.definitionFields.commaSeparatedChoicesMap', { map: (f.options ?? []).map((o) => o.value).join(', ') }) };
    default:
      return { ...base, type: 'text' };
  }
}

/** Editor fields for a definition indexer. */
export function definitionFields(def: IndexerDefinitionSummary, proxies: readonly IndexerProxy[] = []): FieldDefinition[] {
  const fields: FieldDefinition[] = [
    { name: 'name', label: t('common.name'), type: 'text', required: true },
    { name: 'enableRss', label: t('settings.indexers.definitionFields.enableRss'), type: 'checkbox' },
    { name: 'enableAutomaticSearch', label: t('settings.indexers.definitionFields.enableAutomaticSearch'), type: 'checkbox' },
    { name: 'enableInteractiveSearch', label: t('settings.indexers.definitionFields.enableInteractiveSearch'), type: 'checkbox' },
  ];
  if (def.links.length > 1) {
    fields.push({
      name: 'settings.baseUrl',
      label: t('settings.indexers.definitionFields.siteLink'),
      type: 'select',
      options: def.links.map((l) => ({ value: l, label: l })),
      helpText: t('settings.indexers.definitionFields.mirrorToUse'),
    });
  }
  fields.push(...def.settingsFields.filter((f) => !f.informational).map(settingField));
  fields.push(
    {
      name: 'proxyId',
      label: t('settings.indexers.definitionFields.proxy'),
      type: 'select',
      options: [{ value: '', label: t('settings.indexers.definitionFields.byTagAutomatic') }, ...proxies.map((p) => ({ value: p.id, label: `${p.name} (${p.type})` }))],
      helpText: t('settings.indexers.definitionFields.withoutAnExplicitProxyProxies'),
    },
    { name: 'settings.categories', label: t('common.categories'), type: 'multiSelect',
      advanced: true,
      options: def.categories.map((c) => ({ value: c.id, label: `${c.name} (${c.id})` })),
      helpText: t('settings.indexers.definitionFields.emptySearchesEveryCategoryThe'),
    },
    { name: 'settings.minimumSeeders', label: t('settings.indexers.definitionFields.minimumSeeders'), type: 'number', min: 0, advanced: true },
    { name: 'settings.seedRatio', label: t('settings.indexers.definitionFields.seedRatio'), type: 'number', min: 0, advanced: true },
    { name: 'settings.seedTime', label: t('settings.indexers.definitionFields.seedTime'), type: 'number', min: 0, unit: 'min', scale: 60_000, advanced: true },
    { name: 'settings.rateLimitSeconds', label: t('settings.indexers.definitionFields.rateLimit'), type: 'number', min: 0, unit: 's', advanced: true },
    {
      name: 'priority',
      label: t('common.priority'),
      type: 'number',
      min: INDEXER_PRIORITY_MIN,
      max: INDEXER_PRIORITY_MAX,
      default: INDEXER_PRIORITY_DEFAULT,
      required: true,
      advanced: true,
    },
    { name: 'tags', label: t('common.tags'), type: 'text', advanced: true },
  );
  return fields;
}

/** Start values for a new indexer from a definition. */
export function definitionBase(def: IndexerDefinitionSummary): FormValues {
  const fields: Record<string, DefinitionFieldValue> = {};
  for (const f of def.settingsFields) {
    if (f.informational || f.default === undefined) continue;
    fields[f.name] = f.type === 'checkbox' ? truthy(f.default) : f.default;
  }
  return {
    name: def.name,
    implementation: 'definition',
    enableRss: true,
    enableAutomaticSearch: true,
    enableInteractiveSearch: true,
    priority: INDEXER_PRIORITY_DEFAULT,
    tags: [],
    proxyId: '',
    settings: { baseUrl: def.links[0] ?? '', apiPath: '', categories: [], animeCategories: [], definitionId: def.id, fields },
  };
}

/** Form values of a saved definition indexer (the proxy select uses '' for "by tag"). */
export function definitionValuesOf(indexer: Indexer): FormValues {
  return { ...indexer, proxyId: indexer.proxyId ?? '' } as unknown as FormValues;
}

/** Form values -> create/test body for a definition indexer. */
export function toDefinitionBody(values: FormValues, definitionId: string): IndexerCreate {
  const v = values as Record<string, unknown>;
  const s = (v['settings'] as Record<string, unknown> | undefined) ?? {};
  const fields: Record<string, DefinitionFieldValue> = {};
  for (const [k, val] of Object.entries((s['fields'] as Record<string, unknown> | undefined) ?? {})) {
    if (typeof val === 'string' || typeof val === 'boolean') fields[k] = val;
    else if (typeof val === 'number') fields[k] = String(val);
  }
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const settings: IndexerCreate['settings'] = {
    baseUrl: typeof s['baseUrl'] === 'string' ? s['baseUrl'] : '',
    apiPath: '',
    categories: Array.isArray(s['categories']) ? (s['categories'] as number[]) : [],
    animeCategories: [],
    definitionId,
    fields,
  };
  const minimumSeeders = num(s['minimumSeeders']);
  const seedRatio = num(s['seedRatio']);
  const seedTime = num(s['seedTime']);
  const rateLimitSeconds = num(s['rateLimitSeconds']);
  if (minimumSeeders !== undefined) settings.minimumSeeders = minimumSeeders;
  if (seedRatio !== undefined) settings.seedRatio = seedRatio;
  if (seedTime !== undefined) settings.seedTime = seedTime;
  if (rateLimitSeconds !== undefined) settings.rateLimitSeconds = rateLimitSeconds;
  const proxy = v['proxyId'];
  return {
    name: String(v['name'] ?? ''),
    implementation: 'definition',
    enableRss: v['enableRss'] !== false,
    enableAutomaticSearch: v['enableAutomaticSearch'] !== false,
    enableInteractiveSearch: v['enableInteractiveSearch'] !== false,
    priority: num(v['priority']) ?? INDEXER_PRIORITY_DEFAULT,
    tags: Array.isArray(v['tags']) ? (v['tags'] as number[]) : [],
    proxyId: typeof proxy === 'number' ? proxy : typeof proxy === 'string' && /^\d+$/.test(proxy) ? Number(proxy) : null,
    settings,
  };
}

export interface CatalogueFilter {
  text: string;
  privacy: IndexerPrivacy | 'all';
  protocol: ReleaseProtocol | 'all';
  /** Language prefix, '' = any. */
  language: string;
}

export const EMPTY_CATALOGUE_FILTER: CatalogueFilter = { text: '', privacy: 'all', protocol: 'all', language: '' };

/** Client-side catalogue filter: every word must appear in id, name, description or language. */
export function filterDefinitions(list: readonly IndexerDefinitionSummary[], f: CatalogueFilter): IndexerDefinitionSummary[] {
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  const lang = f.language.toLowerCase();
  return list
    .filter((d) => {
      if (f.privacy !== 'all' && d.privacy !== f.privacy) return false;
      if (f.protocol !== 'all' && d.protocol !== f.protocol) return false;
      if (lang && !d.language.toLowerCase().startsWith(lang)) return false;
      const hay = `${d.id} ${d.name} ${d.description} ${d.language}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Distinct languages in the catalogue, for the language filter. */
export function catalogueLanguages(list: readonly IndexerDefinitionSummary[]): string[] {
  return [...new Set(list.map((d) => d.language).filter(Boolean))].sort();
}

/** Generic endpoint templates (Torznab / Newznab) matching the chooser's search text. */
export function filterTemplates(list: readonly IndexerTemplate[], text: string): IndexerTemplate[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return list
    .filter((item) => item.implementation !== 'definition')
    .filter((entry) => {
      const hay = `${entry.implementation} ${entry.implementationName} ${entry.protocol}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
}

/** The definition sits behind a browser challenge (`requiresFlareSolverr`, or an `info_flaresolverr` note). */
export function definitionNeedsSolver(def: Pick<IndexerDefinitionSummary, 'settingsFields'> & { requiresFlareSolverr?: boolean | undefined }): boolean {
  return def.requiresFlareSolverr === true || def.settingsFields.some((f) => f.type === 'info_flaresolverr');
}
