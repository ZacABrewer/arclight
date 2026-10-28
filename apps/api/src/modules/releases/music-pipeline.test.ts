import pino from 'pino';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { SearchRequest } from '@arclight/indexers';
import type { ReleaseResource } from '@arclight/shared';
import { blocklistScopeFor, historyTarget, searchTargetFor } from '../../wiring.js';
import { BlocklistService } from '../blocklist/service.js';
import { HistoryService } from '../history/service.js';
import { setSection } from '../settings/service.js';
import { albumRequests, albumSearchPlan, artistSearchPlan } from './audio-search.js';
import type { ReleasesDeps } from './deps.js';
import { releaseDecisions, releaseSearchState } from './schema.js';
import { harness, makeRelease, musicFixtures, NOW } from './test-support.js';

const MB = 1024 * 1024;
const DAY = 24 * 3_600_000;
const MUSIC = [3000, 3040];

function flac(title: string, overrides: Partial<ReleaseResource> = {}): ReleaseResource {
  return makeRelease(title, { size: 350 * MB, categories: MUSIC, ...overrides });
}

/** A releases harness whose history and blocklist hooks run the real services (as wiring.ts does). */
async function musicHarness() {
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
        if (!('albumId' in item)) return null;
        const row = history.mostRecentForAlbum(item.albumId, type as never);
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
  const m = musicFixtures(h.db, h.profiles);
  const artist = m.addArtist({ name: 'Radiohead' });
  const okc = m.addAlbum(artist.id, 'OK Computer', 1997, { minutes: 53, tracks: 12 });
  const kidA = m.addAlbum(artist.id, 'Kid A', 2000, { minutes: 50, tracks: 10 });
  return { ...h, history, blocklist, m, artist, okc, kidA };
}

describe('album search plans', () => {
  const artist = { id: 1, name: 'Radiohead' };
  it('asks t=music first, then q fallbacks; edition brackets dropped last', () => {
    expect(albumRequests(artist, { id: 2, title: 'OK Computer (Deluxe Edition)', year: 1997 })).toEqual([
      { kind: 'music', artist: 'Radiohead', album: 'OK Computer (Deluxe Edition)', year: 1997 },
      { kind: 'music', query: 'Radiohead OK Computer (Deluxe Edition)' },
      { kind: 'music', query: 'Radiohead OK Computer' },
    ]);
    expect(albumRequests(artist, { id: 2, title: 'Kid A', year: null })).toEqual([
      { kind: 'music', artist: 'Radiohead', album: 'Kid A' },
      { kind: 'music', query: 'Radiohead Kid A' },
    ]);
  });

  it('searches Various Artists albums by the album alone, and never asks for "Various Artists"', () => {
    const va = { id: 9, name: 'Various Artists' };
    expect(albumRequests(va, { id: 3, title: 'Now 50', year: 2001 })).toEqual([
      { kind: 'music', album: 'Now 50', year: 2001 },
      { kind: 'music', query: 'Now 50' },
    ]);
    expect(artistSearchPlan(va, [{ id: 3, title: 'Now 50', year: 2001 }]).map((s) => s.requests[0])).toEqual([{ kind: 'music', album: 'Now 50', year: 2001 }]);
  });

  it('artist search asks for the artist once, then per album', () => {
    const plan = artistSearchPlan(artist, [
      { id: 2, title: 'OK Computer', year: 1997 },
      { id: 3, title: 'Kid A', year: 2000 },
    ]);
    expect(plan[0]).toEqual({ albumIds: [2, 3], requests: [{ kind: 'music', query: 'Radiohead' }] });
    expect(plan.slice(1).map((s) => s.albumIds)).toEqual([[2], [3]]);
    expect(albumSearchPlan(artist, [{ id: 2, title: 'OK Computer', year: 1997 }])).toHaveLength(1);
  });

  it('stops after the first query with an approved release; falls back to q when t=music finds nothing', async () => {
    const h = await musicHarness();
    // An indexer without music search: the structured request yields nothing, the q query hits.
    h.indexers.search = async (request: SearchRequest) => {
      h.indexers.searches.push(request);
      return request.kind === 'music' && request.query ? [flac('Radiohead - OK Computer (1997) [FLAC]')] : [];
    };
    const summary = await h.service.searchFor({ albumIds: [h.okc.id] });
    expect(h.indexers.searches).toEqual([
      { kind: 'music', artist: 'Radiohead', album: 'OK Computer', year: 1997 },
      { kind: 'music', query: 'Radiohead OK Computer' },
    ]);
    expect(summary.grabbed).toEqual(['Radiohead - OK Computer (1997) [FLAC]']);
  });

  it('artist search: the artist query settles the albums it found; the rest are searched one by one', async () => {
    const h = await musicHarness();
    h.indexers.search = async (request: SearchRequest) => {
      h.indexers.searches.push(request);
      return request.kind === 'music' && request.query === 'Radiohead' ? [flac('Radiohead - OK Computer (1997) [FLAC]')] : [];
    };
    await h.service.searchFor({ artistId: h.artist.id }, { userInvoked: true });
    const asked = h.indexers.searches as SearchRequest[];
    expect(asked[0]).toEqual({ kind: 'music', query: 'Radiohead' });
    // OK Computer was grabbed from the artist query: only Kid A gets its own queries.
    expect(asked.slice(1).every((r) => r.kind === 'music' && (r.album === 'Kid A' || r.query?.includes('Kid A')))).toBe(true);
    expect(h.downloads.grabs).toHaveLength(1);
  });
});

describe('music decisions', () => {
  it('decides on music-category releases, records them in the decision log, keeps video paths untouched', async () => {
    const h = await musicHarness();
    const [good, unknownAlbum, video] = await h.service.decide(
      [flac('Radiohead - OK Computer (1997) [FLAC]'), flac('Radiohead - Amnesiac (2001) [FLAC]'), makeRelease('Show.S01E01.1080p.WEB-DL-GRP')],
      'search',
      { criteria: { mediaType: 'music', artistId: h.artist.id, albumIds: [h.okc.id], userInvoked: false } },
    );
    expect(good!.decision).toMatchObject({
      approved: true,
      mediaType: 'music',
      artistId: h.artist.id,
      artistName: 'Radiohead',
      albumIds: [h.okc.id],
      albums: [{ id: h.okc.id, title: 'OK Computer', year: 1997 }],
      music: { artist: 'Radiohead', album: 'OK Computer', year: 1997, codec: 'FLAC', packType: null },
      quality: { quality: { name: 'FLAC' } },
    });
    expect(unknownAlbum!.decision).toMatchObject({ approved: false, mediaType: 'music', artistId: h.artist.id, rejections: [{ reason: 'unknownAlbum' }] });
    // Criteria for music send every release through the music parser: a video title does not map.
    expect(video!.decision.approved).toBe(false);

    await h.service.processReleases([flac('Radiohead - Kid A (2000) [FLAC]')], 'rss');
    const logged = h.db.select().from(releaseDecisions).all();
    expect(logged.find((r) => r.title.includes('Kid A'))).toMatchObject({ mediaType: 'music', artistId: h.artist.id, albumIds: [h.kidA.id], chosen: true });
    const page = h.service.listDecisionBatches({ albumId: h.kidA.id, page: 1, pageSize: 10 });
    expect(page.records[0]!.decisions[0]).toMatchObject({ mediaType: 'music', artistId: h.artist.id, albumIds: [h.kidA.id] });
  });

  it('uncategorised releases go to the music parser only with an audio marker and a library hit', async () => {
    const h = await musicHarness();
    const [hit, noMarker] = await h.service.decide(
      [makeRelease('Radiohead - OK Computer (1997) [FLAC]', { size: 350 * MB }), makeRelease('Radiohead - OK Computer 1997')],
      'search',
    );
    expect(hit!.decision).toMatchObject({ mediaType: 'music', albumIds: [h.okc.id], approved: true });
    expect(noMarker!.decision.mediaType).not.toBe('music');
  });

  it('drops music releases while music is off', async () => {
    const h = await musicHarness();
    setSection(h.db, 'features', { music: false, audiobooks: false });
    expect(await h.service.decide([flac('Radiohead - OK Computer (1997) [FLAC]')], 'rss')).toEqual([]);
  });

  it('parks delayed album releases as pending with their artist and albums, then grabs them', async () => {
    const h = await musicHarness();
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
    await h.service.processReleases([flac('Radiohead - OK Computer (1997) [FLAC]', { ageMinutes: 5 })], 'rss');
    expect(h.service.listPending()).toMatchObject([{ mediaType: 'music', artistId: h.artist.id, albumIds: [h.okc.id], quality: { quality: { name: 'FLAC' } } }]);
    h.advance(3 * 3_600_000);
    await h.service.processPending();
    expect(h.downloads.grabs).toHaveLength(1);
    expect(h.service.listPending()).toEqual([]);
  });
});

describe('music grabs, failures and scheduled searches', () => {
  it('a grab tracks the download and records history for the artist and albums; failure blocklists and re-searches', async () => {
    const h = await musicHarness();
    const bad = flac('Radiohead - OK Computer (1997) [FLAC]', { guid: 'bad' });
    const good = flac('Radiohead - OK Computer (1997) [FLAC] [Remaster]', { guid: 'good', seeders: 10 });
    h.indexers.results = [bad];
    await h.service.searchFor({ albumIds: [h.okc.id] });
    expect(h.downloads.grabs[0]!.tracking).toMatchObject({ mediaType: 'music', artistId: h.artist.id, albumIds: [h.okc.id] });
    const grabbed = h.history.mostRecentForAlbum(h.okc.id, 'grabbed');
    expect(grabbed).toMatchObject({ mediaType: 'music', artistId: h.artist.id, albumIds: [h.okc.id], downloadId: 'hash1' });

    // Failed download → history row → blocklist (artist scope) → automatic re-search (wiring's target).
    const searches: unknown[] = [];
    h.history.onDownloadFailed(async (event) => {
      const target = searchTargetFor(event.target);
      searches.push(target);
      if (target) await h.service.searchFor(target);
    }, 100);
    h.indexers.results = [bad, good];
    await h.history.failTracked({ downloadId: 'hash1', title: bad.title, protocol: 'torrent' }, { message: 'Download failed' });
    expect(h.blocklist.forArtist(h.artist.id)).toMatchObject([{ mediaType: 'music', artistId: h.artist.id, albumIds: [h.okc.id], sourceTitle: bad.title }]);
    expect(searches).toEqual([{ artistId: h.artist.id, albumIds: [h.okc.id] }]);
    expect(h.downloads.grabs.map((g) => g.request.title)).toEqual([bad.title, good.title]);
    expect(h.history.forArtist(h.artist.id).map((r) => r.eventType)).toEqual(['grabbed', 'downloadFailed', 'grabbed']);
  });

  it('MissingAlbumSearch searches missing albums with the per-album back-off; a grab clears it', async () => {
    const h = await musicHarness();
    h.indexers.results = [];
    expect(await h.service.missingAlbumSearch()).toBe('missing albums: searched 2, grabbed 0');
    const states = h.db.select().from(releaseSearchState).where(eq(releaseSearchState.mediaType, 'album')).all();
    expect(states.map((s) => s.itemId).sort()).toEqual([h.okc.id, h.kidA.id].sort());
    // Searched an hour ago: not due yet.
    h.advance(3_600_000);
    expect(await h.service.missingAlbumSearch()).toBe('missing albums: searched 0, grabbed 0');
    h.advance(DAY);
    h.indexers.results = [flac('Radiohead - Kid A (2000) [FLAC]')];
    expect(await h.service.missingAlbumSearch()).toMatch(/searched 2, grabbed 1/);
    const left = h.db.select().from(releaseSearchState).where(eq(releaseSearchState.mediaType, 'album')).all();
    expect(left.map((s) => s.itemId)).toEqual([h.okc.id]);
    expect(h.service.searchStatus({ mediaType: 'album', ids: [h.okc.id] })[0]).toMatchObject({
      mediaType: 'album',
      lastSearch: { outcome: 'noResults' },
      automatic: { state: 'scheduled', job: 'MissingAlbumSearch', searchCount: 2 },
    });
  });

  it('CutoffUnmetAudioSearch looks for albums whose lowest track is below cutoff; skipped while music is off', async () => {
    const h = await musicHarness();
    h.m.addFiles(h.okc, 'FLAC', 'MP3-320');
    h.m.addFiles(h.kidA, 'FLAC');
    h.indexers.results = [flac('Radiohead - OK Computer (1997) [FLAC]')];
    expect(await h.service.cutoffUnmetAudioSearch()).toBe('cutoff unmet albums: searched 1, grabbed 1');
    setSection(h.db, 'features', { music: false, audiobooks: false });
    expect(await h.service.cutoffUnmetAudioSearch()).toBe('skipped: music is not enabled');
  });

  it('interactive album search returns every decision with the parsed music info and the matched album', async () => {
    const h = await musicHarness();
    h.indexers.results = [flac('Radiohead - OK Computer (1997) [FLAC]'), flac('Radiohead - Discography (1993-2016) [MP3 320]', { size: 2000 * MB })];
    const decisions = await h.service.interactiveSearch({ albumId: h.okc.id });
    expect(decisions[0]).toMatchObject({ approved: true, albums: [{ id: h.okc.id, title: 'OK Computer' }], music: { album: 'OK Computer' } });
    // A discography is offered interactively (the pack rule only binds automatic grabs).
    expect(decisions.find((d) => d.music?.packType === 'discography')).toMatchObject({ approved: true, albumIds: [h.okc.id, h.kidA.id] });
    expect(h.downloads.grabs).toHaveLength(0);
    // Grab it by guid: POST /release with the album pinned.
    await h.service.grab({ guid: decisions[0]!.guid, indexerId: 1, albumIds: [h.okc.id] });
    expect(h.downloads.grabs[0]!.tracking).toMatchObject({ artistId: h.artist.id, albumIds: [h.okc.id] });
    expect(NOW).toBeDefined();
  });
});
