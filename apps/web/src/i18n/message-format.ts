// ICU-lite message format. Supported syntax (docs/TRANSLATING.md):
//   {name}                                   a parameter, inserted as-is
//   {name, number}                           a number formatted for the locale
//   {count, plural, =0 {none} one {# item} other {# items}}
//   {kind, select, movie {Movie} series {Series} other {Item}}
//   '{'  '}'  '#'                            a literal brace or hash
// `#` inside a plural branch is the plural number formatted for the locale. Everything else
// (including a lone apostrophe) is literal text. Parsed messages are cached per string.

export type MessageNode =
  | string
  | { type: 'arg'; name: string; format?: 'number' | undefined }
  | { type: 'pound' }
  | { type: 'plural'; name: string; options: Record<string, MessageNode[]> }
  | { type: 'select'; name: string; options: Record<string, MessageNode[]> };

export type MessageValue = string | number | boolean | null | undefined | Date;
export type MessageParams = Readonly<Record<string, MessageValue>>;

// Plain class fields (no parameter properties or enums) so Node's type stripping can run this
// file directly: scripts/i18n-check.mjs imports it.
export class MessageSyntaxError extends Error {
  readonly code = 'MESSAGE_SYNTAX';
  readonly source: string;
  constructor(message: string, source: string) {
    super(`${message} in "${source}"`);
    this.source = source;
  }
}

class Parser {
  private i = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  parse(): MessageNode[] {
    const nodes = this.nodes(false, false);
    if (this.i < this.src.length) throw new MessageSyntaxError(`Unexpected "${this.src[this.i]}" at ${this.i}`, this.src);
    return nodes;
  }

  /** Text and placeholders up to a closing brace (when nested) or the end. */
  private nodes(nested: boolean, inPlural: boolean): MessageNode[] {
    const out: MessageNode[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push(text);
      text = '';
    };
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === "'" && this.src[this.i + 2] === "'" && '{}#'.includes(this.src[this.i + 1] ?? '')) {
        text += this.src[this.i + 1];
        this.i += 3;
        continue;
      }
      if (ch === '}') {
        if (!nested) throw new MessageSyntaxError(`Unmatched "}" at ${this.i}`, this.src);
        break;
      }
      if (ch === '{') {
        flush();
        out.push(this.placeholder());
        continue;
      }
      if (ch === '#' && inPlural) {
        flush();
        out.push({ type: 'pound' });
        this.i++;
        continue;
      }
      text += ch;
      this.i++;
    }
    flush();
    return out;
  }

  private ws() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++;
  }

  private word(): string {
    this.ws();
    const m = /^[^\s{},]+/.exec(this.src.slice(this.i));
    if (!m) throw new MessageSyntaxError(`Expected a name at ${this.i}`, this.src);
    this.i += m[0].length;
    this.ws();
    return m[0];
  }

  private expect(ch: string) {
    this.ws();
    if (this.src[this.i] !== ch) throw new MessageSyntaxError(`Expected "${ch}" at ${this.i}`, this.src);
    this.i++;
  }

  private placeholder(): MessageNode {
    this.expect('{');
    const name = this.word();
    if (this.src[this.i] === '}') {
      this.i++;
      return { type: 'arg', name };
    }
    this.expect(',');
    const kind = this.word();
    if (kind === 'number') {
      this.expect('}');
      return { type: 'arg', name, format: 'number' };
    }
    if (kind !== 'plural' && kind !== 'select') throw new MessageSyntaxError(`Unknown format "${kind}"`, this.src);
    this.expect(',');
    const options: Record<string, MessageNode[]> = {};
    this.ws();
    while (this.src[this.i] !== '}') {
      if (this.i >= this.src.length) throw new MessageSyntaxError('Unterminated placeholder', this.src);
      const key = this.word();
      this.expect('{');
      options[key] = this.nodes(true, kind === 'plural');
      this.expect('}');
      this.ws();
    }
    this.i++;
    if (!options.other) throw new MessageSyntaxError(`"${name}" ${kind} needs an "other" branch`, this.src);
    return { type: kind, name, options };
  }
}

const cache = new Map<string, MessageNode[]>();

export function parseMessage(src: string): MessageNode[] {
  let nodes = cache.get(src);
  if (!nodes) {
    nodes = new Parser(src).parse();
    cache.set(src, nodes);
  }
  return nodes;
}

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function rules(locale: string): Intl.PluralRules {
  let r = pluralRules.get(locale);
  if (!r) pluralRules.set(locale, (r = new Intl.PluralRules(locale)));
  return r;
}

export function numberFormat(locale: string): Intl.NumberFormat {
  let f = numberFormats.get(locale);
  if (!f) numberFormats.set(locale, (f = new Intl.NumberFormat(locale)));
  return f;
}

function str(v: MessageValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function render(nodes: readonly MessageNode[], params: MessageParams, locale: string, pound: number | null): string {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') {
      out += n;
    } else if (n.type === 'pound') {
      out += pound === null ? '#' : numberFormat(locale).format(pound);
    } else if (n.type === 'arg') {
      if (!(n.name in params)) out += `{${n.name}}`;
      else {
        const v = params[n.name];
        out += n.format === 'number' && typeof v === 'number' ? numberFormat(locale).format(v) : str(v);
      }
    } else if (n.type === 'plural') {
      const num = Number(params[n.name] ?? 0);
      const branch = n.options[`=${num}`] ?? n.options[rules(locale).select(num)] ?? n.options.other!;
      out += render(branch, params, locale, num);
    } else {
      const branch = n.options[str(params[n.name])] ?? n.options.other!;
      out += render(branch, params, locale, pound);
    }
  }
  return out;
}

/** Formats a message with ICU-lite syntax. Missing parameters stay as `{name}`. */
export function formatMessage(src: string, params: MessageParams = {}, locale = 'en'): string {
  // Fast path: nothing to substitute.
  if (!src.includes('{') && !src.includes("'")) return src;
  return render(parseMessage(src), params, locale, null);
}

/** Every parameter name a message uses (for the consistency check across locales). */
export function messageParams(src: string): Set<string> {
  const names = new Set<string>();
  const walk = (nodes: readonly MessageNode[]) => {
    for (const n of nodes) {
      if (typeof n === 'string' || n.type === 'pound') continue;
      names.add(n.name);
      if (n.type === 'plural' || n.type === 'select') for (const b of Object.values(n.options)) walk(b);
    }
  };
  walk(parseMessage(src));
  return names;
}
