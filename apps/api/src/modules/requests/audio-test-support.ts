import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import {
  RateLimiter,
  createDefaultAudiobookCatalog,
  createListenBrainzClient,
  createMusicBrainzClient,
  type CatalogBook,
  type FetchLike,
  type MbReleaseGroup,
} from '@arclight/metadata';
import type { AddArtistRequest, AddAuthorRequest, AddBookRequest, AudioRequestKind } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { albums, books, qualityProfiles, rootFolders } from '../../db/schema.js';
import * as ab from '../audiobooks/service.js';
import * as music from '../music/service.js';
import { setSection } from '../settings/service.js';
import type { AudioSources } from './audio-discover.js';
import type { AudioLibraryPort } from './audio-requests.js';

// Test-only helpers for music and audiobook requests: the real MusicBrainz, ListenBrainz and
// audiobook catalog clients over a fake fetch that serves the recorded fixtures of
// packages/metadata/fixtures (no network), and a library port that writes straight through the
// music and audiobook services instead of running the refresher jobs.

const FIXTURES = new URL('../../../../../packages/metadata/fixtures/', import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

export const ARTIST = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
export const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const RELEASE = '0b6b4ba0-d36f-47bd-b4ea-6a5b91842d29';
const RELEASE_2DISC = '2629071c-1d8f-43f1-be99-712d931e3bf1';
/** Release groups the ListenBrainz fakes list (not on MusicBrainz). */
export const FRESH_EP = '11111111-1111-4111-8111-111111111111';
export const FRESH_SINGLE = '22222222-2222-4222-8222-222222222222';
export const PHM = 'B08G9PRS1K';
export const WEIR = 'B00G0WYW92';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function musicBrainz(url: URL): Response {
  const path = url.pathname.replace(/^\/ws\/2/, '');
  const q = url.searchParams;
  if (path === '/artist' && q.has('query')) return json(fixture('musicbrainz/search-artist.json'));
  if (path === `/artist/${ARTIST}`) return json(fixture('musicbrainz/artist.json'));
  if (path === '/release-group' && q.has('query')) return json(fixture('musicbrainz/search-release-group.json'));
  if (path === `/release-group/${OK_COMPUTER}`) {
    const [group] = (fixture('musicbrainz/search-release-group.json') as { 'release-groups': object[] })['release-groups'];
    return json({ ...group, genres: [{ name: 'alternative rock', count: 20 }, { name: 'art rock', count: 5 }] });
  }
  if (path === '/release-group' && q.get('artist') === ARTIST) {
    return json(fixture(q.get('offset') === '100' ? 'musicbrainz/release-groups-page-2.json' : 'musicbrainz/release-groups-page-1.json'));
  }
  if (path === '/release' && q.get('release-group') === OK_COMPUTER) return json(fixture('musicbrainz/releases.json'));
  if (path === `/release/${RELEASE}`) return json(fixture('musicbrainz/release.json'));
  if (path === `/release/${RELEASE_2DISC}`) return json(fixture('musicbrainz/release-2disc.json'));
  return json(fixture('musicbrainz/error-404.json'), 404);
}

function listenBrainz(url: URL): Response {
  if (url.pathname === '/1/explore/fresh-releases') {
    return json({
      payload: {
        releases: [
          { release_group_mbid: FRESH_SINGLE, release_name: 'A Single', release_date: '2026-10-25', artist_credit_name: 'Someone', artist_mbids: [ARTIST], release_group_primary_type: 'Single' },
          { release_group_mbid: FRESH_EP, release_name: 'An EP', release_date: '2026-10-20', artist_credit_name: 'Someone', artist_mbids: [ARTIST], release_group_primary_type: 'EP' },
          { release_group_mbid: OK_COMPUTER, release_name: 'OK Computer', release_date: '2026-10-24', artist_credit_name: 'Radiohead', artist_mbids: [ARTIST], release_group_primary_type: 'Album' },
        ],
      },
    });
  }
  if (url.pathname === '/1/stats/sitewide/release-groups') {
    return json({ payload: { release_groups: [{ release_group_mbid: OK_COMPUTER, release_group_name: 'OK Computer', artist_name: 'Radiohead', artist_mbids: [ARTIST], listen_count: 99 }] } });
  }
  return json({ error: 'not found' }, 404);
}

function audiobooks(url: URL): Response {
  const path = url.pathname;
  const q = url.searchParams;
  if (url.hostname === 'api.audnex.us') {
    if (path === `/books/${PHM}`) return json(fixture('audnexus/book.json'));
    if (path === `/authors/${WEIR}`) return json(fixture('audnexus/author.json'));
    if (path === '/authors') return json(/weir/i.test(q.get('name') ?? '') ? fixture('audnexus/search-authors.json') : []);
    return json(fixture('audnexus/error-404.json'), 404);
  }
  if (url.hostname.startsWith('api.audible.')) {
    const all = `${q.get('title') ?? ''} ${q.get('keywords') ?? ''}`;
    if (q.get('author') && !q.get('title')) {
      const page = ['audible/author-page-0.json', 'audible/author-page-1.json', 'audible/author-page-2.json'][Number(q.get('page') ?? '0')];
      return json(page ? fixture(page) : { ...(fixture('audible/empty.json') as object), total_results: 25 });
    }
    if (/project hail mary/i.test(all) && q.get('page') === '0') return json(fixture('audible/search.json'));
    if (!all.trim() && q.get('products_sort_by') && q.get('page') === '0') {
      return json(fixture(q.get('products_sort_by') === 'BestSellers' ? 'audible/search.json' : 'audible/search-series.json'));
    }
    return json(fixture('audible/empty.json'));
  }
  return json({ numFound: 0, start: 0, docs: [] });
}

/** Every provider by host; `calls` records each URL (host + path + query). */
export function fixtureFetch() {
  const calls: string[] = [];
  let down = false;
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(input);
    calls.push(`${url.host}${url.pathname}${url.search}`);
    if (down) return json({ error: 'down' }, 500);
    if (url.hostname === 'musicbrainz.org') return musicBrainz(url);
    if (url.hostname === 'api.listenbrainz.org') return listenBrainz(url);
    return audiobooks(url);
  };
  return { fetchImpl, calls, setDown: (v: boolean) => void (down = v) };
}

/** A clock whose sleeps return at once (the limiter's budgets cost no wall time). */
function instantClock() {
  let t = Date.parse('2026-10-01T00:00:00Z');
  return { now: () => t, sleep: async (ms: number) => void (t += Math.max(0, ms)) };
}

const UA = 'Arclight-test/0.0 ( https://example.invalid/arclight )';

export function fakeAudioSources(fetchImpl: FetchLike): AudioSources {
  const rateLimiter = new RateLimiter({ clock: instantClock() });
  const common = { userAgent: UA, fetchImpl, rateLimiter, maxRetries: 0 };
  const mb = createMusicBrainzClient(common);
  const lb = createListenBrainzClient(common);
  const catalog = createDefaultAudiobookCatalog({ ...common, region: 'us', openLibraryFallback: false });
  return {
    musicBrainz: () => mb,
    listenBrainz: () => lb,
    audiobookCatalog: () => catalog,
    audibleRegion: () => 'us',
    // The fixtures record the 1997 US CD.
    releasePreferences: () => ({ preferredCountries: ['US'], preferredFormats: ['CD'] }),
  };
}

const OK_COMPUTER_GROUP: MbReleaseGroup = {
  mbid: OK_COMPUTER,
  title: 'OK Computer',
  primaryType: 'Album',
  secondaryTypes: [],
  firstReleaseDate: '1997-05-21',
  year: 1997,
  artistCredits: [],
};

function catalogBook(asin: string, authorAsin: string): CatalogBook {
  return { asin, isbns: [], title: 'Project Hail Mary', authors: [{ name: 'Andy Weir', asin: authorAsin }], narrators: ['Ray Porter'], series: [], genres: [], images: {}, sources: ['audible'] };
}

/** Writes through the library services; release groups appear when `done` (or a refresh) settles. */
export class FakeAudioLibrary implements AudioLibraryPort {
  readonly searches: Array<{ kind: AudioRequestKind; ids: number[] }> = [];
  readonly calls: string[] = [];
  /** Release groups an artist sync finds. */
  groups: MbReleaseGroup[] = [OK_COMPUTER_GROUP];
  failSync: string | null = null;

  constructor(private readonly db: Db) {}

  private async sync(artistId: number, mode: music.ReleaseGroupSyncMode): Promise<void> {
    await Promise.resolve();
    if (this.failSync) throw new Error(this.failSync);
    music.syncReleaseGroups(this.db, artistId, this.groups, mode, () => []);
  }

  async addArtist(req: AddArtistRequest) {
    this.calls.push(`addArtist:${req.mbArtistId}:${req.monitorOption}:${req.searchOnAdd}`);
    const artist = music.addArtist(this.db, { mbArtistId: req.mbArtistId, name: 'Radiohead', sortName: 'Radiohead', disambiguation: null, artistType: 'Group', status: 'continuing', overview: '', genres: [], links: [], aliases: [] }, req);
    return { id: artist.id, done: this.sync(artist.id, { kind: 'add', option: req.monitorOption }) };
  }

  async refreshArtist(id: number) {
    this.calls.push(`refreshArtist:${id}`);
    await this.sync(id, { kind: 'refresh', monitorNewAlbums: 'none' });
  }

  async addAuthor(req: AddAuthorRequest) {
    this.calls.push(`addAuthor:${req.asin}:${req.monitorOption}:${req.searchOnAdd}`);
    const author = ab.addAuthor(this.db, { asin: req.asin ?? null, olAuthorId: null, name: 'Andy Weir', overview: '', images: [], genres: [] }, { ...req, languages: [] });
    return { id: author.id };
  }

  async addBook(req: AddBookRequest) {
    this.calls.push(`addBook:${req.asin}:${req.searchOnAdd}:${req.author ? 'author' : 'none'}`);
    let owner = ab.findAuthorByAsin(this.db, WEIR);
    if (!owner) {
      const a = ab.addAuthor(
        this.db,
        { asin: WEIR, olAuthorId: null, name: 'Andy Weir', overview: '', images: [], genres: [] },
        { asin: WEIR, rootFolderPath: req.author!.rootFolderPath, qualityProfileId: req.author!.qualityProfileId, monitored: true, monitorNewBooks: 'none', languages: [], tags: [] },
      );
      owner = ab.authorRow(this.db, a.id);
    }
    const ownerId = owner.id;
    return { id: this.db.transaction((tx) => ab.upsertCatalogBook(tx, ownerId, catalogBook(req.asin!, WEIR), req.monitored)).id };
  }

  search(kind: AudioRequestKind, ids: number[]): void {
    this.searches.push({ kind, ids });
  }
}

/** Music and audiobook root folders, profiles and both feature flags. */
export function seedAudioLibrary(db: Db, opts: { music?: boolean; audiobooks?: boolean; roots?: boolean } = {}): { musicProfileId: number; audiobookProfileId: number } {
  setSection(db, 'features', { music: opts.music ?? true, audiobooks: opts.audiobooks ?? true });
  if (opts.roots !== false) {
    db.insert(rootFolders).values({ path: '/media/music', mediaType: 'music' }).run();
    db.insert(rootFolders).values({ path: '/media/audiobooks', mediaType: 'audiobook' }).run();
  }
  const profile = (name: string, mediaDomain: 'music' | 'audiobook') =>
    db.insert(qualityProfiles).values({ name, cutoff: 1, items: [], formatItems: [], languages: [], mediaDomain }).returning().get().id;
  return { musicProfileId: profile('Lossless', 'music'), audiobookProfileId: profile('Any audiobook', 'audiobook') };
}

/** Marks a library book as on disk. */
export function giveBookFile(db: Db, asin: string): void {
  db.update(books).set({ hasFile: true }).where(eq(books.asin, asin)).run();
}

export function albumByMbid(db: Db, mbid: string) {
  return db.select().from(albums).where(eq(albums.mbReleaseGroupId, mbid)).get();
}
