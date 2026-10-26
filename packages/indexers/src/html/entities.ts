/**
 * HTML character reference decoding / encoding.
 *
 * Covers the Latin-1 range, common typographic and Greek entities, and a few
 * ASCII punctuation names. Numeric references (decimal and hex) are always
 * decoded. A small set of "legacy" names (amp, lt, gt, quot, apos, nbsp, copy,
 * reg) is also recognised without a trailing semicolon, mirroring what
 * browsers do with sloppy markup.
 */

const LATIN1_NAMES = [
  'nbsp', 'iexcl', 'cent', 'pound', 'curren', 'yen', 'brvbar', 'sect', 'uml', 'copy', 'ordf',
  'laquo', 'not', 'shy', 'reg', 'macr', 'deg', 'plusmn', 'sup2', 'sup3', 'acute', 'micro',
  'para', 'middot', 'cedil', 'sup1', 'ordm', 'raquo', 'frac14', 'frac12', 'frac34', 'iquest',
  'Agrave', 'Aacute', 'Acirc', 'Atilde', 'Auml', 'Aring', 'AElig', 'Ccedil', 'Egrave',
  'Eacute', 'Ecirc', 'Euml', 'Igrave', 'Iacute', 'Icirc', 'Iuml', 'ETH', 'Ntilde', 'Ograve',
  'Oacute', 'Ocirc', 'Otilde', 'Ouml', 'times', 'Oslash', 'Ugrave', 'Uacute', 'Ucirc', 'Uuml',
  'Yacute', 'THORN', 'szlig', 'agrave', 'aacute', 'acirc', 'atilde', 'auml', 'aring', 'aelig',
  'ccedil', 'egrave', 'eacute', 'ecirc', 'euml', 'igrave', 'iacute', 'icirc', 'iuml', 'eth',
  'ntilde', 'ograve', 'oacute', 'ocirc', 'otilde', 'ouml', 'divide', 'oslash', 'ugrave',
  'uacute', 'ucirc', 'uuml', 'yacute', 'thorn', 'yuml',
] as const;

/** Greek capitals from U+0391; the empty slot is the unassigned U+03A2. */
const GREEK_UPPER = [
  'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa',
  'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', '', 'Sigma', 'Tau', 'Upsilon', 'Phi',
  'Chi', 'Psi', 'Omega',
] as const;

const EXTRA: ReadonlyArray<readonly [string, number]> = [
  ['amp', 38], ['lt', 60], ['gt', 62], ['quot', 34], ['apos', 39],
  ['AMP', 38], ['LT', 60], ['GT', 62], ['QUOT', 34], ['COPY', 169], ['REG', 174],
  ['Tab', 9], ['NewLine', 10], ['excl', 33], ['num', 35], ['dollar', 36], ['percnt', 37],
  ['lpar', 40], ['rpar', 41], ['ast', 42], ['plus', 43], ['comma', 44], ['period', 46],
  ['sol', 47], ['colon', 58], ['semi', 59], ['equals', 61], ['quest', 63], ['commat', 64],
  ['lsqb', 91], ['lbrack', 91], ['bsol', 92], ['rsqb', 93], ['rbrack', 93], ['Hat', 94],
  ['lowbar', 95], ['grave', 96], ['lcub', 123], ['lbrace', 123], ['verbar', 124],
  ['vert', 124], ['rcub', 125], ['rbrace', 125],
  ['OElig', 338], ['oelig', 339], ['Scaron', 352], ['scaron', 353], ['Yuml', 376],
  ['fnof', 402], ['circ', 710], ['tilde', 732], ['ensp', 8194], ['emsp', 8195],
  ['thinsp', 8201], ['zwnj', 8204], ['zwj', 8205], ['lrm', 8206], ['rlm', 8207],
  ['hyphen', 8208], ['ndash', 8211], ['mdash', 8212], ['horbar', 8213], ['lsquo', 8216],
  ['rsquo', 8217], ['sbquo', 8218], ['ldquo', 8220], ['rdquo', 8221], ['bdquo', 8222],
  ['dagger', 8224], ['Dagger', 8225], ['bull', 8226], ['bullet', 8226], ['hellip', 8230],
  ['permil', 8240], ['prime', 8242], ['Prime', 8243], ['lsaquo', 8249], ['rsaquo', 8250],
  ['oline', 8254], ['frasl', 8260], ['euro', 8364], ['trade', 8482], ['TRADE', 8482],
  ['larr', 8592], ['uarr', 8593], ['rarr', 8594], ['darr', 8595], ['harr', 8596],
  ['crarr', 8629], ['lArr', 8656], ['uArr', 8657], ['rArr', 8658], ['dArr', 8659],
  ['hArr', 8660], ['forall', 8704], ['part', 8706], ['exist', 8707], ['empty', 8709],
  ['nabla', 8711], ['isin', 8712], ['notin', 8713], ['ni', 8715], ['prod', 8719],
  ['sum', 8721], ['minus', 8722], ['lowast', 8727], ['radic', 8730], ['prop', 8733],
  ['infin', 8734], ['ang', 8736], ['and', 8743], ['or', 8744], ['cap', 8745], ['cup', 8746],
  ['int', 8747], ['there4', 8756], ['sim', 8764], ['cong', 8773], ['asymp', 8776],
  ['ne', 8800], ['equiv', 8801], ['le', 8804], ['ge', 8805], ['sub', 8834], ['sup', 8835],
  ['nsub', 8836], ['sube', 8838], ['supe', 8839], ['oplus', 8853], ['otimes', 8855],
  ['perp', 8869], ['sdot', 8901], ['lceil', 8968], ['rceil', 8969], ['lfloor', 8970],
  ['rfloor', 8971], ['lang', 10216], ['rang', 10217], ['loz', 9674], ['spades', 9824],
  ['clubs', 9827], ['hearts', 9829], ['diams', 9830], ['starf', 9733], ['star', 9734],
  ['check', 10003], ['cross', 10007], ['sigmaf', 962], ['thetasym', 977], ['upsih', 978],
  ['piv', 982],
];

const NAMED = new Map<string, number>();
LATIN1_NAMES.forEach((name, i) => NAMED.set(name, 160 + i));
GREEK_UPPER.forEach((name, i) => {
  if (name === '') return;
  NAMED.set(name, 913 + i);
  // Lower-case Greek letters sit 32 code points above their capitals.
  NAMED.set(name.charAt(0).toLowerCase() + name.slice(1), 945 + i);
});
for (const [name, cp] of EXTRA) NAMED.set(name, cp);

/** Names accepted without a terminating semicolon. Longest first for prefix matching. */
const LEGACY = ['nbsp', 'quot', 'apos', 'copy', 'amp', 'reg', 'lt', 'gt'] as const;

/** Windows-1252 interpretation of C1 control references (&#150; etc.), as browsers do. */
const C1_REMAP: ReadonlyMap<number, number> = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);

function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

function codePointToString(cp: number): string {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(C1_REMAP.get(cp) ?? cp);
}

/**
 * Decode character references. `inAttribute` applies the attribute-value rule
 * that a semicolon-less legacy reference followed by an alphanumeric or `=`
 * is left alone (so query strings like `?a=1&copy=2` survive).
 */
export function decodeEntitiesInternal(text: string, inAttribute: boolean): string {
  let amp = text.indexOf('&');
  if (amp === -1) return text;
  const parts: string[] = [];
  let last = 0;
  const len = text.length;
  while (amp !== -1) {
    let replacement: string | null = null;
    let end = amp + 1;
    if (text.charCodeAt(end) === 35 /* # */) {
      let j = end + 1;
      const hex = text.charCodeAt(j) === 120 || text.charCodeAt(j) === 88;
      if (hex) j++;
      const digitsStart = j;
      let cp = 0;
      while (j < len) {
        const c = text.charCodeAt(j);
        const v = hex ? hexValue(c) : c >= 48 && c <= 57 ? c - 48 : -1;
        if (v < 0) break;
        if (cp <= 0x10ffff) cp = cp * (hex ? 16 : 10) + v;
        j++;
      }
      if (j > digitsStart) {
        replacement = codePointToString(cp);
        end = text.charCodeAt(j) === 59 ? j + 1 : j;
      }
    } else {
      let j = end;
      while (j < len && j - end < 40 && isAlnum(text.charCodeAt(j))) j++;
      if (j > end) {
        const name = text.slice(end, j);
        const cp = text.charCodeAt(j) === 59 ? NAMED.get(name) : undefined;
        if (cp !== undefined) {
          replacement = String.fromCodePoint(cp);
          end = j + 1;
        } else {
          for (const legacy of LEGACY) {
            if (!name.startsWith(legacy)) continue;
            const after = end + legacy.length;
            if (inAttribute && after < len) {
              const next = text.charCodeAt(after);
              if (isAlnum(next) || next === 61) break;
            }
            replacement = String.fromCodePoint(NAMED.get(legacy) ?? 0xfffd);
            end = after;
            break;
          }
        }
      }
    }
    if (replacement !== null) {
      if (amp > last) parts.push(text.slice(last, amp));
      parts.push(replacement);
      last = end;
    }
    amp = text.indexOf('&', replacement !== null ? end : amp + 1);
  }
  if (last < len) parts.push(text.slice(last));
  return parts.join('');
}

/** Decode named, decimal and hex character references in text content. */
export function decodeEntities(text: string): string {
  return decodeEntitiesInternal(text, false);
}

const ENCODE_TEST = /[&<>"']/;
const ENCODE_RE = /[&<>"']/g;
const ENCODE_MAP: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

/** Escape the five HTML-significant characters: & < > " ' */
export function encodeEntities(text: string): string {
  if (!ENCODE_TEST.test(text)) return text;
  return text.replace(ENCODE_RE, (ch) => ENCODE_MAP.get(ch) ?? ch);
}
