import { XMLParser } from 'fast-xml-parser';

// OPML 1.0/2.0 subscription lists, the format every podcast app imports and exports: an
// <outline type="rss" xmlUrl="..."> per feed, possibly nested in folders.

export class OpmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpmlError';
  }
}

export interface OpmlFeed {
  feedUrl: string;
  title: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  htmlEntities: true,
  isArray: (name) => name === 'outline',
});

type Node = Record<string, unknown>;

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(node: Node, name: string): string | null {
  const v = node[`@_${name}`];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Every distinct http(s) feed URL in an OPML document, in document order. */
export function parseOpml(xml: string): OpmlFeed[] {
  let doc: Node;
  try {
    doc = parser.parse(xml.replace(/^﻿/, '')) as Node;
  } catch (err) {
    throw new OpmlError(`not valid XML (${err instanceof Error ? err.message : String(err)})`);
  }
  const opml = doc.opml;
  if (!isNode(opml) || !isNode(opml.body)) throw new OpmlError('not an OPML document (no <opml><body>)');
  const out: OpmlFeed[] = [];
  const seen = new Set<string>();
  const walk = (outlines: unknown) => {
    if (!Array.isArray(outlines)) return;
    for (const o of outlines) {
      if (!isNode(o)) continue;
      const url = str(o, 'xmlUrl') ?? str(o, 'xmlurl') ?? str(o, 'url');
      if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url);
        out.push({ feedUrl: url, title: str(o, 'text') ?? str(o, 'title') });
      }
      walk(o.outline);
    }
  };
  walk(opml.body.outline);
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** An OPML 2.0 document listing the given feeds. */
export function buildOpml(feeds: readonly { title: string; feedUrl: string; link?: string | null }[], now: Date = new Date()): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    '    <title>Arclight podcasts</title>',
    `    <dateCreated>${now.toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
    ...feeds.map(
      (f) =>
        `    <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.feedUrl)}"${f.link ? ` htmlUrl="${esc(f.link)}"` : ''}/>`,
    ),
    '  </body>',
    '</opml>',
    '',
  ];
  return lines.join('\n');
}
