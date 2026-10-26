import { isStandardCategory } from '../categories.js';
import type { IndexerCapabilities, IndexerProtocol, ReleaseInfo } from '../types.js';
import { asArray, attrOf, isAttrTag, isRecord, textOf, type XmlNode } from './xml.js';

export interface ItemContext {
  protocol: IndexerProtocol;
  indexerName: string;
  indexerId?: number;
  caps?: IndexerCapabilities;
  /** Epoch ms used for items without a parseable date. */
  now: number;
}

const NZB_TYPE = 'application/x-nzb';
const TORRENT_TYPE = 'application/x-bittorrent';

interface Enclosure {
  url: string | undefined;
  length: number | undefined;
  type: string | undefined;
}

/** Pull the `<item>` list out of an RSS document. */
export function rssItems(doc: XmlNode): XmlNode[] {
  const rss = doc['rss'];
  const channel = isRecord(rss) ? rss['channel'] : undefined;
  if (!isRecord(channel)) return [];
  return asArray(channel['item']).filter(isRecord);
}

/** `<newznab:response offset total>` element, when present. */
export function responseTotal(doc: XmlNode): number | undefined {
  const rss = doc['rss'];
  const channel = isRecord(rss) ? rss['channel'] : undefined;
  if (!isRecord(channel)) return undefined;
  for (const [key, value] of Object.entries(channel)) {
    if (key === 'response' || key.endsWith(':response')) {
      const total = Number.parseInt(attrOf(value, 'total') ?? '', 10);
      if (Number.isFinite(total)) return total;
    }
  }
  return undefined;
}

export function isRssDocument(doc: XmlNode): boolean {
  return isRecord(doc['rss']) && isRecord((doc['rss'] as XmlNode)['channel']);
}

/** Map every usable `<item>` in a document to a release, skipping bogus ones. */
export function parseReleases(doc: XmlNode, ctx: ItemContext): ReleaseInfo[] {
  const releases: ReleaseInfo[] = [];
  for (const item of rssItems(doc)) {
    const release = parseItem(item, ctx);
    if (release) releases.push(release);
  }
  return releases;
}

/** Collect `*:attr name=… value=…` pairs, keyed by lower-case name (names may repeat). */
function collectAttrs(item: XmlNode): Map<string, string[]> {
  const attrs = new Map<string, string[]>();
  for (const [key, value] of Object.entries(item)) {
    if (!isAttrTag(key)) continue;
    for (const node of asArray(value)) {
      const name = attrOf(node, 'name')?.trim().toLowerCase();
      const attrValue = attrOf(node, 'value');
      if (!name || attrValue === undefined) continue;
      const list = attrs.get(name);
      if (list) list.push(attrValue.trim());
      else attrs.set(name, [attrValue.trim()]);
    }
  }
  return attrs;
}

function toInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^-?\d+(\.\d+)?$/.test(raw.trim())) return undefined;
  const value = Math.trunc(Number(raw));
  return Number.isSafeInteger(value) ? value : undefined;
}

function toFloat(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function isHttpUrl(value: string | undefined): value is string {
  return value !== undefined && /^https?:\/\//i.test(value);
}

function isMagnet(value: string | undefined): value is string {
  return value !== undefined && value.toLowerCase().startsWith('magnet:');
}

function readEnclosures(item: XmlNode): Enclosure[] {
  return asArray(item['enclosure']).map((node) => ({
    url: attrOf(node, 'url')?.trim(),
    length: toInt(attrOf(node, 'length')),
    type: attrOf(node, 'type')?.trim().toLowerCase(),
  }));
}

function parseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw.trim());
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function normalizeImdb(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.trim().replace(/^tt/i, '');
  if (!/^\d+$/.test(digits) || Number(digits) === 0) return undefined;
  return `tt${digits.padStart(7, '0')}`;
}

function infoHashFromMagnet(magnet: string): string | undefined {
  const match = /xt=urn:btih:([0-9a-f]{40})/i.exec(magnet);
  return match?.[1]?.toLowerCase();
}

function categoriesOf(item: XmlNode, attrs: Map<string, string[]>, caps: IndexerCapabilities | undefined): number[] {
  let raw = attrs.get('category') ?? [];
  if (raw.length === 0) {
    raw = asArray(item['category']).flatMap((node) => {
      const text = textOf(node);
      return text === undefined ? [] : [text];
    });
  }
  const ids = new Set<number>();
  for (const value of raw) {
    const id = toInt(value);
    if (id !== undefined && id >= 0) ids.add(id);
  }
  // Indexer-specific ids nested under a standard parent in caps imply that parent.
  if (caps) {
    for (const id of [...ids]) {
      if (isStandardCategory(id)) continue;
      const parent = caps.categories.find((c) => c.subcats.some((s) => s.id === id));
      if (parent && isStandardCategory(parent.id)) ids.add(parent.id);
    }
  }
  return [...ids];
}

function chooseEnclosure(enclosures: Enclosure[], protocol: IndexerProtocol): Enclosure | undefined {
  const preferred = protocol === 'usenet' ? NZB_TYPE : TORRENT_TYPE;
  const other = protocol === 'usenet' ? TORRENT_TYPE : NZB_TYPE;
  return (
    enclosures.find((e) => e.type === preferred && e.url) ??
    enclosures.find((e) => e.type === undefined && e.url) ??
    enclosures.find((e) => e.type !== other && e.url)
  );
}

function parseItem(item: XmlNode, ctx: ItemContext): ReleaseInfo | undefined {
  const title = textOf(item['title']);
  if (!title) return undefined;

  const attrs = collectAttrs(item);
  const attr = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = attrs.get(name)?.[0];
      if (value !== undefined && value !== '') return value;
    }
    return undefined;
  };

  const enclosures = readEnclosures(item);
  const enclosure = chooseEnclosure(enclosures, ctx.protocol);
  // Every enclosure is of the other protocol: this is the wrong indexer type for the item.
  if (!enclosure && enclosures.some((e) => e.url)) return undefined;

  const link = textOf(item['link']);
  const magnetAttr = attr('magneturl');
  let downloadUrl = enclosure?.url ?? (isHttpUrl(link) || isMagnet(link) ? link : undefined);
  if (!downloadUrl && ctx.protocol === 'torrent' && isMagnet(magnetAttr)) downloadUrl = magnetAttr;
  if (!downloadUrl) return undefined;

  const size = toInt(attr('size')) ?? enclosure?.length ?? toInt(textOf(item['size']));
  if (size === undefined || size <= 0) return undefined;

  const guid = textOf(item['guid']) ?? link ?? downloadUrl;
  const publishDate =
    parseDate(attr('usenetdate')) ?? parseDate(textOf(item['pubDate'])) ?? new Date(ctx.now).toISOString();

  const release: ReleaseInfo = {
    guid,
    title,
    size,
    publishDate,
    downloadUrl,
    categories: categoriesOf(item, attrs, ctx.caps),
    indexerName: ctx.indexerName,
    protocol: ctx.protocol,
  };
  if (ctx.indexerId !== undefined) release.indexerId = ctx.indexerId;

  const comments = textOf(item['comments'])?.replace(/#comments$/i, '');
  if (isHttpUrl(comments)) release.infoUrl = comments;

  const tvdbId = toInt(attr('tvdbid', 'tvdb'));
  if (tvdbId !== undefined && tvdbId > 0) release.tvdbId = tvdbId;
  const tmdbId = toInt(attr('tmdbid', 'tmdb'));
  if (tmdbId !== undefined && tmdbId > 0) release.tmdbId = tmdbId;
  const imdbId = normalizeImdb(attr('imdbid', 'imdb'));
  if (imdbId) release.imdbId = imdbId;
  const grabs = toInt(attr('grabs'));
  if (grabs !== undefined && grabs >= 0) release.grabs = grabs;

  if (ctx.protocol === 'torrent') applyTorrentFields(release, attr, downloadUrl, link);
  return release;
}

function applyTorrentFields(
  release: ReleaseInfo,
  attr: (...names: string[]) => string | undefined,
  downloadUrl: string,
  link: string | undefined,
): void {
  const magnet = [attr('magneturl'), downloadUrl, link].find(isMagnet);
  if (magnet) release.magnetUrl = magnet;

  const hash = attr('infohash')?.toLowerCase() ?? (magnet ? infoHashFromMagnet(magnet) : undefined);
  if (hash && /^[0-9a-f]{40}$/.test(hash)) release.infoHash = hash;

  const seeders = toInt(attr('seeders'));
  let peers = toInt(attr('peers'));
  let leechers = toInt(attr('leechers'));
  if (peers === undefined && seeders !== undefined && leechers !== undefined) peers = seeders + leechers;
  if (leechers === undefined && peers !== undefined && seeders !== undefined) {
    leechers = Math.max(0, peers - seeders);
  }
  if (seeders !== undefined && seeders >= 0) release.seeders = seeders;
  if (peers !== undefined && peers >= 0) release.peers = peers;
  if (leechers !== undefined && leechers >= 0) release.leechers = leechers;

  const dvf = toFloat(attr('downloadvolumefactor'));
  if (dvf !== undefined) release.downloadVolumeFactor = dvf;
  const uvf = toFloat(attr('uploadvolumefactor'));
  if (uvf !== undefined) release.uploadVolumeFactor = uvf;
  const ratio = toFloat(attr('minimumratio'));
  if (ratio !== undefined) release.minimumRatio = ratio;
  // Torznab expresses minimum seed time in seconds.
  const seedSeconds = toInt(attr('minimumseedtime'));
  if (seedSeconds !== undefined && seedSeconds >= 0) release.minimumSeedTime = seedSeconds * 1000;
}
