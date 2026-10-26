/**
 * CSS selector engine over the html/dom.ts node model.
 *
 * Selectors are parsed once into a small AST and cached by source string.
 * Matching is right-to-left with backtracking for descendant/sibling
 * combinators, like browsers.
 *
 * jQuery positional pseudos (`:eq(n)`, `:lt(n)`, `:gt(n)`, `:first`, `:last`):
 *  - In `querySelectorAll` / `querySelector` / `removeMatching`, a complex
 *    selector containing them is evaluated set-wise, left to right, like
 *    jQuery: each compound's matches (descendants of the context, in document
 *    order) are filtered by the compound's non-positional parts and then by
 *    its positional pseudos in order. `table tr:eq(1) td` therefore means
 *    "cells of the 2nd row found under the context".
 *  - In `matches()` and inside `:has()` / `:not()` / `:is()`, they fall back
 *    to a sibling-relative reading: the element must be at that index among
 *    its parent's element children that match the rest of the compound.
 *  Negative indexes count from the end (`:eq(-1)` is the last).
 *
 * `:contains()` computes textContent per candidate, so `*:contains(x)` over a
 * huge, deeply nested page is quadratic; scope it (e.g. `td:contains(x)`).
 */
import {
  descendantElements,
  ownerDocument,
  previousElementSibling,
  textContent,
  type HtmlElement,
  type HtmlParent,
} from './dom.js';

export class SelectorSyntaxError extends Error {
  readonly code = 'SELECTOR_SYNTAX';
  constructor(message: string) {
    super(message);
    this.name = 'SelectorSyntaxError';
  }
}

// ---------------------------------------------------------------------------
// AST

type Combinator = ' ' | '>' | '+' | '~';
type AttrOp = '=' | '~=' | '|=' | '^=' | '$=' | '*=' | '!=';
type FlagName =
  | 'empty' | 'parent' | 'root' | 'checked' | 'selected' | 'disabled' | 'enabled' | 'scope'
  | 'only-child' | 'only-of-type';

type Simple =
  | { kind: 'id'; value: string }
  | { kind: 'class'; value: string }
  | { kind: 'attr'; name: string; nameLower: string; op: AttrOp | null; value: string; ci: boolean }
  | { kind: 'has'; list: Complex[] }
  | { kind: 'not'; list: Complex[] }
  | { kind: 'is'; list: Complex[] }
  | { kind: 'contains'; text: string; ci: boolean }
  | { kind: 'nth'; a: number; b: number; ofType: boolean; last: boolean }
  | { kind: 'flag'; name: FlagName }
  | { kind: 'pos'; op: 'eq' | 'lt' | 'gt'; n: number };

interface Compound {
  /** null means any element. */
  tag: string | null;
  tagLower: string | null;
  simples: Simple[];
  positional: boolean;
}

interface Complex {
  compounds: Compound[];
  /** combinators[i] sits between compounds[i] and compounds[i + 1]. */
  combinators: Combinator[];
  /** Only for relative selectors inside :has(). */
  leading: Combinator | null;
  positional: boolean;
}

// ---------------------------------------------------------------------------
// Parser

function isIdentStart(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45 || c >= 128 ||
    (c >= 48 && c <= 57) // tolerated: tracker definitions use things like `.1080p`
  );
}

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

class SelectorParser {
  private pos = 0;
  constructor(private readonly src: string) {}

  private fail(message: string): never {
    throw new SelectorSyntaxError(
      `Invalid selector ${JSON.stringify(this.src)} at position ${this.pos}: ${message}`,
    );
  }

  private peek(offset = 0): number {
    return this.src.charCodeAt(this.pos + offset);
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private skipWs(): boolean {
    const start = this.pos;
    while (!this.eof() && isWs(this.peek())) this.pos++;
    return this.pos > start;
  }

  parseTop(): Complex[] {
    const list = this.parseList(false);
    if (!this.eof()) this.fail(`unexpected ${JSON.stringify(this.src[this.pos])}`);
    return list;
  }

  /** Comma-separated list, ending at EOF or (unconsumed) ')'. */
  private parseList(relative: boolean): Complex[] {
    const list: Complex[] = [];
    for (;;) {
      list.push(this.parseComplex(relative));
      this.skipWs();
      if (this.peek() === 44 /* , */) {
        this.pos++;
        continue;
      }
      return list;
    }
  }

  private parseComplex(relative: boolean): Complex {
    this.skipWs();
    let leading: Combinator | null = null;
    if (relative) {
      const c = this.peek();
      if (c === 62 || c === 43 || c === 126) {
        leading = String.fromCharCode(c) as Combinator;
        this.pos++;
        this.skipWs();
      } else {
        leading = ' ';
      }
    }
    const compounds: Compound[] = [this.parseCompound()];
    const combinators: Combinator[] = [];
    for (;;) {
      const sawWs = this.skipWs();
      if (this.eof()) break;
      const c = this.peek();
      if (c === 44 || c === 41) break; // , )
      let comb: Combinator;
      if (c === 62 || c === 43 || c === 126) {
        comb = String.fromCharCode(c) as Combinator;
        this.pos++;
        this.skipWs();
      } else if (sawWs) {
        comb = ' ';
      } else {
        this.fail(`unexpected ${JSON.stringify(this.src[this.pos])}`);
      }
      combinators.push(comb);
      compounds.push(this.parseCompound());
    }
    return {
      compounds,
      combinators,
      leading,
      positional: compounds.some((c) => c.positional),
    };
  }

  private parseCompound(): Compound {
    let tag: string | null = null;
    let any = false;
    const simples: Simple[] = [];
    if (this.peek() === 42 /* * */) {
      this.pos++;
      any = true;
    } else if (!this.eof() && (isIdentStart(this.peek()) || this.peek() === 92)) {
      tag = this.parseIdent('element name');
    }
    for (;;) {
      if (this.eof()) break;
      const c = this.peek();
      if (c === 35 /* # */) {
        this.pos++;
        simples.push({ kind: 'id', value: this.parseIdent('id') });
      } else if (c === 46 /* . */) {
        this.pos++;
        simples.push({ kind: 'class', value: this.parseIdent('class name') });
      } else if (c === 91 /* [ */) {
        simples.push(this.parseAttribute());
      } else if (c === 58 /* : */) {
        simples.push(this.parsePseudo());
      } else {
        break;
      }
    }
    if (tag === null && !any && simples.length === 0) {
      this.fail(this.eof() ? 'expected a selector but reached the end' : `expected a selector, found ${JSON.stringify(this.src[this.pos])}`);
    }
    return {
      tag,
      tagLower: tag === null ? null : tag.toLowerCase(),
      simples,
      positional: simples.some((s) => s.kind === 'pos'),
    };
  }

  private parseIdent(what: string): string {
    let out = '';
    const start = this.pos;
    while (!this.eof()) {
      const c = this.peek();
      if (c === 92 /* \ */) {
        out += this.parseEscape();
      } else if (isIdentStart(c)) {
        out += this.src[this.pos];
        this.pos++;
      } else {
        break;
      }
    }
    if (this.pos === start) this.fail(`expected ${what}`);
    return out;
  }

  private parseEscape(): string {
    this.pos++; // backslash
    if (this.eof()) this.fail('dangling escape');
    let hex = '';
    while (hex.length < 6 && /[0-9a-fA-F]/.test(this.src[this.pos] ?? '')) {
      hex += this.src[this.pos];
      this.pos++;
    }
    if (hex.length > 0) {
      if (isWs(this.peek())) this.pos++;
      const cp = parseInt(hex, 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp);
    }
    const ch = String.fromCodePoint(this.src.codePointAt(this.pos) ?? 0xfffd);
    this.pos += ch.length;
    return ch;
  }

  private parseString(): string {
    const quote = this.peek();
    this.pos++;
    let out = '';
    for (;;) {
      if (this.eof()) this.fail('unterminated string');
      const c = this.peek();
      if (c === quote) {
        this.pos++;
        return out;
      }
      if (c === 92) {
        if (this.peek(1) === 10) {
          this.pos += 2; // escaped newline: line continuation
          continue;
        }
        out += this.parseEscape();
        continue;
      }
      out += this.src[this.pos];
      this.pos++;
    }
  }

  private parseAttribute(): Simple {
    this.pos++; // [
    this.skipWs();
    const name = this.parseIdent('attribute name');
    this.skipWs();
    let op: AttrOp | null = null;
    let value = '';
    let ci = false;
    const c = this.peek();
    if (c === 61) {
      op = '=';
      this.pos++;
    } else if ([126, 124, 94, 36, 42, 33].includes(c) && this.peek(1) === 61) {
      op = (this.src[this.pos]! + '=') as AttrOp;
      this.pos += 2;
    }
    if (op !== null) {
      this.skipWs();
      const q = this.peek();
      if (q === 34 || q === 39) {
        value = this.parseString();
      } else {
        // Unquoted: tolerant of things CSS would reject (e.g. `[href^=/torrent/]`).
        let v = '';
        while (!this.eof()) {
          const d = this.peek();
          if (isWs(d) || d === 93) break;
          if (d === 92) {
            v += this.parseEscape();
            continue;
          }
          v += this.src[this.pos];
          this.pos++;
        }
        if (v.length === 0) this.fail('expected attribute value');
        value = v;
      }
      this.skipWs();
      const f = this.peek();
      if ((f === 105 || f === 73 || f === 115 || f === 83) && this.isFlagEnd(this.pos + 1)) {
        ci = f === 105 || f === 73;
        this.pos++;
        this.skipWs();
      }
    }
    if (this.peek() !== 93) this.fail('expected "]" to close attribute selector');
    this.pos++;
    return { kind: 'attr', name, nameLower: name.toLowerCase(), op, value, ci };
  }

  private isFlagEnd(i: number): boolean {
    let j = i;
    while (j < this.src.length && isWs(this.src.charCodeAt(j))) j++;
    return this.src.charCodeAt(j) === 93;
  }

  private expectClose(what: string): void {
    this.skipWs();
    if (this.peek() !== 41) this.fail(`expected ")" to close :${what}(`);
    this.pos++;
  }

  /** Raw argument up to the matching ')' (not consumed), honouring nested parens. */
  private rawArgument(): string {
    const start = this.pos;
    let depth = 0;
    while (!this.eof()) {
      const c = this.peek();
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      this.pos++;
    }
    if (this.eof()) this.fail('unterminated pseudo-class argument');
    return this.src.slice(start, this.pos);
  }

  private parsePseudo(): Simple {
    this.pos++; // :
    if (this.peek() === 58) this.fail('pseudo-elements (::) are not supported');
    const name = this.parseIdent('pseudo-class name').toLowerCase();
    const hasArgs = this.peek() === 40;
    if (hasArgs) this.pos++;
    const needArgs = (yes: boolean): void => {
      if (yes && !hasArgs) this.fail(`:${name} requires an argument`);
      if (!yes && hasArgs) this.fail(`:${name} does not take an argument`);
    };
    switch (name) {
      case 'has': {
        needArgs(true);
        const list = this.parseList(true);
        this.expectClose(name);
        return { kind: 'has', list };
      }
      case 'not':
      case 'is':
      case 'where':
      case 'matches': {
        needArgs(true);
        const list = this.parseList(false);
        this.expectClose(name);
        return name === 'not' ? { kind: 'not', list } : { kind: 'is', list };
      }
      case 'contains':
      case 'icontains': {
        needArgs(true);
        this.skipWs();
        const q = this.peek();
        let text: string;
        if (q === 34 || q === 39) {
          text = this.parseString();
          this.expectClose(name);
        } else {
          text = this.rawArgument().trim();
          this.pos++;
        }
        const ci = name === 'icontains';
        return { kind: 'contains', text: ci ? text.toLowerCase() : text, ci };
      }
      case 'nth-child':
      case 'nth-last-child':
      case 'nth-of-type':
      case 'nth-last-of-type': {
        needArgs(true);
        const raw = this.rawArgument();
        const { a, b } = this.parseNth(raw);
        this.pos++;
        return { kind: 'nth', a, b, ofType: name.endsWith('of-type'), last: name.includes('last') };
      }
      case 'first-child':
      case 'last-child':
      case 'first-of-type':
      case 'last-of-type':
        needArgs(false);
        return { kind: 'nth', a: 0, b: 1, ofType: name.endsWith('of-type'), last: name.startsWith('last') };
      case 'eq':
      case 'lt':
      case 'gt': {
        needArgs(true);
        const raw = this.rawArgument().trim();
        if (!/^[+-]?\d+$/.test(raw)) this.fail(`:${name}() expects an integer, got ${JSON.stringify(raw)}`);
        this.pos++;
        return { kind: 'pos', op: name, n: parseInt(raw, 10) };
      }
      case 'first':
        needArgs(false);
        return { kind: 'pos', op: 'eq', n: 0 };
      case 'last':
        needArgs(false);
        return { kind: 'pos', op: 'eq', n: -1 };
      case 'empty':
      case 'parent':
      case 'root':
      case 'checked':
      case 'selected':
      case 'disabled':
      case 'enabled':
      case 'scope':
      case 'only-child':
      case 'only-of-type':
        needArgs(false);
        return { kind: 'flag', name };
      default:
        this.fail(`unsupported pseudo-class :${name}`);
    }
  }

  private parseNth(raw: string): { a: number; b: number } {
    const s = raw.replace(/\s+/g, '').toLowerCase();
    if (s === 'odd') return { a: 2, b: 1 };
    if (s === 'even') return { a: 2, b: 0 };
    if (/^[+-]?\d+$/.test(s)) return { a: 0, b: parseInt(s, 10) };
    const m = /^([+-]?)(\d*)n([+-]\d+)?$/.exec(s);
    if (m === null) this.fail(`invalid an+b expression ${JSON.stringify(raw.trim())}`);
    const sign = m[1] === '-' ? -1 : 1;
    const a = sign * (m[2] === '' || m[2] === undefined ? 1 : parseInt(m[2], 10));
    const b = m[3] === undefined ? 0 : parseInt(m[3], 10);
    return { a, b };
  }
}

const CACHE_LIMIT = 2000;
const cache = new Map<string, Complex[]>();

function compile(selector: string): Complex[] {
  const hit = cache.get(selector);
  if (hit !== undefined) return hit;
  if (typeof selector !== 'string') throw new SelectorSyntaxError('Selector must be a string');
  const parsed = new SelectorParser(selector).parseTop();
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(selector, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Matching

interface MatchContext {
  xml: boolean;
  scope: HtmlParent | null;
  /** Element children per parent, built lazily for structural pseudos. */
  siblings: Map<HtmlParent, HtmlElement[]>;
  /** 0-based index of an element within its parent's element children. */
  index: Map<HtmlElement, number>;
}

function makeContext(anchor: HtmlElement | HtmlParent, scope: HtmlParent | null): MatchContext {
  return {
    xml: ownerDocument(anchor)?.xml ?? false,
    scope,
    siblings: new Map(),
    index: new Map(),
  };
}

function parentElement(el: HtmlElement): HtmlElement | null {
  const p = el.parent;
  return p !== null && p.type === 'element' ? p : null;
}

function siblingList(el: HtmlElement, ctx: MatchContext): HtmlElement[] {
  const parent = el.parent;
  if (parent === null) return [el];
  let list = ctx.siblings.get(parent);
  if (list === undefined) {
    list = [];
    for (const c of parent.children) {
      if (c.type === 'element') {
        ctx.index.set(c, list.length);
        list.push(c);
      }
    }
    ctx.siblings.set(parent, list);
  }
  return list;
}

function indexIn(el: HtmlElement, ctx: MatchContext): number {
  const list = siblingList(el, ctx);
  return ctx.index.get(el) ?? list.indexOf(el);
}

function tagMatches(el: HtmlElement, c: Compound, ctx: MatchContext): boolean {
  if (c.tag === null) return true;
  const name = el.tagName;
  if (ctx.xml) {
    if (name === c.tag) return true;
    const colon = name.indexOf(':');
    return colon !== -1 && name.slice(colon + 1) === c.tag;
  }
  return name === c.tagLower || name.toLowerCase() === c.tagLower;
}

function attrValue(el: HtmlElement, name: string, nameLower: string, ctx: MatchContext): string | undefined {
  if (ctx.xml) return el.attributes.get(name);
  return el.attributes.get(nameLower) ?? (nameLower === name ? undefined : el.attributes.get(name));
}

function attrMatches(el: HtmlElement, s: Extract<Simple, { kind: 'attr' }>, ctx: MatchContext): boolean {
  const actual = attrValue(el, s.name, s.nameLower, ctx);
  if (s.op === '!=') {
    if (actual === undefined) return true;
    return s.ci ? actual.toLowerCase() !== s.value.toLowerCase() : actual !== s.value;
  }
  if (actual === undefined) return false;
  if (s.op === null) return true;
  const v = s.ci ? actual.toLowerCase() : actual;
  const want = s.ci ? s.value.toLowerCase() : s.value;
  switch (s.op) {
    case '=':
      return v === want;
    case '~=':
      if (want === '' || /\s/.test(want)) return false;
      return v.split(/[ \t\n\r\f]+/).includes(want);
    case '|=':
      return v === want || v.startsWith(want + '-');
    case '^=':
      return want !== '' && v.startsWith(want);
    case '$=':
      return want !== '' && v.endsWith(want);
    case '*=':
      return want !== '' && v.includes(want);
  }
}

function hasClass(el: HtmlElement, cls: string): boolean {
  const attr = el.attributes.get('class');
  if (attr === undefined) return false;
  if (attr === cls) return true;
  if (!attr.includes(cls)) return false;
  return attr.split(/[ \t\n\r\f]+/).includes(cls);
}

const FORM_CONTROLS = new Set(['button', 'input', 'select', 'textarea', 'optgroup', 'option', 'fieldset']);

function nthMatches(el: HtmlElement, s: Extract<Simple, { kind: 'nth' }>, ctx: MatchContext): boolean {
  const list = siblingList(el, ctx);
  let position: number;
  if (!s.ofType) {
    const i = indexIn(el, ctx);
    position = s.last ? list.length - i : i + 1;
  } else {
    const tag = el.tagName;
    let before = 0;
    let after = 0;
    let seen = false;
    for (const sib of list) {
      if (sib === el) {
        seen = true;
        continue;
      }
      if (sib.tagName !== tag) continue;
      if (seen) after++;
      else before++;
    }
    position = s.last ? after + 1 : before + 1;
  }
  if (s.a === 0) return position === s.b;
  const diff = position - s.b;
  return diff % s.a === 0 && diff / s.a >= 0;
}

function flagMatches(el: HtmlElement, name: FlagName, ctx: MatchContext): boolean {
  switch (name) {
    case 'empty':
    case 'parent': {
      const empty = el.children.every(
        (c) => c.type === 'comment' || (c.type === 'text' && c.data.length === 0),
      );
      return name === 'empty' ? empty : !empty;
    }
    case 'root':
      return el.parent !== null && el.parent.type === 'document';
    case 'checked':
      return (
        el.attributes.has('checked') ||
        (el.tagName.toLowerCase() === 'option' && el.attributes.has('selected'))
      );
    case 'selected':
      return el.attributes.has('selected');
    case 'disabled':
      return el.attributes.has('disabled');
    case 'enabled':
      return FORM_CONTROLS.has(el.tagName.toLowerCase()) && !el.attributes.has('disabled');
    case 'scope': {
      const scope = ctx.scope;
      if (scope === null) return el.parent !== null && el.parent.type === 'document';
      if (scope.type === 'document') return el.parent === scope;
      return el === scope;
    }
    case 'only-child':
      return siblingList(el, ctx).length === 1;
    case 'only-of-type': {
      let count = 0;
      for (const sib of siblingList(el, ctx)) if (sib.tagName === el.tagName) count++;
      return count === 1;
    }
  }
}

function simpleMatches(el: HtmlElement, s: Simple, ctx: MatchContext): boolean {
  switch (s.kind) {
    case 'id':
      return el.attributes.get('id') === s.value;
    case 'class':
      return hasClass(el, s.value);
    case 'attr':
      return attrMatches(el, s, ctx);
    case 'has':
      return hasMatches(el, s.list, ctx);
    case 'not':
      return !s.list.some((cx) => matchAt(el, cx, cx.compounds.length - 1, ctx, null));
    case 'is':
      return s.list.some((cx) => matchAt(el, cx, cx.compounds.length - 1, ctx, null));
    case 'contains': {
      const text = textContent(el);
      return s.ci ? text.toLowerCase().includes(s.text) : text.includes(s.text);
    }
    case 'nth':
      return nthMatches(el, s, ctx);
    case 'flag':
      return flagMatches(el, s.name, ctx);
    case 'pos':
      // Handled by compoundMatches (needs the preceding simples).
      return true;
  }
}

function resolveIndex(n: number, length: number): number {
  return n < 0 ? n + length : n;
}

/** Apply a positional filter to an ordered list (set semantics). */
function applyPositional(list: HtmlElement[], s: Extract<Simple, { kind: 'pos' }>): HtmlElement[] {
  const n = resolveIndex(s.n, list.length);
  switch (s.op) {
    case 'eq': {
      const hit = n >= 0 ? list[n] : undefined;
      return hit === undefined ? [] : [hit];
    }
    case 'lt':
      return n <= 0 ? [] : list.slice(0, n);
    case 'gt':
      return list.slice(Math.max(0, n + 1));
  }
}

/**
 * Compound test. With `skipPositional`, positional pseudos are ignored (the
 * caller applies them set-wise); otherwise they use the sibling-relative reading.
 */
function compoundMatches(el: HtmlElement, c: Compound, ctx: MatchContext, skipPositional = false): boolean {
  if (!tagMatches(el, c, ctx)) return false;
  const simples = c.simples;
  for (let i = 0; i < simples.length; i++) {
    const s = simples[i]!;
    if (s.kind === 'pos') {
      if (skipPositional) continue;
      const prefix: Compound = { tag: c.tag, tagLower: c.tagLower, simples: simples.slice(0, i), positional: false };
      const peers = siblingList(el, ctx).filter((sib) => compoundMatches(sib, prefix, ctx));
      if (!applyPositional(peers, s).includes(el)) return false;
      continue;
    }
    if (!simpleMatches(el, s, ctx)) return false;
  }
  return true;
}

function isAncestor(anc: HtmlElement, el: HtmlElement): boolean {
  for (let p = el.parent; p !== null; p = p.parent) if (p === anc) return true;
  return false;
}

/** Relation between the leftmost compound's element and the :has() anchor. */
function relatesToAnchor(el: HtmlElement, comb: Combinator, anchor: HtmlElement): boolean {
  switch (comb) {
    case ' ':
      return isAncestor(anchor, el);
    case '>':
      return el.parent === anchor;
    case '+':
      return previousElementSibling(el) === anchor;
    case '~':
      for (let s = previousElementSibling(el); s !== null; s = previousElementSibling(s)) {
        if (s === anchor) return true;
      }
      return false;
  }
}

/** Does `el` match compounds[0..i] of `cx`, with compounds[i] at `el`? */
function matchAt(el: HtmlElement, cx: Complex, i: number, ctx: MatchContext, anchor: HtmlElement | null): boolean {
  const compound = cx.compounds[i];
  if (compound === undefined || !compoundMatches(el, compound, ctx)) return false;
  if (i === 0) return anchor === null || relatesToAnchor(el, cx.leading ?? ' ', anchor);
  switch (cx.combinators[i - 1]) {
    case '>': {
      const p = parentElement(el);
      return p !== null && matchAt(p, cx, i - 1, ctx, anchor);
    }
    case ' ':
      for (let p = parentElement(el); p !== null; p = parentElement(p)) {
        if (matchAt(p, cx, i - 1, ctx, anchor)) return true;
        if (p === anchor) return false; // nothing above the :has() anchor can qualify
      }
      return false;
    case '+': {
      const s = previousElementSibling(el);
      return s !== null && matchAt(s, cx, i - 1, ctx, anchor);
    }
    case '~':
      for (let s = previousElementSibling(el); s !== null; s = previousElementSibling(s)) {
        if (matchAt(s, cx, i - 1, ctx, anchor)) return true;
      }
      return false;
    default:
      return false;
  }
}

function hasMatches(el: HtmlElement, list: Complex[], ctx: MatchContext): boolean {
  for (const cx of list) {
    const last = cx.compounds.length - 1;
    const leading = cx.leading ?? ' ';
    let candidates: HtmlElement[];
    if (leading === ' ' || leading === '>') {
      candidates = descendantElements(el);
    } else {
      candidates = [];
      const parent = el.parent;
      if (parent === null) continue;
      let seen = false;
      for (const sib of parent.children) {
        if (sib === el) {
          seen = true;
          continue;
        }
        if (!seen || sib.type !== 'element') continue;
        candidates.push(sib, ...descendantElements(sib));
      }
    }
    for (const cand of candidates) {
      if (matchAt(cand, cx, last, ctx, el)) return true;
    }
  }
  return false;
}

/** jQuery-style left-to-right set evaluation for complex selectors with positional pseudos. */
function evaluateSetwise(cx: Complex, all: HtmlElement[], ctx: MatchContext): HtmlElement[] {
  let current: HtmlElement[] = [];
  for (let i = 0; i < cx.compounds.length; i++) {
    const compound = cx.compounds[i]!;
    let next: HtmlElement[];
    if (i === 0) {
      next = all.filter((el) => compoundMatches(el, compound, ctx, true));
    } else {
      const prev = new Set(current);
      const comb = cx.combinators[i - 1];
      next = all.filter((el) => {
        if (!compoundMatches(el, compound, ctx, true)) return false;
        switch (comb) {
          case '>':
            return el.parent !== null && el.parent.type === 'element' && prev.has(el.parent);
          case '+': {
            const s = previousElementSibling(el);
            return s !== null && prev.has(s);
          }
          case '~':
            for (let s = previousElementSibling(el); s !== null; s = previousElementSibling(s)) {
              if (prev.has(s)) return true;
            }
            return false;
          default:
            for (let p = parentElement(el); p !== null; p = parentElement(p)) if (prev.has(p)) return true;
            return false;
        }
      });
    }
    for (const s of compound.simples) if (s.kind === 'pos') next = applyPositional(next, s);
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

function selectAll(context: HtmlParent, list: Complex[], firstOnly: boolean): HtmlElement[] {
  const ctx = makeContext(context, context);
  const all = descendantElements(context);
  const plain = list.filter((cx) => !cx.positional);
  const positional = list.filter((cx) => cx.positional);
  const matchesPlain = (el: HtmlElement): boolean =>
    plain.some((cx) => matchAt(el, cx, cx.compounds.length - 1, ctx, null));
  if (positional.length === 0) {
    if (firstOnly) {
      for (const el of all) if (matchesPlain(el)) return [el];
      return [];
    }
    return all.filter(matchesPlain);
  }
  const extra = new Set<HtmlElement>();
  for (const cx of positional) for (const el of evaluateSetwise(cx, all, ctx)) extra.add(el);
  const out: HtmlElement[] = [];
  for (const el of all) {
    if (extra.has(el) || matchesPlain(el)) {
      out.push(el);
      if (firstOnly) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API

/** Matching descendants of `context` (never `context` itself), document order, deduplicated. */
export function querySelectorAll(context: HtmlParent, selector: string): HtmlElement[] {
  return selectAll(context, compile(selector), false);
}

export function querySelector(context: HtmlParent, selector: string): HtmlElement | null {
  return selectAll(context, compile(selector), true)[0] ?? null;
}

/**
 * Does `el` itself match `selector`? Ancestors/siblings are considered for
 * combinators. `scope` is what `:scope` refers to.
 */
export function matches(el: HtmlElement, selector: string, scope?: HtmlParent): boolean {
  const list = compile(selector);
  const ctx = makeContext(el, scope ?? null);
  return list.some((cx) => matchAt(el, cx, cx.compounds.length - 1, ctx, null));
}

/** Validate a selector without running it (throws SelectorSyntaxError). */
export function compileSelector(selector: string): void {
  compile(selector);
}
