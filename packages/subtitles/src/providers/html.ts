// Minimal HTML helpers for the scraper providers. Not a parser: tolerant regex and
// tag-balancing over the markup, enough for table rows, list items and anchors.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»',
  ndash: '–', mdash: '—', hellip: '…', copy: '©', eacute: 'é', egrave: 'è', aacute: 'á',
  agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', ouml: 'ö',
  uuml: 'ü', auml: 'ä', szlig: 'ß',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Text content: tags removed, <br> as newline, entities decoded, whitespace collapsed per line. */
export function textContent(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Attribute value from an opening tag string (or any HTML fragment's first tag). */
export function getAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

export interface Element {
  /** The opening tag, e.g. `<tr class="x">`. */
  open: string;
  /** Inner HTML. */
  inner: string;
  /** Whole element including open/close tags. */
  outer: string;
}

/**
 * All elements with the given tag name whose opening tag satisfies `filter`, nested tags of
 * the same name balanced. Unclosed elements run to the end of the input.
 */
export function findElements(html: string, tagName: string, filter?: (openTag: string) => boolean): Element[] {
  const out: Element[] = [];
  const openRe = new RegExp(`<${tagName}(?=[\\s>/])[^>]*>`, 'gi');
  const anyRe = new RegExp(`<(/?)${tagName}(?=[\\s>/])[^>]*>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    const open = m[0];
    if (filter && !filter(open)) continue;
    const start = m.index;
    const innerStart = start + open.length;
    anyRe.lastIndex = innerStart;
    let depth = 1;
    let end = html.length;
    let innerEnd = html.length;
    let t: RegExpExecArray | null;
    while ((t = anyRe.exec(html))) {
      if (t[1] === '/') depth--;
      else if (!t[0].endsWith('/>')) depth++;
      if (depth === 0) {
        innerEnd = t.index;
        end = t.index + t[0].length;
        break;
      }
    }
    out.push({ open, inner: html.slice(innerStart, innerEnd), outer: html.slice(start, end) });
  }
  return out;
}

/** Elements whose class attribute contains the given class. */
export function byClass(html: string, tagName: string, className: string): Element[] {
  return findElements(html, tagName, (o) => (getAttr(o, 'class') ?? '').split(/\s+/).includes(className));
}

export interface Anchor {
  href: string;
  text: string;
  open: string;
}

export function anchors(html: string): Anchor[] {
  return findElements(html, 'a').map((e) => ({ href: getAttr(e.open, 'href') ?? '', text: textContent(e.inner), open: e.open }));
}

/** Resolve a possibly relative href against a base URL. */
export function absoluteUrl(href: string, base: string): string {
  return new URL(href, base).toString();
}
