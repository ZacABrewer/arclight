import pino from 'pino';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { SearchRequest } from '@arclight/indexers';
import type { ReleaseResource } from '@arclight/shared';
import { blocklistScopeFor, historyTarget, searchTargetFor } from '../../wiring.js';
import { BlocklistService } from '../blocklist/service.js';
import { HistoryService } from '../history/service.js';
import { setSection } from '../settings/service.js';
import { authorSearchPlan, bookRequests, bookSearchPlan, significantWords } from './audio-search.js';
import type { ReleasesDeps } from './deps.js';
import { pendingReleases, releaseDecisions, releaseSearchState } from './schema.js';
import { bookFixtures, harness, makeRelease } from './test-support.js';

const MB = 1024 * 1024;
const DAY = 24 * 3_600_000;
const AUDIOBOOK = [3030];

function m4b(title: string, overrides: Partial<ReleaseResource> = {}): ReleaseResource {
  return makeRelease(title, { size: 500 * MB, categories: AUDIOBOOK, ...overrides });
}

/** A releases harness whose history and blocklist hooks run the real services (as wiring.ts does). */
async function bookHarness() {
  let history!: HistoryService;
  let blocklist!: BlocklistService;
  const deps: ReleasesDeps = {
    history: {
      recordGrab: (g) => {
        const target = historyTarget(g);
        if (!target) return;
        history.recordGrab(
          { title: g.sourceTitle, protocol: g.protocol, guid: g.guid, indexerId: g.indexerId, indexerName: g.indexerName, size: g.size, publishDate: g.publishDate },
          { target, quality: g.quality, languages: g.languages, customFormatScore: g.customFormatScore },
          g.downloadId,
          g.downloadClientName ?? 'client',
        );
      },
      latestFor: (item, type) => {
        if (!('bookId' in item)) return null;
        const row = history.mostRecentForBook(item.bookId, type as never);
        return row ? { eventType: row.eventType, date: row.date, sourceTitle: row.sourceTitle, quality: row.quality, ...(row.downloadId ? { downloadId: row.downloadId } : {}) } : null;
      },
    },
    blocklist: {
      isBlocklisted: (c) => {
        const scope = blocklistScopeFor(c);
        return scope ? blocklist.isBlocklisted(scope, { title: c.title, protocol: c.protocol, indexer: 'Tracker', torrentInfoHash: c.infoHash ?? null, publishedDate: c.publishDate }) : false;
      },
    },
  };
  const h = await harness({ deps });
  const log = pino({ level: 'silent' });
  history = new HistoryService({ db: h.db, log, now: h.now });
  blocklist = new BlocklistService({ db: h.db, log, now: h.now });
  history.onDownloadFailed((e) => {
    blocklist.addFromFailed(e);
  });
  const b = bookFixtures(h.db, h.profiles);
  const author = b.addAuthor({ name: 'Andy Weir', sortName: 'Weir, Andy' });
  const hailMary = b.addBook(author.id, 'Project Hail Mary', { asin: 'B08G9PRS1K', runtimeMinutes: 970, releaseDate: '2021-05-04', year: 2021 });
  const martian = b.addBook(author.id, 'The Martian', { runtimeMinutes: 650, releaseDate: '2013-03-22', year: 2013 });
  return { ...h, history, blocklist, b, author, hailMary, martian };
}

describe('book search plans', () => {
  const author = { id: 1, name: 'Andy Weir' };
  it('asks t=book first, then q fallbacks: author + title, title (3+ words), ASIN', () => {
    expect(bookRequests(author, { id: 2, title: 'Project Hail Mary', asin: 'B08G9PRS1K' })).toEqual([
      { kind: 'book', author: 'Andy Weir', title: 'Project Hail Mary' },
      { kind: 'book', query: 'Andy Weir Project Hail Mary' },
      { kind: 'book', query: 'Project Hail Mary' },
      { kind: 'book', query: 'B08G9PRS1K' },
    ]);
    // "The Martian" is one significant word: searching it alone would bring the film.
    expect(significantWords('The Martian')).toBe(1);
    expect(bookRequests(author, { id: 3, title: 'The Martian', asin: null })).toEqual([
      { kind: 'book', author: 'Andy Weir', title: 'The Martian' },
      { kind: 'book', query: 'Andy Weir The Martian' },
    ]);
  });

  it('author search asks for the author once, then per book', () => {
    const plan = authorSearchPlan(author, [
      { id: 2, title: 'Project Hail Mary', asin: null },
      { id: 3, title: 'The Martian', asin: null },
    ]);
    expect(plan[0]).toEqual({ bookIds: [2, 3], requests: [{ kind: 'book', query: 'Andy Weir' }] });
    expect(plan.slice(1).map((s) => s.bookIds)).toEqual([[2], [3]]);
    expect(bookSearchPlan(author, [{ id: 2, title: 'Project Hail Mary', asin: null }])).toHaveLength(1);
    expect(authorSearchPlan(author, [])).toEqual([]);
  });

  it('stops after the first query with an approved release; falls back to q when t=book finds nothing', async () => {
    const h = await bookHarness();
    h.indexers.search = async (request: SearchRequest) => {
      h.indexers.searches.push(request);
      return request.kind === 'book' && request.query ? [m4b('Andy Weir - Project Hail Mary (Unabridged) [m4b]')] : [];
    };
    const summary = await h.service.searchFor({ bookIds: [h.hailMary.id] });
    expect(h.indexers.searches).toEqual([
      { kind: 'book', author: 'Andy Weir', title: 'Project Hail Mary' },
      { kind: 'book', query: 'Andy Weir Project Hail Mary' },
    ]);
    expect(summary.grabbed).toEqual(['Andy Weir - Project Hail Mary (Unabridged) [m4b]']);
  });

  it('works through every fallback down to the ASIN when nothing earlier is approved', async () => {
    const h = await bookHarness();
    h.indexers.search = async (request: SearchRequest) => {
      h.indexers.searches.push(request);
      return request.kind === 'book' && request.query === 'B08G9PRS1K' ? [m4b('Project.Hail.Mary.B08G9PRS1K.m4b-GRP')] : [];
    };
    const summary = await h.service.searchFor({ bookIds: [h.hailMary.id] });
    expect((h.indexers.searches as SearchRequest[]).map((r) => (r.kind === 'book' ? (r.query ?? 't=book') : ''))).toEqual([
      't=book',
      'Andy Weir Project Hail Mary',
      'Project Hail Mary',
      'B08G9PRS1K',
    ]);
    expect(summary.grabbed).toHaveLength(1);
  });

  it('author search: the author query settles the books it found; the rest are searched one by one', async () => {
    const h = await bookHarness();
    h.indexers.search = async (request: SearchRequest) => {
      h.indexers.searches.push(request);
      return request.kind === 'book' && request.query === 'Andy Weir' ? [m4b('Andy Weir - Project Hail Mary [m4b]')] : [];
    };
    await h.service.searchFor({ authorId: h.author.id }, { userInvoked: true });
    const asked = h.indexers.searches as SearchRequest[];
    expect(asked[0]).toEqual({ kind: 'book', query: 'Andy Weir' });
    expect(asked.slice(1).every((r) => r.kind === 'book' && (r.title === 'The Martian' || r.query?.includes('The Martian')))).toBe(true);
    expect(h.downloads.grabs).toHaveLength(1);
  });
});

describe('audiobook decisions', () => {
  it('decides on audiobook-category releases end to end and logs them as audiobook rows', async () => {
    const h = await bookHarness();
    const [good, unknownBook, video] = await h.service.decide(
      [m4b('Andy Weir - Project Hail Mary (Unabridged) [m4b] narrated by Ray Porter'), m4b('Andy Weir - Artemis [m4b]'), makeRelease('Show.S01E01.1080p.WEB-DL-GRP')],
      'search',
      { criteria: { mediaType: 'audiobook', authorId: h.author.id, bookIds: [h.hailMary.id], userInvoked: false } },
    );
    expect(good!.decision).toMatchObject({
      approved: true,
      mediaType: 'audiobook',
      authorId: h.author.id,
      authorName: 'Andy Weir',
      bookIds: [h.hailMary.id],
      books: [{ id: h.hailMary.id, title: 'Project Hail Mary', series: null, seriesPosition: null, year: 2021 }],
      audiobook: { authors: ['Andy Weir'], title: 'Project Hail Mary', narrators: ['Ray Porter'], formatType: 'unabridged', container: 'm4b', isPack: false },
      quality: { quality: { name: 'AB-AAC' } },
    });
    expect(unknownBook!.decision).toMatchObject({ approved: false, mediaType: 'audiobook', authorId: h.author.id, rejections: [{ reason: 'unknownBook' }] });
    expect(video!.decision.approved).toBe(false);

    await h.service.processReleases([m4b('Andy Weir - The Martian [m4b]')], 'rss');
    const logged = h.db.select().from(releaseDecisions).all();
    expect(logged.find((r) => r.title.includes('Martian'))).toMatchObject({ mediaType: 'audiobook', authorId: h.author.id, bookIds: [h.martian.id], chosen: true });
    const page = h.service.listDecisionBatches({ bookId: h.martian.id, page: 1, pageSize: 10 });
    expect(page.records[0]!.decisions[0]).toMatchObject({ mediaType: 'audiobook', authorId: h.author.id, bookIds: [h.martian.id] });
    expect(h.service.listDecisionBatches({ authorId: h.author.id, page: 1, pageSize: 10 }).totalRecords).toBeGreaterThan(0);
  });

  it('uncategorised releases go to the audiobook parser only with a marker and a library hit', async () => {
    const h = await bookHarness();
    h.addMovie({ title: 'The Martian', year: 2015 });
    const [hit, noMarker, noHit] = await h.service.decide(
      [
        makeRelease('Andy Weir - The Martian (Unabridged) [m4b]', { size: 400 * MB }),
        makeRelease('The.Martian.2015.1080p.BluRay.x264-GRP'),
        makeRelease('Nobody - Unknown Book (Unabridged) [m4b]'),
      ],
      'search',
    );
    expect(hit!.decision).toMatchObject({ mediaType: 'audiobook', bookIds: [h.martian.id], approved: true });
    expect(noMarker!.decision.mediaType).toBe('movie');
    expect(noHit!.decision.mediaType).not.toBe('audiobook');
  });

  it('drops audiobook releases while audiobooks are off', async () => {
    const h = await bookHarness();
    setSection(h.db, 'features', { music: false, audiobooks: false });
    expect(await h.service.decide([m4b('Andy Weir - The Martian [m4b]')], 'rss')).toEqual([]);
  });

  it('parks delayed book releases as pending with their author and books, then grabs them', async () => {
    const h = await bookHarness();
    const dp = h.profiles.listDelayProfiles()[0]!;
    h.profiles.updateDelayProfile(dp.id, {
      tags: [],
      preferredProtocol: 'usenet',
      usenetDelayMinutes: 0,
      torrentDelayMinutes: 120,
      bypassIfHighestQuality: false,
      bypassIfAboveCustomFormatScore: false,
      minimumCustomFormatScore: 0,
    });
    await h.service.processReleases([m4b('Andy Weir - The Martian [m4b]', { ageMinutes: 5 })], 'rss');
    expect(h.service.listPending()).toMatchObject([{ mediaType: 'audiobook', authorId: h.author.id, bookIds: [h.martian.id], quality: { quality: { name: 'AB-AAC' } } }]);
    expect(h.db.select().from(pendingReleases).all()[0]).toMatchObject({ authorId: h.author.id, bookIds: [h.martian.id] });
    h.advance(3 * 3_600_000);
    await h.service.processPending();
    expect(h.downloads.grabs).toHaveLength(1);
    expect(h.downloads.grabs[0]!.tracking).toMatchObject({ mediaType: 'audiobook', authorId: h.author.id, bookIds: [h.martian.id] });
    expect(h.service.listPending()).toEqual([]);
  });

  it('series packs: books in range, wanted ones only, automatic grabs only when allowed', async () => {
    const h = await bookHarness();
    const corey = h.b.addAuthor({ name: 'James S. A. Corey' });
    const books = ['Leviathan Wakes', "Caliban's War", "Abaddon's Gate"].map((t) => h.b.addBook(corey.id, t));
    h.b.addSeries('The Expanse', books.map((b, i) => ({ bookId: b.id, position: String(i + 1) })));
    h.b.addFile(books[0]!, 'AB-AAC');
    const pack = m4b('James S. A. Corey - The Expanse Books 1-3 [m4b]', { size: 1500 * MB });
    const [rss] = await h.service.decide([pack], 'rss');
    expect(rss!.decision.rejections.map((r) => r.reason)).toContain('bookPackNotAllowed');
    const [interactive] = await h.service.decide([pack], 'interactiveSearch');
    // Book 1 already meets the cutoff: the pack is tracked for books 2 and 3.
    expect(interactive!.decision).toMatchObject({ approved: true, bookIds: [books[1]!.id, books[2]!.id], audiobook: { isPack: true, series: 'The Expanse' } });
  });
});

describe('audiobook grabs, failures and scheduled searches', () => {
  it('a grab tracks the download and records history for the author and books; failure blocklists and re-searches', async () => {
    const h = await bookHarness();
    const bad = m4b('Andy Weir - Project Hail Mary [m4b]', { guid: 'bad' });
    const good = m4b('Andy Weir - Project Hail Mary (Unabridged) [m4b] [Retail]', { guid: 'good', seeders: 10 });
    h.indexers.results = [bad];
    await h.service.searchFor({ bookIds: [h.hailMary.id] });
    expect(h.downloads.grabs[0]!.tracking).toMatchObject({ mediaType: 'audiobook', authorId: h.author.id, bookIds: [h.hailMary.id] });
    const grabbed = h.history.mostRecentForBook(h.hailMary.id, 'grabbed');
    expect(grabbed).toMatchObject({ mediaType: 'audiobook', authorId: h.author.id, bookIds: [h.hailMary.id], downloadId: 'hash1' });
    expect(h.history.list({ page: 1, pageSize: 10, sortKey: 'date', sortDirection: 'desc', authorId: [h.author.id], bookId: h.hailMary.id } as never).totalRecords).toBe(1);

    // Failed download → history row → blocklist (author scope) → automatic re-search (wiring's target).
    const searches: unknown[] = [];
    h.history.onDownloadFailed(async (event) => {
      const target = searchTargetFor(event.target);
      searches.push(target);
      if (target) await h.service.searchFor(target);
    }, 100);
    h.indexers.results = [bad, good];
    await h.history.failTracked({ downloadId: 'hash1', title: bad.title, protocol: 'torrent' }, { message: 'Download failed' });
    expect(h.blocklist.forAuthor(h.author.id)).toMatchObject([{ mediaType: 'audiobook', authorId: h.author.id, bookIds: [h.hailMary.id], sourceTitle: bad.title }]);
    expect(searches).toEqual([{ authorId: h.author.id, bookIds: [h.hailMary.id] }]);
    expect(h.downloads.grabs.map((g) => g.request.title)).toEqual([bad.title, good.title]);
    expect(h.history.forAuthor(h.author.id).map((r) => r.eventType)).toEqual(['grabbed', 'downloadFailed', 'grabbed']);
  });

  it('history redownload of an audiobook row searches its books', async () => {
    const h = await bookHarness();
    h.indexers.results = [m4b('Andy Weir - The Martian [m4b]')];
    await h.service.searchFor({ bookIds: [h.martian.id] });
    const row = h.history.mostRecentForBook(h.martian.id, 'grabbed')!;
    const targets: unknown[] = [];
    h.history.setRedownloadHandler((target) => {
      targets.push(searchTargetFor(target));
      return { id: 1 } as never;
    });
    h.history.redownload(row.id);
    expect(targets).toEqual([{ authorId: h.author.id, bookIds: [h.martian.id] }]);
  });

  it('MissingBookSearch searches missing books with the per-book back-off; a grab clears it', async () => {
    const h = await bookHarness();
    h.indexers.results = [];
    expect(await h.service.missingBookSearch()).toBe('missing books: searched 2, grabbed 0');
    const states = h.db.select().from(releaseSearchState).where(eq(releaseSearchState.mediaType, 'book')).all();
    expect(states.map((s) => s.itemId).sort()).toEqual([h.hailMary.id, h.martian.id].sort());
    h.advance(3_600_000);
    expect(await h.service.missingBookSearch()).toBe('missing books: searched 0, grabbed 0');
    h.advance(DAY);
    h.indexers.results = [m4b('Andy Weir - The Martian [m4b]')];
    expect(await h.service.missingBookSearch()).toMatch(/searched 2, grabbed 1/);
    const left = h.db.select().from(releaseSearchState).where(eq(releaseSearchState.mediaType, 'book')).all();
    expect(left.map((s) => s.itemId)).toEqual([h.hailMary.id]);
    expect(h.service.searchStatus({ mediaType: 'book', ids: [h.hailMary.id] })[0]).toMatchObject({
      mediaType: 'book',
      lastSearch: { outcome: 'noResults' },
      automatic: { state: 'scheduled', job: 'MissingBookSearch', searchCount: 2 },
    });
    setSection(h.db, 'features', { music: false, audiobooks: false });
    expect(await h.service.missingBookSearch()).toBe('skipped: audiobooks are not enabled');
  });

  it('CutoffUnmetAudioSearch includes books whose lowest file is below cutoff', async () => {
    const h = await bookHarness();
    h.b.addFile(h.martian, 'AB-MP3');
    h.b.addFile(h.hailMary, 'AB-AAC');
    h.indexers.results = [m4b('Andy Weir - The Martian [m4b]')];
    expect(await h.service.cutoffUnmetAudioSearch()).toBe('cutoff unmet books: searched 1, grabbed 1');
    expect(h.service.searchStatus({ mediaType: 'book', ids: [h.hailMary.id] })[0]!.automatic.state).toBe('satisfied');
  });

  it('interactive book and author search return every decision with the parsed audiobook info', async () => {
    const h = await bookHarness();
    h.indexers.results = [m4b('Andy Weir - Project Hail Mary (Unabridged) [m4b] narrated by Ray Porter'), m4b('Andy Weir - The Martian (Abridged) [mp3] 64kbps')];
    const decisions = await h.service.interactiveSearch({ bookId: h.hailMary.id });
    expect(decisions[0]).toMatchObject({ approved: true, books: [{ id: h.hailMary.id, title: 'Project Hail Mary' }], audiobook: { narrators: ['Ray Porter'], container: 'm4b' } });
    expect(decisions.find((d) => d.bookIds?.includes(h.martian.id))).toMatchObject({ approved: false, rejections: expect.arrayContaining([expect.objectContaining({ reason: 'wrongBook' })]) });
    expect(h.downloads.grabs).toHaveLength(0);
    const byAuthor = await h.service.interactiveSearch({ authorId: h.author.id });
    expect(byAuthor.find((d) => d.bookIds?.includes(h.martian.id))).toMatchObject({ audiobook: { formatType: 'abridged', bitrateKbps: 64 }, rejections: [{ reason: 'abridgedNotWanted' }] });
    // Grab by guid: POST /release with the book pinned.
    await h.service.grab({ guid: decisions[0]!.guid, indexerId: 1, bookIds: [h.hailMary.id] });
    expect(h.downloads.grabs[0]!.tracking).toMatchObject({ authorId: h.author.id, bookIds: [h.hailMary.id] });
  });
});
