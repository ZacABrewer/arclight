/**
 * A minimal XML-RPC codec (https://xmlrpc.com/spec.md), sized for talking to rTorrent.
 *
 * Encodes `methodCall` / `methodResponse` documents and decodes them back. It understands
 * the scalar types string, int/i4/i8 (also the `ex:i8` Apache extension spelling), boolean,
 * double, base64, dateTime.iso8601 (decoded as its raw string) and nil, plus array and
 * struct. Untyped `<value>text</value>` is a string, as the spec requires.
 *
 * The XML reader is a small hand-written parser: elements, attributes (ignored), text,
 * CDATA, comments, processing instructions and a DOCTYPE (skipped). Entity references
 * are limited to the five predefined ones plus numeric character references; anything
 * else is rejected rather than guessed at.
 */
import { fromBase64, toBase64 } from '../http.js';

/** Forces a number to be sent as `<double>` even when it is integral. */
export class XmlRpcDouble {
  constructor(readonly value: number) {}
}

/** Forces a number to be sent as `<i8>` even when it fits in 32 bits. */
export class XmlRpcI8 {
  constructor(readonly value: number) {}
}

export type XmlRpcValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | XmlRpcDouble
  | XmlRpcI8
  | XmlRpcValue[]
  | { [key: string]: XmlRpcValue };

/** Decoded values never contain the encoder-only wrapper classes. */
export type XmlRpcDecoded =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | XmlRpcDecoded[]
  | { [key: string]: XmlRpcDecoded };

/** The document is not well-formed XML or not a valid XML-RPC message. */
export class XmlRpcParseError extends Error {
  override readonly name = 'XmlRpcParseError';
}

/** The server answered with a `<fault>`. */
export class XmlRpcFault extends Error {
  override readonly name = 'XmlRpcFault';
  constructor(
    readonly faultCode: number,
    readonly faultString: string,
  ) {
    super(`XML-RPC fault ${faultCode}: ${faultString}`);
  }
}

// ------------------------------------------------------------------------------- encoding

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const I4_MIN = -(2 ** 31);
const I4_MAX = 2 ** 31 - 1;

function encodeNumber(value: number, tag?: 'double' | 'i8'): string {
  if (!Number.isFinite(value)) throw new XmlRpcParseError(`Cannot encode non-finite number ${value} in XML-RPC.`);
  if (tag === 'double' || (tag === undefined && !Number.isInteger(value))) return `<double>${String(value)}</double>`;
  if (!Number.isInteger(value)) throw new XmlRpcParseError(`Cannot encode ${value} as an integer.`);
  if (tag === 'i8' || value < I4_MIN || value > I4_MAX) return `<i8>${value.toFixed(0)}</i8>`;
  return `<i4>${value.toFixed(0)}</i4>`;
}

export function encodeValue(value: XmlRpcValue): string {
  return `<value>${encodeInner(value)}</value>`;
}

function encodeInner(value: XmlRpcValue): string {
  if (value === null) return '<nil/>';
  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`;
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'boolean') return `<boolean>${value ? 1 : 0}</boolean>`;
  if (value instanceof XmlRpcDouble) return encodeNumber(value.value, 'double');
  if (value instanceof XmlRpcI8) return encodeNumber(value.value, 'i8');
  if (value instanceof Uint8Array) return `<base64>${toBase64(value)}</base64>`;
  if (Array.isArray(value)) return `<array><data>${value.map(encodeValue).join('')}</data></array>`;
  const members = Object.entries(value)
    .map(([key, member]) => `<member><name>${escapeXml(key)}</name>${encodeValue(member)}</member>`)
    .join('');
  return `<struct>${members}</struct>`;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

export function encodeMethodCall(method: string, params: readonly XmlRpcValue[]): string {
  const encodedParams = params.map((p) => `<param>${encodeValue(p)}</param>`).join('');
  return `${XML_DECLARATION}<methodCall><methodName>${escapeXml(method)}</methodName><params>${encodedParams}</params></methodCall>`;
}

export function encodeMethodResponse(value: XmlRpcValue): string {
  return `${XML_DECLARATION}<methodResponse><params><param>${encodeValue(value)}</param></params></methodResponse>`;
}

export function encodeFault(faultCode: number, faultString: string): string {
  return `${XML_DECLARATION}<methodResponse><fault>${encodeValue({ faultCode, faultString })}</fault></methodResponse>`;
}

// ------------------------------------------------------------------------------- XML reader

interface XmlElement {
  name: string;
  children: XmlNode[];
}
type XmlNode = XmlElement | string;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&([^;&\s]*)(;?)/g, (match, body: string, semicolon: string) => {
    if (semicolon === '') throw new XmlRpcParseError(`Unterminated entity reference "${match}".`);
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) return named;
    let code: number | undefined;
    if (/^#x[0-9a-fA-F]+$/.test(body)) code = Number.parseInt(body.slice(2), 16);
    else if (/^#[0-9]+$/.test(body)) code = Number.parseInt(body.slice(1), 10);
    if (code === undefined || code > 0x10ffff) throw new XmlRpcParseError(`Unknown entity reference "${match}".`);
    return String.fromCodePoint(code);
  });
}

const WHITESPACE = /\s/;
const TAG_NAME = /[^\s/>]+/y;

class XmlReader {
  private pos = 0;
  constructor(private readonly text: string) {}

  parseDocument(): XmlElement {
    if (this.text.charCodeAt(0) === 0xfeff) this.pos = 1;
    this.skipMisc();
    if (!this.text.startsWith('<', this.pos)) throw new XmlRpcParseError('Response is not an XML document.');
    const root = this.parseElement();
    this.skipMisc();
    if (this.pos < this.text.length) throw new XmlRpcParseError('Unexpected content after the root element.');
    return root;
  }

  /** Skips whitespace, comments, processing instructions and a DOCTYPE between elements. */
  private skipMisc(): void {
    for (;;) {
      while (this.pos < this.text.length && WHITESPACE.test(this.text[this.pos] ?? '')) this.pos++;
      if (this.text.startsWith('<?', this.pos)) this.skipPast('?>');
      else if (this.text.startsWith('<!--', this.pos)) this.skipPast('-->');
      else if (this.text.startsWith('<!DOCTYPE', this.pos)) this.skipPast('>');
      else return;
    }
  }

  private skipPast(terminator: string): void {
    const end = this.text.indexOf(terminator, this.pos);
    if (end < 0) throw new XmlRpcParseError(`Unterminated markup, expected "${terminator}".`);
    this.pos = end + terminator.length;
  }

  private parseElement(): XmlElement {
    // At "<".
    this.pos++;
    TAG_NAME.lastIndex = this.pos;
    const nameMatch = TAG_NAME.exec(this.text);
    if (!nameMatch) throw new XmlRpcParseError('Malformed start tag.');
    const name = nameMatch[0];
    this.pos += name.length;
    // Attributes are irrelevant for XML-RPC; skip them, honouring quotes.
    let quote: string | undefined;
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) throw new XmlRpcParseError(`Unterminated start tag <${name}>.`);
      if (quote !== undefined) {
        if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        this.pos++;
        break;
      } else if (ch === '/' && this.text[this.pos + 1] === '>') {
        this.pos += 2;
        return { name, children: [] };
      }
      this.pos++;
    }

    const children: XmlNode[] = [];
    for (;;) {
      if (this.pos >= this.text.length) throw new XmlRpcParseError(`Missing end tag </${name}>.`);
      if (this.text.startsWith('</', this.pos)) {
        const end = this.text.indexOf('>', this.pos);
        if (end < 0) throw new XmlRpcParseError(`Unterminated end tag for <${name}>.`);
        const closing = this.text.slice(this.pos + 2, end).trim();
        if (closing !== name) throw new XmlRpcParseError(`Mismatched end tag: expected </${name}>, found </${closing}>.`);
        this.pos = end + 1;
        return { name, children };
      }
      if (this.text.startsWith('<![CDATA[', this.pos)) {
        const end = this.text.indexOf(']]>', this.pos);
        if (end < 0) throw new XmlRpcParseError('Unterminated CDATA section.');
        children.push(this.text.slice(this.pos + 9, end));
        this.pos = end + 3;
      } else if (this.text.startsWith('<!--', this.pos)) {
        this.skipPast('-->');
      } else if (this.text.startsWith('<?', this.pos)) {
        this.skipPast('?>');
      } else if (this.text.startsWith('<', this.pos)) {
        children.push(this.parseElement());
      } else {
        const next = this.text.indexOf('<', this.pos);
        const end = next < 0 ? this.text.length : next;
        children.push(decodeEntities(this.text.slice(this.pos, end)));
        this.pos = end;
      }
    }
  }
}

function textOf(element: XmlElement): string {
  return element.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}

/** Child elements; whitespace-only text between them is ignored, other text is an error. */
function elementsOf(element: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (typeof child !== 'string') out.push(child);
    else if (child.trim() !== '') throw new XmlRpcParseError(`Unexpected text inside <${element.name}>.`);
  }
  return out;
}

function single(element: XmlElement, name: string): XmlElement {
  const found = elementsOf(element).filter((c) => c.name === name);
  const first = found[0];
  if (first === undefined || found.length > 1) {
    throw new XmlRpcParseError(`Expected exactly one <${name}> inside <${element.name}>.`);
  }
  return first;
}

function parseInteger(text: string, tag: string): number {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) throw new XmlRpcParseError(`Invalid <${tag}> value "${trimmed}".`);
  return Number(trimmed);
}

function decodeValueElement(value: XmlElement): XmlRpcDecoded {
  const hasElements = value.children.some((c) => typeof c !== 'string');
  if (!hasElements) return textOf(value);
  const inner = elementsOf(value);
  const node = inner[0];
  if (node === undefined || inner.length > 1) throw new XmlRpcParseError('A <value> must contain a single type element.');
  // Strip a namespace prefix such as "ex:" (Apache extension types).
  const tag = node.name.includes(':') ? node.name.slice(node.name.indexOf(':') + 1) : node.name;
  switch (tag) {
    case 'string':
    case 'dateTime.iso8601':
      return textOf(node);
    case 'i4':
    case 'int':
    case 'i8':
    case 'i2':
    case 'i1':
      return parseInteger(textOf(node), tag);
    case 'boolean': {
      const text = textOf(node).trim();
      if (text === '1' || text === 'true') return true;
      if (text === '0' || text === 'false') return false;
      throw new XmlRpcParseError(`Invalid <boolean> value "${text}".`);
    }
    case 'double':
    case 'float': {
      const text = textOf(node).trim();
      const number = Number(text);
      if (text === '' || Number.isNaN(number)) throw new XmlRpcParseError(`Invalid <double> value "${text}".`);
      return number;
    }
    case 'base64':
      try {
        return fromBase64(textOf(node).replace(/\s+/g, ''));
      } catch (error) {
        throw new XmlRpcParseError(`Invalid <base64> value: ${error instanceof Error ? error.message : String(error)}`);
      }
    case 'nil':
      return null;
    case 'array': {
      const data = single(node, 'data');
      return elementsOf(data).map((item) => {
        if (item.name !== 'value') throw new XmlRpcParseError(`Unexpected <${item.name}> inside <data>.`);
        return decodeValueElement(item);
      });
    }
    case 'struct': {
      const out: { [key: string]: XmlRpcDecoded } = {};
      for (const member of elementsOf(node)) {
        if (member.name !== 'member') throw new XmlRpcParseError(`Unexpected <${member.name}> inside <struct>.`);
        const key = textOf(single(member, 'name'));
        out[key] = decodeValueElement(single(member, 'value'));
      }
      return out;
    }
    default:
      throw new XmlRpcParseError(`Unsupported XML-RPC type <${node.name}>.`);
  }
}

/**
 * Decodes a `methodResponse`. Returns the single result value (null when the response has
 * no params), or throws `XmlRpcFault` for a fault and `XmlRpcParseError` for bad input.
 */
export function decodeMethodResponse(xml: string): XmlRpcDecoded {
  const root = new XmlReader(xml).parseDocument();
  if (root.name !== 'methodResponse') throw new XmlRpcParseError(`Expected <methodResponse>, found <${root.name}>.`);
  const body = elementsOf(root)[0];
  if (body === undefined) throw new XmlRpcParseError('Empty <methodResponse>.');
  if (body.name === 'fault') {
    const fault = decodeValueElement(single(body, 'value'));
    if (fault === null || typeof fault !== 'object' || Array.isArray(fault) || fault instanceof Uint8Array) {
      throw new XmlRpcParseError('A <fault> must contain a struct.');
    }
    const code = fault['faultCode'];
    const message = fault['faultString'];
    throw new XmlRpcFault(typeof code === 'number' ? code : 0, typeof message === 'string' ? message : 'Unknown fault');
  }
  if (body.name !== 'params') throw new XmlRpcParseError(`Unexpected <${body.name}> inside <methodResponse>.`);
  const first = elementsOf(body)[0];
  if (first === undefined) return null;
  return decodeValueElement(single(first, 'value'));
}

/** Decodes a `methodCall` (used by test fakes standing in for a server). */
export function decodeMethodCall(xml: string): { method: string; params: XmlRpcDecoded[] } {
  const root = new XmlReader(xml).parseDocument();
  if (root.name !== 'methodCall') throw new XmlRpcParseError(`Expected <methodCall>, found <${root.name}>.`);
  const method = textOf(single(root, 'methodName')).trim();
  const paramsNode = elementsOf(root).find((c) => c.name === 'params');
  const params = paramsNode === undefined
    ? []
    : elementsOf(paramsNode).map((param) => decodeValueElement(single(param, 'value')));
  return { method, params };
}
