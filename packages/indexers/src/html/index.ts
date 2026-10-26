export type {
  HtmlComment,
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  HtmlParent,
  HtmlText,
} from './dom.js';
export {
  appendChild,
  detach,
  elementChildren,
  getAttribute,
  nextElementSibling,
  outerHtml,
  previousElementSibling,
  textContent,
} from './dom.js';
export { decodeEntities, encodeEntities } from './entities.js';
export { parseHtml, parseXml } from './parser.js';
export {
  SelectorSyntaxError,
  compileSelector,
  matches,
  querySelector,
  querySelectorAll,
} from './selector.js';

import { detach, type HtmlParent } from './dom.js';
import { querySelectorAll } from './selector.js';

/** Detach every descendant of `context` matching `selector`; returns how many matched. */
export function removeMatching(context: HtmlParent, selector: string): number {
  const found = querySelectorAll(context, selector);
  for (const el of found) detach(el);
  return found.length;
}
