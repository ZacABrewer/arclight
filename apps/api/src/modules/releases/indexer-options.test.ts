import { describe, expect, it } from 'vitest';
import { indexerFlagsFromVolumeFactors } from '@arclight/shared';
import { DEFAULT_RELEASE_SETTINGS, type ReleaseSettings } from './deps.js';
import {
  buildDecision,
  evaluate,
  indexerFlagScore,
  prioritize,
  releaseIndexerFlags,
  type Candidate,
  type DecisionContext,
  type Ranked,
} from './engine.js';
import { detectHardcodedSubs, isWhitelistedHardcodedSubs } from './hardcoded-subs.js';
import { HD_ALLOWED, harness, makeCandidate, makeContext, makeEpisode, makeMovie, makeProfile, makeRelease, makeSeries, snapshot } from './test-support.js';

// Settings → Indexers options the decision engine honours: hardcoded subs (allow + whitelist)
// and preferIndexerFlags (freeleech / double upload ranking).

const movie = makeMovie({ title: 'Movie Title', year: 2016, runtimeMinutes: 120 });
const movieLib = snapshot([], [], [movie]);
const show = makeSeries({ title: 'Show Name', runtimeMinutes: 45 });
const tvLib = snapshot([show], [1, 2].map((n) => makeEpisode(show.id, 1, n)));

function ctxWith(settings: Partial<ReleaseSettings> = {}): DecisionContext {
  return makeContext({ settings: { ...DEFAULT_RELEASE_SETTINGS, ...settings } });
}

function film(title: string): Candidate {
  return makeCandidate(makeRelease(title, { size: 8 * 1024 ** 3 }), movieLib);
}

function reasons(ctx: DecisionContext, c: Candidate): string[] {
  return evaluate(ctx, c).rejections.map((r) => r.reason);
}

describe('detectHardcodedSubs', () => {
  it('finds language-prefixed subtitle markers', () => {
    expect(detectHardcodedSubs('Movie.Title.2016.1080p.KORSUB.WEBRip.x264.AAC2.0-RADARR', 'RADARR')).toEqual({
      tag: 'KORSUB',
      language: 'KOR',
      generic: false,
    });
    expect(detectHardcodedSubs('Movie.Title.2016.1080p.KORSUBS.WEBRip.x264.AAC2.0-RADARR')?.tag).toBe('KORSUBS');
  });

  it('finds generic markers (HC, HARDSUB, HARDCODED, SUBBED) and HC.<LANG>', () => {
    expect(detectHardcodedSubs('Movie Title 2017 HC 720p HDRiP DD5 1 x264-LEGi0N')).toEqual({ tag: 'HC', generic: true });
    expect(detectHardcodedSubs('Movie.Title.2017.720p.SUBBED.HDRip.V2.XViD-26k')?.generic).toBe(true);
    expect(detectHardcodedSubs('Movie.Title.2017.HARDSUB.1080p.WEB-DL-GRP')?.tag).toBe('HARDSUB');
    expect(detectHardcodedSubs('Movie.Title.2017.HARDCODED.1080p.WEB-DL-GRP')?.tag).toBe('HARDCODED');
    expect(detectHardcodedSubs('Movie.Title.2017.HC.ENG.1080p.WEB-DL-GRP')).toEqual({ tag: 'HC.ENG', language: 'ENG', generic: false });
  });

  it('ignores soft subtitles, subtitle group names and a release group named HC', () => {
    for (const title of [
      'Movie.Title.2000.1080p.BlueRay.x264.DTS.RoSubbed-playHD',
      'Movie Title 2018 [Web][MKV][h264][480p][AAC 2.0][Softsubs]',
      'Movie Title 2019 [HorribleSubs][Web][MKV][h264][848x480][AAC 2.0][Softsubs(HorribleSubs)]',
      'Movie Title 2024 [Web][x265][1080p][EAC3][MultiSubs]',
      'Movie.Title.2016.1080p.WEB-DL.x264',
    ]) {
      expect(detectHardcodedSubs(title), title).toBeNull();
    }
    expect(detectHardcodedSubs('Movie.Title.2016.1080p.WEB-DL.x264-HC', 'HC')).toBeNull();
  });
});

describe('isWhitelistedHardcodedSubs', () => {
  it('matches the tag, its language, HC.<LANG>, and treats SUB/SUBS alike', () => {
    const kor = detectHardcodedSubs('Movie.2016.KORSUBS.1080p-G')!;
    expect(isWhitelistedHardcodedSubs(kor, ['korsub'])).toBe(true);
    expect(isWhitelistedHardcodedSubs(kor, ['KOR'])).toBe(true);
    expect(isWhitelistedHardcodedSubs(kor, ['HC.KOR'])).toBe(true);
    expect(isWhitelistedHardcodedSubs(kor, ['ENG', 'HC'])).toBe(false);
    const eng = detectHardcodedSubs('Movie.2016.HC.ENG.1080p-G')!;
    expect(isWhitelistedHardcodedSubs(eng, ['hc eng'])).toBe(true);
    expect(isWhitelistedHardcodedSubs(eng, ['ENG'])).toBe(true);
  });

  it('only exact entries whitelist generic markers', () => {
    const hc = detectHardcodedSubs('Movie Title 2017 HC 720p HDRiP-G')!;
    expect(isWhitelistedHardcodedSubs(hc, ['ENG', 'KOR'])).toBe(false);
    expect(isWhitelistedHardcodedSubs(hc, ['HC'])).toBe(true);
  });
});

describe('hardcodedSubs specification', () => {
  it('rejects hardcoded subs by default (permanent) and accepts clean releases', () => {
    const ev = evaluate(ctxWith(), film('Movie.Title.2016.1080p.KORSUB.WEB-DL.x264-GRP'));
    expect(ev.rejections).toEqual([{ reason: 'hardcodedSubs', message: 'Hardcoded subs found: KORSUB', type: 'permanent' }]);
    expect(reasons(ctxWith(), film('Movie.Title.2016.1080p.WEB-DL.x264-GRP'))).toEqual([]);
    expect(evaluate(ctxWith(), film('Movie.Title.2016.HC.1080p.WEB-DL.x264-GRP')).rejections[0]?.message).toBe('Hardcoded subs found');
  });

  it('accepts everything when allowHardcodedSubs is on', () => {
    expect(reasons(ctxWith({ allowHardcodedSubs: true }), film('Movie.Title.2016.1080p.KORSUB.WEB-DL.x264-GRP'))).toEqual([]);
  });

  it('accepts whitelisted tags only', () => {
    const ctx = ctxWith({ whitelistedHardcodedSubs: ['ENG', 'HC.KOR'] });
    expect(reasons(ctx, film('Movie.Title.2016.1080p.KORSUB.WEB-DL.x264-GRP'))).toEqual([]);
    expect(reasons(ctx, film('Movie.Title.2016.HC.ENG.1080p.WEB-DL.x264-GRP'))).toEqual([]);
    expect(reasons(ctx, film('Movie.Title.2016.1080p.CHSUB.WEB-DL.x264-GRP'))).toEqual(['hardcodedSubs']);
  });

  it('applies to series releases too', () => {
    const c = makeCandidate(makeRelease('Show.Name.S01E01.1080p.HARDSUB.WEB-DL-GRP'), tvLib);
    expect(reasons(ctxWith(), c)).toEqual(['hardcodedSubs']);
  });
});

describe('indexer flags', () => {
  it('derives flags from Torznab volume factors', () => {
    expect(indexerFlagsFromVolumeFactors({ downloadVolumeFactor: 0, uploadVolumeFactor: 1 })).toEqual(['freeleech']);
    expect(indexerFlagsFromVolumeFactors({ downloadVolumeFactor: 0.5, uploadVolumeFactor: 2 })).toEqual(['halfleech', 'doubleUpload']);
    expect(indexerFlagsFromVolumeFactors({ downloadVolumeFactor: 0.25 })).toEqual(['freeleech75']);
    expect(indexerFlagsFromVolumeFactors({ downloadVolumeFactor: 0.75 })).toEqual(['freeleech25']);
    expect(indexerFlagsFromVolumeFactors({ downloadVolumeFactor: 1, uploadVolumeFactor: 1 })).toEqual([]);
    expect(indexerFlagsFromVolumeFactors({})).toEqual([]);
  });

  it('merges reported flags with volume-factor flags and scores them', () => {
    const flags = releaseIndexerFlags({ indexerFlags: ['internal', 'freeleech'], downloadVolumeFactor: 0, uploadVolumeFactor: 2 });
    expect(flags.sort()).toEqual(['doubleUpload', 'freeleech', 'internal']);
    expect(indexerFlagScore(['freeleech'])).toBeGreaterThan(indexerFlagScore(['halfleech']));
    expect(indexerFlagScore(['halfleech', 'doubleUpload'])).toBeGreaterThan(indexerFlagScore(['halfleech']));
    expect(indexerFlagScore(['internal', 'scene'])).toBe(0);
  });
});

describe('preferIndexerFlags prioritisation', () => {
  const profile = makeProfile(HD_ALLOWED);
  function ranked(title: string, overrides: Parameters<typeof makeRelease>[1], preferIndexerFlags: boolean): Ranked {
    const c = makeCandidate(makeRelease(title, overrides), tvLib);
    return {
      decision: buildDecision('rss', c, { rejections: [], remainingMinutes: undefined }),
      rank: {
        profile,
        preferredProtocol: undefined,
        runtimeMinutes: 45,
        preferredSizeMbPerMinute: null,
        isAnime: false,
        firstEpisodeNumber: 1,
        preferIndexerFlags,
      },
    };
  }

  it('ranks a freeleech release above more seeders when enabled, not when disabled', () => {
    const list = (on: boolean) => [
      ranked('Show.Name.S01E01.1080p.WEB-DL-A', { guid: 'plain', seeders: 1000 }, on),
      ranked('Show.Name.S01E01.1080p.WEB-DL-B', { guid: 'free', seeders: 10, downloadVolumeFactor: 0 }, on),
    ];
    expect(prioritize(list(true), 'preferAndUpgrade')[0]!.decision.guid).toBe('free');
    expect(prioritize(list(false), 'preferAndUpgrade')[0]!.decision.guid).toBe('plain');
  });

  it('never outranks quality, and indexer priority still comes first', () => {
    const out = prioritize(
      [
        ranked('Show.Name.S01E01.720p.HDTV-A', { guid: 'free720', indexerFlags: ['freeleech'] }, true),
        ranked('Show.Name.S01E01.1080p.WEB-DL-B', { guid: 'plain1080' }, true),
      ],
      'preferAndUpgrade',
    );
    expect(out[0]!.decision.guid).toBe('plain1080');
    const prio = prioritize(
      [
        ranked('Show.Name.S01E01.1080p.WEB-DL-A', { guid: 'free', indexerPriority: 30, indexerFlags: ['freeleech'] }, true),
        ranked('Show.Name.S01E01.1080p.WEB-DL-B', { guid: 'prio', indexerPriority: 1 }, true),
      ],
      'preferAndUpgrade',
    );
    expect(prio[0]!.decision.guid).toBe('prio');
  });

  it('prefers freeleech over halfleech over double upload only', () => {
    const out = prioritize(
      [
        ranked('Show.Name.S01E01.1080p.WEB-DL-A', { guid: 'du', uploadVolumeFactor: 2 }, true),
        ranked('Show.Name.S01E01.1080p.WEB-DL-B', { guid: 'half', downloadVolumeFactor: 0.5 }, true),
        ranked('Show.Name.S01E01.1080p.WEB-DL-C', { guid: 'free', downloadVolumeFactor: 0 }, true),
      ],
      'preferAndUpgrade',
    );
    expect(out.map((r) => r.decision.guid)).toEqual(['free', 'half', 'du']);
  });
});

describe('service wiring of indexer options', () => {
  async function setup(settings: Partial<ReleaseSettings>) {
    const h = await harness({ deps: { settings: { getReleaseSettings: () => settings } } });
    const series = h.addSeries({ title: 'Show Name', tvdbId: 4242 });
    h.addEpisode(series.id, 1, 1);
    return h;
  }

  it('grabs the freeleech copy in RSS when preferIndexerFlags is on', async () => {
    const h = await setup({ preferIndexerFlags: true });
    await h.service.processReleases(
      [
        makeRelease('Show.Name.S01E01.1080p.WEB-DL-A', { guid: 'a', seeders: 900 }),
        makeRelease('Show.Name.S01E01.1080p.WEB-DL-B', { guid: 'b', seeders: 20, downloadVolumeFactor: 0 }),
      ],
      'rss',
    );
    expect(h.downloads.grabs.map((g) => g.request.title)).toEqual(['Show.Name.S01E01.1080p.WEB-DL-B']);
  });

  it('rejects hardcoded subs from settings, and accepts them when allowed', async () => {
    const strict = await setup({});
    const d1 = await strict.service.processReleases([makeRelease('Show.Name.S01E01.1080p.KORSUB.WEB-DL-A')], 'rss');
    expect(d1[0]!.rejections.map((r) => r.reason)).toEqual(['hardcodedSubs']);
    expect(strict.downloads.grabs).toHaveLength(0);

    const lax = await setup({ allowHardcodedSubs: true });
    await lax.service.processReleases([makeRelease('Show.Name.S01E01.1080p.KORSUB.WEB-DL-A')], 'rss');
    expect(lax.downloads.grabs).toHaveLength(1);
  });
});
