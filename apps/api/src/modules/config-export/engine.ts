import {
  ConfigDocument,
  type ConfigChange,
  type ConfigFieldChange,
  type ConfigImportResult,
  type ConfigIssue,
  type ConfigResourceKind,
} from '@arclight/shared';
import type { ZodError } from 'zod';
import type { Db } from '../../db/index.js';
import { tags as tagsTable } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  getSection,
  setSection,
  settingsSections,
  validateSection,
  type SettingsSection,
} from '../settings/service.js';
import { isSecretKey, maskSecrets, resolveMasks } from './secrets.js';
import { listTags, Refs, RESOURCE_KINDS, type EntryRef, type RefKind, type ResourceKindDef } from './resources.js';
import { settingsToIds, settingsToNames } from './settings-refs.js';

// Config as code: the exporter turns settings + resources into one document keyed by stable
// names; the importer plans a document against the database (diff), and applies the plan in
// one transaction. Dry runs, the API import, the managed config file and validation all go
// through planImport.

/** Settings keys that describe this install's state rather than its configuration. */
const VOLATILE_SETTINGS: Partial<Record<SettingsSection, readonly string[]>> = {
  security: ['setupComplete', 'setupCompletedAt'],
};

const REF_KINDS: ReadonlySet<string> = new Set<RefKind>([
  'tags',
  'customFormats',
  'qualityProfiles',
  'downloadClients',
  'indexerProxies',
  'indexers',
  'languageProfiles',
]);

const KNOWN_TOP_LEVEL = new Set(['version', 'prune', 'settings', 'tags', ...RESOURCE_KINDS.map((k) => k.kind)]);

// ---------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------

export interface ExportOptions {
  includeSecrets?: boolean;
}

/** A stored section as the document shows it: install state dropped, ids replaced by names. */
function settingsValue(db: Db, section: SettingsSection, refs: Refs): Record<string, unknown> {
  const value = { ...(getSection(db, section) as Record<string, unknown>) };
  for (const key of VOLATILE_SETTINGS[section] ?? []) delete value[key];
  return settingsToNames(section, value, refs);
}

/** The whole configuration as one document (secrets masked unless `includeSecrets`). */
export function buildDocument(db: Db, opts: ExportOptions = {}): Record<string, unknown> {
  const refs = new Refs(db);
  const settings: Record<string, unknown> = {};
  for (const section of settingsSections()) settings[section] = settingsValue(db, section, refs);
  const doc: Record<string, unknown> = { version: 1, settings, tags: listTags(db).map((t) => t.label) };
  for (const kind of RESOURCE_KINDS) {
    doc[kind.kind] = Object.fromEntries(kind.list(db, refs).map((item) => [item.key, item.entry]));
  }
  return opts.includeSecrets ? doc : maskSecrets(doc);
}

// ---------------------------------------------------------------------------------------
// diff helpers
// ---------------------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with sorted keys, so key order never counts as a change. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    isPlainObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}

function maskedLeaf(path: string, value: unknown): unknown {
  const secret = path.split(/[.[\]]/).some((seg) => seg !== '' && isSecretKey(seg));
  if (secret && typeof value === 'string' && value !== '') return '********';
  return maskSecrets(value);
}

/** Changed leaves between two values (objects recurse; arrays and scalars compare whole). */
export function diffValues(before: unknown, after: unknown, path = ''): ConfigFieldChange[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffValues(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (stableJson(before) === stableJson(after)) return [];
  return [{ path, before: maskedLeaf(path, before ?? null), after: maskedLeaf(path, after ?? null) }];
}

function zodIssues(prefix: string, err: ZodError): ConfigIssue[] {
  return err.issues.map((i) => ({
    path: [prefix, ...i.path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p)))].join('.').replace(/\.\[/g, '['),
    message: i.message,
  }));
}

// ---------------------------------------------------------------------------------------
// plan / apply
// ---------------------------------------------------------------------------------------

export type ImportMode = 'normal' | 'managed';

export interface ImportOptions {
  dryRun?: boolean;
  /** Overrides the document's own `prune`. */
  prune?: boolean;
  mode?: ImportMode;
  now?: string;
}

/** What a managed (config file) import owns: settings keys per section and resource keys per kind. */
export interface ManagedKeys {
  settings: Record<string, string[]>;
  resources: Record<string, string[]>;
}

export interface ImportOutcome extends ConfigImportResult {
  managed: ManagedKeys;
  /** Settings sections the apply changed (callers publish `settings` events for them). */
  changedSections: string[];
}

type Write = (db: Db, refs: Refs, now: string) => void;

interface ResourcePlan {
  def: ResourceKindDef;
  upserts: Write[];
  deletes: Write[];
}

/** Parse YAML/JSON text or take an object; returns the raw document. */
export function planImport(db: Db, raw: unknown, opts: ImportOptions = {}): { outcome: ImportOutcome; apply: () => void } {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const changes: ConfigChange[] = [];
  const managed: ManagedKeys = { settings: {}, resources: {} };
  const changedSections: string[] = [];
  let unchanged = 0;

  const parsed = ConfigDocument.safeParse(raw);
  const finish = (applyFn: () => void) => {
    const summary = { create: 0, update: 0, delete: 0, unchanged };
    for (const c of changes) summary[c.op]++;
    const outcome: ImportOutcome = {
      dryRun: opts.dryRun ?? false,
      applied: false,
      changes,
      summary,
      errors,
      warnings,
      managed,
      changedSections,
    };
    return { outcome, apply: applyFn };
  };
  if (!parsed.success) {
    errors.push(...zodIssues('', parsed.error).map((i) => ({ ...i, path: i.path.replace(/^\./, '') || '(document)' })));
    return finish(() => undefined);
  }
  const doc = parsed.data as ConfigDocument & Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!KNOWN_TOP_LEVEL.has(key)) warnings.push({ path: key, message: 'unknown top-level key ignored' });
  }
  const prune = opts.prune ?? doc.prune ?? false;
  const settingsWrites: Array<{ section: SettingsSection; value: Record<string, unknown> }> = [];
  const refs = new Refs(db);
  const docNames = new Map<string, Set<string>>();
  for (const def of RESOURCE_KINDS) {
    const coll = doc[def.kind];
    if (coll && isPlainObject(coll) && REF_KINDS.has(def.kind)) docNames.set(def.kind, new Set(Object.keys(coll)));
  }
  docNames.set('tags', new Set(doc.tags ?? []));
  const referencedTags = new Map<string, string>(); // label -> first path
  const recordedRefs: Array<EntryRef & { path: string }> = [];

  // Names that only exist in this document get stand-in ids while planning (validation needs
  // numbers); the apply step resolves them again once the resources are written.
  const placeholders = new Map<number, string>();
  const pending = (kind: RefKind, name: string): number | null => {
    if (kind !== 'tags' && !docNames.get(kind)?.has(name)) return null;
    const id = 1_000_000_000 + placeholders.size;
    placeholders.set(id, name);
    return id;
  };

  // ---- settings ----------------------------------------------------------------------
  const known = new Set<string>(settingsSections());
  for (const [section, incoming] of Object.entries(doc.settings ?? {})) {
    const path = `settings.${section}`;
    if (!known.has(section)) {
      errors.push({ path, message: 'unknown settings section' });
      continue;
    }
    const s = section as SettingsSection;
    const stored = getSection(db, s) as Record<string, unknown>;
    const current = settingsToNames(s, stored, refs);
    const resolved = resolveMasks(incoming, current, (p) =>
      warnings.push({ path: `${path}.${p}`, message: 'masked secret has no stored value; left unset' }),
    ) as Record<string, unknown>;
    const merged = { ...current, ...resolved };
    const withIds = settingsToIds(s, merged, refs, {
      pending,
      onRef: (kind, name, at) => {
        if (kind === 'tags') {
          if (!referencedTags.has(name)) referencedTags.set(name, at);
        } else recordedRefs.push({ kind, name, field: at, path: at });
      },
      onUnknown: (kind, name, at) => errors.push({ path: at, message: `unknown ${kind} "${name}"` }),
    });
    const valid = validateSection(s, withIds);
    if (!valid.ok) {
      errors.push({ path, message: valid.error });
      continue;
    }
    for (const key of Object.keys(resolved)) {
      if (!(key in valid.value)) warnings.push({ path: `${path}.${key}`, message: 'unknown settings key ignored' });
    }
    managed.settings[section] = Object.keys(incoming).filter((k) => k in valid.value);
    const after = settingsToNames(s, valid.value, refs);
    const fields = diffValues(current, after).map((f) => ({
      ...f,
      after: typeof f.after === 'number' && placeholders.has(f.after) ? placeholders.get(f.after) : f.after,
    }));
    if (fields.length === 0) {
      unchanged++;
      continue;
    }
    changes.push({ kind: 'settings', key: section, op: 'update', fields });
    settingsWrites.push({ section: s, value: merged });
    changedSections.push(section);
  }

  // ---- resources ---------------------------------------------------------------------
  const deletedNames = new Map<string, Set<string>>();
  const plans: ResourcePlan[] = [];

  for (const def of RESOURCE_KINDS) {
    const coll = doc[def.kind as ConfigResourceKind];
    if (coll === undefined) continue;
    const plan: ResourcePlan = { def, upserts: [], deletes: [] };
    plans.push(plan);
    const existing = new Map(def.list(db, refs).map((item) => [item.key, item]));
    const seen = new Set<string>();
    managed.resources[def.kind] = [];

    for (const [docKey, rawEntry] of Object.entries(coll as Record<string, unknown>)) {
      const path = `${def.kind}.${docKey}`;
      const first = def.schema.safeParse(rawEntry ?? {});
      if (!first.success) {
        errors.push(...zodIssues(path, first.error));
        continue;
      }
      const key = def.keyOf ? def.keyOf(first.data, docKey) : docKey;
      if (seen.has(key)) {
        errors.push({ path, message: `duplicate key "${key}"` });
        continue;
      }
      seen.add(key);
      managed.resources[def.kind]!.push(key);
      const current = existing.get(key);
      const resolved = resolveMasks(first.data, current?.entry, (p) =>
        warnings.push({ path: `${path}.${p}`, message: 'masked secret has no stored value; left unset' }),
      );
      const second = def.schema.safeParse(resolved);
      if (!second.success) {
        errors.push(...zodIssues(path, second.error));
        continue;
      }
      const entry: unknown = second.data;
      for (const c of def.check?.(entry) ?? []) {
        (c.level === 'error' ? errors : warnings).push({ path: `${path}.${c.field}`, message: c.message });
      }
      for (const ref of def.refsOf(entry)) {
        const refPath = `${path}.${ref.field}`;
        if (ref.kind === 'tags') {
          if (!referencedTags.has(ref.name)) referencedTags.set(ref.name, refPath);
          continue;
        }
        recordedRefs.push({ ...ref, path: refPath });
        if (!refs.has(ref.kind, ref.name) && !docNames.get(ref.kind)?.has(ref.name)) {
          errors.push({ path: refPath, message: `unknown ${ref.kind} "${ref.name}"` });
        }
      }
      if (!current) {
        changes.push({ kind: def.kind, key, op: 'create' });
        plan.upserts.push((tx, r, now) => def.insert(tx, key, entry, r, now));
        continue;
      }
      const fields = diffValues(current.entry, entry);
      if (fields.length === 0) {
        unchanged++;
        continue;
      }
      changes.push({ kind: def.kind, key, op: 'update', fields });
      const id = current.id;
      plan.upserts.push((tx, r, now) => def.update(tx, id, key, entry, r, now));
    }

    if (prune) {
      for (const [key, item] of existing) {
        if (seen.has(key)) continue;
        changes.push({ kind: def.kind, key, op: 'delete' });
        if (REF_KINDS.has(def.kind)) {
          let set = deletedNames.get(def.kind);
          if (!set) deletedNames.set(def.kind, (set = new Set()));
          set.add(key);
        }
        plan.deletes.push((tx) => def.remove(tx, item.id));
      }
    }
  }

  for (const ref of recordedRefs) {
    if (deletedNames.get(ref.kind)?.has(ref.name) && !docNames.get(ref.kind)?.has(ref.name)) {
      errors.push({ path: ref.path, message: `${ref.kind} "${ref.name}" would be pruned but is still referenced` });
    }
  }

  // ---- tags (explicit list + every label referenced anywhere) ------------------------
  const existingTags = listTags(db);
  const existingLabels = new Set(existingTags.map((t) => t.label));
  const wantedLabels = new Set<string>([...(doc.tags ?? []), ...referencedTags.keys()]);
  const tagCreates = [...wantedLabels].filter((l) => !existingLabels.has(l));
  for (const label of tagCreates) changes.push({ kind: 'tags', key: label, op: 'create' });
  if (doc.tags) {
    managed.resources['tags'] = [...doc.tags];
    unchanged += doc.tags.filter((l) => existingLabels.has(l)).length;
  }
  const tagDeletes = prune && doc.tags ? existingTags.filter((t) => !wantedLabels.has(t.label)) : [];
  for (const t of tagDeletes) {
    changes.push({ kind: 'tags', key: t.label, op: 'delete' });
    warnings.push({ path: `tags.${t.label}`, message: 'pruned tag is removed; items still carrying its id lose it' });
  }

  const apply = () => {
    const now = opts.now ?? new Date().toISOString();
    db.transaction((tx) => {
      // The transaction handle has the same query-builder surface as Db.
      const t = tx as unknown as Db;
      for (const label of tagCreates) t.insert(tagsTable).values({ label }).run();
      const r = new Refs(t);
      for (const plan of plans) {
        for (const write of plan.upserts) write(t, r, now);
        if (REF_KINDS.has(plan.def.kind)) r.invalidate(plan.def.kind as RefKind);
      }
      // Settings last: their references may name resources written just above.
      for (const w of settingsWrites) {
        const valid = validateSection(w.section, settingsToIds(w.section, w.value, r));
        if (!valid.ok) throw new Error(`settings.${w.section}: ${valid.error}`);
        setSection(t, w.section, valid.value as never, now);
      }
      for (const plan of [...plans].reverse()) for (const del of plan.deletes) del(t, r, now);
      for (const tag of tagDeletes) t.delete(tagsTable).where(eq(tagsTable.id, tag.id)).run();
    });
  };

  return finish(apply);
}

/** Plan and (unless dry run or invalid) apply. */
export function importDocument(db: Db, raw: unknown, opts: ImportOptions = {}): ImportOutcome {
  const { outcome, apply } = planImport(db, raw, opts);
  if (opts.dryRun || outcome.errors.length > 0) return outcome;
  try {
    apply();
    outcome.applied = true;
  } catch (err) {
    outcome.errors.push({ path: '(apply)', message: err instanceof Error ? err.message : String(err) });
    outcome.changedSections = [];
  }
  return outcome;
}
