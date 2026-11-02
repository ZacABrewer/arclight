import { XMLParser } from 'fast-xml-parser';
import type { PodcastEnclosure, PodcastPerson, PodcastTranscript } from '@arclight/shared';

// Podcast feed parser: RSS 2.0 with the iTunes tags (itunes:*), the Podcasting 2.0 namespace
// (podcast:guid, chapters, transcript, alternateEnclosure, person, season, episode, funding) and
// content:encoded, plus enough Atom (entries with rel="enclosure" links) for the few podcasts
// published that way. Namespace prefixes are mapped by their xmlns URI, so a feed declaring
// `xmlns:pi="https://podcastindex.org/namespace/1.0"` reads the same as one using `podcast:`.
// Everything the feed says is data: descriptions come back as plain text (tags stripped), so
// nothing from a feed is ever rendered as HTML.

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

export interface ParsedEpisode {
  guid: string;
  title: string;
  description: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  season: number | null;
  episodeNumber: number | null;
  episodeType: 'full' | 'trailer' | 'bonus';
  explicit: boolean;
  imageUrl: string | null;
  link: string | null;
  enclosure: PodcastEnclosure | null;
  alternateEnclosures: PodcastEnclosure[];
  chaptersUrl: string | null;
  transcripts: PodcastTranscript[];
  persons: PodcastPerson[];
}

export interface ParsedFeed {
  title: string;
  author: string | null;
  description: string;
  link: string | null;
  imageUrl: string | null;
  language: string | null;
  categories: string[];
  explicit: boolean;
  feedType: 'episodic' | 'serial';
  podcastGuid: string | null;
  funding: { url: string; title: string }[];
  ttlMinutes: number | null;
  /** `<itunes:new-feed-url>`: the publisher moved the feed here. */
  newFeedUrl: string | null;
  /** `<atom:link rel="self">` (informational; a move is only taken from new-feed-url or a 301). */
  selfUrl: string | null;
  /** `<podcast:locked>yes`: the owner does not want the feed imported elsewhere (shown, not enforced). */
  locked: boolean;
  episodes: ParsedEpisode[];
}

/** Canonical prefixes by namespace URI. */
const NAMESPACES: Record<string, string> = {
  'http://www.itunes.com/dtds/podcast-1.0.dtd': 'itunes',
  'https://www.itunes.com/dtds/podcast-1.0.dtd': 'itunes',
  'https://podcastindex.org/namespace/1.0': 'podcast',
  'http://podcastindex.org/namespace/1.0': 'podcast',
  'https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md': 'podcast',
  'http://purl.org/rss/1.0/modules/content/': 'content',
  'http://www.w3.org/2005/Atom': 'atom',
  'http://search.yahoo.com/mrss/': 'media',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://www.google.com/schemas/play-podcasts/1.0': 'googleplay',
};

/** Elements that may repeat (by canonical name). */
const ARRAY_TAGS = new Set([
  'item',
  'entry',
  'category',
  'itunes:category',
  'link',
  'atom:link',
  'enclosure',
  'podcast:transcript',
  'podcast:person',
  'podcast:alternateEnclosure',
  'podcast:source',
  'podcast:funding',
]);

type Node = Record<string, unknown>;

function prefixMap(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const head = xml.slice(0, 20_000);
  for (const m of head.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']+)["']/g)) {
    const canonical = NAMESPACES[m[2]!.trim()];
    if (canonical) map.set(m[1]!, canonical);
  }
  return map;
}

function makeParser(prefixes: Map<string, string>): XMLParser {
  const rename = (name: string): string => {
    const i = name.indexOf(':');
    if (i <= 0) return name;
    const canonical = prefixes.get(name.slice(0, i));
    return canonical ? `${canonical}:${name.slice(i + 1)}` : name;
  };
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    htmlEntities: true,
    processEntities: true,
    transformTagName: rename,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
}

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function list(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string | null {
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isNode(v)) return text(v['#text']);
  return null;
}

function attr(v: unknown, name: string): string | null {
  const node = Array.isArray(v) ? v[0] : v;
  if (!isNode(node)) return null;
  const value = node[`@_${name}`];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function httpUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function int(v: string | null): number | null {
  if (v === null) return null;
  const n = Number.parseInt(v.replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function positiveInt(v: string | null): number | null {
  const n = int(v);
  return n !== null && n >= 0 ? n : null;
}

/** `<itunes:explicit>`: yes / true / explicit. */
function explicitOf(v: string | null): boolean {
  return v !== null && /^(yes|true|explicit)$/i.test(v);
}

/** `HH:MM:SS`, `MM:SS` or seconds (possibly fractional). */
export function parseDuration(raw: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  const [h, m, sec] = nums.length === 3 ? nums : [0, nums[0]!, nums[1]!];
  return Math.round(h! * 3600 + m! * 60 + sec!);
}

/** RFC 822 dates (and ISO 8601, which some feeds use); null when unreadable. */
export function parseFeedDate(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  let t = Date.parse(s);
  if (Number.isNaN(t)) {
    // Common breakage: a localized/invalid weekday, or "UT"/named zones Date.parse misses.
    s = s.replace(/^[A-Za-z]+,\s*/, '').replace(/\s+(UT|Z)$/i, ' GMT');
    t = Date.parse(s);
  }
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Feed HTML to plain text: block tags become line breaks, the rest is dropped. */
export function plainText(raw: string | null, max = 20_000): string {
  if (!raw) return '';
  const out = raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith('#x') || e.startsWith('#X')) return safeChar(Number.parseInt(e.slice(2), 16)) ?? m;
      if (e.startsWith('#')) return safeChar(Number.parseInt(e.slice(1), 10)) ?? m;
      return ENTITY[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

function safeChar(code: number): string | null {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return null;
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

function enclosureOf(node: unknown): PodcastEnclosure | null {
  const url = httpUrl(attr(node, 'url'));
  if (!url) return null;
  const length = positiveInt(attr(node, 'length'));
  return { url, type: attr(node, 'type'), length: length && length > 0 ? length : null };
}

function alternateEnclosures(item: Node): PodcastEnclosure[] {
  const out: PodcastEnclosure[] = [];
  for (const alt of list(item['podcast:alternateEnclosure'])) {
    if (!isNode(alt)) continue;
    const source = list(alt['podcast:source'])
      .map((s) => httpUrl(attr(s, 'uri')))
      .find((u): u is string => u !== null);
    if (!source) continue;
    const length = positiveInt(attr(alt, 'length'));
    const bitrate = attr(alt, 'bitrate');
    out.push({
      url: source,
      type: attr(alt, 'type'),
      length: length && length > 0 ? length : null,
      title: attr(alt, 'title'),
      bitrate: bitrate !== null && Number.isFinite(Number(bitrate)) ? Number(bitrate) : null,
    });
  }
  return out;
}

function transcriptsOf(item: Node): PodcastTranscript[] {
  const out: PodcastTranscript[] = [];
  for (const t of list(item['podcast:transcript'])) {
    const url = httpUrl(attr(t, 'url'));
    const type = attr(t, 'type');
    if (!url || !type) continue;
    out.push({ url, type, language: attr(t, 'language'), rel: attr(t, 'rel') });
  }
  return out;
}

function personsOf(item: Node): PodcastPerson[] {
  const out: PodcastPerson[] = [];
  for (const p of list(item['podcast:person'])) {
    const name = text(p);
    if (!name) continue;
    out.push({ name, role: attr(p, 'role'), href: httpUrl(attr(p, 'href')), img: httpUrl(attr(p, 'img')) });
  }
  return out;
}

function imageOf(node: Node): string | null {
  return (
    httpUrl(attr(node['itunes:image'], 'href')) ??
    (isNode(node.image) ? httpUrl(text(node.image.url)) : null) ??
    httpUrl(attr(node['media:thumbnail'], 'url')) ??
    httpUrl(attr(node['googleplay:image'], 'href'))
  );
}

function rssLink(node: Node): string | null {
  for (const l of list(node.link)) {
    const u = httpUrl(text(l) ?? attr(l, 'href'));
    if (u) return u;
  }
  return null;
}

function atomLinks(node: Node): Node[] {
  return [...list(node['atom:link']), ...list(node.link)].filter(isNode);
}

function categoriesOf(channel: Node): string[] {
  const seen = new Set<string>();
  const walk = (v: unknown) => {
    for (const c of list(v)) {
      const name = attr(c, 'text');
      if (name) seen.add(name);
      if (isNode(c)) walk(c['itunes:category']);
    }
  };
  walk(channel['itunes:category']);
  if (seen.size === 0) for (const c of list(channel.category)) {
    const name = text(c);
    if (name) seen.add(name);
  }
  return [...seen].slice(0, 20);
}

function episodeTypeOf(v: string | null): ParsedEpisode['episodeType'] {
  const t = v?.toLowerCase();
  return t === 'trailer' || t === 'bonus' ? t : 'full';
}

function rssEpisode(item: Node, channelExplicit: boolean): ParsedEpisode | null {
  const enclosure = list(item.enclosure).map(enclosureOf).find((e): e is PodcastEnclosure => e !== null) ?? null;
  const alternates = alternateEnclosures(item);
  if (!enclosure && alternates.length === 0) return null;
  const title = plainText(text(item.title) ?? text(item['itunes:title']), 500) || 'Untitled episode';
  const publishedAt = parseFeedDate(text(item.pubDate) ?? text(item['dc:date']));
  const guid = text(item.guid) ?? enclosure?.url ?? alternates[0]?.url ?? `${title}|${publishedAt ?? ''}`;
  const explicitRaw = text(item['itunes:explicit']);
  return {
    guid: guid.slice(0, 1000),
    title,
    description: plainText(text(item['content:encoded']) ?? text(item.description) ?? text(item['itunes:summary'])),
    publishedAt,
    durationSeconds: parseDuration(text(item['itunes:duration'])),
    season: positiveInt(text(item['podcast:season']) ?? text(item['itunes:season'])),
    episodeNumber: positiveInt(text(item['podcast:episode']) ?? text(item['itunes:episode'])),
    episodeType: episodeTypeOf(text(item['itunes:episodeType'])),
    explicit: explicitRaw === null ? channelExplicit : explicitOf(explicitRaw),
    imageUrl: imageOf(item),
    link: rssLink(item),
    enclosure: enclosure ?? alternates[0] ?? null,
    alternateEnclosures: enclosure ? alternates : alternates.slice(1),
    chaptersUrl: httpUrl(attr(item['podcast:chapters'], 'url')),
    transcripts: transcriptsOf(item),
    persons: personsOf(item),
  };
}

function atomEpisode(entry: Node): ParsedEpisode | null {
  const links = atomLinks(entry);
  const enc = links.find((l) => attr(l, 'rel') === 'enclosure');
  const url = httpUrl(attr(enc, 'href'));
  if (!enc || !url) return null;
  const length = positiveInt(attr(enc, 'length'));
  const title = plainText(text(entry.title), 500) || 'Untitled episode';
  const publishedAt = parseFeedDate(text(entry.published) ?? text(entry.updated));
  const alt = links.find((l) => (attr(l, 'rel') ?? 'alternate') === 'alternate');
  return {
    guid: (text(entry.id) ?? url).slice(0, 1000),
    title,
    description: plainText(text(entry.content) ?? text(entry.summary)),
    publishedAt,
    durationSeconds: parseDuration(text(entry['itunes:duration'])),
    season: null,
    episodeNumber: null,
    episodeType: 'full',
    explicit: explicitOf(text(entry['itunes:explicit'])),
    imageUrl: imageOf(entry),
    link: httpUrl(attr(alt, 'href')),
    enclosure: { url, type: attr(enc, 'type'), length: length && length > 0 ? length : null },
    alternateEnclosures: [],
    chaptersUrl: null,
    transcripts: [],
    persons: [],
  };
}

function dedupe(episodes: ParsedEpisode[]): ParsedEpisode[] {
  const seen = new Set<string>();
  return episodes.filter((e) => (seen.has(e.guid) ? false : (seen.add(e.guid), true)));
}

/** Parse a feed body. Throws FeedParseError with a readable reason for anything that is not a podcast feed. */
export function parseFeed(xml: string): ParsedFeed {
  const body = xml.replace(/^﻿/, '').trimStart();
  if (body === '') throw new FeedParseError('the feed is empty');
  const head = body.slice(0, 512).toLowerCase();
  if (head.startsWith('<!doctype html') || /^<html[\s>]/.test(head)) {
    throw new FeedParseError('the address returned a web page, not a feed');
  }
  if (!body.startsWith('<')) throw new FeedParseError('the feed is not XML');
  let doc: Node;
  try {
    doc = makeParser(prefixMap(body)).parse(body) as Node;
  } catch (err) {
    throw new FeedParseError(`the feed is not valid XML (${err instanceof Error ? err.message : String(err)})`);
  }

  const rss = doc.rss;
  if (isNode(rss)) {
    const channel = Array.isArray(rss.channel) ? rss.channel[0] : rss.channel;
    if (!isNode(channel)) throw new FeedParseError('the RSS feed has no <channel>');
    return rssFeed(channel);
  }
  const atom = doc.feed;
  if (isNode(atom)) return atomFeed(atom);
  if (isNode(doc['rdf:RDF'])) throw new FeedParseError('RSS 1.0 (RDF) feeds are not podcast feeds');
  throw new FeedParseError('the document is not an RSS or Atom feed');
}

function rssFeed(channel: Node): ParsedFeed {
  const explicit = explicitOf(text(channel['itunes:explicit']));
  const episodes = dedupe(
    list(channel.item)
      .filter(isNode)
      .map((i) => rssEpisode(i, explicit))
      .filter((e): e is ParsedEpisode => e !== null),
  );
  const title = plainText(text(channel.title) ?? text(channel['itunes:title']), 500);
  if (!title) throw new FeedParseError('the feed has no title');
  const selfLink = atomLinks(channel).find((l) => attr(l, 'rel') === 'self');
  const ttl = positiveInt(text(channel.ttl));
  return {
    title,
    author: plainText(text(channel['itunes:author']) ?? text(channel.managingEditor) ?? text(channel['dc:creator']), 300) || null,
    description: plainText(text(channel.description) ?? text(channel['itunes:summary'])),
    link: rssLink(channel),
    imageUrl: imageOf(channel),
    language: text(channel.language)?.slice(0, 20) ?? null,
    categories: categoriesOf(channel),
    explicit,
    feedType: text(channel['itunes:type'])?.toLowerCase() === 'serial' ? 'serial' : 'episodic',
    podcastGuid: text(channel['podcast:guid']),
    funding: list(channel['podcast:funding'])
      .map((f) => ({ url: httpUrl(attr(f, 'url')), title: text(f) ?? '' }))
      .filter((f): f is { url: string; title: string } => f.url !== null),
    ttlMinutes: ttl && ttl > 0 ? ttl : null,
    newFeedUrl: httpUrl(text(channel['itunes:new-feed-url'])),
    selfUrl: httpUrl(attr(selfLink, 'href')),
    locked: /^yes$/i.test(text(channel['podcast:locked']) ?? ''),
    episodes,
  };
}

function atomFeed(feed: Node): ParsedFeed {
  const title = plainText(text(feed.title), 500);
  if (!title) throw new FeedParseError('the feed has no title');
  const links = atomLinks(feed);
  const author = isNode(feed.author) ? text(feed.author.name) : text(feed.author);
  return {
    title,
    author: author ?? null,
    description: plainText(text(feed.subtitle) ?? text(feed['itunes:summary'])),
    link: httpUrl(attr(links.find((l) => (attr(l, 'rel') ?? 'alternate') === 'alternate'), 'href')),
    imageUrl: imageOf(feed) ?? httpUrl(text(feed.logo) ?? text(feed.icon)),
    language: null,
    categories: list(feed.category).map((c) => attr(c, 'term')).filter((c): c is string => c !== null),
    explicit: explicitOf(text(feed['itunes:explicit'])),
    feedType: 'episodic',
    podcastGuid: null,
    funding: [],
    ttlMinutes: null,
    newFeedUrl: httpUrl(text(feed['itunes:new-feed-url'])),
    selfUrl: httpUrl(attr(links.find((l) => attr(l, 'rel') === 'self'), 'href')),
    locked: false,
    episodes: dedupe(list(feed.entry).filter(isNode).map(atomEpisode).filter((e): e is ParsedEpisode => e !== null)),
  };
}

/** Pick the enclosure to download for a preference (falls back to the feed's enclosure). */
export function chooseEnclosure(
  main: PodcastEnclosure | null,
  alternates: readonly PodcastEnclosure[],
  pref: 'feed' | 'audio' | 'video' | 'smallest' | 'largest',
): PodcastEnclosure | null {
  const all = [...(main ? [main] : []), ...alternates];
  if (all.length === 0) return null;
  switch (pref) {
    case 'feed':
      return all[0]!;
    case 'audio':
    case 'video':
      return all.find((e) => e.type?.toLowerCase().startsWith(`${pref}/`)) ?? all[0]!;
    case 'smallest':
    case 'largest': {
      const sized = all.filter((e) => e.length !== null);
      if (sized.length === 0) return all[0]!;
      return sized.reduce((a, b) => ((pref === 'smallest' ? b.length! < a.length! : b.length! > a.length!) ? b : a));
    }
  }
}
