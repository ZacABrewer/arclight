import {
  chooseRelease,
  coverArtReleaseGroupFrontUrl,
  formatArtistCredit,
  isMbid,
  isMetadataError,
  type AudibleRegion,
  type AudiobookCatalog,
  type CatalogBook,
  type LbReleaseGroup,
  type ListenBrainzClient,
  type MbReleaseGroup,
  type MusicBrainzClient,
  type ReleasePreferences,
} from '@arclight/metadata';
import type {
  AudioAlbumDetail,
  AudioArtistDetail,
  AudioAuthorDetail,
  AudioBookDetail,
  AudioDiscoverHome,
  AudioDiscoverSearchResult,
  AudioRequestKind,
  AudioTrackEntry,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { audiobooksEnabled, creditRole } from '../audiobooks/service.js';
import { musicEnabled } from '../music/service.js';
import { withAudioStatus, type RawAudioItem } from './audio-status.js';
import { DiscoverCache } from './discover-cache.js';
import { AudioDisabledError, RequestsError } from './errors.js';

// Music and audiobook Discover (design music-audiobooks.md section 11): the catalogue behind the
// portal's music and audiobook pages, and the metadata a new audio request stores.
//
// * Music home: ListenBrainz fresh releases (albums and EPs of the last 14 days) and the sitewide
//   release-group chart of the week. Both answer MusicBrainz ids, names and artists, so the home
//   page costs no MusicBrainz call (MusicBrainz allows 1 request per second). Covers are Cover Art
//   Archive URLs, never fetched here.
// * Music search, album and artist pages: MusicBrainz.
// * Audiobook home: the anonymous Audible catalogue by best sellers and by release date; search,
//   book and author pages through the audiobook catalog (Audible + Audnexus).
//
// Catalogue answers are cached (home 1 h, search 15 min, details 1 h); library and request status
// is overlaid fresh on every answer. Every call answers 404 MUSIC_DISABLED / AUDIOBOOKS_DISABLED
// while the matching feature flag is off.

const MINUTE = 60 * 1000;
export const AUDIO_HOME_TTL_MS = 60 * MINUTE;
export const AUDIO_SEARCH_TTL_MS = 15 * MINUTE;
export const AUDIO_DETAIL_TTL_MS = 60 * MINUTE;
const HOME_SIZE = 40;
const MORE_SIZE = 20;
const SEARCH_SIZE = 25;
const ASIN_RE = /^[A-Z0-9]{10}$/;

/** The catalogue clients (the metadata module in production, clients over a fake fetch in tests). */
export interface AudioSources {
  musicBrainz(): MusicBrainzClient;
  listenBrainz(): ListenBrainzClient;
  audiobookCatalog(): AudiobookCatalog;
  /** `audiobookMetadata.audibleRegion`. */
  audibleRegion(): AudibleRegion;
  /** Edition choice for album track lists (`musicMetadata` preferred countries and formats). */
  releasePreferences?(): ReleasePreferences;
}

export interface AudioDiscoverServiceOptions {
  db: Db;
  sources: AudioSources;
  log?: Logger;
  cache?: DiscoverCache;
}

/** What a request stores about its item. */
export interface AudioItemFacts {
  title: string;
  subtitle: string | null;
  year: number | null;
  coverUrl: string | null;
  parentForeignId: string | null;
  region: AudibleRegion | null;
}

function yearOf(date: string | null | undefined): number | null {
  const match = date ? /^(\d{4})/.exec(date) : null;
  return match ? Number(match[1]) : null;
}

function cover(mbid: string): string | null {
  return isMbid(mbid) ? coverArtReleaseGroupFrontUrl(mbid, 250) : null;
}

/** Metadata failures as request errors: unknown ids 404, the rest 502. */
function upstream(err: unknown): unknown {
  if (err instanceof RequestsError || err instanceof AudioDisabledError) return err;
  if (isMetadataError(err, 'not-found')) return new RequestsError('NOT_FOUND', err.message);
  if (isMetadataError(err)) return new RequestsError('UPSTREAM', err.message);
  return err;
}

function lbAlbum(r: LbReleaseGroup): RawAudioItem {
  return {
    kind: 'album',
    foreignId: r.releaseGroupMbid,
    title: r.title,
    subtitle: r.artistName ?? null,
    year: yearOf(r.releaseDate),
    releaseDate: r.releaseDate ?? null,
    coverUrl: cover(r.releaseGroupMbid),
    detail: r.primaryType ?? null,
    parentForeignId: r.artistMbids[0] ?? null,
    region: null,
  };
}

function mbAlbum(g: MbReleaseGroup, artist?: { name: string; mbid: string }): RawAudioItem {
  const credit = formatArtistCredit(g.artistCredits);
  return {
    kind: 'album',
    foreignId: g.mbid.toLowerCase(),
    title: g.title,
    subtitle: credit || artist?.name || null,
    year: g.year ?? null,
    releaseDate: g.firstReleaseDate ?? null,
    coverUrl: cover(g.mbid),
    detail: [g.primaryType, ...g.secondaryTypes].filter(Boolean).join(' · ') || null,
    parentForeignId: g.artistCredits[0]?.artistMbid.toLowerCase() ?? artist?.mbid ?? null,
    region: null,
  };
}

function bookItem(b: CatalogBook, region: AudibleRegion): RawAudioItem | null {
  const asin = b.asin?.toUpperCase();
  if (!asin) return null;
  return {
    kind: 'book',
    foreignId: asin,
    title: b.title,
    subtitle: b.authors.map((a) => a.name).join(', ') || null,
    year: yearOf(b.releaseDate),
    releaseDate: b.releaseDate ?? null,
    coverUrl: cardImage(b.images.cover ?? b.images.thumbnail ?? null),
    detail: b.narrators.join(', ') || null,
    parentForeignId: b.authors.find((a) => a.asin)?.asin?.toUpperCase() ?? null,
    region: b.region ?? region,
  };
}

function books(list: readonly CatalogBook[], region: AudibleRegion, exceptAsin?: string): RawAudioItem[] {
  const out: RawAudioItem[] = [];
  const seen = new Set<string>();
  for (const b of list) {
    const item = bookItem(b, region);
    if (!item || item.foreignId === exceptAsin || seen.has(item.foreignId)) continue;
    seen.add(item.foreignId);
    out.push(item);
  }
  return out;
}

/** Amazon image URLs carry their size (`._SL1024_.`); cards ask for a 500px copy instead. */
export function cardImage(url: string | null): string | null {
  return url ? url.replace(/\._SL\d+_\./, '._SL500_.') : null;
}

/** Lower-case letters and digits only, for loose name matching. */
function nameKey(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

/** Newest first; undated last. */
function byDateDesc(a: { releaseDate?: string | null }, b: { releaseDate?: string | null }): number {
  return (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '');
}

/** Studio albums and EPs first (newest first), then compilations, live and the rest. */
function artistAlbumOrder(a: MbReleaseGroup, b: MbReleaseGroup): number {
  const rank = (g: MbReleaseGroup) => (g.secondaryTypes.length === 0 && (g.primaryType === 'Album' || g.primaryType === 'EP') ? 0 : 1);
  return rank(a) - rank(b) || (b.firstReleaseDate ?? '').localeCompare(a.firstReleaseDate ?? '');
}

type RawAlbumDetail = Omit<AudioAlbumDetail, 'item' | 'moreByArtist'> & { item: RawAudioItem; moreByArtist: RawAudioItem[] };
type RawArtistDetail = Omit<AudioArtistDetail, 'item' | 'albums'> & { item: RawAudioItem; albums: RawAudioItem[] };
type RawBookDetail = Omit<AudioBookDetail, 'item' | 'moreByAuthor'> & { item: RawAudioItem; moreByAuthor: RawAudioItem[] };
type RawAuthorDetail = Omit<AudioAuthorDetail, 'item' | 'books'> & { item: RawAudioItem; books: RawAudioItem[] };

export class AudioDiscoverService {
  private readonly db: Db;
  private readonly sources: AudioSources;
  private readonly log: Logger | undefined;
  readonly cache: DiscoverCache;

  constructor(opts: AudioDiscoverServiceOptions) {
    this.db = opts.db;
    this.sources = opts.sources;
    this.log = opts.log;
    this.cache = opts.cache ?? new DiscoverCache();
  }

  /** Throws 404 MUSIC_DISABLED / AUDIOBOOKS_DISABLED while the domain's feature flag is off. */
  assertEnabled(domain: 'music' | 'audiobook'): void {
    const on = domain === 'music' ? musicEnabled(this.db) : audiobooksEnabled(this.db);
    if (!on) throw new AudioDisabledError(domain);
  }

  private async load<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.cache.get(key, ttlMs, fn);
    } catch (err) {
      throw upstream(err);
    }
  }

  /** One home section; a failing source leaves its section empty (and uncached) instead of failing the page. */
  private async section(key: string, fn: () => Promise<RawAudioItem[]>): Promise<RawAudioItem[]> {
    try {
      return await this.cache.get(key, AUDIO_HOME_TTL_MS, fn);
    } catch (err) {
      this.log?.warn({ err, section: key }, 'audio discover section unavailable');
      return [];
    }
  }

  private region(region: AudibleRegion | undefined): AudibleRegion {
    return region ?? this.sources.audibleRegion();
  }

  // -------------------------------------------------------------------------------------
  // music
  // -------------------------------------------------------------------------------------

  async musicHome(): Promise<AudioDiscoverHome> {
    this.assertEnabled('music');
    const [fresh, top] = await Promise.all([
      this.section('music:fresh', async () => {
        const releases = await this.sources.listenBrainz().freshReleases({ days: 14, sort: 'release_date' });
        const seen = new Set<string>();
        return releases
          .filter((r) => r.primaryType === 'Album' || r.primaryType === 'EP')
          .sort(byDateDesc)
          .filter((r) => !seen.has(r.releaseGroupMbid) && seen.add(r.releaseGroupMbid))
          .slice(0, HOME_SIZE)
          .map(lbAlbum);
      }),
      // ListenBrainz lists a release group once per artist credit, so the same album can repeat.
      this.section('music:top', async () => {
        const seen = new Set<string>();
        return (await this.sources.listenBrainz().sitewideReleaseGroups({ range: 'week', count: HOME_SIZE * 2 }))
          .filter((r) => !seen.has(r.releaseGroupMbid) && seen.add(r.releaseGroupMbid))
          .slice(0, HOME_SIZE)
          .map(lbAlbum);
      }),
    ]);
    return {
      sections: [
        { id: 'music-fresh', title: 'Fresh releases', items: withAudioStatus(this.db, fresh) },
        { id: 'music-top', title: 'Popular this week', items: withAudioStatus(this.db, top) },
      ],
    };
  }

  async musicSearch(query: string): Promise<AudioDiscoverSearchResult> {
    this.assertEnabled('music');
    const q = query.trim();
    const raw = await this.load(`music:search:${q.toLowerCase()}`, AUDIO_SEARCH_TTL_MS, async () => {
      const mb = this.sources.musicBrainz();
      const [artists, groups] = await Promise.all([mb.searchArtists(q, { limit: SEARCH_SIZE }), mb.searchReleaseGroups(q, { limit: SEARCH_SIZE })]);
      const people: RawAudioItem[] = artists.results.map((a) => ({
        kind: 'artist',
        foreignId: a.mbid.toLowerCase(),
        title: a.name,
        subtitle: a.disambiguation ?? null,
        year: yearOf(a.beginDate),
        releaseDate: null,
        coverUrl: null,
        detail: a.type ?? null,
        parentForeignId: null,
        region: null,
      }));
      return { people, titles: groups.results.map((g) => mbAlbum(g)) };
    });
    return { people: withAudioStatus(this.db, raw.people), titles: withAudioStatus(this.db, raw.titles) };
  }

  private rawAlbum(mbid: string): Promise<RawAlbumDetail> {
    const id = mbid.toLowerCase();
    return this.load(`music:album:${id}`, AUDIO_DETAIL_TTL_MS, async () => {
      if (!isMbid(id)) throw RequestsError.notFound('MusicBrainz release group', mbid);
      const mb = this.sources.musicBrainz();
      const group = await mb.getReleaseGroup(id);
      const artistName = formatArtistCredit(group.artistCredits) || 'Unknown artist';
      const artistForeignId = group.artistCredits[0]?.artistMbid.toLowerCase() ?? '';
      // Track list of the edition the library would pick by default; best effort.
      let tracks: AudioTrackEntry[] = [];
      try {
        const chosen = chooseRelease(await mb.browseReleases(id), this.sources.releasePreferences?.() ?? {});
        if (chosen) {
          const release = await mb.getRelease(chosen.mbid);
          const multi = release.media.length > 1;
          tracks = release.media.flatMap((m) =>
            m.tracks.map((t) => ({ position: multi ? `${m.position}-${t.number}` : t.number, title: t.title, durationMs: t.durationMs ?? null })),
          );
        }
      } catch (err) {
        this.log?.debug({ err, mbid: id }, 'album tracks unavailable');
      }
      let moreByArtist: RawAudioItem[] = [];
      if (artistForeignId) {
        try {
          const groups = await mb.browseReleaseGroups(artistForeignId, { types: ['album', 'ep'] });
          moreByArtist = groups
            .filter((g) => g.mbid.toLowerCase() !== id)
            .sort(artistAlbumOrder)
            .slice(0, MORE_SIZE)
            .map((g) => mbAlbum(g, { name: artistName, mbid: artistForeignId }));
        } catch (err) {
          this.log?.debug({ err, mbid: artistForeignId }, 'artist albums unavailable');
        }
      }
      return { item: mbAlbum(group), artistName, artistForeignId, overview: null, genres: group.genres, tracks, moreByArtist };
    });
  }

  async album(mbid: string): Promise<AudioAlbumDetail> {
    this.assertEnabled('music');
    const raw = await this.rawAlbum(mbid);
    const [item] = withAudioStatus(this.db, [raw.item]);
    return { ...raw, item: item!, moreByArtist: withAudioStatus(this.db, raw.moreByArtist) };
  }

  private rawArtist(mbid: string): Promise<RawArtistDetail> {
    const id = mbid.toLowerCase();
    return this.load(`music:artist:${id}`, AUDIO_DETAIL_TTL_MS, async () => {
      if (!isMbid(id)) throw RequestsError.notFound('MusicBrainz artist', mbid);
      const mb = this.sources.musicBrainz();
      const artist = await mb.getArtist(id);
      const groups = await mb.browseReleaseGroups(id, { types: ['album', 'ep'] });
      return {
        item: {
          kind: 'artist',
          foreignId: id,
          title: artist.name,
          subtitle: artist.disambiguation ?? null,
          year: yearOf(artist.beginDate),
          releaseDate: null,
          coverUrl: null,
          detail: artist.type ?? null,
          parentForeignId: null,
          region: null,
        },
        overview: null,
        genres: artist.genres,
        country: artist.country ?? null,
        albums: [...groups].sort(artistAlbumOrder).map((g) => mbAlbum(g, { name: artist.name, mbid: id })),
      };
    });
  }

  async artist(mbid: string): Promise<AudioArtistDetail> {
    this.assertEnabled('music');
    const raw = await this.rawArtist(mbid);
    const [item] = withAudioStatus(this.db, [raw.item]);
    return { ...raw, item: item!, albums: withAudioStatus(this.db, raw.albums) };
  }

  // -------------------------------------------------------------------------------------
  // audiobooks
  // -------------------------------------------------------------------------------------

  async audiobookHome(regionParam?: AudibleRegion): Promise<AudioDiscoverHome> {
    this.assertEnabled('audiobook');
    const region = this.region(regionParam);
    const browse = (sort: 'bestsellers' | 'newest') =>
      this.section(`book:${sort}:${region}`, async () => books(await this.sources.audiobookCatalog().browseBooks(sort, { region, pageSize: HOME_SIZE }), region));
    const [best, fresh] = await Promise.all([browse('bestsellers'), browse('newest')]);
    return {
      sections: [
        { id: 'book-bestsellers', title: 'Best sellers', items: withAudioStatus(this.db, best) },
        { id: 'book-new', title: 'New releases', items: withAudioStatus(this.db, fresh) },
      ],
    };
  }

  async audiobookSearch(query: string, regionParam?: AudibleRegion): Promise<AudioDiscoverSearchResult> {
    this.assertEnabled('audiobook');
    const region = this.region(regionParam);
    const q = query.trim();
    const raw = await this.load(`book:search:${region}:${q.toLowerCase()}`, AUDIO_SEARCH_TTL_MS, async () => {
      const catalog = this.sources.audiobookCatalog();
      const [found, authors] = await Promise.all([
        catalog.searchBooks(q, { region, pageSize: SEARCH_SIZE }),
        catalog.searchAuthors(q, { region }).catch((err: unknown) => {
          this.log?.debug({ err }, 'author search unavailable');
          return [];
        }),
      ]);
      // Audnexus' author search is loose (a title search returns book names as "authors"), so
      // authors credited on the matching books come first, most credited first, and Audnexus
      // hits only count when the name itself matches the query.
      const credited = new Map<string, { name: string; count: number }>();
      for (const b of found) {
        for (const c of b.authors) {
          const asin = c.asin?.toUpperCase();
          if (!asin || creditRole(c.name).role !== 'author') continue;
          const entry = credited.get(asin) ?? { name: creditRole(c.name).name, count: 0 };
          entry.count += 1;
          credited.set(asin, entry);
        }
      }
      const people: RawAudioItem[] = [];
      const author = (asin: string, name: string, image: string | null | undefined, from: AudibleRegion | null | undefined): void => {
        if (people.some((p) => p.foreignId === asin)) return;
        people.push({ kind: 'author', foreignId: asin, title: name, subtitle: null, year: null, releaseDate: null, coverUrl: image ?? null, detail: null, parentForeignId: null, region: from ?? region });
      };
      for (const [asin, c] of [...credited].sort((a, b) => b[1].count - a[1].count)) author(asin, c.name, null, region);
      const wanted = nameKey(q);
      for (const a of authors) {
        const asin = a.asin?.toUpperCase();
        const key = nameKey(a.name);
        if (!asin || key.length === 0 || !(key.includes(wanted) || wanted.includes(key))) continue;
        author(asin, a.name, a.image, a.region);
      }
      return { people, titles: books(found, region) };
    });
    return { people: withAudioStatus(this.db, raw.people), titles: withAudioStatus(this.db, raw.titles) };
  }

  private rawBook(asinParam: string, region: AudibleRegion): Promise<RawBookDetail> {
    const asin = asinParam.toUpperCase();
    return this.load(`book:book:${region}:${asin}`, AUDIO_DETAIL_TTL_MS, async () => {
      if (!ASIN_RE.test(asin)) throw RequestsError.notFound('Audible book', asinParam);
      const catalog = this.sources.audiobookCatalog();
      const book = await catalog.getBook({ asin }, { region });
      const item = bookItem({ ...book, asin: book.asin ?? asin }, region)!;
      let moreByAuthor: RawAudioItem[] = [];
      const primary = book.authors.find((a) => a.asin);
      if (primary?.asin) {
        try {
          const found = await catalog.getAuthorWithBooks({ asin: primary.asin, name: primary.name }, { region });
          moreByAuthor = books([...found.books].sort(byDateDesc), region, asin).slice(0, MORE_SIZE);
        } catch (err) {
          this.log?.debug({ err, asin: primary.asin }, 'author bibliography unavailable');
        }
      }
      return {
        item,
        authors: book.authors.map((a) => ({ name: a.name, foreignId: a.asin?.toUpperCase() ?? null })),
        narrators: book.narrators,
        overview: book.overview ?? null,
        runtimeMinutes: book.runtimeMinutes ?? null,
        publisher: book.publisher ?? null,
        series: book.series.map((s) => ({ name: s.name, position: s.position ?? null, foreignId: s.asin ?? null })),
        genres: book.genres,
        abridged: book.formatType ? book.formatType === 'abridged' : null,
        language: book.language ?? null,
        moreByAuthor,
      };
    });
  }

  async book(asin: string, regionParam?: AudibleRegion): Promise<AudioBookDetail> {
    this.assertEnabled('audiobook');
    const raw = await this.rawBook(asin, this.region(regionParam));
    const [item] = withAudioStatus(this.db, [raw.item]);
    return { ...raw, item: item!, moreByAuthor: withAudioStatus(this.db, raw.moreByAuthor) };
  }

  private rawAuthor(asinParam: string, region: AudibleRegion): Promise<RawAuthorDetail> {
    const asin = asinParam.toUpperCase();
    return this.load(`book:author:${region}:${asin}`, AUDIO_DETAIL_TTL_MS, async () => {
      if (!ASIN_RE.test(asin)) throw RequestsError.notFound('Audible author', asinParam);
      const found = await this.sources.audiobookCatalog().getAuthorWithBooks({ asin }, { region });
      return {
        item: {
          kind: 'author',
          foreignId: asin,
          title: found.author.name,
          subtitle: null,
          year: null,
          releaseDate: null,
          coverUrl: found.author.image ?? null,
          detail: null,
          parentForeignId: null,
          region: found.author.region ?? region,
        },
        overview: found.author.description ?? null,
        genres: found.author.genres,
        books: books([...found.books].sort(byDateDesc), region),
      };
    });
  }

  async author(asin: string, regionParam?: AudibleRegion): Promise<AudioAuthorDetail> {
    this.assertEnabled('audiobook');
    const raw = await this.rawAuthor(asin, this.region(regionParam));
    const [item] = withAudioStatus(this.db, [raw.item]);
    return { ...raw, item: item!, books: withAudioStatus(this.db, raw.books) };
  }

  // -------------------------------------------------------------------------------------
  // request metadata
  // -------------------------------------------------------------------------------------

  /** Title, artist/author, year, cover and parent of an item, from the (cached) detail lookups. */
  async facts(kind: AudioRequestKind, foreignId: string, regionParam?: AudibleRegion): Promise<AudioItemFacts> {
    const region = this.region(regionParam);
    let item: RawAudioItem;
    switch (kind) {
      case 'album':
        item = (await this.rawAlbum(foreignId)).item;
        break;
      case 'artist':
        item = (await this.rawArtist(foreignId)).item;
        break;
      case 'book':
        item = (await this.rawBook(foreignId, region)).item;
        break;
      case 'author':
        item = (await this.rawAuthor(foreignId, region)).item;
        break;
    }
    return {
      title: item.title,
      subtitle: item.subtitle ?? null,
      year: item.year ?? null,
      coverUrl: item.coverUrl ?? null,
      parentForeignId: item.parentForeignId ?? null,
      region: kind === 'book' || kind === 'author' ? (item.region ?? region) : null,
    };
  }
}
