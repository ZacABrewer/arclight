/**
 * Field/keyword filters (spec S6). Each filter maps a string to a string; a null input
 * skips the whole chain. A filter that cannot produce a value throws `FilterError`, which
 * makes the field fail (required -> row skipped; optional -> default).
 */
import { decodeEntities, encodeEntities } from '../html/index.js';
import { parseFuzzyTime, parseGoLayout, parseTimeAgo, toIsoString, type DateContext } from './dates.js';
import { formDecode, formEncode } from './encoding.js';
import { jsonQuery, jsonToString, type JsonValue } from './jsonpath.js';
import { definitionRegex, regexReplace, renderTemplate, type TemplateVars } from './template.js';

export type FilterArgValue = string | number | boolean;
export type FilterArgs = FilterArgValue | readonly FilterArgValue[] | null | undefined;

export interface FilterSpec {
  name: string;
  args?: FilterArgs;
}

export interface FilterContext {
  vars: TemplateVars;
  encoding?: string;
  now: number;
  timeZone?: string;
  /** Debug sink for `hexdump`/`strdump` and soft failures. */
  log?: (message: string) => void;
}

export class FilterError extends Error {
  readonly code = 'filter_failed';
  constructor(
    readonly filter: string,
    message: string,
  ) {
    super(`Filter ${filter}: ${message}`);
    this.name = 'FilterError';
  }
}

export const SUPPORTED_FILTERS: ReadonlySet<string> = new Set([
  'querystring', 'regexp', 're_replace', 'replace', 'split', 'trim', 'trimprefix', 'trimsuffix', 'prepend', 'append',
  'tolower', 'toupper', 'urlencode', 'urldecode', 'htmlencode', 'htmldecode', 'base64encode', 'base64decode',
  'dateparse', 'timeparse', 'timeago', 'reltime', 'fuzzytime', 'validfilename', 'diacritics', 'jsonjoinarray',
  'validate', 'hexdump', 'strdump',
]);

function argList(args: FilterArgs): string[] {
  if (args === null || args === undefined) return [];
  if (Array.isArray(args)) return args.map((a) => String(a));
  return [String(args as FilterArgValue)];
}

function arg(args: string[], i: number, filter: string): string {
  const v = args[i];
  if (v === undefined) throw new FilterError(filter, `missing argument ${i + 1}`);
  return v;
}

const TOKEN_SPLIT = /[,\s/)(.;[\]"|:]+/;

function dateCtx(ctx: FilterContext, dayFirst = false): DateContext {
  return { now: ctx.now, ...(ctx.timeZone === undefined ? {} : { timeZone: ctx.timeZone }), dayFirst };
}

function base64UrlDecode(text: string): string {
  const std = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/** Apply one filter to a non-null value. */
export function applyFilter(value: string, filter: FilterSpec, ctx: FilterContext): string {
  const name = filter.name.toLowerCase();
  const args = argList(filter.args);
  const tpl = (s: string): string => renderTemplate(s, ctx.vars);
  switch (name) {
    case 'querystring': {
      const param = arg(args, 0, name);
      const q = value.indexOf('?');
      if (q < 0) throw new FilterError(name, `no query string in "${value}"`);
      const query = value.slice(q + 1).split('#')[0] ?? '';
      for (const part of query.split('&')) {
        const eq = part.indexOf('=');
        const k = eq < 0 ? part : part.slice(0, eq);
        if (formDecode(k, ctx.encoding) === param) return eq < 0 ? '' : formDecode(part.slice(eq + 1), ctx.encoding);
      }
      return '';
    }
    case 'regexp': {
      const m = definitionRegex(arg(args, 0, name)).exec(value);
      return m?.[1] ?? '';
    }
    case 're_replace':
      return regexReplace(value, arg(args, 0, name), tpl(args[1] ?? ''));
    case 'replace':
      return value.split(arg(args, 0, name)).join(tpl(args[1] ?? ''));
    case 'split': {
      const sep = arg(args, 0, name)[0] ?? ',';
      const index = Number(arg(args, 1, name));
      const parts = value.split(sep);
      const i = index < 0 ? parts.length + index : index;
      const part = parts[i];
      if (!Number.isInteger(i) || part === undefined) throw new FilterError(name, `index ${index} out of range`);
      return part;
    }
    case 'trim': {
      const chars = args[0];
      if (!chars) return value.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, '');
      const c = chars[0] ?? '';
      let start = 0;
      let end = value.length;
      while (start < end && value[start] === c) start++;
      while (end > start && value[end - 1] === c) end--;
      return value.slice(start, end);
    }
    case 'trimprefix': {
      const p = arg(args, 0, name);
      return value.startsWith(p) ? value.slice(p.length) : value;
    }
    case 'trimsuffix': {
      const p = arg(args, 0, name);
      return p && value.endsWith(p) ? value.slice(0, -p.length) : value;
    }
    case 'prepend':
      return tpl(args[0] ?? '') + value;
    case 'append':
      return value + tpl(args[0] ?? '');
    case 'tolower':
      return value.toLowerCase();
    case 'toupper':
      return value.toUpperCase();
    case 'urlencode':
      return formEncode(value, ctx.encoding);
    case 'urldecode':
      return formDecode(value, ctx.encoding);
    case 'htmlencode':
      return encodeEntities(value);
    case 'htmldecode':
      return decodeEntities(value);
    case 'base64encode':
      return Buffer.from(value, 'utf8').toString('base64url');
    case 'base64decode':
      return base64UrlDecode(value);
    case 'dateparse':
    case 'timeparse': {
      const layout = args[0];
      const parsed = layout ? parseGoLayout(value, layout, dateCtx(ctx)) : parseFuzzyTime(value, dateCtx(ctx));
      if (!parsed) {
        ctx.log?.(`dateparse: "${value}" does not match layout "${layout ?? ''}"`);
        return value;
      }
      return toIsoString(parsed);
    }
    case 'timeago':
    case 'reltime': {
      const parsed = parseTimeAgo(value, ctx.now);
      if (!parsed) throw new FilterError(name, `cannot parse relative time "${value}"`);
      return toIsoString(parsed);
    }
    case 'fuzzytime': {
      const dayFirst = (args[0] ?? '').toUpperCase() === 'UK';
      const parsed = parseFuzzyTime(value, dateCtx(ctx, dayFirst));
      if (!parsed) throw new FilterError(name, `cannot parse date "${value}"`);
      return toIsoString(parsed);
    }
    case 'validfilename':
      // eslint-disable-next-line no-control-regex
      return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    case 'diacritics': {
      if ((args[0] ?? 'replace') !== 'replace') throw new FilterError(name, `unsupported argument "${args[0]}"`);
      return value.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
    }
    case 'jsonjoinarray': {
      const path = arg(args, 0, name);
      const sep = args[1] ?? ',';
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(value) as JsonValue;
      } catch {
        throw new FilterError(name, 'input is not JSON');
      }
      const target = jsonQuery(parsed, path);
      if (!Array.isArray(target)) throw new FilterError(name, `${path} is not an array`);
      return target.map((v) => jsonToString(v) ?? '').join(sep);
    }
    case 'validate': {
      const allowed = new Set(arg(args, 0, name).toLowerCase().split(TOKEN_SPLIT).filter(Boolean));
      return value
        .split(TOKEN_SPLIT)
        .filter((t) => t && allowed.has(t.toLowerCase()))
        .join(', ');
    }
    case 'hexdump':
      ctx.log?.(
        `hexdump: ${[...value].map((c) => `${c}(${(c.codePointAt(0) ?? 0).toString(16).padStart(2, '0')})`).join(' ')}`,
      );
      return value;
    case 'strdump':
      ctx.log?.(
        `strdump${args[0] ? `(${args[0]})` : ''}: ${value.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/ /g, '\\u00A0')}`,
      );
      return value;
    default:
      ctx.log?.(`unsupported filter "${filter.name}" skipped`);
      return value;
  }
}

/** Apply a filter chain; null stays null (S6). */
export function applyFilters(value: string | null, filters: readonly FilterSpec[] | undefined, ctx: FilterContext): string | null {
  if (value === null || !filters || filters.length === 0) return value;
  let current = value;
  for (const f of filters) current = applyFilter(current, f, ctx);
  return current;
}
