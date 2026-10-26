import { readFileSync, existsSync } from 'node:fs';

// Parsers for the upstream config files the importer needs a few values from. Each is a
// small subset parser written for the files these apps generate (no new dependency):
// - arr `config.xml`: a flat `<Config><Key>value</Key>...</Config>`
// - Bazarr `config.yaml` (PyYAML dump: nested maps, block lists, inline lists, quoted scalars)
// - Bazarr `config.ini` (older releases)
// - Seerr `settings.json`

export type ConfigTree = { [key: string]: ConfigValue };
export type ConfigValue = string | number | boolean | null | ConfigValue[] | ConfigTree;

export function readTextFile(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** `config.xml` → lower-cased key → text value. */
export function parseArrConfigXml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<([A-Za-z][\w]*)>([^<]*)<\/\1>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const key = m[1];
    if (key && key.toLowerCase() !== 'config') out[key.toLowerCase()] = decodeXml(m[2] ?? '');
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// ---- YAML subset ---------------------------------------------------------------------------

interface Line {
  indent: number;
  text: string;
}

function scalar(raw: string): ConfigValue {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s === 'true' || s === 'True') return true;
  if (s === 'false' || s === 'False') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitInline(inner).map(scalar);
  }
  if (s === '{}') return {};
  return s;
}

function splitInline(s: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Index of the `key: value` colon outside quotes, or -1. */
function keyColon(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function unquoteKey(k: string): string {
  const s = k.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
  return s;
}

export function parseSimpleYaml(text: string): ConfigTree {
  const lines: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(raw) || raw.trim() === '---') continue;
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, text: raw.trim() });
  }
  let pos = 0;

  function parseBlock(indent: number): ConfigValue {
    const first = lines[pos];
    if (!first) return null;
    if (first.text.startsWith('- ') || first.text === '-') return parseList(first.indent);
    return parseMap(indent);
  }

  function parseList(indent: number): ConfigValue[] {
    const out: ConfigValue[] = [];
    while (pos < lines.length) {
      const line = lines[pos]!;
      if (line.indent !== indent || !(line.text.startsWith('- ') || line.text === '-')) break;
      pos++;
      const rest = line.text === '-' ? '' : line.text.slice(2);
      if (rest === '') {
        const next = lines[pos];
        out.push(next && next.indent > indent ? parseBlock(next.indent) : null);
      } else if (keyColon(rest) > 0) {
        // `- key: value` starts an inline map item; following deeper lines belong to it.
        const synthetic: Line = { indent: indent + 2, text: rest };
        lines.splice(pos, 0, synthetic);
        out.push(parseMap(indent + 2));
      } else out.push(scalar(rest));
    }
    return out;
  }

  function parseMap(indent: number): ConfigTree {
    const out: ConfigTree = {};
    while (pos < lines.length) {
      const line = lines[pos]!;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        pos++; // stray deeper line; ignore
        continue;
      }
      const colon = keyColon(line.text);
      if (colon <= 0) break;
      pos++;
      const key = unquoteKey(line.text.slice(0, colon));
      const rest = line.text.slice(colon + 1).trim();
      if (rest !== '') {
        out[key] = scalar(rest);
        continue;
      }
      const next = lines[pos];
      if (next && (next.indent > indent || (next.indent === indent && (next.text.startsWith('- ') || next.text === '-')))) {
        out[key] = parseBlock(next.indent);
      } else out[key] = null;
    }
    return out;
  }

  const result = parseBlock(lines[0]?.indent ?? 0);
  return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
}

// ---- INI -----------------------------------------------------------------------------------

export function parseIni(text: string): ConfigTree {
  const out: ConfigTree = {};
  let section: ConfigTree = out;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.+)]$/.exec(line);
    if (header?.[1]) {
      section = {};
      out[header[1].trim()] = section;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    // Bazarr stores lists as Python reprs: ['a', 'b'].
    section[key] = value.startsWith('[') ? scalar(value) : scalar(value.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

export function parseJsonConfig(text: string): ConfigTree {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ConfigTree) : {};
  } catch {
    return {};
  }
}

/** Child map of a config tree, or `{}`. */
export function section(tree: ConfigTree | null | undefined, key: string): ConfigTree {
  const v = tree?.[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
