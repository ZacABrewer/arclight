import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@arclight/shared';
import { ProviderError } from '@arclight/subtitles';
import { mediaFiles, movies, series } from '../../db/schema.js';
import { subtitleFiles, subtitleHistory, subtitleProviderState } from './schema.js';
import {
  EN_PROFILE,
  GOOD_EPISODE,
  GOOD_MOVIE,
  SRT,
  SRT_HI,
  VTT,
  WEAK_EPISODE,
  candidate,
  setup,
  type Fixture,
} from './test-support.js';

const DAY = 24 * 3600 * 1000;
let fx: Fixture | undefined;
afterEach(async () => {
  await fx?.service.idle();
  await fx?.cleanup();
  fx = undefined;
});

async function fixture(opts?: Parameters<typeof setup>[0]): Promise<Fixture> {
  fx = await setup(opts);
  return fx;
}

describe('language profiles', () => {
  it('normalizes codes and validates duplicates and cutoff', async () => {
    const f = await fixture();
    const p = f.service.createProfile({ ...EN_PROFILE, name: 'Multi', languages: [{ code: 'eng', forced: 'never', hi: 'also' }, { code: 'fre', forced: 'also', hi: 'never' }], cutoff: 'fra' });
    expect(p.languages.map((l) => l.code)).toEqual(['en', 'fr']);
    expect(p.cutoff).toBe('fr');
    expect(() => f.service.createProfile({ ...EN_PROFILE, languages: [{ code: 'en', forced: 'never', hi: 'also' }, { code: 'eng', forced: 'never', hi: 'also' }] })).toThrow(/twice/);
    expect(() => f.service.createProfile({ ...EN_PROFILE, cutoff: 'de' })).toThrow(/cutoff/);
    expect(() => f.service.createProfile({ ...EN_PROFILE, languages: [{ code: 'zz-nope', forced: 'never', hi: 'also' }] })).toThrow(/unknown language/);
  });

  it('deleting a profile clears items and defaults that use it', async () => {
    const f = await fixture();
    f.settings((s) => {
      s.defaultSeriesProfileId = f.profileId;
    });
    f.service.deleteProfile(f.profileId);
    expect(f.db.select().from(series).get()!.languageProfileId).toBeNull();
    expect(f.db.select().from(movies).get()!.languageProfileId).toBeNull();
    expect(f.service.settings().defaultSeriesProfileId).toBeNull();
    expect(f.events.some((e) => e.type === 'subtitle' && e.action === 'profiles')).toBe(true);
  });
});

describe('indexing and wanted', () => {
  it('indexes external files and embedded tracks, and reconciles removed files', async () => {
    const f = await fixture();
    const srt = f.videos.s1e1.replace(/\.mkv$/, '.en.srt');
    await writeFile(srt, SRT);
    f.probes.set(f.videos.s1e1, { streams: [{ index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'spa' } }] });
    const [first] = await f.service.scan({ mediaFileId: f.files.s1e1 });
    expect(first!.subtitles.map((s) => [s.language, s.embedded, s.path === srt])).toEqual([
      ['en', false, true],
      ['es', true, false],
    ]);
    expect(first!.missing).toEqual([]);
    await rm(srt);
    const [second] = await f.service.scan({ mediaFileId: f.files.s1e1 });
    expect(second!.subtitles.map((s) => s.language)).toEqual(['es']);
    expect(second!.missing).toEqual([{ language: 'en', forced: false, hi: false }]);
  });

  it('lists wanted files per media type and skips items without a profile', async () => {
    const f = await fixture();
    await writeFile(f.videos.s1e2.replace(/\.mkv$/, '.en.hi.srt'), SRT_HI);
    await f.service.scan({ seriesId: f.seriesId });
    const tv = f.service.wanted({ mediaType: 'series', page: 1, pageSize: 50 });
    expect(tv.records.map((r) => r.episodeLabel)).toEqual(['S01E01', 'S02E01']);
    expect(tv.records[0]).toMatchObject({ title: 'Test Show', missing: [{ language: 'en', forced: false, hi: false }], attempts: 0 });
    expect(f.service.wanted({ mediaType: 'movie', page: 1, pageSize: 50 }).totalRecords).toBe(1);
    f.db.update(movies).set({ languageProfileId: null }).run();
    expect(f.service.wanted({ mediaType: 'movie', page: 1, pageSize: 50 }).totalRecords).toBe(0);
  });

  it('embedded mode decides whether embedded tracks satisfy wanted', async () => {
    const f = await fixture();
    f.probes.set(f.videos.movie, { streams: [{ index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } }] });
    await f.service.scan({ movieId: f.movieId });
    expect(f.service.wanted({ mediaType: 'movie', page: 1, pageSize: 10 }).totalRecords).toBe(0);
    f.settings((s) => {
      s.embedded.mode = 'ignore';
    });
    expect(f.service.wanted({ mediaType: 'movie', page: 1, pageSize: 10 }).totalRecords).toBe(1);
  });

  it('extract mode copies a wanted embedded text track out with ffmpeg', async () => {
    const f = await fixture({
      runner: async (call) => {
        await writeFile(call.args[call.args.length - 1]!, SRT);
      },
    });
    f.settings((s) => {
      s.embedded.mode = 'extract';
    });
    f.probes.set(f.videos.movie, { streams: [{ index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } }] });
    const [m] = await f.service.scan({ movieId: f.movieId });
    expect(f.runner.calls[0]!.command).toBe('ffmpeg');
    expect(f.runner.calls[0]!.args).toContain('0:2');
    const external = m!.subtitles.find((s) => !s.embedded);
    expect(external?.path).toBe(f.videos.movie.replace(/\.mkv$/, '.en.srt'));
    expect(m!.missing).toEqual([]);
    expect(f.service.history({ page: 1, pageSize: 10 }).records[0]!.action).toBe('extracted');
  });

  it('prunes subtitle rows of deleted media files', async () => {
    const f = await fixture();
    await writeFile(f.videos.s1e1.replace(/\.mkv$/, '.en.srt'), SRT);
    await f.service.scan({ mediaFileId: f.files.s1e1 });
    f.db.delete(mediaFiles).where(eq(mediaFiles.id, f.files.s1e1)).run();
    expect(f.service.pruneOrphans()).toBe(1);
    expect(f.db.select().from(subtitleFiles).all()).toHaveLength(0);
  });
});

describe('search -> download pipeline', () => {
  it('downloads the best candidate, writes the file, records state and history, notifies', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'weak', { matches: WEAK_EPISODE }), candidate('podnapisi', 'good', { matches: GOOD_EPISODE, releaseInfo: 'Test.Show.S01E01.1080p.WEB-DL' })];
    f.providers.addic7ed.candidates = [candidate('addic7ed', 'other', { matches: ['series', 'season', 'episode', 'year'] })];
    const r = await f.service.searchFile(f.files.s1e1);
    expect(r).toEqual({ searched: 1, downloaded: 1, allThrottled: false });
    const path = f.videos.s1e1.replace(/\.mkv$/, '.en.srt');
    expect(await readFile(path, 'utf8')).toContain('General Kenobi');
    const [state] = f.service.fileSubtitles({ mediaFileId: f.files.s1e1 })[0]!.subtitles;
    expect(state).toMatchObject({ provider: 'podnapisi', providerSubtitleId: 'good', path, embedded: false });
    expect(state!.percent).toBeGreaterThanOrEqual(90);
    const h = f.service.history({ page: 1, pageSize: 10 }).records[0]!;
    expect(h).toMatchObject({ action: 'downloaded', title: 'Test Show - S01E01', scoreOutOf: 360, provider: 'podnapisi' });
    expect(h.description).toMatch(/^English subtitles downloaded from Podnapisi with a score of/);
    expect(h.matched).toContain('series');
    expect(f.notifications[0]).toMatchObject({ type: 'subtitleDownloaded', subtitle: { language: 'en', provider: 'podnapisi', path } });
    expect(f.notifications[0]!.type === 'subtitleDownloaded' && f.notifications[0]!.episodes?.[0]?.episodeNumber).toBe(1);
    expect(f.events.some((e) => e.type === 'subtitle' && e.action === 'downloaded' && e.mediaFileId === f.files.s1e1)).toBe(true);
    expect(f.service.wanted({ mediaType: 'series', page: 1, pageSize: 10 }).records.map((x) => x.mediaFileId)).not.toContain(f.files.s1e1);
  });

  it('names HI and forced downloads with their tags and applies the content HI heuristic', async () => {
    const f = await fixture();
    f.service.updateProfile(f.profileId, { ...EN_PROFILE, languages: [{ code: 'en', forced: 'also', hi: 'also' }] });
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'full', { matches: GOOD_EPISODE }), candidate('podnapisi', 'forced', { forced: true, matches: GOOD_EPISODE })];
    f.providers.podnapisi.contents.set('full', SRT_HI);
    const r = await f.service.searchFile(f.files.s1e1);
    expect(r.downloaded).toBe(2);
    const paths = f.service.fileSubtitles({ mediaFileId: f.files.s1e1 })[0]!.subtitles.map((s) => s.path!);
    const stem = f.videos.s1e1.replace(/\.mkv$/, '');
    expect(paths.sort()).toEqual([`${stem}.en.forced.srt`, `${stem}.en.hi.srt`].sort());
  });

  it('records an attempt when nothing passes the minimum score, and the adaptive gate skips later runs', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'weak', { matches: WEAK_EPISODE })];
    expect(await f.service.searchFile(f.files.s1e1)).toEqual({ searched: 1, downloaded: 0, allThrottled: false });
    expect(f.service.wanted({ mediaType: 'series', page: 1, pageSize: 10 }).records[0]).toMatchObject({ mediaFileId: f.files.s1e1, attempts: 1 });
    f.clock.advance(22 * DAY);
    // Past the 21-day window: searched because the last attempt is more than 7 days old.
    expect((await f.service.searchFile(f.files.s1e1)).searched).toBe(1);
    f.clock.advance(1 * DAY);
    expect((await f.service.searchFile(f.files.s1e1)).searched).toBe(0);
    f.clock.advance(7 * DAY);
    expect((await f.service.searchFile(f.files.s1e1)).searched).toBe(1);
    expect((await f.service.searchFile(f.files.s1e1, { ignoreBackoff: true })).searched).toBe(1);
  });

  it('honours the minimum score override', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'weak', { matches: WEAK_EPISODE })];
    f.settings((s) => {
      s.minimumScore.series = 50;
    });
    expect((await f.service.searchFile(f.files.s1e1)).downloaded).toBe(1);
  });

  it('applies must-contain / must-not-contain from the profile', async () => {
    const f = await fixture();
    f.service.updateProfile(f.profileId, { ...EN_PROFILE, mustNotContain: ['HDTV'], mustContain: ['web'] });
    f.providers.podnapisi.candidates = [
      candidate('podnapisi', 'tv', { matches: GOOD_EPISODE, releaseInfo: 'Test.Show.S01E01.HDTV' }),
      candidate('podnapisi', 'web', { matches: GOOD_EPISODE, releaseInfo: 'Test.Show.S01E01.WEB' }),
    ];
    await f.service.searchFile(f.files.s1e1);
    expect(f.providers.podnapisi.downloads).toEqual(['web']);
  });

  it('falls through to the next candidate when a download fails validation', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'broken', { matches: [...GOOD_EPISODE, 'release_group'] }), candidate('podnapisi', 'ok', { matches: GOOD_EPISODE })];
    f.providers.podnapisi.contents.set('broken', '<html>nope</html>');
    expect((await f.service.searchFile(f.files.s1e1)).downloaded).toBe(1);
    expect(f.providers.podnapisi.downloads).toEqual(['broken', 'ok']);
  });

  it('movies use the movie score table', async () => {
    const f = await fixture();
    f.providers.addic7ed.candidates = [candidate('addic7ed', 'm1', { matches: GOOD_MOVIE })];
    expect((await f.service.searchFile(f.files.movie)).downloaded).toBe(1);
    expect(f.service.history({ page: 1, pageSize: 1, mediaType: 'movie' }).records[0]).toMatchObject({ scoreOutOf: 180, title: 'Test Movie' });
  });

  it('post-processing runs sync and the custom command with substituted placeholders', async () => {
    const f = await fixture({
      runner: async (call) => {
        if (call.command === 'ffsubsync') {
          const out = call.args[call.args.indexOf('-o') + 1]!;
          await writeFile(out, SRT.replace('Hello there', 'Synced'));
          return { stderr: 'offset seconds: 1.250\nframerate scale factor: 1.000' };
        }
      },
    });
    f.settings((s) => {
      s.sync.enabled = true;
      s.postProcessing.enabled = true;
      s.postProcessing.command = '/bin/notify "{{episode_name}}" {{subtitles_language_code2}} {{series_id}}';
    });
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    await f.service.searchFile(f.files.s1e1);
    const path = f.videos.s1e1.replace(/\.mkv$/, '.en.srt');
    expect(await readFile(path, 'utf8')).toContain('Synced');
    const script = f.runner.calls.find((c) => c.command === '/bin/notify')!;
    expect(script.args).toEqual(['Test.Show.S01E01.1080p.WEB-DL', 'en', String(f.seriesId)]);
    expect(script.opts.env?.['ARCLIGHT_SUBTITLES']).toBe(path);
    const synced = f.service.history({ page: 1, pageSize: 10, action: 'synced' }).records[0]!;
    expect(synced.description).toMatch(/offset of 1.250 seconds/);
  });

  it('a failed sync keeps the original subtitle', async () => {
    const f = await fixture({ runner: () => ({ ok: false, exitCode: 1, stderr: 'boom' }) });
    f.settings((s) => {
      s.sync.enabled = true;
    });
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    await f.service.searchFile(f.files.s1e1);
    expect(await readFile(f.videos.s1e1.replace(/\.mkv$/, '.en.srt'), 'utf8')).toContain('Hello there');
    const state = f.service.fileSubtitles({ mediaFileId: f.files.s1e1 })[0]!.subtitles[0]!;
    const r = await f.service.sync(state.id);
    expect(r).toMatchObject({ ok: false, message: 'boom' });
  });

  it('import hook searches the new file in the background', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    f.service.onImported({ file: { id: f.files.s1e2 } });
    await f.service.idle();
    expect(f.service.fileSubtitles({ mediaFileId: f.files.s1e2 })[0]!.subtitles).toHaveLength(1);
    f.settings((s) => {
      s.search.searchOnImport = false;
    });
    f.service.onImported({ file: { id: f.files.s2e1 } });
    await f.service.idle();
    expect(f.providers.podnapisi.searches).toHaveLength(1);
  });

  it('command search covers a season and ignores the backoff', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    const r = await f.service.commandSearch({ seriesId: f.seriesId, seasonNumber: 1 });
    expect(r).toMatchObject({ files: 2, searched: 2, downloaded: 2 });
    await expect(f.service.commandSearch({})).rejects.toThrow(/required/);
  });

  it('the wanted job searches up to the batch size', async () => {
    const f = await fixture();
    f.settings((s) => {
      s.search.batchSize = 2;
    });
    const msg = await f.service.searchWanted();
    expect(msg).toMatch(/Searched 2 of 4 wanted item/);
  });
});

describe('throttling', () => {
  it('throttles after repeated rate limits, persists the state and aborts without recording attempts', async () => {
    const f = await fixture();
    f.settings((s) => {
      s.providers = s.providers.filter((p) => p.id === 'podnapisi');
    });
    f.providers.podnapisi.searchError = new ProviderError('rate-limited', 'too many requests', { provider: 'podnapisi' });
    const r = await f.service.searchFile(f.files.s1e1);
    expect(r.downloaded).toBe(0);
    expect(f.db.select().from(subtitleProviderState).all()).toMatchObject([{ provider: 'podnapisi', code: 'rate-limited' }]);
    const restored = f.makeService();
    expect(restored.providers().status.find((s) => s.id === 'podnapisi')!.throttle?.code).toBe('rate-limited');
    expect(await restored.searchFile(f.files.s1e2)).toEqual({ searched: 0, downloaded: 0, allThrottled: true });
    expect(restored.wanted({ mediaType: 'series', page: 1, pageSize: 10 }).records.find((x) => x.mediaFileId === f.files.s1e2)!.attempts).toBe(0);
    restored.resetThrottles(false);
    expect(f.db.select().from(subtitleProviderState).all()).toHaveLength(0);
  });
});

describe('upgrades', () => {
  async function downloaded(f: Fixture) {
    f.settings((s) => {
      s.minimumScore.series = 50;
    });
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'weak', { matches: WEAK_EPISODE })];
    await f.service.searchFile(f.files.s1e1);
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'better', { matches: GOOD_EPISODE }), candidate('podnapisi', 'weak', { matches: WEAK_EPISODE })];
  }

  it('replaces a recent low-score download with a better one and links the history', async () => {
    const f = await fixture();
    await downloaded(f);
    const original = f.service.history({ page: 1, pageSize: 10 }).records[0]!;
    f.clock.advance(2 * DAY);
    expect(await f.service.upgrade()).toEqual({ candidates: 1, upgraded: 1 });
    const h = f.service.history({ page: 1, pageSize: 10, action: 'upgraded' }).records[0]!;
    expect(h.upgradedFromId).toBe(original.id);
    const subs = f.service.fileSubtitles({ mediaFileId: f.files.s1e1 })[0]!.subtitles;
    expect(subs).toHaveLength(1);
    expect(subs[0]!.providerSubtitleId).toBe('better');
    // Already upgraded from, and the new one is near perfect: nothing more to do.
    expect((await f.service.upgrade()).upgraded).toBe(0);
  });

  it('ignores downloads outside the upgrade window', async () => {
    const f = await fixture();
    await downloaded(f);
    f.clock.advance(8 * DAY);
    expect(await f.service.upgrade()).toEqual({ candidates: 0, upgraded: 0 });
  });

  it('requires the new score to beat the old one by two points', async () => {
    const f = await fixture();
    await downloaded(f);
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'same', { matches: WEAK_EPISODE })];
    expect(await f.service.upgrade()).toEqual({ candidates: 1, upgraded: 0 });
  });

  it('a delete ends the upgrade chain', async () => {
    const f = await fixture();
    await downloaded(f);
    const state = f.service.fileSubtitles({ mediaFileId: f.files.s1e1 })[0]!.subtitles[0]!;
    await f.service.delete(state.id);
    expect((await f.service.upgrade()).candidates).toBe(0);
  });
});

describe('blacklist', () => {
  it('blacklisting a download deletes it and the re-search picks another candidate', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'first', { matches: [...GOOD_EPISODE, 'release_group'] }), candidate('podnapisi', 'second', { matches: GOOD_EPISODE })];
    await f.service.searchFile(f.files.s1e1);
    const state = f.service.fileSubtitles({ mediaFileId: f.files.s1e1 })[0]!.subtitles[0]!;
    expect(state.providerSubtitleId).toBe('first');
    const entry = await f.service.blacklist(state.id, true);
    expect(entry).toMatchObject({ provider: 'podnapisi', providerSubtitleId: 'first', title: 'Test Show - S01E01' });
    await f.service.idle();
    const now = f.service.fileSubtitles({ mediaFileId: f.files.s1e1 })[0]!.subtitles;
    expect(now.map((s) => s.providerSubtitleId)).toEqual(['second']);
    expect(f.service.history({ page: 1, pageSize: 10, action: 'deleted' }).totalRecords).toBe(1);
    expect(f.service.isBlacklisted('podnapisi', 'first')).toBe(true);
  });

  it('blacklisted candidates never appear in manual search', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'first', { matches: GOOD_EPISODE }), candidate('podnapisi', 'second', { matches: WEAK_EPISODE })];
    await f.service.searchFile(f.files.s1e1);
    await f.service.blacklist(f.service.fileSubtitles({ mediaFileId: f.files.s1e1 })[0]!.subtitles[0]!.id, false);
    const res = await f.service.manualSearch(f.files.s1e1);
    expect(res.results.map((r) => r.providerSubtitleId)).toEqual(['second']);
    const page = f.service.listBlacklist(1, 10);
    f.service.removeBlacklist(page.records[0]!.id);
    expect(f.service.listBlacklist(1, 10).totalRecords).toBe(0);
  });

  it('a provider saying must-blacklist creates an entry', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'bad', { matches: GOOD_EPISODE })];
    f.providers.podnapisi.downloadErrors.set('bad', new ProviderError('must-blacklist', 'gone', { provider: 'podnapisi' }));
    await f.service.searchFile(f.files.s1e1);
    expect(f.service.isBlacklisted('podnapisi', 'bad')).toBe(true);
    expect(() => f.service.removeBlacklist(999)).toThrow(/not found/);
  });

  it('uploaded subtitles cannot be blacklisted', async () => {
    const f = await fixture();
    const st = await f.service.upload({ mediaFileId: f.files.movie, language: 'en', forced: false, hi: false }, new TextEncoder().encode(SRT), 'a.srt');
    await expect(f.service.blacklist(st.id, false)).rejects.toThrow(/only subtitles downloaded/);
  });
});

describe('manual search, download, upload, delete', () => {
  it('manual search lists every candidate with scores, and download saves the chosen one', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'weak', { matches: WEAK_EPISODE, releaseInfo: 'Line one\nLine two', uploader: 'bob' }), candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    const res = await f.service.manualSearch(f.files.s1e1);
    expect(res.results.map((r) => r.providerSubtitleId)).toEqual(['good', 'weak']);
    const weak = res.results[1]!;
    expect(weak).toMatchObject({ releaseInfo: ['Line one', 'Line two'], uploader: 'bob', scoreOutOf: 360 });
    expect(weak.dontMatches).toContain('year');
    const state = await f.service.manualDownload(f.files.s1e1, weak.key);
    expect(state.providerSubtitleId).toBe('weak');
    expect(f.service.history({ page: 1, pageSize: 1 }).records[0]!.action).toBe('manualDownload');
    await expect(f.service.manualDownload(f.files.s1e1, weak.key)).rejects.toThrow(/expired/);
  });

  it('manual search results expire after an hour', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    const res = await f.service.manualSearch(f.files.s1e1, 'en');
    f.clock.advance(3601 * 1000);
    await expect(f.service.manualDownload(f.files.s1e1, res.results[0]!.key)).rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('manual search on an item without a profile needs a language', async () => {
    const f = await fixture();
    f.db.update(movies).set({ languageProfileId: null }).run();
    await expect(f.service.manualSearch(f.files.movie)).rejects.toThrow(/pick a language/);
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'de1', { language: 'de', matches: GOOD_MOVIE })];
    expect((await f.service.manualSearch(f.files.movie, 'ger')).results).toHaveLength(1);
  });

  it('upload converts to SubRip, saves with the fake maximum score and leaves wanted', async () => {
    const f = await fixture();
    const st = await f.service.upload({ mediaFileId: f.files.movie, language: 'eng', forced: false, hi: true }, new TextEncoder().encode(VTT), 'mine.vtt');
    expect(st.path).toBe(f.videos.movie.replace(/\.mkv$/, '.en.hi.srt'));
    expect(await readFile(st.path!, 'utf8')).toContain('00:00:01,000 --> 00:00:02,000');
    expect(st).toMatchObject({ provider: 'manual', score: 180, percent: 100, hi: true });
    expect(f.service.history({ page: 1, pageSize: 1 }).records[0]).toMatchObject({ action: 'uploaded', score: 180, scoreOutOf: 180 });
    expect(f.service.wanted({ mediaType: 'movie', page: 1, pageSize: 10 }).totalRecords).toBe(0);
    await expect(f.service.upload({ mediaFileId: f.files.movie, language: 'en', forced: false, hi: false }, new TextEncoder().encode('garbage'), 'x.srt')).rejects.toThrow(/invalid subtitle/);
    await expect(f.service.upload({ mediaFileId: f.files.movie, language: 'en', forced: false, hi: false }, new TextEncoder().encode(SRT), 'x.exe')).rejects.toThrow(/not a subtitle/);
  });

  it('upload keeps the original format when the profile asks for it', async () => {
    const f = await fixture();
    f.service.updateProfile(f.profileId, { ...EN_PROFILE, originalFormat: true });
    const st = await f.service.upload({ mediaFileId: f.files.movie, language: 'en', forced: true, hi: false }, new TextEncoder().encode(VTT), 'mine.vtt');
    expect(st.path).toBe(f.videos.movie.replace(/\.mkv$/, '.en.forced.vtt'));
  });

  it('a new subtitle with the same identity replaces the old file', async () => {
    const f = await fixture();
    f.settings((s) => {
      s.naming.hiExtension = 'sdh';
    });
    const a = await f.service.upload({ mediaFileId: f.files.movie, language: 'en', forced: false, hi: true }, new TextEncoder().encode(SRT), 'a.srt');
    expect(a.path!.endsWith('.en.sdh.srt')).toBe(true);
    f.settings((s) => {
      s.naming.hiExtension = 'cc';
    });
    const b = await f.service.upload({ mediaFileId: f.files.movie, language: 'en', forced: false, hi: true }, new TextEncoder().encode(SRT), 'b.srt');
    await expect(stat(a.path!)).rejects.toThrow();
    expect(f.service.fileSubtitles({ mediaFileId: f.files.movie })[0]!.subtitles.map((s) => s.id)).toEqual([b.id]);
  });

  it('delete removes external files only and writes history', async () => {
    const f = await fixture();
    f.probes.set(f.videos.movie, { streams: [{ index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'fre' } }] });
    const st = await f.service.upload({ mediaFileId: f.files.movie, language: 'en', forced: false, hi: false }, new TextEncoder().encode(SRT), 'a.srt');
    await f.service.delete(st.id);
    await expect(stat(st.path!)).rejects.toThrow();
    expect(f.service.history({ page: 1, pageSize: 1 }).records[0]!.action).toBe('deleted');
    const [m] = await f.service.scan({ movieId: f.movieId });
    const embedded = m!.subtitles.find((s) => s.embedded)!;
    await expect(f.service.delete(embedded.id)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(f.service.delete(9999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('extraction rejects bitmap tracks', async () => {
    const f = await fixture();
    f.probes.set(f.videos.movie, { streams: [{ index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } }] });
    const [m] = await f.service.scan({ movieId: f.movieId });
    await expect(f.service.extract(m!.subtitles[0]!.id)).rejects.toThrow(/bitmap/);
  });
});

describe('settings and providers', () => {
  it('masks provider secrets and keeps them when the mask is sent back', async () => {
    const f = await fixture();
    const s = f.service.settings();
    f.service.updateSettings({ ...s, providers: [...s.providers, { id: 'subdl', enabled: true, settings: { apiKey: 'real-key' } }] });
    const masked = f.service.getMaskedSettings();
    expect(masked.providers.find((p) => p.id === 'subdl')!.settings['apiKey']).toBe(SECRET_MASK);
    f.service.updateSettings(masked);
    expect(f.service.settings().providers.find((p) => p.id === 'subdl')!.settings['apiKey']).toBe('real-key');
    expect(() => f.service.updateSettings({ ...masked, defaultMovieProfileId: 999 })).toThrow(/does not exist/);
  });

  it('reports provider status and tests a provider', async () => {
    const f = await fixture();
    const status = f.service.providers().status;
    expect(status.find((p) => p.id === 'podnapisi')).toMatchObject({ enabled: true, configured: true, throttle: null });
    expect(status.find((p) => p.id === 'subdl')).toMatchObject({ enabled: false, configured: false });
    expect(await f.service.testProvider('podnapisi', {})).toMatchObject({ ok: true });
    expect(f.providers.podnapisi.tested).toBe(1);
    expect(await f.service.testProvider('subdl', {})).toMatchObject({ ok: false, message: expect.stringMatching(/API key/) });
  });

  it('new series get the default language profile unless the request names one', async () => {
    const f = await fixture();
    const { libraryService } = await import('../library/index.js');
    f.settings((s) => {
      s.defaultSeriesProfileId = f.profileId;
    });
    await libraryService.addRootFolder(f.db, { path: f.dir, mediaType: 'series' } as never);
    const meta = { tmdbId: 555, title: 'New Show', year: 2024, status: 'continuing' as const };
    const added = libraryService.addSeries(f.db, meta as never, { tmdbId: 555, rootFolderPath: f.dir, qualityProfileId: 1, monitored: true, monitorOption: 'all', monitorNewItems: 'all', seriesType: 'standard', seasonFolder: true, tags: [], searchOnAdd: false });
    expect(added.languageProfileId).toBe(f.profileId);
    const none = libraryService.addSeries(f.db, { ...meta, tmdbId: 556, title: 'Other Show' } as never, { tmdbId: 556, rootFolderPath: f.dir, qualityProfileId: 1, monitored: true, monitorOption: 'all', monitorNewItems: 'all', seriesType: 'standard', seasonFolder: true, tags: [], searchOnAdd: false, languageProfileId: null });
    expect(none.languageProfileId).toBeNull();
    const updated = libraryService.updateSeries(f.db, none.id, { languageProfileId: f.profileId });
    expect(updated.languageProfileId).toBe(f.profileId);
  });
});

describe('history', () => {
  it('filters by action and provider and pages newest first', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    await f.service.commandSearch({ seriesId: f.seriesId });
    await f.service.upload({ mediaFileId: f.files.movie, language: 'en', forced: false, hi: false }, new TextEncoder().encode(SRT), 'a.srt');
    expect(f.service.history({ page: 1, pageSize: 2 }).records.map((r) => r.action)).toEqual(['uploaded', 'downloaded']);
    expect(f.service.history({ page: 1, pageSize: 10, provider: 'podnapisi' }).totalRecords).toBe(3);
    expect(f.service.history({ page: 1, pageSize: 10, mediaFileId: f.files.movie }).totalRecords).toBe(1);
    expect(f.db.select().from(subtitleHistory).all()).toHaveLength(4);
  });
});
