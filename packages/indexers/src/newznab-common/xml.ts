import { XMLParser } from 'fast-xml-parser';
import { IndexerError } from '../types.js';

/** Parsed XML node as produced by fast-xml-parser (attributes are `@_`-prefixed keys). */
export type XmlNode = Record<string, unknown>;

const ARRAY_TAGS = new Set(['item', 'category', 'subcat', 'enclosure']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  htmlEntities: true,
  isArray: (tagName) => ARRAY_TAGS.has(tagName) || isAttrTag(tagName),
});

/** `torznab:attr`, `newznab:attr` or any other namespace prefix used for the attr element. */
export function isAttrTag(tagName: string): boolean {
  return tagName === 'attr' || tagName.endsWith(':attr');
}

export function isRecord(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Text content of an element whether it parsed to a plain string or to `{ '#text': ... }`. */
export function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  if (typeof value === 'number') return String(value);
  if (isRecord(value)) return textOf(value['#text']);
  return undefined;
}

export function attrOf(node: unknown, name: string): string | undefined {
  if (!isRecord(node)) return undefined;
  const value = node[`@_${name}`];
  return typeof value === 'string' ? value : undefined;
}

export function looksLikeHtml(body: string): boolean {
  const head = body.trimStart().slice(0, 512).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /<html[\s>]/.test(head);
}

export interface RawResponse {
  status: number;
  body: string;
  /** Request URL with the API key redacted, for error messages. */
  safeUrl: string;
  /** Whether the request carried an apikey parameter. */
  hadApiKey: boolean;
}

/**
 * Turn an HTTP response into a parsed XML document, throwing a typed error for Newznab
 * `<error>` replies, HTML pages, non-XML bodies and HTTP failures.
 */
export function parseResponse(res: RawResponse): XmlNode {
  const body = res.body.replace(/^﻿/, '');
  const trimmed = body.trim();

  if (trimmed.startsWith('<') && !looksLikeHtml(trimmed)) {
    let doc: XmlNode | undefined;
    try {
      const parsed: unknown = parser.parse(trimmed);
      doc = isRecord(parsed) ? parsed : undefined;
    } catch (cause) {
      throw new IndexerError('bad-response', `Malformed XML from ${res.safeUrl}`, {
        status: res.status,
        cause,
      });
    }
    if (doc) {
      throwIfNewznabError(doc, res);
      if (res.status >= 200 && res.status < 300) return doc;
    }
  }

  throwForStatus(res);

  if (looksLikeHtml(trimmed)) {
    throw new IndexerError('bad-response', `Indexer returned an HTML page instead of XML (${res.safeUrl})`, {
      status: res.status,
    });
  }
  throw new IndexerError('bad-response', `Indexer returned a non-XML response (${res.safeUrl})`, {
    status: res.status,
  });
}

function throwForStatus(res: RawResponse): void {
  const { status, safeUrl } = res;
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) {
    throw new IndexerError('auth', `Indexer rejected credentials (HTTP ${status})`, { status });
  }
  if (status === 429) {
    throw new IndexerError('rate-limited', 'Indexer rate limit reached (HTTP 429)', { status });
  }
  if (status >= 500) {
    throw new IndexerError('unreachable', `Indexer server error (HTTP ${status}) at ${safeUrl}`, { status });
  }
  throw new IndexerError('bad-response', `Unexpected HTTP ${status} from ${safeUrl}`, { status });
}

/**
 * Newznab error codes: 100-199 account/credential problems, 200-299 request problems
 * (203 = function not available), 300-399 server problems, 429/500 request limit,
 * 501 download limit.
 */
function throwIfNewznabError(doc: XmlNode, res: RawResponse): void {
  const error = findErrorNode(doc);
  if (!error) return;

  const indexerCode = Number.parseInt(attrOf(error, 'code') ?? '', 10);
  const description = attrOf(error, 'description') ?? textOf(error) ?? 'Unknown indexer error';
  const details = {
    status: res.status,
    ...(Number.isFinite(indexerCode) ? { indexerCode } : {}),
  };
  const lower = description.toLowerCase();

  if (indexerCode >= 100 && indexerCode <= 199) {
    throw new IndexerError('auth', `Indexer authentication failed: ${description}`, details);
  }
  if (!res.hadApiKey && (lower === 'missing parameter' || lower.includes('apikey') || lower.includes('api key'))) {
    throw new IndexerError('auth', 'Indexer requires an API key', details);
  }
  if (indexerCode === 429 || indexerCode === 500 || indexerCode === 501 || lower.includes('limit reached')) {
    throw new IndexerError('rate-limited', `Indexer limit reached: ${description}`, details);
  }
  if (indexerCode === 202 || indexerCode === 203) {
    throw new IndexerError('unsupported-search', `Indexer does not support this request: ${description}`, details);
  }
  throw new IndexerError('bad-response', `Indexer error ${Number.isFinite(indexerCode) ? indexerCode : ''}: ${description}`.replace('  ', ' '), details);
}

function findErrorNode(doc: XmlNode): XmlNode | undefined {
  if (isRecord(doc['error'])) return doc['error'];
  const rss = doc['rss'];
  if (isRecord(rss)) {
    if (isRecord(rss['error'])) return rss['error'];
    const channel = rss['channel'];
    if (isRecord(channel) && isRecord(channel['error'])) return channel['error'];
  }
  return undefined;
}
