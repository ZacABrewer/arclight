import { watch, type FSWatcher } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import {
  BUILTIN_DEFINITIONS_DIR,
  buildCategoryMap,
  DefinitionCatalogue,
  DefinitionError,
  parseDefinitionYaml,
  synthesizeCaps,
  type Definition,
  type SettingDefinition,
} from '@arclight/indexers';
import type {
  DefinitionFieldValue,
  DefinitionLoadError,
  DefinitionSettingField,
  IndexerDefinitionDetail,
  IndexerDefinitionListQuery,
  IndexerDefinitionReloadResult,
  IndexerDefinitionSummary,
} from '@arclight/shared';

// The definition catalogue as the api serves it, in three layers that override by id:
// definitions bundled with @arclight/indexers, then the definition feed's downloads in
// `<config>/definitions/feed` (see definition-feed.ts), then user YAML files in
// `<config>/definitions`. The user directory is watched (debounced) and can be reloaded on demand.

export type DefinitionSource = 'builtin' | 'feed' | 'custom';

export class DefinitionStoreError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION',
    message: string,
  ) {
    super(message);
    this.name = 'DefinitionStoreError';
  }
}

export interface DefinitionStoreOptions {
  /** User definitions directory (`<config>/definitions`); undefined = builtin only. */
  customDir?: string;
  /** Builtin directory; defaults to the package's bundled definitions. */
  builtinDir?: string;
  /** Definition feed directory (`<config>/definitions/feed`); loaded between builtin and custom. */
  feedDir?: string;
  log?: Logger;
  /** Watch `customDir` and reload on change. Default false. */
  watch?: boolean;
}

const ID_PATTERN = /^[a-z0-9._-]+$/;

export class DefinitionStore {
  private catalogue = new DefinitionCatalogue();
  private sources = new Map<string, DefinitionSource>();
  private errors: DefinitionLoadError[] = [];
  private counts = { builtin: 0, feed: 0, custom: 0 };
  private loading: Promise<IndexerDefinitionReloadResult> | undefined;
  private loaded = false;
  private watcher: FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private readonly builtinDir: string;
  private readonly reloadListeners = new Set<() => void>();

  constructor(private readonly opts: DefinitionStoreOptions = {}) {
    this.builtinDir = opts.builtinDir ?? BUILTIN_DEFINITIONS_DIR;
  }

  get customDir(): string | undefined {
    return this.opts.customDir;
  }

  get feedDir(): string | undefined {
    return this.opts.feedDir;
  }

  /** Resolves once the first load finished (starting it if needed). */
  async ready(): Promise<void> {
    if (this.loaded) return;
    await (this.loading ?? this.reload());
  }

  /** Re-read both directories. Concurrent calls share one load. */
  reload(): Promise<IndexerDefinitionReloadResult> {
    if (this.loading) return this.loading;
    const run = this.load().finally(() => {
      this.loading = undefined;
    });
    this.loading = run;
    return run;
  }

  private async load(): Promise<IndexerDefinitionReloadResult> {
    const builtin = await DefinitionCatalogue.fromDirectories([this.builtinDir]);
    const feed = new DefinitionCatalogue();
    if (this.opts.feedDir) await feed.loadDirectory(this.opts.feedDir);
    const custom = new DefinitionCatalogue();
    if (this.opts.customDir) await custom.loadDirectory(this.opts.customDir);

    const merged = new DefinitionCatalogue();
    const sources = new Map<string, DefinitionSource>();
    for (const def of builtin.list()) {
      merged.add(def);
      sources.set(def.id, 'builtin');
    }
    for (const def of feed.list()) {
      merged.add(def);
      sources.set(def.id, 'feed');
    }
    for (const def of custom.list()) {
      merged.add(def);
      sources.set(def.id, 'custom');
    }
    this.catalogue = merged;
    this.sources = sources;
    this.counts = { builtin: builtin.size, feed: feed.size, custom: custom.size };
    this.errors = [...builtin.errors, ...feed.errors, ...custom.errors].map((e) => ({
      file: e.file,
      code: e.error.code,
      message: e.error.message,
    }));
    this.loaded = true;
    for (const e of this.errors) this.opts.log?.warn({ file: e.file, code: e.code }, `definition not loaded: ${e.message}`);
    this.opts.log?.info({ builtin: builtin.size, feed: feed.size, custom: custom.size }, 'indexer definitions loaded');
    for (const listener of this.reloadListeners) listener();
    return this.status();
  }

  /** Called after every (re)load, e.g. to drop cached indexer clients. Returns unsubscribe. */
  addReloadListener(listener: () => void): () => void {
    this.reloadListeners.add(listener);
    return () => this.reloadListeners.delete(listener);
  }

  status(): IndexerDefinitionReloadResult {
    return { total: this.catalogue.size, ...this.counts, errors: [...this.errors] };
  }

  /** Synchronous lookup; undefined before the first load or for unknown ids. */
  get(id: string): Definition | undefined {
    return this.catalogue.get(id);
  }

  source(id: string): DefinitionSource | undefined {
    return this.sources.get(id);
  }

  list(query: IndexerDefinitionListQuery = {}): IndexerDefinitionSummary[] {
    const q = query.query?.toLowerCase();
    const lang = query.language?.toLowerCase();
    return this.catalogue
      .list()
      .map((def) => this.summary(def))
      .filter(
        (s) =>
          (!query.privacy || s.privacy === query.privacy) &&
          (!query.protocol || s.protocol === query.protocol) &&
          (!lang || s.language.toLowerCase().startsWith(lang)) &&
          (!q || s.id.includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  detail(id: string): IndexerDefinitionDetail {
    const def = this.catalogue.get(id);
    if (!def) throw new DefinitionStoreError('NOT_FOUND', `definition "${id}" not found`);
    return {
      ...this.summary(def),
      searchModes: Object.keys(def.caps.modes).filter((m) => (def.caps.modes as Record<string, string[] | undefined>)[m] !== undefined),
      requiresLogin: def.login !== undefined,
      warnings: [...def.warnings],
    };
  }

  summary(def: Definition): IndexerDefinitionSummary {
    return toSummary(def, this.sources.get(def.id) ?? 'builtin');
  }

  /** Validate YAML, save it as `<customDir>/<id>.yml` and reload. */
  async upload(yaml: string): Promise<IndexerDefinitionDetail> {
    const dir = this.opts.customDir;
    if (!dir) throw new DefinitionStoreError('VALIDATION', 'custom definitions are not enabled');
    let def: Definition;
    try {
      def = parseDefinitionYaml(yaml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DefinitionStoreError('VALIDATION', `invalid definition: ${message}`);
    }
    if (!ID_PATTERN.test(def.id)) throw new DefinitionStoreError('VALIDATION', `invalid definition id "${def.id}"`);
    await mkdir(dir, { recursive: true });
    // A .yaml twin with the same id would make the catalogue order-dependent.
    await unlink(join(dir, `${def.id}.yaml`)).catch(() => undefined);
    await writeFile(join(dir, `${def.id}.yml`), yaml, 'utf8');
    await this.reload();
    return this.detail(def.id);
  }

  /** Delete a custom definition file (a bundled one with the same id becomes visible again). */
  async remove(id: string): Promise<void> {
    const dir = this.opts.customDir;
    if (!dir || this.sources.get(id) !== 'custom' || !ID_PATTERN.test(id)) {
      throw new DefinitionStoreError('NOT_FOUND', `custom definition "${id}" not found`);
    }
    let removed = false;
    for (const ext of ['.yml', '.yaml']) {
      try {
        await unlink(join(dir, `${id}${ext}`));
        removed = true;
      } catch {
        // not this extension
      }
    }
    if (!removed) throw new DefinitionStoreError('NOT_FOUND', `custom definition "${id}" not found`);
    await this.reload();
  }

  /** Start watching the custom directory (no-op without one or when `watch` is off). */
  async startWatching(): Promise<void> {
    const dir = this.opts.customDir;
    if (!this.opts.watch || !dir || this.watcher) return;
    try {
      await mkdir(dir, { recursive: true });
      this.watcher = watch(dir, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.reload().catch((err: unknown) => this.opts.log?.error({ err }, 'definition reload failed'));
        }, 500);
      });
      this.watcher.on('error', (err) => this.opts.log?.warn({ err }, 'definition watcher failed'));
    } catch (err) {
      this.opts.log?.warn({ err, dir }, 'cannot watch the definitions directory');
    }
  }

  stopWatching(): void {
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
  }
}

// ---- mapping ------------------------------------------------------------------------

const INFORMATIONAL = (type: string) => type.startsWith('info') || type === 'cardigannCaptcha';

export function settingField(s: SettingDefinition): DefinitionSettingField {
  const out: DefinitionSettingField = {
    name: s.name,
    type: s.type,
    label: s.label ?? s.name,
    informational: INFORMATIONAL(s.type),
  };
  const dflt = settingDefault(s);
  if (dflt !== undefined) out.default = dflt;
  if (s.options) out.options = Object.entries(s.options).map(([value, label]) => ({ value, label: String(label) }));
  return out;
}

/** The value a setting has when the user leaves it alone (checkbox → boolean, multi-select → comma list). */
export function settingDefault(s: SettingDefinition): DefinitionFieldValue | undefined {
  if (s.type === 'checkbox') {
    const raw = s.default;
    return raw === true || raw === 1 || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
  }
  if (s.type === 'multi-select') return s.defaults ? s.defaults.map(String).join(',') : undefined;
  if (s.default === undefined || s.default === null) return undefined;
  return String(s.default);
}

function privacyOf(def: Definition): IndexerDefinitionSummary['privacy'] {
  return def.type;
}

/** The definition parser lowercases keys, so the parsed flag is `requiresflaresolverr`. */
function requiresFlareSolverr(def: Definition): boolean {
  const flags = def as unknown as { requiresflaresolverr?: unknown; requiresFlareSolverr?: unknown };
  return flags.requiresflaresolverr === true || flags.requiresFlareSolverr === true;
}

export function toSummary(def: Definition, source: DefinitionSource): IndexerDefinitionSummary {
  const caps = synthesizeCaps(def, buildCategoryMap(def));
  const categories: IndexerDefinitionSummary['categories'] = [];
  for (const c of caps.categories) {
    categories.push({ id: c.id, name: c.name });
    for (const sub of c.subcats) categories.push({ id: sub.id, name: sub.name });
  }
  return {
    id: def.id,
    name: def.name,
    description: def.description ?? '',
    language: def.language ?? 'en-US',
    type: privacyOf(def),
    protocol: 'torrent',
    privacy: privacyOf(def),
    links: [...def.links],
    settingsFields: def.settings.map(settingField),
    categories,
    tested: def.tested === true,
    source,
    ...(requiresFlareSolverr(def) ? { requiresFlareSolverr: true } : {}),
  };
}

export { DefinitionError };
