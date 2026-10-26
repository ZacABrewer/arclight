/**
 * Loading YAML definitions from disk (spec S2.14): a bundled directory plus optional user
 * directories, later directories overriding earlier ones by `id`. Duplicate YAML keys are
 * preserved by renaming repeats to `<key>_<n>` (which the field mapper treats as the same
 * field, S10.1); YAML alias expansion is capped (S19.10).
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isScalar, parseDocument, visit } from 'yaml';
import { DefinitionError, parseDefinition, type Definition } from './schema.js';

const MAX_ALIAS_COUNT = 100;

/** Parse a YAML definition document. */
export function parseDefinitionYaml(text: string, options: { fileKey?: string } = {}): Definition {
  const doc = parseDocument(text, { uniqueKeys: false, prettyErrors: false });
  const firstError = doc.errors[0];
  if (firstError) throw new DefinitionError('invalid_yaml', `Invalid YAML: ${firstError.message}`);
  visit(doc, {
    Map(_key, map) {
      if (!isMap(map)) return;
      const counts = new Map<string, number>();
      for (const item of map.items) {
        if (!isScalar(item.key)) continue;
        const key = String(item.key.value);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        if (n > 1) item.key.value = `${key}_${n}`;
      }
    },
  });
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (err) {
    throw new DefinitionError('invalid_yaml', `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseDefinition(data, options);
}

export interface CatalogueError {
  file: string;
  error: DefinitionError;
}

/** In-memory definition index keyed by id, with a case-insensitive name lookup. */
export class DefinitionCatalogue {
  private readonly byId = new Map<string, Definition>();
  private readonly byName = new Map<string, string>();
  readonly errors: CatalogueError[] = [];

  add(def: Definition): void {
    const previous = this.byId.get(def.id);
    if (previous) this.byName.delete(previous.name.toLowerCase());
    this.byId.set(def.id, def);
    this.byName.set(def.name.toLowerCase(), def.id);
  }

  get(id: string): Definition | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Lookup by id first, then by display name (case-insensitive). */
  find(idOrName: string): Definition | undefined {
    const direct = this.byId.get(idOrName) ?? this.byId.get(idOrName.toLowerCase());
    if (direct) return direct;
    const id = this.byName.get(idOrName.toLowerCase());
    return id === undefined ? undefined : this.byId.get(id);
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  list(): Definition[] {
    return this.ids().map((id) => this.byId.get(id) as Definition);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Load every `.yml`/`.yaml` file in `dir` (non-recursive); broken files are recorded in `errors`. */
  async loadDirectory(dir: string): Promise<number> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    let loaded = 0;
    for (const name of names.sort()) {
      const ext = extname(name).toLowerCase();
      if (ext !== '.yml' && ext !== '.yaml') continue;
      const file = join(dir, name);
      try {
        const def = parseDefinitionYaml(await readFile(file, 'utf8'), { fileKey: basename(name, extname(name)) });
        this.add(def);
        loaded++;
      } catch (err) {
        const error =
          err instanceof DefinitionError ? err : new DefinitionError('invalid_value', err instanceof Error ? err.message : String(err));
        this.errors.push({ file, error });
      }
    }
    return loaded;
  }

  /** Build a catalogue from directories in order (later ones override by id). */
  static async fromDirectories(dirs: readonly string[]): Promise<DefinitionCatalogue> {
    const catalogue = new DefinitionCatalogue();
    for (const dir of dirs) await catalogue.loadDirectory(dir);
    return catalogue;
  }
}

/** Directory holding the definitions shipped with the package. */
export const BUILTIN_DEFINITIONS_DIR = fileURLToPath(new URL('./builtin/', import.meta.url));

/** Bundled definitions, optionally overridden by user directories. */
export function loadDefinitionCatalogue(userDirs: readonly string[] = []): Promise<DefinitionCatalogue> {
  return DefinitionCatalogue.fromDirectories([BUILTIN_DEFINITIONS_DIR, ...userDirs]);
}
