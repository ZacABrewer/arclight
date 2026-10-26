/**
 * JSONPath-lite for `type: json` responses (spec S5.4): dotted paths (`data.items`,
 * `files[0].name`, `[-1]`), wildcards (`[*]`, `.*`), recursive descent (`..key`), an
 * optional leading `$`/`.`, and on row selectors the suffix filters `:has(p)`, `:not(p)`,
 * `:contains(text)`.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type Step = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wild' } | { kind: 'descend'; key: string | null };

const pathCache = new Map<string, Step[]>();

function parsePath(path: string): Step[] {
  const cached = pathCache.get(path);
  if (cached) return cached;
  const steps: Step[] = [];
  let p = path.trim();
  if (p.startsWith('$')) p = p.slice(1);
  let i = 0;
  if (p.startsWith('.') && !p.startsWith('..')) i = 1;
  const readKey = (): string => {
    let key = '';
    while (i < p.length && p[i] !== '.' && p[i] !== '[') key += p[i++];
    return key;
  };
  while (i < p.length) {
    const c = p[i];
    if (c === '.') {
      if (p[i + 1] === '.') {
        i += 2;
        if (p[i] === '[' || p[i] === '*') {
          steps.push({ kind: 'descend', key: null });
          if (p[i] === '*') i++;
          continue;
        }
        steps.push({ kind: 'descend', key: readKey() });
        continue;
      }
      i++;
      continue;
    }
    if (c === '[') {
      const end = p.indexOf(']', i);
      if (end < 0) throw new Error(`Unclosed [ in JSON path ${path}`);
      const inner = p.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === '*') steps.push({ kind: 'wild' });
      else if (/^-?\d+$/.test(inner)) steps.push({ kind: 'index', index: Number(inner) });
      else steps.push({ kind: 'key', key: inner.replace(/^['"]|['"]$/g, '') });
      continue;
    }
    const key = readKey();
    steps.push(key === '*' ? { kind: 'wild' } : { kind: 'key', key });
  }
  pathCache.set(path, steps);
  return steps;
}

function isObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function children(v: JsonValue): JsonValue[] {
  if (Array.isArray(v)) return v;
  if (isObject(v)) return Object.values(v);
  return [];
}

function descendants(v: JsonValue, out: JsonValue[]): void {
  out.push(v);
  for (const c of children(v)) descendants(c, out);
}

/** Every value the path selects (wildcards and descent can yield several). */
export function jsonQueryAll(root: JsonValue, path: string): JsonValue[] {
  let current: JsonValue[] = [root];
  for (const step of parsePath(path)) {
    const next: JsonValue[] = [];
    for (const v of current) {
      switch (step.kind) {
        case 'key':
          if (isObject(v) && step.key in v) next.push(v[step.key] as JsonValue);
          else if (Array.isArray(v) && /^\d+$/.test(step.key) && Number(step.key) < v.length) next.push(v[Number(step.key)] as JsonValue);
          break;
        case 'index':
          if (Array.isArray(v)) {
            const idx = step.index < 0 ? v.length + step.index : step.index;
            if (idx >= 0 && idx < v.length) next.push(v[idx] as JsonValue);
          }
          break;
        case 'wild':
          next.push(...children(v));
          break;
        case 'descend': {
          const all: JsonValue[] = [];
          descendants(v, all);
          if (step.key === null) next.push(...all.slice(1));
          else for (const d of all) if (isObject(d) && step.key in d) next.push(d[step.key] as JsonValue);
          break;
        }
      }
    }
    current = next;
  }
  return current;
}

/** First selected value, or undefined. Wildcard results are returned as an array. */
export function jsonQuery(root: JsonValue, path: string): JsonValue | undefined {
  if (path.trim() === '' || path.trim() === '$' || path.trim() === '.') return root;
  const steps = parsePath(path);
  const results = jsonQueryAll(root, path);
  const multi = steps.some((s) => s.kind === 'wild' || s.kind === 'descend');
  if (multi && steps[steps.length - 1]?.kind === 'wild') return results;
  return results[0];
}

/** S5.4 value-to-string rules. null/undefined -> null. */
export function jsonToString(value: JsonValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => jsonToString(v) ?? '').join(',');
  return JSON.stringify(value);
}

interface RowFilter {
  kind: 'has' | 'not' | 'contains';
  arg: string;
}

/** Split `path:has(a):not(b)` into the base path and its filters (balanced parentheses). */
export function splitRowSelector(selector: string): { path: string; filters: RowFilter[] } {
  const filters: RowFilter[] = [];
  const first = selector.search(/:(has|not|contains)\(/);
  if (first < 0) return { path: selector, filters };
  const path = selector.slice(0, first);
  let i = first;
  while (i < selector.length) {
    const m = /^:(has|not|contains)\(/.exec(selector.slice(i));
    if (!m) break;
    let depth = 1;
    let j = i + m[0].length;
    const start = j;
    while (j < selector.length && depth > 0) {
      if (selector[j] === '(') depth++;
      else if (selector[j] === ')') depth--;
      j++;
    }
    filters.push({ kind: m[1] as RowFilter['kind'], arg: selector.slice(start, j - 1) });
    i = j;
  }
  return { path, filters };
}

function rowPasses(row: JsonValue, filter: RowFilter): boolean {
  if (filter.kind === 'contains') return JSON.stringify(row).includes(filter.arg);
  const { path, filters } = splitRowSelector(filter.arg);
  const found = jsonQueryAll(row, path).filter((v) => v !== null && filters.every((f) => rowPasses(v, f)));
  return filter.kind === 'has' ? found.length > 0 : found.length === 0;
}

/**
 * Evaluate a rows selector: the path must lead to an array (or an object whose values are
 * rows is NOT accepted here; use `rows.multiple`). Returns undefined when it is not an array.
 */
export function jsonSelectRows(root: JsonValue, selector: string): JsonValue[] | undefined {
  const { path, filters } = splitRowSelector(selector);
  const target = jsonQuery(root, path);
  if (!Array.isArray(target)) return undefined;
  return filters.length === 0 ? target : target.filter((row) => filters.every((f) => rowPasses(row, f)));
}
