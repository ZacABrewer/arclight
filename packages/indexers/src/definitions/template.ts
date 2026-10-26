/**
 * The definition template language (spec S4): a small Go-template-like dialect with
 * `{{ .Var }}`, `if/else if/else/end`, `range` (optionally `$i, $e :=`), and the functions
 * `and or not eq ne join re_replace len`. Implemented as a real parser + evaluator; parsed
 * templates are cached by source string.
 *
 * Variables are looked up in a flat map keyed by the dotted name without the leading dot
 * (`Config.username`, `Query.Keywords`, `Today.Year`). Unknown variables render as ''.
 */

export type TemplateValue = string | null | readonly string[];

export interface TemplateVars {
  [name: string]: TemplateValue | undefined;
}

export interface RenderOptions {
  /** Applied to every substituted value (not to literal template text); used for paths (S4.7). */
  encodeValue?: (value: string) => string;
}

export class TemplateError extends Error {
  readonly code = 'template_syntax';
  constructor(message: string, readonly template: string) {
    super(`${message} in template ${JSON.stringify(template.length > 120 ? `${template.slice(0, 117)}...` : template)}`);
    this.name = 'TemplateError';
  }
}

// ---------------------------------------------------------------------------------------
// AST

type Expr =
  | { kind: 'var'; name: string } // '' = dot
  | { kind: 'local'; name: string }
  | { kind: 'lit'; value: string }
  | { kind: 'call'; fn: string; args: Expr[] };

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'out'; expr: Expr }
  | { kind: 'if'; cond: Expr; then: Node[]; else: Node[] }
  | { kind: 'range'; expr: Expr; index?: string; elem?: string; body: Node[]; else: Node[] };

const FUNCTIONS = new Set(['and', 'or', 'not', 'eq', 'ne', 'join', 're_replace', 'len']);

// ---------------------------------------------------------------------------------------
// Lexing

interface Action {
  kind: 'action';
  body: string;
}
type Piece = { kind: 'text'; text: string } | Action;

function lex(src: string): Piece[] {
  const pieces: Piece[] = [];
  let pos = 0;
  while (pos < src.length) {
    const open = src.indexOf('{{', pos);
    if (open < 0) {
      pieces.push({ kind: 'text', text: src.slice(pos) });
      break;
    }
    let text = src.slice(pos, open);
    let bodyStart = open + 2;
    if (src[bodyStart] === '-' && /\s/.test(src[bodyStart + 1] ?? '')) {
      text = text.replace(/\s+$/, '');
      bodyStart++;
    }
    if (text) pieces.push({ kind: 'text', text });
    const close = findClose(src, bodyStart);
    if (close < 0) throw new TemplateError('Unclosed action', src);
    let body = src.slice(bodyStart, close);
    pos = close + 2;
    if (/\s-$/.test(body)) {
      body = body.slice(0, -1);
      while (pos < src.length && /\s/.test(src[pos] ?? '')) pos++;
    }
    pieces.push({ kind: 'action', body: body.trim() });
  }
  return pieces;
}

/** Find the `}}` closing an action, skipping quoted strings. */
function findClose(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' && quote === '"' && src[i + 1] === '"' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '}' && src[i + 1] === '}') return i;
    i++;
  }
  return -1;
}

type Token =
  | { t: 'ident'; v: string }
  | { t: 'var'; v: string }
  | { t: 'local'; v: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: string }
  | { t: '(' }
  | { t: ')' }
  | { t: ',' }
  | { t: ':=' };

function tokenize(body: string, src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i] ?? '';
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      tokens.push({ t: c });
      i++;
      continue;
    }
    if (c === ':' && body[i + 1] === '=') {
      tokens.push({ t: ':=' });
      i += 2;
      continue;
    }
    if (c === '"') {
      let out = '';
      i++;
      while (i < body.length && body[i] !== '"') {
        // Only `\"` is an escape; other backslashes stay literal so regex patterns
        // like "\s+" survive (catalogue definitions rely on that).
        if (body[i] === '\\' && body[i + 1] === '"') {
          out += '"';
          i += 2;
        } else {
          out += body[i];
          i++;
        }
      }
      if (body[i] !== '"') throw new TemplateError('Unterminated string', src);
      i++;
      tokens.push({ t: 'str', v: out });
      continue;
    }
    if (c === '`') {
      const end = body.indexOf('`', i + 1);
      if (end < 0) throw new TemplateError('Unterminated raw string', src);
      tokens.push({ t: 'str', v: body.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '.') {
      const m = /^\.[A-Za-z0-9_.]*/.exec(body.slice(i));
      const name = (m?.[0] ?? '.').slice(1).replace(/\.$/, '');
      tokens.push({ t: 'var', v: name });
      i += m?.[0].length ?? 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z0-9_]*/.exec(body.slice(i));
      tokens.push({ t: 'local', v: (m?.[0] ?? '$').slice(1) });
      i += m?.[0].length ?? 1;
      continue;
    }
    if (/[-\d]/.test(c)) {
      const m = /^-?\d+(\.\d+)?/.exec(body.slice(i));
      if (m) {
        tokens.push({ t: 'num', v: m[0] });
        i += m[0].length;
        continue;
      }
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i));
    if (m) {
      tokens.push({ t: 'ident', v: m[0] });
      i += m[0].length;
      continue;
    }
    throw new TemplateError(`Unexpected character '${c}'`, src);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------
// Parsing

class ExprParser {
  private i = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  done(): boolean {
    return this.i >= this.tokens.length;
  }

  /** Full expression: a function call with arguments, or a single operand. */
  parse(): Expr {
    const expr = this.command();
    if (!this.done()) throw new TemplateError('Unexpected trailing tokens', this.src);
    return expr;
  }

  private command(): Expr {
    const first = this.tokens[this.i];
    if (first?.t === 'ident') {
      if (first.v === 'true' || first.v === 'false') {
        this.i++;
        return first.v === 'true' ? { kind: 'lit', value: 'True' } : { kind: 'var', name: 'False' };
      }
      if (!FUNCTIONS.has(first.v)) throw new TemplateError(`Unknown function '${first.v}'`, this.src);
      this.i++;
      const args: Expr[] = [];
      while (!this.done() && this.tokens[this.i]?.t !== ')') args.push(this.operand());
      return { kind: 'call', fn: first.v, args };
    }
    return this.operand();
  }

  private operand(): Expr {
    const tok = this.tokens[this.i++];
    if (!tok) throw new TemplateError('Missing operand', this.src);
    switch (tok.t) {
      case 'var':
        return { kind: 'var', name: tok.v };
      case 'local':
        return { kind: 'local', name: tok.v };
      case 'str':
      case 'num':
        return { kind: 'lit', value: tok.v };
      case '(': {
        const inner = this.command();
        if (this.tokens[this.i]?.t !== ')') throw new TemplateError('Missing )', this.src);
        this.i++;
        return inner;
      }
      case 'ident':
        if (tok.v === 'true') return { kind: 'lit', value: 'True' };
        if (tok.v === 'false' || tok.v === 'nil') return { kind: 'var', name: 'False' };
        throw new TemplateError(`Function '${tok.v}' used as operand; wrap it in parentheses`, this.src);
      default:
        throw new TemplateError(`Unexpected token '${tok.t}'`, this.src);
    }
  }
}

function parseExpr(body: string, src: string): Expr {
  return new ExprParser(tokenize(body, src), src).parse();
}

interface Frame {
  node: Node & { kind: 'if' | 'range' };
  inElse: boolean;
  /** `else if` chains open nested ifs that close with the same `end`. */
  chained: number;
}

function parse(src: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  const current = (): Node[] => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    if (top.inElse) return top.node.else;
    return top.node.kind === 'if' ? top.node.then : top.node.body;
  };

  for (const piece of lex(src)) {
    if (piece.kind === 'text') {
      current().push({ kind: 'text', text: piece.text });
      continue;
    }
    const body = piece.body;
    if (body.startsWith('/*')) continue; // comment
    const word = /^[A-Za-z_]+/.exec(body)?.[0];
    if (word === 'if') {
      const node: Node = { kind: 'if', cond: parseExpr(body.slice(2), src), then: [], else: [] };
      current().push(node);
      stack.push({ node, inElse: false, chained: 0 });
    } else if (word === 'else') {
      const top = stack[stack.length - 1];
      if (!top || top.inElse) throw new TemplateError('Unexpected else', src);
      top.inElse = true;
      const rest = body.slice(4).trim();
      if (rest.startsWith('if ') || rest.startsWith('if(')) {
        const nested: Node = { kind: 'if', cond: parseExpr(rest.slice(2), src), then: [], else: [] };
        top.node.else.push(nested);
        stack.push({ node: nested, inElse: false, chained: top.chained + 1 });
      } else if (rest) {
        throw new TemplateError(`Unexpected '${rest}' after else`, src);
      }
    } else if (word === 'end') {
      let top = stack.pop();
      if (!top) throw new TemplateError('Unexpected end', src);
      while (top.chained > 0) {
        top = stack.pop();
        if (!top) throw new TemplateError('Unexpected end', src);
      }
    } else if (word === 'range') {
      const rest = body.slice(5).trim();
      const decl = /^\$([A-Za-z0-9_]*)\s*(?:,\s*\$([A-Za-z0-9_]*))?\s*:=\s*([\s\S]+)$/.exec(rest);
      let node: Node;
      if (decl) {
        const second = decl[2];
        node = {
          kind: 'range',
          expr: parseExpr(decl[3] ?? '', src),
          body: [],
          else: [],
          ...(second === undefined ? { elem: decl[1] ?? '' } : { index: decl[1] ?? '', elem: second }),
        };
      } else {
        node = { kind: 'range', expr: parseExpr(rest, src), body: [], else: [] };
      }
      current().push(node);
      stack.push({ node, inElse: false, chained: 0 });
    } else {
      current().push({ kind: 'out', expr: parseExpr(body, src) });
    }
  }
  if (stack.length > 0) throw new TemplateError('Missing end', src);
  return root;
}

const cache = new Map<string, Node[]>();

function compile(src: string): Node[] {
  let nodes = cache.get(src);
  if (!nodes) {
    nodes = parse(src);
    if (cache.size > 5000) cache.clear();
    cache.set(src, nodes);
  }
  return nodes;
}

/** Throw a TemplateError when `src` does not parse (used for load-time validation). */
export function validateTemplate(src: string): void {
  if (src.includes('{{')) compile(src);
}

/** Variable names (without leading dot) referenced by a template. */
export function templateVariables(src: string): string[] {
  if (!src.includes('{{')) return [];
  const names = new Set<string>();
  const visitExpr = (e: Expr): void => {
    if (e.kind === 'var' && e.name) names.add(e.name);
    if (e.kind === 'call') e.args.forEach(visitExpr);
  };
  const visit = (nodes: Node[]): void => {
    for (const n of nodes) {
      if (n.kind === 'out') visitExpr(n.expr);
      if (n.kind === 'if') {
        visitExpr(n.cond);
        visit(n.then);
        visit(n.else);
      }
      if (n.kind === 'range') {
        visitExpr(n.expr);
        visit(n.body);
        visit(n.else);
      }
    }
  };
  visit(compile(src));
  return [...names];
}

// ---------------------------------------------------------------------------------------
// Evaluation

/** S4.1: null, blank string and empty list are false; everything else is true. */
export function isTruthy(value: TemplateValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return value.length > 0;
}

function asString(value: TemplateValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return value.join(',');
}

const regexCache = new Map<string, RegExp>();

/** Compile a definition regex (ECMAScript, optional leading `(?i)`), cached. */
export function definitionRegex(pattern: string, flags = ''): RegExp {
  const key = `${flags}/${pattern}`;
  let re = regexCache.get(key);
  if (!re) {
    let source = pattern;
    let f = flags;
    if (source.startsWith('(?i)')) {
      source = source.slice(4);
      if (!f.includes('i')) f += 'i';
    }
    // .NET named groups `(?<name>` are the same in JS; `(?'name'` is not.
    source = source.replace(/\(\?'([A-Za-z_]\w*)'/g, '(?<$1>');
    re = new RegExp(source, f);
    regexCache.set(key, re);
  }
  return re;
}

/** Translate .NET-style replacement tokens (`${name}`) to JS (`$<name>`). */
export function translateReplacement(replacement: string): string {
  return replacement.replace(/\$\{([A-Za-z_]\w*)\}/g, '$<$1>').replace(/\$\{(\d+)\}/g, '$$$1');
}

export function regexReplace(input: string, pattern: string, replacement: string): string {
  return input.replace(definitionRegex(pattern, 'g'), translateReplacement(replacement));
}

interface Scope {
  vars: TemplateVars;
  dot: TemplateValue;
  locals: Map<string, TemplateValue>;
}

function evalExpr(e: Expr, scope: Scope): TemplateValue {
  switch (e.kind) {
    case 'lit':
      return e.value;
    case 'var':
      if (e.name === '') return scope.dot;
      if (e.name === 'True') return 'True';
      if (e.name === 'False') return null;
      return scope.vars[e.name] ?? null;
    case 'local':
      return scope.locals.get(e.name) ?? null;
    case 'call':
      return callFunction(e.fn, e.args, scope);
  }
}

function callFunction(fn: string, args: Expr[], scope: Scope): TemplateValue {
  const values = (): TemplateValue[] => args.map((a) => evalExpr(a, scope));
  switch (fn) {
    case 'and': {
      let last: TemplateValue = null;
      for (const a of args) {
        last = evalExpr(a, scope);
        if (!isTruthy(last)) return last;
      }
      return last;
    }
    case 'or': {
      let last: TemplateValue = null;
      for (const a of args) {
        last = evalExpr(a, scope);
        if (isTruthy(last)) return last;
      }
      return last;
    }
    case 'not':
      return isTruthy(evalExpr(args[0] ?? { kind: 'lit', value: '' }, scope)) ? null : 'True';
    case 'eq':
    case 'ne': {
      const [first, ...rest] = values();
      const same = (a: TemplateValue | undefined, b: TemplateValue | undefined): boolean =>
        a === null || a === undefined || b === null || b === undefined
          ? (a ?? null) === (b ?? null)
          : asString(a) === asString(b);
      const equal = rest.some((v) => same(first, v));
      return (fn === 'eq') === equal ? 'True' : null;
    }
    case 'join': {
      const [list, sep] = values();
      if (list === null || list === undefined) return '';
      return typeof list === 'string' ? list : list.join(asString(sep));
    }
    case 're_replace': {
      const [input, pattern, replacement] = values();
      return regexReplace(asString(input), asString(pattern), asString(replacement));
    }
    case 'len': {
      const [v] = values();
      if (v === null || v === undefined) return '0';
      return String(v.length);
    }
    default:
      return null;
  }
}

function renderNodes(nodes: Node[], scope: Scope, options: RenderOptions, out: string[]): void {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'out': {
        const s = asString(evalExpr(n.expr, scope));
        out.push(options.encodeValue ? options.encodeValue(s) : s);
        break;
      }
      case 'if':
        renderNodes(isTruthy(evalExpr(n.cond, scope)) ? n.then : n.else, scope, options, out);
        break;
      case 'range': {
        const v = evalExpr(n.expr, scope);
        const list: readonly string[] = v === null ? [] : typeof v === 'string' ? (v ? [v] : []) : v;
        if (list.length === 0) {
          renderNodes(n.else, scope, options, out);
          break;
        }
        list.forEach((item, i) => {
          const locals = new Map(scope.locals);
          if (n.index !== undefined) locals.set(n.index, String(i));
          if (n.elem !== undefined) locals.set(n.elem, item);
          renderNodes(n.body, { vars: scope.vars, dot: item, locals }, options, out);
        });
        break;
      }
    }
  }
}

/** Render a template; strings without `{{` are returned untouched (S4.10). */
export function renderTemplate(src: string, vars: TemplateVars, options: RenderOptions = {}): string {
  if (!src.includes('{{')) return src;
  const out: string[] = [];
  renderNodes(compile(src), { vars, dot: null, locals: new Map() }, options, out);
  return out.join('');
}
