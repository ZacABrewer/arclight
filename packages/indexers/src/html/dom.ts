/**
 * Minimal DOM-ish node model plus tree helpers and a serializer.
 * Every traversal here is iterative so deeply nested tag soup cannot blow the stack.
 */
import { encodeEntities } from './entities.js';

export interface HtmlText {
  type: 'text';
  data: string;
  parent: HtmlParent | null;
}

export interface HtmlComment {
  type: 'comment';
  data: string;
  parent: HtmlParent | null;
}

export interface HtmlElement {
  type: 'element';
  /** Lower-cased in HTML mode; as written in XML mode. */
  tagName: string;
  /** Names lower-cased in HTML mode; values entity-decoded. */
  attributes: Map<string, string>;
  children: HtmlNode[];
  parent: HtmlParent | null;
}

export interface HtmlDocument {
  type: 'document';
  children: HtmlNode[];
  parent: null;
  xml: boolean;
}

export type HtmlParent = HtmlElement | HtmlDocument;
export type HtmlNode = HtmlElement | HtmlText | HtmlComment;

/** HTML elements that never have content or an end tag. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
  'source', 'track', 'wbr', 'keygen', 'basefont', 'bgsound', 'frame',
]);

/** Elements whose text content is serialized verbatim (no escaping). */
const UNESCAPED_TEXT_PARENTS: ReadonlySet<string> = new Set([
  'script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext',
]);

/** Concatenated descendant text, in document order, with no separators or trimming. */
export function textContent(node: HtmlNode | HtmlDocument): string {
  if (node.type === 'text' || node.type === 'comment') return node.data;
  const out: string[] = [];
  const stack: HtmlNode[] = [];
  for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'text') out.push(n.data);
    else if (n.type === 'element') {
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
  }
  return out.join('');
}

/** Attribute lookup: exact name first, then lower-cased name. */
export function getAttribute(el: HtmlElement, name: string): string | undefined {
  const v = el.attributes.get(name);
  if (v !== undefined) return v;
  const lower = name.toLowerCase();
  return lower === name ? undefined : el.attributes.get(lower);
}

/** Remove a node from its parent (no-op when already detached). */
export function detach(node: HtmlNode): void {
  const parent = node.parent;
  if (parent === null) return;
  const idx = parent.children.indexOf(node);
  if (idx !== -1) parent.children.splice(idx, 1);
  node.parent = null;
}

/** Append `node` to `parent`, detaching it from any previous parent first. */
export function appendChild(parent: HtmlParent, node: HtmlNode): void {
  // Refuse to create a cycle (appending an ancestor into its own subtree).
  if (node.type === 'element') {
    for (let p: HtmlParent | null = parent; p !== null; p = p.parent) {
      if (p === node) throw new Error('appendChild: cannot append a node into its own subtree');
    }
  }
  detach(node);
  parent.children.push(node);
  node.parent = parent;
}

export function elementChildren(parent: HtmlParent): HtmlElement[] {
  const out: HtmlElement[] = [];
  for (const c of parent.children) if (c.type === 'element') out.push(c);
  return out;
}

export function previousElementSibling(el: HtmlElement): HtmlElement | null {
  const parent = el.parent;
  if (parent === null) return null;
  const siblings = parent.children;
  for (let i = siblings.indexOf(el) - 1; i >= 0; i--) {
    const s = siblings[i]!;
    if (s.type === 'element') return s;
  }
  return null;
}

export function nextElementSibling(el: HtmlElement): HtmlElement | null {
  const parent = el.parent;
  if (parent === null) return null;
  const siblings = parent.children;
  const idx = siblings.indexOf(el);
  if (idx === -1) return null;
  for (let i = idx + 1; i < siblings.length; i++) {
    const s = siblings[i]!;
    if (s.type === 'element') return s;
  }
  return null;
}

/** All element descendants of `parent` (excluding `parent`), in document order. */
export function descendantElements(parent: HtmlParent): HtmlElement[] {
  const out: HtmlElement[] = [];
  const stack: HtmlNode[] = [];
  for (let i = parent.children.length - 1; i >= 0; i--) stack.push(parent.children[i]!);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type !== 'element') continue;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}

/** The owning document, or null for a detached subtree. */
export function ownerDocument(node: HtmlNode | HtmlDocument): HtmlDocument | null {
  let cur: HtmlNode | HtmlParent = node;
  while (cur.type !== 'document') {
    const p: HtmlParent | null = cur.parent;
    if (p === null) return null;
    cur = p;
  }
  return cur;
}

function escapeText(text: string): string {
  if (!/[&<>]/.test(text)) return text;
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** Serialize a node (or document) back to markup. Attribute values are re-escaped. */
export function outerHtml(node: HtmlNode | HtmlDocument): string {
  const xml = ownerDocument(node)?.xml ?? false;
  const out: string[] = [];
  const stack: Array<HtmlNode | HtmlDocument | string> = [node];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    switch (item.type) {
      case 'text': {
        const parent = item.parent;
        const raw =
          !xml && parent !== null && parent.type === 'element' &&
          UNESCAPED_TEXT_PARENTS.has(parent.tagName);
        out.push(raw ? item.data : escapeText(item.data));
        break;
      }
      case 'comment':
        out.push(`<!--${item.data}-->`);
        break;
      case 'document':
        for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]!);
        break;
      case 'element': {
        let open = `<${item.tagName}`;
        for (const [name, value] of item.attributes) open += ` ${name}="${encodeEntities(value)}"`;
        if (item.children.length === 0 && (xml || VOID_ELEMENTS.has(item.tagName))) {
          out.push(xml ? `${open}/>` : `${open}>`);
          break;
        }
        out.push(`${open}>`);
        stack.push(`</${item.tagName}>`);
        for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]!);
        break;
      }
    }
  }
  return out.join('');
}
