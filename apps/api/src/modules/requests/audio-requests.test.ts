import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { NotificationEvent } from '@arclight/notifications';
import { Permission as P } from '@arclight/shared';
import { albums, artists, books, qualityProfiles, rootFolders, users } from '../../db/schema.js';
import { setSection } from '../settings/service.js';
import { AudioDisabledError, RequestsError } from './errors.js';
import { audioRequests } from './schema.js';
import { addUser, setup } from './test-support.js';
import { cardImage } from './audio-discover.js';
import { ARTIST, FRESH_EP, FakeAudioLibrary, OK_COMPUTER, PHM, WEIR, albumByMbid, fakeAudioSources, fixtureFetch, giveBookFile, seedAudioLibrary } from './audio-test-support.js';

async function harness(opts: { music?: boolean; audiobooks?: boolean; roots?: boolean } = {}) {
  const net = fixtureFetch();
  const events: NotificationEvent[] = [];
  let library!: FakeAudioLibrary;
  const h = await setup({
    extra: {
      audioSources: fakeAudioSources(net.fetchImpl),
      // Built lazily: the database exists only inside setup.
      audioLibrary: {
        addArtist: (req) => library.addArtist(req),
        refreshArtist: (id) => library.refreshArtist(id),
        addAuthor: (req) => library.addAuthor(req),
        addBook: (req) => library.addBook(req),
        search: (kind, ids) => library.search(kind, ids),
      },
      systemDispatch: async (event) => {
        events.push(event);
        return [];
      },
    },
  });
  library = new FakeAudioLibrary(h.db);
  const seeded = seedAudioLibrary(h.db, opts);
  const admin = addUser(h.db, { role: 'admin', username: 'boss' });
  const user = addUser(h.db, { username: 'listener', permissions: P.REQUEST });
  return { ...h, ...seeded, net, events, library, admin, user, audio: h.services.audio, discover: h.services.audioDiscover };
}

describe('music discover', () => {
  it('builds the home from ListenBrainz without MusicBrainz calls: albums and EPs only, newest first, covers from the archive', async () => {
    const h = await harness();
    const home = await h.discover.musicHome();
    expect(home.sections.map((s) => [s.id, s.title])).toEqual([
      ['music-fresh', 'Fresh releases'],
      ['music-top', 'Popular this week'],
    ]);
    const fresh = home.sections[0]!.items;
    expect(fresh.map((i) => i.foreignId)).toEqual([OK_COMPUTER, FRESH_EP]);
    expect(fresh[0]).toMatchObject({
      kind: 'album',
      title: 'OK Computer',
      subtitle: 'Radiohead',
      detail: 'Album',
      parentForeignId: ARTIST,
      coverUrl: `https://coverartarchive.org/release-group/${OK_COMPUTER}/front-250`,
      mediaStatus: 'unknown',
      requestId: null,
    });
    expect(home.sections[1]!.items[0]).toMatchObject({ foreignId: OK_COMPUTER, title: 'OK Computer' });
    expect(h.net.calls.some((c) => c.startsWith('musicbrainz.org'))).toBe(false);
    // Cached: a second visit costs nothing.
    const before = h.net.calls.length;
    await h.discover.musicHome();
    expect(h.net.calls.length).toBe(before);
  });

  it('keeps the page up when a source fails (empty section, not cached)', async () => {
    const h = await harness();
    h.net.setDown(true);
    const home = await h.discover.musicHome();
    expect(home.sections.every((s) => s.items.length === 0)).toBe(true);
    h.net.setDown(false);
    expect((await h.discover.musicHome()).sections[0]!.items.length).toBe(2);
  });

  it('searches artists and albums, and serves album and artist pages', async () => {
    const h = await harness();
    const found = await h.discover.musicSearch('radiohead');
    expect(found.people[0]).toMatchObject({ kind: 'artist', foreignId: ARTIST, title: 'Radiohead' });
    expect(found.titles[0]).toMatchObject({ kind: 'album', foreignId: OK_COMPUTER, subtitle: 'Radiohead', parentForeignId: ARTIST });

    const album = await h.discover.album(OK_COMPUTER);
    expect(album).toMatchObject({ artistName: 'Radiohead', artistForeignId: ARTIST, genres: ['alternative rock', 'art rock'] });
    expect(album.item).toMatchObject({ title: 'OK Computer', year: 1997 });
    expect(album.tracks.length).toBeGreaterThan(10);
    expect(album.tracks[0]).toMatchObject({ title: 'Airbag' });
    expect(album.moreByArtist.every((a) => a.foreignId !== OK_COMPUTER)).toBe(true);
    expect(album.moreByArtist.length).toBeGreaterThan(0);

    const artist = await h.discover.artist(ARTIST);
    expect(artist.item).toMatchObject({ kind: 'artist', title: 'Radiohead' });
    expect(artist.albums.some((a) => a.foreignId === OK_COMPUTER)).toBe(true);
    // Studio albums and EPs come before compilations and live albums.
    const studio = (detail: string | null | undefined) => detail === 'Album' || detail === 'EP';
    const firstOther = artist.albums.findIndex((a) => !studio(a.detail));
    expect(firstOther).toBeGreaterThan(0);
    expect(artist.albums.slice(firstOther).some((a) => studio(a.detail))).toBe(false);

    await expect(h.discover.album('not-an-mbid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers MUSIC_DISABLED while the feature is off', async () => {
    const h = await harness({ music: false });
    await expect(h.discover.musicHome()).rejects.toBeInstanceOf(AudioDisabledError);
    await expect(h.audio.create(h.user.actor, { kind: 'album', foreignId: OK_COMPUTER })).rejects.toMatchObject({ code: 'MUSIC_DISABLED' });
  });
});

describe('audiobook discover', () => {
  it('asks Amazon for a card-sized cover', () => {
    expect(cardImage('https://m.media-amazon.com/images/I/915w7r3QuxL._SL1024_.jpg')).toBe('https://m.media-amazon.com/images/I/915w7r3QuxL._SL500_.jpg');
    expect(cardImage('https://example.test/cover.jpg')).toBe('https://example.test/cover.jpg');
    expect(cardImage(null)).toBeNull();
  });

  it('lists best sellers and new releases, searches, and serves book and author pages', async () => {
    const h = await harness();
    const home = await h.discover.audiobookHome();
    expect(home.sections.map((s) => s.id)).toEqual(['book-bestsellers', 'book-new']);
    const best = home.sections[0]!.items;
    expect(best.find((b) => b.foreignId === PHM)).toMatchObject({ kind: 'book', title: 'Project Hail Mary', subtitle: 'Andy Weir', region: 'us', parentForeignId: WEIR });
    expect(h.net.calls.some((c) => c.includes('products_sort_by=BestSellers'))).toBe(true);
    expect(h.net.calls.some((c) => c.includes('products_sort_by=-ReleaseDate'))).toBe(true);

    const found = await h.discover.audiobookSearch('project hail mary');
    expect(found.titles[0]).toMatchObject({ foreignId: PHM });
    // A title search finds the author through the books' credits, not by name.
    expect(found.people[0]).toMatchObject({ kind: 'author', foreignId: WEIR, title: 'Andy Weir' });
    expect(found.people.every((p) => !/hail mary/i.test(p.title))).toBe(true);

    const book = await h.discover.book(PHM);
    expect(book.item).toMatchObject({ foreignId: PHM, title: 'Project Hail Mary' });
    expect(book.authors[0]).toMatchObject({ name: 'Andy Weir', foreignId: WEIR });
    expect(book.narrators).toContain('Ray Porter');
    expect(book.moreByAuthor.every((b) => b.foreignId !== PHM)).toBe(true);

    const author = await h.discover.author(WEIR);
    expect(author.item).toMatchObject({ kind: 'author', title: 'Andy Weir' });
    expect(author.books.length).toBeGreaterThan(0);
  });

  it('honours the region parameter in the catalogue host', async () => {
    const h = await harness();
    await h.discover.audiobookHome('uk');
    expect(h.net.calls.some((c) => c.startsWith('api.audible.co.uk'))).toBe(true);
  });
});

describe('audio requests: creation', () => {
  it('stores the catalogue facts, is pending for plain users and shows on discover cards', async () => {
    const h = await harness();
    const req = await h.audio.create(h.user.actor, { kind: 'album', foreignId: OK_COMPUTER.toUpperCase() });
    expect(req).toMatchObject({
      kind: 'album',
      status: 'pending',
      foreignId: OK_COMPUTER,
      title: 'OK Computer',
      subtitle: 'Radiohead',
      year: 1997,
      parentForeignId: ARTIST,
      mediaStatus: 'pending',
      canRemove: true,
      requestedBy: { username: 'listener' },
    });
    const card = (await h.discover.musicHome()).sections[0]!.items.find((i) => i.foreignId === OK_COMPUTER)!;
    expect(card).toMatchObject({ mediaStatus: 'pending', requestId: req.id, requestStatus: 'pending' });
    expect(h.events.map((e) => e.type)).toEqual(['requestCreated']);
    expect(h.events[0]).toMatchObject({ media: { mediaType: 'music', title: 'Radiohead' }, album: { title: 'OK Computer', mbReleaseGroupId: OK_COMPUTER } });
    expect('applicationUrl' in h.events[0]!).toBe(false);
  });

  it('refuses duplicates, bad ids and users without the permission', async () => {
    const h = await harness();
    await h.audio.create(h.user.actor, { kind: 'album', foreignId: OK_COMPUTER });
    await expect(h.audio.create(h.user.actor, { kind: 'album', foreignId: OK_COMPUTER })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(h.audio.create(h.user.actor, { kind: 'album', foreignId: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(h.audio.create(h.user.actor, { kind: 'book', foreignId: 'short' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const movieOnly = addUser(h.db, { permissions: P.REQUEST_MOVIE });
    await expect(h.audio.create(movieOnly.actor, { kind: 'artist', foreignId: ARTIST })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const musicOnly = addUser(h.db, { permissions: P.REQUEST_MUSIC });
    expect((await h.audio.create(musicOnly.actor, { kind: 'artist', foreignId: ARTIST })).status).toBe('pending');
    await expect(h.audio.create(musicOnly.actor, { kind: 'book', foreignId: PHM })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const bookOnly = addUser(h.db, { permissions: P.REQUEST_AUDIOBOOK });
    expect((await h.audio.create(bookOnly.actor, { kind: 'book', foreignId: PHM })).status).toBe('pending');
  });

  it('refuses an item already available in the library', async () => {
    const h = await harness();
    await h.audio.create(h.admin.actor, { kind: 'book', foreignId: PHM });
    giveBookFile(h.db, PHM);
    h.db.delete(audioRequests).run();
    await expect(h.audio.create(h.user.actor, { kind: 'book', foreignId: PHM })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/already in the library/) });
  });

  it('auto-approves for AUTO_APPROVE and MANAGE_REQUESTS', async () => {
    const h = await harness();
    const auto = addUser(h.db, { permissions: P.REQUEST | P.AUTO_APPROVE });
    expect((await h.audio.create(auto.actor, { kind: 'artist', foreignId: ARTIST })).status).toBe('approved');
    const manager = addUser(h.db, { permissions: P.MANAGE_REQUESTS | P.REQUEST_AUDIOBOOK });
    expect((await h.audio.create(manager.actor, { kind: 'book', foreignId: PHM })).status).toBe('approved');
  });
});

describe('audio requests: approval', () => {
  it('album of a new artist: adds the artist with nothing monitored, then monitors the album and searches it', async () => {
    const h = await harness();
    const req = await h.audio.create(h.user.actor, { kind: 'album', foreignId: OK_COMPUTER });
    const approved = await h.audio.approve(h.admin.actor, req.id);
    expect(approved.status).toBe('approved');
    expect(h.library.calls).toEqual([`addArtist:${ARTIST}:none:false`]);
    await h.audio.whenIdle();
    const album = albumByMbid(h.db, OK_COMPUTER)!;
    expect(album.monitored).toBe(true);
    expect(h.db.select().from(artists).where(eq(artists.id, album.artistId)).get()!.monitored).toBe(true);
    expect(h.library.searches).toEqual([{ kind: 'album', ids: [album.id] }]);
    const after = h.audio.get(h.admin.actor, req.id);
    expect(after).toMatchObject({ status: 'approved', libraryId: album.id, mediaStatus: 'processing', modifiedBy: { username: 'boss' } });
    expect(h.events.map((e) => e.type)).toEqual(['requestCreated', 'requestApproved']);
  });

  it('album of an artist in the library: refreshes when the album row is missing, monitors at once when present', async () => {
    const h = await harness();
    h.library.groups = [];
    await h.library.addArtist({ mbArtistId: ARTIST, rootFolderPath: '/media/music', qualityProfileId: h.musicProfileId, monitored: false, monitorOption: 'none', monitorNewAlbums: 'none', tags: [], searchOnAdd: false });
    h.library.groups = [{ mbid: OK_COMPUTER, title: 'OK Computer', primaryType: 'Album', secondaryTypes: [], artistCredits: [] }];
    const req = await h.audio.create(h.admin.actor, { kind: 'album', foreignId: OK_COMPUTER });
    await h.audio.whenIdle();
    expect(h.library.calls.at(-1)).toMatch(/^refreshArtist:/);
    expect(h.audio.get(h.admin.actor, req.id)).toMatchObject({ status: 'approved', libraryId: albumByMbid(h.db, OK_COMPUTER)!.id });

    // Present already: no refresh.
    h.db.delete(audioRequests).run();
    h.db.update(albums).set({ monitored: false }).run();
    const calls = h.library.calls.length;
    const again = await h.audio.create(h.admin.actor, { kind: 'album', foreignId: OK_COMPUTER });
    expect(h.library.calls.length).toBe(calls);
    expect(again.libraryId).toBe(albumByMbid(h.db, OK_COMPUTER)!.id);
    expect(albumByMbid(h.db, OK_COMPUTER)!.monitored).toBe(true);
  });

  it('fails with a reason when the album never shows up, or the sync fails', async () => {
    const h = await harness();
    h.library.groups = [];
    const req = await h.audio.create(h.admin.actor, { kind: 'album', foreignId: OK_COMPUTER });
    await h.audio.whenIdle();
    expect(h.audio.get(h.admin.actor, req.id)).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/not found on the artist/) });
    h.library.groups = [{ mbid: OK_COMPUTER, title: 'OK Computer', primaryType: 'Album', secondaryTypes: [], artistCredits: [] }];
    h.library.failSync = 'MusicBrainz is unreachable';
    await h.audio.retry(h.admin.actor, req.id);
    await h.audio.whenIdle();
    expect(h.audio.get(h.admin.actor, req.id)).toMatchObject({ status: 'failed', failureReason: 'MusicBrainz is unreachable' });
    h.library.failSync = null;
    await h.audio.retry(h.admin.actor, req.id);
    await h.audio.whenIdle();
    expect(h.audio.get(h.admin.actor, req.id).status).toBe('approved');
  });

  it('without a root folder the request fails (no 500); retry works once one exists', async () => {
    const h = await harness({ roots: false });
    const req = await h.audio.create(h.user.actor, { kind: 'artist', foreignId: ARTIST });
    const failed = await h.audio.approve(h.admin.actor, req.id);
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'No music root folder is set up' });
    h.db.insert(rootFolders).values({ path: '/media/music', mediaType: 'music' }).run();
    const retried = await h.audio.retry(h.admin.actor, req.id);
    expect(retried.status).toBe('approved');
    expect(h.library.calls).toEqual([`addArtist:${ARTIST}:all:true`]);
  });

  it('uses the audioRequests defaults and validates them', async () => {
    const h = await harness();
    expect(() => h.audio.setDefaults(h.admin.actor, { music: { rootFolderPath: '/elsewhere', qualityProfileId: null }, audiobook: { rootFolderPath: null, qualityProfileId: null } })).toThrow(RequestsError);
    expect(() => h.audio.setDefaults(h.admin.actor, { music: { rootFolderPath: null, qualityProfileId: h.audiobookProfileId }, audiobook: { rootFolderPath: null, qualityProfileId: null } })).toThrow(/not a music profile/);
    expect(() => h.audio.defaults(h.user.actor)).toThrow(RequestsError);
    const second = h.db.insert(qualityProfiles).values({ name: 'Second', cutoff: 1, items: [], formatItems: [], languages: [], mediaDomain: 'music' }).returning().get().id;
    h.audio.setDefaults(h.admin.actor, { music: { rootFolderPath: '/media/music', qualityProfileId: second }, audiobook: { rootFolderPath: null, qualityProfileId: null } });
    const req = await h.audio.create(h.admin.actor, { kind: 'artist', foreignId: ARTIST });
    expect(h.db.select().from(artists).where(eq(artists.id, req.libraryId!)).get()!.qualityProfileId).toBe(second);
  });

  it('artist in the library: monitored and searched', async () => {
    const h = await harness();
    const added = await h.library.addArtist({ mbArtistId: ARTIST, rootFolderPath: '/media/music', qualityProfileId: h.musicProfileId, monitored: false, monitorOption: 'none', monitorNewAlbums: 'none', tags: [], searchOnAdd: false });
    const req = await h.audio.create(h.admin.actor, { kind: 'artist', foreignId: ARTIST });
    expect(req).toMatchObject({ status: 'approved', libraryId: added.id });
    expect(h.db.select().from(artists).where(eq(artists.id, added.id)).get()!.monitored).toBe(true);
    expect(h.library.searches).toEqual([{ kind: 'artist', ids: [added.id] }]);
  });

  it('book: added by ASIN with author options and search on add; an existing book is monitored and searched', async () => {
    const h = await harness();
    const req = await h.audio.create(h.user.actor, { kind: 'book', foreignId: PHM });
    expect(req).toMatchObject({ title: 'Project Hail Mary', subtitle: 'Andy Weir', parentForeignId: WEIR, region: 'us' });
    const approved = await h.audio.approve(h.admin.actor, req.id);
    expect(h.library.calls).toEqual([`addBook:${PHM}:true:author`]);
    const book = h.db.select().from(books).where(eq(books.asin, PHM)).get()!;
    expect(approved).toMatchObject({ status: 'approved', libraryId: book.id, mediaStatus: 'processing' });
    expect(h.library.searches).toEqual([]);

    h.db.update(books).set({ monitored: false }).run();
    h.db.delete(audioRequests).run();
    const again = await h.audio.create(h.admin.actor, { kind: 'book', foreignId: PHM });
    expect(again.libraryId).toBe(book.id);
    expect(h.db.select().from(books).where(eq(books.id, book.id)).get()!.monitored).toBe(true);
    expect(h.library.searches).toEqual([{ kind: 'book', ids: [book.id] }]);
  });

  it('author: added with every book monitored and search on add', async () => {
    const h = await harness();
    const req = await h.audio.create(h.admin.actor, { kind: 'author', foreignId: WEIR });
    expect(req).toMatchObject({ status: 'approved', title: 'Andy Weir' });
    expect(h.library.calls).toEqual([`addAuthor:${WEIR}:all:true`]);
  });

  it('decline needs MANAGE_REQUESTS and keeps the reason; only pending requests decline', async () => {
    const h = await harness();
    const req = await h.audio.create(h.user.actor, { kind: 'artist', foreignId: ARTIST });
    await expect(h.audio.decline(h.user.actor, req.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.audio.approve(h.user.actor, req.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const declined = await h.audio.decline(h.admin.actor, req.id, 'not now');
    expect(declined).toMatchObject({ status: 'declined', declineReason: 'not now', canRemove: true });
    await expect(h.audio.decline(h.admin.actor, req.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.events.at(-1)).toMatchObject({ type: 'requestDeclined', reason: 'not now' });
  });
});

describe('audio requests: reading, sync and cleanup', () => {
  it('scopes lists to the caller unless they may view all; filters by domain and status; counts', async () => {
    const h = await harness();
    const other = addUser(h.db, { permissions: P.REQUEST });
    await h.audio.create(h.user.actor, { kind: 'album', foreignId: OK_COMPUTER });
    await h.audio.create(other.actor, { kind: 'book', foreignId: PHM });
    expect(h.audio.list(h.user.actor, {}).results.map((r) => r.title)).toEqual(['OK Computer']);
    expect(() => h.audio.list(h.user.actor, { requestedBy: other.id })).toThrow(RequestsError);
    expect(h.audio.list(h.admin.actor, {}).pageInfo.total).toBe(2);
    expect(h.audio.list(h.admin.actor, { domain: 'audiobook' }).results.map((r) => r.kind)).toEqual(['book']);
    expect(h.audio.list(h.admin.actor, { filter: 'approved' }).pageInfo.total).toBe(0);
    expect(h.audio.list(h.admin.actor, { sortDirection: 'asc', take: 1 }).results[0]!.kind).toBe('album');
    const viewer = addUser(h.db, { permissions: P.REQUEST_VIEW });
    expect(h.audio.list(viewer.actor, {}).pageInfo.total).toBe(2);
    expect(h.audio.count(h.admin.actor)).toEqual({ total: 2, music: 1, audiobook: 1, pending: 2 });
    expect(h.audio.count(h.user.actor)).toEqual({ total: 1, music: 1, audiobook: 0, pending: 1 });
    const theirs = h.audio.list(h.admin.actor, { domain: 'audiobook' }).results[0]!;
    expect(() => h.audio.get(h.user.actor, theirs.id)).toThrow(RequestsError);
  });

  it('owners delete their pending requests; managers delete any', async () => {
    const h = await harness();
    const mine = await h.audio.create(h.user.actor, { kind: 'artist', foreignId: ARTIST });
    const auto = await h.audio.create(h.admin.actor, { kind: 'author', foreignId: WEIR });
    expect(() => h.audio.remove(h.user.actor, auto.id)).toThrow(RequestsError);
    h.audio.remove(h.user.actor, mine.id);
    h.audio.remove(h.admin.actor, auto.id);
    expect(h.db.select().from(audioRequests).all()).toEqual([]);
  });

  it('the status sync completes approved requests once the item is available', async () => {
    const h = await harness();
    const req = await h.audio.create(h.user.actor, { kind: 'book', foreignId: PHM });
    await h.audio.approve(h.admin.actor, req.id);
    expect(await h.audio.syncStatuses()).toBe('1 audio requests checked, 0 completed');
    giveBookFile(h.db, PHM);
    expect(await h.audio.syncStatuses()).toBe('1 audio requests checked, 1 completed');
    expect(h.audio.get(h.user.actor, req.id)).toMatchObject({ status: 'completed', mediaStatus: 'available' });
    expect(h.events.at(-1)).toMatchObject({ type: 'requestAvailable', media: { mediaType: 'audiobook', title: 'Andy Weir' }, book: { asin: PHM } });
  });

  it('purgeOrphans drops audio requests of deleted users', async () => {
    const h = await harness();
    await h.audio.create(h.user.actor, { kind: 'artist', foreignId: ARTIST });
    h.db.delete(users).where(eq(users.id, h.user.id)).run();
    expect(h.services.requests.purgeOrphans()).toBeGreaterThanOrEqual(1);
    expect(h.db.select().from(audioRequests).all()).toEqual([]);
  });

  it('a disabled domain blocks approval but not reading', async () => {
    const h = await harness();
    const req = await h.audio.create(h.user.actor, { kind: 'artist', foreignId: ARTIST });
    setSection(h.db, 'features', { music: false, audiobooks: true });
    await expect(h.audio.approve(h.admin.actor, req.id)).rejects.toBeInstanceOf(AudioDisabledError);
    expect(h.audio.get(h.admin.actor, req.id).status).toBe('pending');
  });
});
