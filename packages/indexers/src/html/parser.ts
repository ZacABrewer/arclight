/**
 * Tag-soup tolerant HTML / XML parser.
 *
 * A single forward scan over the source (indexOf-driven, no backtracking
 * regexes) feeds a small tree builder that keeps a stack of open elements.
 * HTML mode applies a pragmatic subset of browser recovery rules: void and
 * raw-text elements, implied end tags for p/li/dt/dd/option/table parts,
 * implicit tbody/tr, scoped end-tag matching, and silent dropping of stray end
 * tags. It never throws.
 */
import { decodeEntitiesInternal } from './entities.js';
import {
  VOID_ELEMENTS,
  type HtmlComment,
  type HtmlDocument,
  type HtmlElement,
  type HtmlParent,
  type HtmlText,
} from './dom.js';

/** Content runs to the matching end tag as one text node. */
const RAW_TEXT: ReadonlySet<string> = new Set([
  'script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes',
]);
/** Raw-text elements whose content still gets entity decoding. */
const ESCAPABLE_RAW_TEXT: ReadonlySet<string> = new Set(['textarea', 'title']);

/** Known HTML elements: for these, `<x/>` is treated as a plain start tag. */
const KNOWN_HTML: ReadonlySet<string> = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'blockquote', 'body',
  'button', 'canvas', 'caption', 'center', 'cite', 'code', 'colgroup', 'data', 'datalist', 'dd',
  'del', 'details', 'dfn', 'dialog', 'dir', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption',
  'figure', 'font', 'footer', 'form', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head',
  'header', 'hgroup', 'html', 'i', 'iframe', 'ins', 'kbd', 'label', 'legend', 'li', 'main',
  'map', 'mark', 'marquee', 'menu', 'meter', 'nav', 'nobr', 'noembed', 'noframes', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 'rp',
  'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'span',
  'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template',
  'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'tt', 'u', 'ul', 'var', 'video',
  'xmp',
]);

/** Start tags that implicitly close an open `p`. */
const CLOSES_P: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl',
  'dd', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'ul', 'xmp', 'search', 'listing', 'plaintext',
]);

const P_SCOPE = new Set(['button', 'table', 'td', 'th', 'caption', 'marquee', 'object', 'applet', 'template', 'html']);
const LI_SCOPE = new Set(['ul', 'ol', 'menu', 'table', 'td', 'th', 'caption', 'html']);
const DLIST_SCOPE = new Set(['dl', 'table', 'td', 'th', 'caption', 'html']);
const TR_SCOPE = new Set(['table', 'tbody', 'thead', 'tfoot', 'html']);
const CELL_SCOPE = new Set(['tr', 'table', 'tbody', 'thead', 'tfoot', 'html']);
const SECTION_SCOPE = new Set(['table', 'html']);
const A_SCOPE = new Set(['td', 'th', 'table', 'caption', 'marquee', 'object', 'applet', 'button', 'html']);

const TABLE_SECTIONS = new Set(['tbody', 'thead', 'tfoot']);
/** Elements a new table section closes (rows and cells above them are popped too). */
const SECTION_CLOSERS = new Set(['tbody', 'thead', 'tfoot', 'caption', 'colgroup']);
const TABLE_INTERNAL = new Set(['tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'caption', 'colgroup']);
/** End tags for ordinary elements do not cross these. */
const GENERAL_SCOPE = new Set(['td', 'th', 'table', 'caption', 'marquee', 'object', 'applet', 'template']);
const NO_SCOPE: ReadonlySet<string> = new Set();

const SET_P = new Set(['p']);
const SET_LI = new Set(['li']);
const SET_DLIST = new Set(['dt', 'dd']);
const SET_TR = new Set(['tr']);
const SET_CELL = new Set(['td', 'th']);
const SET_A = new Set(['a']);

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

class TreeBuilder {
  private readonly src: string;
  private readonly len: number;
  private readonly xml: boolean;
  private pos = 0;
  readonly doc: HtmlDocument;
  /** stack[0] is always the document. */
  private readonly stack: HtmlParent[];
  /** How many elements of each tag name are currently open (lets stray end tags bail in O(1)). */
  private readonly openCounts = new Map<string, number>();

  constructor(src: string, xml: boolean) {
    this.src = src;
    this.len = src.length;
    this.xml = xml;
    this.doc = { type: 'document', children: [], parent: null, xml };
    this.stack = [this.doc];
  }

  private get current(): HtmlParent {
    return this.stack[this.stack.length - 1]!;
  }

  private push(el: HtmlElement): void {
    this.stack.push(el);
    this.openCounts.set(el.tagName, (this.openCounts.get(el.tagName) ?? 0) + 1);
  }

  /** Pop elements until the stack has `length` entries. */
  private popTo(length: number): void {
    while (this.stack.length > length) {
      const n = this.stack.pop()!;
      if (n.type === 'element') this.openCounts.set(n.tagName, (this.openCounts.get(n.tagName) ?? 1) - 1);
    }
  }

  private isOpen(name: string): boolean {
    return (this.openCounts.get(name) ?? 0) > 0;
  }

  private currentTag(): string | null {
    const c = this.current;
    return c.type === 'element' ? c.tagName : null;
  }

  run(): HtmlDocument {
    const { src, len } = this;
    let textStart = 0;
    let searchFrom = 0;
    while (searchFrom < len) {
      const lt = src.indexOf('<', searchFrom);
      if (lt === -1) break;
      if (!this.looksLikeMarkup(lt)) {
        // A literal '<' stays inside the surrounding text run.
        searchFrom = lt + 1;
        continue;
      }
      if (lt > textStart) this.appendText(src.slice(textStart, lt), true);
      this.pos = lt;
      this.markup();
      textStart = this.pos;
      searchFrom = this.pos;
    }
    if (textStart < len) this.appendText(src.slice(textStart), true);
    return this.doc;
  }

  private looksLikeMarkup(lt: number): boolean {
    const c = this.src.charCodeAt(lt + 1);
    if (isAsciiLetter(c) || c === 33 /* ! */ || c === 63 /* ? */) return true;
    if (c === 47 /* / */) return lt + 2 < this.len;
    if (this.xml && (c === 95 || c > 127)) return true;
    return false;
  }

  /** Called with this.pos at a '<' that looksLikeMarkup. Advances this.pos past it. */
  private markup(): void {
    const { src } = this;
    const c = src.charCodeAt(this.pos + 1);
    if (c === 33) {
      if (src.startsWith('<!--', this.pos)) return this.comment();
      if (src.startsWith('<![CDATA[', this.pos)) return this.cdata();
      return this.declaration();
    }
    if (c === 63) return this.processingInstruction();
    if (c === 47) {
      const c2 = src.charCodeAt(this.pos + 2);
      if (isAsciiLetter(c2) || (this.xml && (c2 === 95 || c2 > 127))) return this.endTag();
      // `</>` or `</ junk>`: swallow up to the next '>'.
      return this.skipPast('>', this.pos + 2);
    }
    this.startTag();
  }

  private skipPast(needle: string, from: number): void {
    const end = this.src.indexOf(needle, from);
    this.pos = end === -1 ? this.len : end + needle.length;
  }

  private comment(): void {
    const { src } = this;
    const start = this.pos + 4;
    // `<!-->` and `<!--->` are complete, empty comments.
    if (src.startsWith('>', start)) {
      this.appendNode(this.makeComment(''));
      this.pos = start + 1;
      return;
    }
    if (src.startsWith('->', start)) {
      this.appendNode(this.makeComment(''));
      this.pos = start + 2;
      return;
    }
    const end = src.indexOf('-->', start);
    if (end === -1) {
      this.appendNode(this.makeComment(src.slice(start)));
      this.pos = this.len;
    } else {
      this.appendNode(this.makeComment(src.slice(start, end)));
      this.pos = end + 3;
    }
  }

  private cdata(): void {
    const start = this.pos + 9;
    const end = this.src.indexOf(']]>', start);
    const data = end === -1 ? this.src.slice(start) : this.src.slice(start, end);
    this.pos = end === -1 ? this.len : end + 3;
    // XML: CDATA is literal text. HTML content: browsers treat it as a comment.
    if (this.xml) this.appendText(data, false);
    else this.appendNode(this.makeComment(`[CDATA[${data}]]`));
  }

  /** `<!DOCTYPE ...>` and other `<!...>` declarations, including an internal `[...]` subset. */
  private declaration(): void {
    const { src, len } = this;
    let i = this.pos + 2;
    while (i < len) {
      const c = src.charCodeAt(i);
      if (c === 62) {
        this.pos = i + 1;
        return;
      }
      if (c === 91 /* [ */) {
        const close = src.indexOf(']', i + 1);
        if (close === -1) break;
        i = close + 1;
        continue;
      }
      i++;
    }
    this.pos = len;
  }

  private processingInstruction(): void {
    this.skipPast(this.xml ? '?>' : '>', this.pos + 2);
  }

  /** Reads a tag name starting at i; returns the end index. */
  private scanName(i: number): number {
    const { src, len } = this;
    while (i < len) {
      const c = src.charCodeAt(i);
      if (isWs(c) || c === 47 || c === 62) break;
      i++;
    }
    return i;
  }

  private startTag(): void {
    const { src, len, xml } = this;
    let i = this.pos + 1;
    const nameEnd = this.scanName(i);
    const rawName = src.slice(i, nameEnd);
    const name = xml ? rawName : rawName.toLowerCase();
    i = nameEnd;
    const attributes = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      while (i < len && isWs(src.charCodeAt(i))) i++;
      if (i >= len) {
        // Unterminated tag at EOF: dropped, as browsers do.
        this.pos = len;
        return;
      }
      const c = src.charCodeAt(i);
      if (c === 62) {
        i++;
        break;
      }
      if (c === 47) {
        i++;
        if (src.charCodeAt(i) === 62) {
          selfClosing = true;
          i++;
          break;
        }
        continue;
      }
      const attrStart = i;
      i++; // first char may be anything (even '='), per tag-soup rules
      while (i < len) {
        const d = src.charCodeAt(i);
        if (isWs(d) || d === 47 || d === 62 || d === 61) break;
        i++;
      }
      const rawAttr = src.slice(attrStart, i);
      let j = i;
      while (j < len && isWs(src.charCodeAt(j))) j++;
      let value = '';
      if (src.charCodeAt(j) === 61 /* = */) {
        j++;
        while (j < len && isWs(src.charCodeAt(j))) j++;
        const q = src.charCodeAt(j);
        if (q === 34 || q === 39) {
          const close = src.indexOf(q === 34 ? '"' : "'", j + 1);
          if (close === -1) {
            value = src.slice(j + 1);
            j = len;
          } else {
            value = src.slice(j + 1, close);
            j = close + 1;
          }
        } else {
          const vs = j;
          while (j < len) {
            const d = src.charCodeAt(j);
            if (isWs(d) || d === 62) break;
            j++;
          }
          value = src.slice(vs, j);
        }
        value = decodeEntitiesInternal(value, true);
        i = j;
      }
      const attrName = xml ? rawAttr : rawAttr.toLowerCase();
      if (!attributes.has(attrName)) attributes.set(attrName, value);
    }
    this.pos = i;
    this.openElement(name, attributes, selfClosing);
  }

  private openElement(name: string, attributes: Map<string, string>, selfClosing: boolean): void {
    if (this.xml) {
      const el = this.makeElement(name, attributes);
      this.appendNode(el);
      if (!selfClosing) this.push(el);
      return;
    }
    this.applyImpliedEnds(name);
    const el = this.makeElement(name, attributes);
    this.appendNode(el);
    if (VOID_ELEMENTS.has(name)) return;
    if (selfClosing && (!KNOWN_HTML.has(name) || this.inForeignContent())) return;
    if (RAW_TEXT.has(name)) {
      this.rawText(el);
      return;
    }
    this.push(el);
  }

  private inForeignContent(): boolean {
    if (!this.isOpen('svg') && !this.isOpen('math')) return false;
    for (let i = this.stack.length - 1; i > 0; i--) {
      const n = this.stack[i]!;
      if (n.type === 'element' && (n.tagName === 'svg' || n.tagName === 'math')) return true;
    }
    return false;
  }

  /** Content up to the matching (case-insensitive) end tag becomes one text node. */
  private rawText(el: HtmlElement): void {
    const { src, len } = this;
    const name = el.tagName;
    let from = this.pos;
    let close = -1;
    while (from < len) {
      const k = src.indexOf('</', from);
      if (k === -1) break;
      const after = k + 2 + name.length;
      if (src.slice(k + 2, after).toLowerCase() === name) {
        const c = src.charCodeAt(after);
        if (after >= len || isWs(c) || c === 47 || c === 62) {
          close = k;
          break;
        }
      }
      from = k + 2;
    }
    const end = close === -1 ? len : close;
    if (end > this.pos) {
      const raw = src.slice(this.pos, end);
      const data = ESCAPABLE_RAW_TEXT.has(name) ? decodeEntitiesInternal(raw, false) : raw;
      const text: HtmlText = { type: 'text', data, parent: el };
      el.children.push(text);
    }
    if (close === -1) {
      this.pos = len;
    } else {
      const gt = src.indexOf('>', close);
      this.pos = gt === -1 ? len : gt + 1;
    }
  }

  /**
   * Walk the open-element stack from the top; if an element in `targets` is
   * found before one in `stopAt`, pop everything down to and including it.
   */
  private closeImplied(targets: ReadonlySet<string>, stopAt: ReadonlySet<string>): void {
    let anyOpen = false;
    for (const t of targets) if (this.isOpen(t)) anyOpen = true;
    if (!anyOpen) return;
    for (let i = this.stack.length - 1; i > 0; i--) {
      const n = this.stack[i]!;
      if (n.type !== 'element') return;
      if (targets.has(n.tagName)) {
        this.popTo(i);
        return;
      }
      if (stopAt.has(n.tagName)) return;
    }
  }

  private insertImplicit(name: string): void {
    const el = this.makeElement(name, new Map());
    this.appendNode(el);
    this.push(el);
  }

  private applyImpliedEnds(name: string): void {
    if (CLOSES_P.has(name)) this.closeImplied(SET_P, P_SCOPE);
    switch (name) {
      case 'li':
        this.closeImplied(SET_LI, LI_SCOPE);
        break;
      case 'dt':
      case 'dd':
        this.closeImplied(SET_DLIST, DLIST_SCOPE);
        break;
      case 'option':
        if (this.currentTag() === 'option') this.popTo(this.stack.length - 1);
        break;
      case 'optgroup':
        if (this.currentTag() === 'option') this.popTo(this.stack.length - 1);
        if (this.currentTag() === 'optgroup') this.popTo(this.stack.length - 1);
        break;
      case 'a':
        this.closeImplied(SET_A, A_SCOPE);
        break;
      case 'tr':
        this.closeImplied(SET_TR, TR_SCOPE);
        if (this.currentTag() === 'table') this.insertImplicit('tbody');
        break;
      case 'td':
      case 'th': {
        this.closeImplied(SET_CELL, CELL_SCOPE);
        if (this.currentTag() === 'table') this.insertImplicit('tbody');
        const cur = this.currentTag();
        if (cur !== null && TABLE_SECTIONS.has(cur)) this.insertImplicit('tr');
        break;
      }
      case 'thead':
      case 'tbody':
      case 'tfoot':
      case 'caption':
      case 'colgroup':
        this.closeImplied(SECTION_CLOSERS, SECTION_SCOPE);
        break;
    }
  }

  private endTag(): void {
    const { src, xml } = this;
    const start = this.pos + 2;
    const nameEnd = this.scanName(start);
    const rawName = src.slice(start, nameEnd);
    const name = xml ? rawName : rawName.toLowerCase();
    this.skipPast('>', nameEnd);

    if (!xml && name === 'br') {
      // Browsers turn a stray </br> into <br>.
      this.appendNode(this.makeElement('br', new Map()));
      return;
    }
    const boundary = xml
      ? NO_SCOPE
      : name === 'table'
        ? NO_SCOPE
        : TABLE_INTERNAL.has(name)
          ? SECTION_SCOPE
          : GENERAL_SCOPE;
    if (!this.isOpen(name)) return; // stray end tag
    for (let i = this.stack.length - 1; i > 0; i--) {
      const n = this.stack[i]!;
      if (n.type !== 'element') return;
      if (n.tagName === name) {
        this.popTo(i);
        return;
      }
      if (boundary.has(n.tagName)) return;
    }
    // Not open: stray end tag, ignored.
  }

  private makeElement(tagName: string, attributes: Map<string, string>): HtmlElement {
    return { type: 'element', tagName, attributes, children: [], parent: null };
  }

  private makeComment(data: string): HtmlComment {
    return { type: 'comment', data, parent: null };
  }

  private appendNode(node: HtmlElement | HtmlComment | HtmlText): void {
    const parent = this.current;
    node.parent = parent;
    parent.children.push(node);
  }

  private appendText(raw: string, decode: boolean): void {
    if (raw.length === 0) return;
    const data = decode ? decodeEntitiesInternal(raw, false) : raw;
    this.appendNode({ type: 'text', data, parent: null });
  }
}

/** Parse HTML with browser-like error recovery. Never throws. */
export function parseHtml(source: string): HtmlDocument {
  return new TreeBuilder(String(source ?? ''), false).run();
}

/**
 * Parse XML: case-preserving names, no implied tags, `<x/>` always
 * self-closes, CDATA becomes text, `<?...?>` and doctype skipped. Never throws.
 */
export function parseXml(source: string): HtmlDocument {
  return new TreeBuilder(String(source ?? ''), true).run();
}
