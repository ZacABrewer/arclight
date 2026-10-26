import type { Definition } from '@arclight/indexers';
import type { DefinitionFieldValue } from '@arclight/shared';
import { DefinitionStore } from '../../indexers/definitions.js';
import { indexersServiceFor } from '../../indexers/index.js';
import { IndexersService } from '../../indexers/service.js';
import type { AreaEnv } from '../areas.js';
import type { DefinitionRef, MigrateDeps } from '../deps.js';
import { bool, field, str } from '../foreign-db.js';

// Matching Prowlarr indexers to Arclight's indexer definitions, and translating the values a
// Prowlarr indexer stores (Cardigann `extraFieldData`, or a native indexer's settings) into the
// definition's setting names and value types. Prowlarr keeps a select as the option's index;
// Arclight keeps the option key.

let fallbackStore: DefinitionStore | null = null;

/** The app's definition store (built-in, feed, custom, community), or the built-in one alone. */
export function definitionStore(deps: Pick<MigrateDeps, 'ctx'>): DefinitionStore {
  if (deps.ctx) return indexersServiceFor(deps.ctx).definitions;
  fallbackStore ??= new DefinitionStore();
  return fallbackStore;
}

/** Waits for the store's first load (definitions load asynchronously). */
export async function definitionsReady(deps: Pick<MigrateDeps, 'ctx'>): Promise<void> {
  try {
    await definitionStore(deps).ready();
  } catch {
    // A broken custom folder must not stop an import; unknown definitions fall back to proxying.
  }
}

const serviceCache = new WeakMap<object, IndexersService>();

/**
 * An IndexersService on the area's database (the import's transaction) that knows every loaded
 * definition, so definition indexers validate against the same catalogue they were matched in.
 * The shared store is wrapped so the short-lived service does not register a reload listener on
 * it (that would leak one per import area).
 */
export function indexerServiceFor(env: Pick<AreaEnv, 'db' | 'log' | 'deps' | 'services'>): IndexersService {
  let service = serviceCache.get(env.services);
  if (!service) {
    const shared = definitionStore(env.deps);
    const quiet = Object.create(shared, { addReloadListener: { value: () => () => undefined } }) as DefinitionStore;
    service = new IndexersService({ db: env.db, log: env.log, definitions: quiet });
    serviceCache.set(env.services, service);
  }
  return service;
}

export interface DefinitionMatch {
  ref: DefinitionRef;
  def: Definition | undefined;
}

/** First candidate id Arclight has a definition for (case-insensitive). */
export function matchDefinition(deps: Pick<MigrateDeps, 'ctx' | 'findDefinition'>, candidates: ReadonlyArray<string | null | undefined>): DefinitionMatch | null {
  const store = definitionStore(deps);
  for (const raw of candidates) {
    const id = raw?.trim();
    if (!id) continue;
    let ref: DefinitionRef | null = null;
    if (deps.findDefinition) ref = deps.findDefinition(id);
    else {
      const summary = store.list().find((d) => d.id.toLowerCase() === id.toLowerCase());
      if (summary) ref = { id: summary.id, name: summary.name, privacy: summary.privacy, settings: summary.settingsFields.map((s) => s.name), links: summary.links };
    }
    if (ref) return { ref, def: store.get(ref.id) };
  }
  return null;
}

/** Keys of Prowlarr's indexer settings that are not definition settings. */
const BASE_KEYS = new Set(['definitionfile', 'extrafielddata', 'baseurl', 'basesettings', 'torrentbasesettings', 'apipath', 'categories', 'animecategories', 'additionalparameters']);

function optionKey(options: Record<string, unknown> | undefined, value: unknown): string | null {
  if (!options) return str(value);
  const keys = Object.keys(options);
  if (typeof value === 'number' && Number.isInteger(value)) return keys[value] ?? null;
  const s = str(value);
  if (s === null) return null;
  if (keys.includes(s)) return s;
  if (/^\d+$/.test(s) && keys[Number(s)] !== undefined) return keys[Number(s)]!;
  const byValue = keys.find((k) => String(options[k]).toLowerCase() === s.toLowerCase());
  return byValue ?? null;
}

export interface TranslatedFields {
  fields: Record<string, DefinitionFieldValue>;
  /** Setting names whose values could not be translated. */
  dropped: string[];
}

/**
 * Prowlarr setting values → the definition's fields. `settings` is the indexer's settings
 * object (DB JSON or rebuilt from the API's fields); values come from `extraFieldData` first,
 * then from top-level keys that are not Prowlarr's own.
 */
export function translateFields(match: DefinitionMatch, settings: Record<string, unknown>): TranslatedFields {
  const values = new Map<string, unknown>();
  for (const [k, v] of Object.entries(settings)) if (!BASE_KEYS.has(k.toLowerCase())) values.set(k.toLowerCase(), v);
  const extra = field(settings, 'extraFieldData');
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) for (const [k, v] of Object.entries(extra as Record<string, unknown>)) values.set(k.toLowerCase(), v);

  const fields: Record<string, DefinitionFieldValue> = {};
  const dropped: string[] = [];
  const specs = match.def?.settings ?? match.ref.settings.map((name) => ({ name, type: 'text' as const, options: undefined }));
  for (const s of specs) {
    if (s.type.startsWith('info') || s.type === 'cardigannCaptcha') continue;
    const raw = values.get(s.name.toLowerCase());
    if (raw === undefined || raw === null || raw === '') continue;
    const options = 'options' in s ? (s.options as Record<string, unknown> | undefined) : undefined;
    switch (s.type) {
      case 'checkbox':
        fields[s.name] = bool(raw);
        break;
      case 'select': {
        const key = optionKey(options, raw);
        if (key === null) dropped.push(s.name);
        else fields[s.name] = key;
        break;
      }
      case 'multi-select': {
        const list = Array.isArray(raw) ? raw : String(raw).split(',');
        const keys = list.map((v) => optionKey(options, typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v)).filter((k): k is string => k !== null);
        if (keys.length > 0) fields[s.name] = keys.join(',');
        break;
      }
      default: {
        const text = typeof raw === 'object' ? null : str(raw);
        if (text === null) dropped.push(s.name);
        else fields[s.name] = text;
      }
    }
  }
  return { fields, dropped };
}
