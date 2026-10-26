import { describe, expect, it } from 'vitest';
import {
  QUALITIES,
  QUALITY_GROUP_ID_BASE,
  type CustomFormat,
  type CustomFormatSpec,
  type DelayProfile,
  type QualityDefinition,
  type QualityModel,
  type QualityProfile,
  type ReleaseEvaluation,
  type ReleaseProfile,
} from '@arclight/shared';
import {
  buildItems,
  compareQuality,
  computeDelay,
  defaultQualityProfiles,
  formatMatches,
  isCutoffMet,
  isQualityAllowed,
  isRevisionUpgrade,
  isUpgrade,
  matchesReleaseProfiles,
  matchesTerm,
  reorderDelayProfiles,
  scoreRelease,
  selectDelayProfile,
  specImplementations,
  specMatches,
  validateCustomFormat,
  validateQualityProfile,
} from './index.js';

// ---------------------------------------------------------------------------------------
// fixtures

const qm = (q: QualityDefinition, rev: Partial<QualityModel['revision']> = {}): QualityModel => ({
  quality: { ...q, mediaTypes: [...q.mediaTypes] },
  revision: { version: 1, real: 0, isRepack: false, ...rev },
});

const WEB1080_GROUP = QUALITY_GROUP_ID_BASE + 3;

/** HD-1080p-ish: HDTV-1080p < {WEBDL,WEBRip}-1080p < Bluray-1080p (cutoff), 720p disallowed. */
const hd1080: QualityProfile = {
  id: 1,
  name: 'HD-1080p',
  upgradeAllowed: true,
  cutoff: QUALITIES['Bluray-1080p'].id,
  items: buildItems(['HDTV-1080p', 'WEBDL-1080p', 'WEBRip-1080p', 'Bluray-1080p']),
  minFormatScore: 0,
  cutoffFormatScore: 100,
  minUpgradeFormatScore: 10,
  formatItems: [
    { formatId: 1, score: 50 },
    { formatId: 2, score: -100 },
    { formatId: 3, score: 25 },
  ],
  languages: [],
};

const release = (over: Partial<ReleaseEvaluation> = {}): ReleaseEvaluation => ({
  title: 'Some.Movie.2019.1080p.BluRay.x264-GROUP',
  releaseGroup: 'GROUP',
  languages: ['en'],
  quality: qm(QUALITIES['Bluray-1080p']),
  sizeBytes: 8 * 1024 ** 3,
  indexerFlags: ['freeleech'],
  edition: 'Directors Cut',
  year: 2019,
  releaseKind: 'single',
  mediaType: 'movie',
  ...over,
});

const spec = <I extends CustomFormatSpec['implementation']>(
  implementation: I,
  fields: Extract<CustomFormatSpec, { implementation: I }>['fields'],
  flags: { negate?: boolean; required?: boolean } = {},
): CustomFormatSpec =>
  ({ implementation, name: implementation, negate: flags.negate ?? false, required: flags.required ?? false, fields }) as CustomFormatSpec;

const format = (id: number, ...specifications: CustomFormatSpec[]): CustomFormat => ({
  id,
  name: `cf${id}`,
  includeWhenRenaming: false,
  specifications,
});

// ---------------------------------------------------------------------------------------

describe('quality profile ranking', () => {
  it('allows listed qualities and rejects the rest', () => {
    expect(isQualityAllowed(hd1080, QUALITIES['WEBDL-1080p'])).toBe(true);
    expect(isQualityAllowed(hd1080, QUALITIES['HDTV-720p'])).toBe(false);
    expect(isQualityAllowed(hd1080, 9999)).toBe(false);
  });

  it('accepts a group id as an allowed reference', () => {
    expect(isQualityAllowed(hd1080, WEB1080_GROUP)).toBe(true);
  });

  it('ranks by item order, not vocabulary weight', () => {
    expect(compareQuality(hd1080, QUALITIES['Bluray-1080p'], QUALITIES['HDTV-1080p'])).toBe(1);
    expect(compareQuality(hd1080, QUALITIES['HDTV-1080p'], QUALITIES['Bluray-1080p'])).toBe(-1);
  });

  it('treats group members as equal', () => {
    expect(compareQuality(hd1080, QUALITIES['WEBDL-1080p'], QUALITIES['WEBRip-1080p'])).toBe(0);
    expect(compareQuality(hd1080, QUALITIES['WEBDL-1080p'], WEB1080_GROUP)).toBe(0);
  });

  it('ranks disallowed-but-listed qualities by their position', () => {
    // 2160p is listed (disallowed) above 1080p in the template ordering.
    expect(compareQuality(hd1080, QUALITIES['Bluray-2160p'], QUALITIES['Bluray-1080p'])).toBe(1);
  });

  it('falls back to vocabulary weight for qualities a profile does not list', () => {
    const tiny: QualityProfile = { ...hd1080, items: [{ kind: 'quality', qualityId: QUALITIES['HDTV-1080p'].id, allowed: true }], cutoff: 9 };
    expect(compareQuality(tiny, QUALITIES['Bluray-2160p'], QUALITIES['SDTV'])).toBe(1);
    expect(compareQuality(tiny, QUALITIES['HDTV-1080p'], QUALITIES['Bluray-2160p'])).toBe(1);
  });
});

describe('cutoff', () => {
  it('is unmet below the cutoff quality', () => {
    expect(isCutoffMet(hd1080, QUALITIES['WEBDL-1080p'], 500)).toBe(false);
  });

  it('is met at the cutoff quality when the format cutoff is reached', () => {
    expect(isCutoffMet(hd1080, QUALITIES['Bluray-1080p'], 100)).toBe(true);
  });

  it('is unmet at the cutoff quality while the format score is below the format cutoff', () => {
    expect(isCutoffMet(hd1080, QUALITIES['Bluray-1080p'], 99)).toBe(false);
  });

  it('is met above the cutoff quality', () => {
    expect(isCutoffMet(hd1080, QUALITIES['Remux-1080p'], 100)).toBe(true);
  });

  it('uses a group as cutoff: any member satisfies it', () => {
    const p = { ...hd1080, cutoff: WEB1080_GROUP };
    expect(isCutoffMet(p, QUALITIES['WEBRip-1080p'], 100)).toBe(true);
    expect(isCutoffMet(p, QUALITIES['HDTV-1080p'], 100)).toBe(false);
  });

  it('collapses to the lowest allowed quality and minFormatScore when upgrades are off', () => {
    const p = { ...hd1080, upgradeAllowed: false, minFormatScore: -50 };
    expect(isCutoffMet(p, QUALITIES['HDTV-1080p'], -50)).toBe(true);
    expect(isCutoffMet(p, QUALITIES['HDTV-1080p'], -51)).toBe(false);
  });
});

describe('upgrade decisions', () => {
  const cur = (q: QualityDefinition, score = 0, rev = {}) => ({ quality: qm(q, rev), formatScore: score });

  it('upgrades to a better quality while below cutoff', () => {
    expect(isUpgrade(hd1080, cur(QUALITIES['HDTV-1080p']), cur(QUALITIES['WEBDL-1080p']))).toEqual({ upgrade: true, reason: 'quality' });
  });

  it('rejects a worse quality', () => {
    expect(isUpgrade(hd1080, cur(QUALITIES['Bluray-1080p']), cur(QUALITIES['WEBDL-1080p']))).toEqual({ upgrade: false, reason: 'betterQuality' });
  });

  it('does not upgrade quality once the cutoff is met', () => {
    const r = isUpgrade(hd1080, cur(QUALITIES['Bluray-1080p'], 100), cur(QUALITIES['Remux-1080p'], 100));
    expect(r).toEqual({ upgrade: false, reason: 'qualityCutoffMet' });
  });

  it('takes a proper of the same quality', () => {
    const r = isUpgrade(hd1080, cur(QUALITIES['Bluray-1080p'], 200), cur(QUALITIES['Bluray-1080p'], 200, { version: 2 }));
    expect(r).toEqual({ upgrade: true, reason: 'revision' });
  });

  it('takes a repack and a REAL of the same quality', () => {
    expect(isUpgrade(hd1080, cur(QUALITIES['WEBDL-1080p']), cur(QUALITIES['WEBDL-1080p'], 0, { isRepack: true })).upgrade).toBe(true);
    expect(isUpgrade(hd1080, cur(QUALITIES['WEBDL-1080p']), cur(QUALITIES['WEBDL-1080p'], 0, { real: 1 })).upgrade).toBe(true);
  });

  it('takes a proper even when the profile forbids upgrades', () => {
    const p = { ...hd1080, upgradeAllowed: false };
    expect(isUpgrade(p, cur(QUALITIES['HDTV-1080p']), cur(QUALITIES['HDTV-1080p'], 0, { version: 2 })).upgrade).toBe(true);
  });

  it('a proper of a different quality is not a revision upgrade', () => {
    expect(isRevisionUpgrade(qm(QUALITIES['WEBDL-1080p']), qm(QUALITIES['WEBRip-1080p'], { version: 2 }))).toBe(false);
  });

  it('rejects a revision downgrade', () => {
    const r = isUpgrade(hd1080, cur(QUALITIES['WEBDL-1080p'], 0, { version: 2 }), cur(QUALITIES['WEBDL-1080p'], 50));
    expect(r).toEqual({ upgrade: false, reason: 'betterRevision' });
  });

  it('rejects everything but propers when upgrades are disabled', () => {
    const p = { ...hd1080, upgradeAllowed: false };
    expect(isUpgrade(p, cur(QUALITIES['HDTV-1080p']), cur(QUALITIES['Bluray-1080p']))).toEqual({ upgrade: false, reason: 'upgradesNotAllowed' });
    expect(isUpgrade(p, cur(QUALITIES['HDTV-1080p'], 0), cur(QUALITIES['HDTV-1080p'], 500))).toEqual({ upgrade: false, reason: 'upgradesNotAllowed' });
  });

  it('upgrades on format score when the gain meets minUpgradeFormatScore', () => {
    const r = isUpgrade(hd1080, cur(QUALITIES['Bluray-1080p'], 0), cur(QUALITIES['Bluray-1080p'], 10));
    expect(r).toEqual({ upgrade: true, reason: 'formatScore' });
  });

  it('rejects a format score gain smaller than minUpgradeFormatScore', () => {
    const r = isUpgrade(hd1080, cur(QUALITIES['Bluray-1080p'], 0), cur(QUALITIES['Bluray-1080p'], 9));
    expect(r).toEqual({ upgrade: false, reason: 'minUpgradeFormatScore' });
  });

  it('rejects an equal or lower format score', () => {
    expect(isUpgrade(hd1080, cur(QUALITIES['Bluray-1080p'], 50), cur(QUALITIES['Bluray-1080p'], 50)).reason).toBe('formatScoreNotHigher');
    expect(isUpgrade(hd1080, cur(QUALITIES['Bluray-1080p'], 50), cur(QUALITIES['Bluray-1080p'], 20)).reason).toBe('formatScoreNotHigher');
  });

  it('does not chase format score once the format cutoff is met', () => {
    expect(isUpgrade(hd1080, cur(QUALITIES['Bluray-1080p'], 100), cur(QUALITIES['Bluray-1080p'], 500)).reason).toBe('formatCutoffMet');
  });

  it('treats group members as the same quality for format-score upgrades', () => {
    const r = isUpgrade(hd1080, cur(QUALITIES['WEBRip-1080p'], 0), cur(QUALITIES['WEBDL-1080p'], 50));
    expect(r).toEqual({ upgrade: true, reason: 'formatScore' });
  });
});

describe('custom format specs', () => {
  const ev = release();

  it('releaseTitle regex, case-insensitive', () => {
    expect(specMatches(spec('releaseTitle', { pattern: 'bluray' }), ev)).toBe(true);
    expect(specMatches(spec('releaseTitle', { pattern: '\\bHDR\\b' }), ev)).toBe(false);
  });

  it('releaseGroup regex and missing group', () => {
    expect(specMatches(spec('releaseGroup', { pattern: '^group$' }), ev)).toBe(true);
    expect(specMatches(spec('releaseGroup', { pattern: 'group' }), release({ releaseGroup: undefined }))).toBe(false);
  });

  it('language with and without exceptLanguage', () => {
    expect(specMatches(spec('language', { language: 'en', exceptLanguage: false }), ev)).toBe(true);
    expect(specMatches(spec('language', { language: 'fr', exceptLanguage: false }), ev)).toBe(false);
    expect(specMatches(spec('language', { language: 'en', exceptLanguage: true }), ev)).toBe(false);
    expect(specMatches(spec('language', { language: 'en', exceptLanguage: true }), release({ languages: ['en', 'fr'] }))).toBe(true);
  });

  it('language "original" resolves to the item original language', () => {
    const s = spec('language', { language: 'original', exceptLanguage: false });
    expect(specMatches(s, release({ languages: ['ja'], originalLanguage: 'ja' }))).toBe(true);
    expect(specMatches(s, release({ languages: ['en'], originalLanguage: 'ja' }))).toBe(false);
  });

  it('source, resolution and quality modifier compare against the quality model', () => {
    expect(specMatches(spec('source', { source: 'bluray' }), ev)).toBe(true);
    expect(specMatches(spec('source', { source: 'web' }), ev)).toBe(false);
    expect(specMatches(spec('resolution', { resolution: 1080 }), ev)).toBe(true);
    expect(specMatches(spec('resolution', { resolution: 2160 }), ev)).toBe(false);
    expect(specMatches(spec('qualityModifier', { modifier: 'none' }), ev)).toBe(true);
    expect(specMatches(spec('qualityModifier', { modifier: 'remux' }), release({ quality: qm(QUALITIES['Remux-1080p']) }))).toBe(true);
  });

  it('size is exclusive at min, inclusive at max, false when unknown', () => {
    expect(specMatches(spec('size', { minGb: 5, maxGb: 8 }), ev)).toBe(true);
    expect(specMatches(spec('size', { minGb: 8, maxGb: 20 }), ev)).toBe(false);
    expect(specMatches(spec('size', { minGb: 0, maxGb: 1 }), ev)).toBe(false);
    expect(specMatches(spec('size', { minGb: 0, maxGb: 100 }), release({ sizeBytes: undefined }))).toBe(false);
  });

  it('indexerFlag', () => {
    expect(specMatches(spec('indexerFlag', { flag: 'freeleech' }), ev)).toBe(true);
    expect(specMatches(spec('indexerFlag', { flag: 'internal' }), ev)).toBe(false);
    expect(specMatches(spec('indexerFlag', { flag: 'freeleech' }), release({ indexerFlags: undefined }))).toBe(false);
  });

  it('edition regex', () => {
    expect(specMatches(spec('edition', { pattern: 'director' }), ev)).toBe(true);
    expect(specMatches(spec('edition', { pattern: 'extended' }), ev)).toBe(false);
  });

  it('year range inclusive', () => {
    expect(specMatches(spec('year', { min: 2019, max: 2019 }), ev)).toBe(true);
    expect(specMatches(spec('year', { min: 2020, max: 2030 }), ev)).toBe(false);
    expect(specMatches(spec('year', { min: 1900, max: 2030 }), release({ year: undefined }))).toBe(false);
  });

  it('releaseType', () => {
    expect(specMatches(spec('releaseType', { releaseType: 'single' }), ev)).toBe(true);
    expect(specMatches(spec('releaseType', { releaseType: 'seasonPack' }), release({ releaseKind: 'seasonPack', mediaType: 'series' }))).toBe(true);
    expect(specMatches(spec('releaseType', { releaseType: 'multi' }), ev)).toBe(false);
  });

  it('releaseExtras: any kind when empty, else intersection', () => {
    expect(specMatches(spec('releaseExtras', { kinds: [] }), ev)).toBe(false);
    expect(specMatches(spec('releaseExtras', { kinds: [] }), release({ extras: ['trailer'] }))).toBe(true);
    expect(specMatches(spec('releaseExtras', { kinds: ['featurette'] }), release({ extras: ['trailer'] }))).toBe(false);
    expect(specMatches(spec('releaseExtras', { kinds: ['featurette', 'trailer'] }), release({ extras: ['trailer'] }))).toBe(true);
  });

  it('negate inverts a spec', () => {
    expect(specMatches(spec('releaseTitle', { pattern: 'bluray' }, { negate: true }), ev)).toBe(false);
    expect(specMatches(spec('source', { source: 'web' }, { negate: true }), ev)).toBe(true);
  });

  it('an invalid regex never matches and is reported by validation', () => {
    expect(specMatches(spec('releaseTitle', { pattern: '(' }), ev)).toBe(false);
    const issues = validateCustomFormat(format(1, spec('releaseTitle', { pattern: '(' }), spec('size', { minGb: 5, maxGb: 2 })));
    expect(issues.map((i) => i.path)).toEqual(['specifications[0]', 'specifications[1]']);
  });
});

describe('custom format composition', () => {
  const ev = release();

  it('a format without specs matches nothing', () => {
    expect(formatMatches(format(1), ev)).toBe(false);
  });

  it('specs of one implementation are OR-ed', () => {
    const f = format(1, spec('releaseTitle', { pattern: 'nope' }), spec('releaseTitle', { pattern: 'x264' }));
    expect(formatMatches(f, ev)).toBe(true);
  });

  it('different implementations are AND-ed', () => {
    expect(formatMatches(format(1, spec('releaseTitle', { pattern: 'x264' }), spec('source', { source: 'bluray' })), ev)).toBe(true);
    expect(formatMatches(format(1, spec('releaseTitle', { pattern: 'x264' }), spec('source', { source: 'web' })), ev)).toBe(false);
  });

  it('a required spec must match even when a sibling in its group does', () => {
    const f = format(1, spec('releaseTitle', { pattern: 'x264' }), spec('releaseTitle', { pattern: 'HDR' }, { required: true }));
    expect(formatMatches(f, ev)).toBe(false);
  });

  it('negate + required: must NOT contain', () => {
    const f = format(1, spec('releaseTitle', { pattern: 'x264' }), spec('releaseTitle', { pattern: 'CAM' }, { negate: true, required: true }));
    expect(formatMatches(f, ev)).toBe(true);
    expect(formatMatches(f, release({ title: 'Some.Movie.2019.CAM.x264' }))).toBe(false);
  });

  it('scoreRelease sums matched format scores from the profile and lists the ids', () => {
    const formats = [
      format(1, spec('source', { source: 'bluray' })), // +50
      format(2, spec('releaseTitle', { pattern: 'CAM' })), // no match
      format(3, spec('indexerFlag', { flag: 'freeleech' })), // +25
      format(4, spec('resolution', { resolution: 1080 })), // matched but unscored
    ];
    expect(scoreRelease(hd1080, formats, ev)).toEqual({ score: 75, matchedFormatIds: [1, 3, 4] });
  });

  it('negative scores subtract', () => {
    const formats = [format(2, spec('releaseTitle', { pattern: 'x264' })), format(1, spec('source', { source: 'bluray' }))];
    expect(scoreRelease(hd1080, formats, ev).score).toBe(-50);
  });

  it('describes every implementation for the UI', () => {
    const defs = specImplementations();
    const names = defs.map((d) => d.implementation).sort();
    expect(names).toEqual(
      ['edition', 'indexerFlag', 'language', 'qualityModifier', 'releaseExtras', 'releaseGroup', 'releaseTitle', 'releaseType', 'resolution', 'size', 'source', 'year'].sort(),
    );
    expect(defs.every((d) => d.fields.length > 0)).toBe(true);
  });
});

describe('delay profiles', () => {
  const dp = (id: number, order: number, tags: number[], over: Partial<DelayProfile> = {}): DelayProfile => ({
    id,
    order,
    tags,
    preferredProtocol: 'usenet',
    usenetDelayMinutes: 0,
    torrentDelayMinutes: 0,
    bypassIfHighestQuality: false,
    bypassIfAboveCustomFormatScore: false,
    minimumCustomFormatScore: 0,
    ...over,
  });
  const profiles = [dp(1, 3, []), dp(2, 1, [10]), dp(3, 2, [20, 30])];

  it('picks the lowest-order profile sharing a tag, else the default', () => {
    expect(selectDelayProfile(profiles, [30])?.id).toBe(3);
    expect(selectDelayProfile(profiles, [10, 30])?.id).toBe(2);
    expect(selectDelayProfile(profiles, [99])?.id).toBe(1);
    expect(selectDelayProfile([], [1])).toBeUndefined();
  });

  const torrent60 = dp(1, 1, [], { preferredProtocol: 'torrent', torrentDelayMinutes: 60, usenetDelayMinutes: 0 });
  const cand = (over: Partial<Parameters<typeof computeDelay>[2]> = {}) => ({
    protocol: 'torrent' as const,
    ageMinutes: 10,
    quality: qm(QUALITIES['WEBDL-1080p']),
    formatScore: 0,
    ...over,
  });

  it('computes remaining wait and no delay for a zero-delay protocol', () => {
    expect(computeDelay(torrent60, hd1080, cand())).toEqual({ delayMinutes: 60, remainingMinutes: 50 });
    expect(computeDelay(torrent60, hd1080, cand({ protocol: 'usenet' }))).toEqual({ delayMinutes: 0, remainingMinutes: 0, bypass: 'noDelay' });
  });

  it('releases older than the delay pass', () => {
    expect(computeDelay(torrent60, hd1080, cand({ ageMinutes: 60 })).remainingMinutes).toBe(0);
    expect(computeDelay(torrent60, hd1080, cand({ ageMinutes: 60 })).bypass).toBe('aged');
  });

  it('bypasses for the highest allowed quality on the preferred protocol only', () => {
    const p = { ...torrent60, bypassIfHighestQuality: true };
    expect(computeDelay(p, hd1080, cand({ quality: qm(QUALITIES['Bluray-1080p']) })).bypass).toBe('highestQuality');
    expect(computeDelay(p, hd1080, cand()).bypass).toBeUndefined();
    const usenetPreferred = { ...p, preferredProtocol: 'usenet' as const };
    expect(computeDelay(usenetPreferred, hd1080, cand({ quality: qm(QUALITIES['Bluray-1080p']) })).remainingMinutes).toBe(50);
  });

  it('bypasses at or above the minimum custom format score', () => {
    const p = { ...torrent60, bypassIfAboveCustomFormatScore: true, minimumCustomFormatScore: 100 };
    expect(computeDelay(p, hd1080, cand({ formatScore: 100 })).bypass).toBe('formatScore');
    expect(computeDelay(p, hd1080, cand({ formatScore: 99 })).remainingMinutes).toBe(50);
  });

  it('bypasses for a proper of the quality already on disk', () => {
    const r = computeDelay(torrent60, hd1080, cand({ quality: qm(QUALITIES['WEBDL-1080p'], { version: 2 }), currentQuality: qm(QUALITIES['WEBDL-1080p']) }));
    expect(r.bypass).toBe('revisionUpgrade');
  });

  it('reorders, keeping the untagged default last', () => {
    const moved = reorderDelayProfiles(profiles, 3); // to front
    expect(moved.map((p) => [p.id, p.order])).toEqual([[3, 1], [2, 2], [1, 3]]);
    const after = reorderDelayProfiles(profiles, 2, 3); // 2 after 3
    expect(after.map((p) => p.id)).toEqual([3, 2, 1]);
    const defaultStaysLast = reorderDelayProfiles(profiles, 1); // try to move default first
    expect(defaultStaysLast.map((p) => p.id)).toEqual([2, 3, 1]);
  });
});

describe('release profiles', () => {
  const rp = (id: number, over: Partial<ReleaseProfile> = {}): ReleaseProfile => ({
    id,
    name: `rp${id}`,
    enabled: true,
    required: [],
    ignored: [],
    tags: [],
    ...over,
  });
  const title = 'Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-NTb';

  it('plain terms match case-insensitively as substrings', () => {
    expect(matchesTerm('web-dl', title)).toBe(true);
    expect(matchesTerm('ntb', title)).toBe(true);
    expect(matchesTerm('bluray', title)).toBe(false);
  });

  it('/regex/ terms are regular expressions', () => {
    expect(matchesTerm('/S\\d{2}E\\d{2}/', title)).toBe(true);
    expect(matchesTerm('/^show\\./', title)).toBe(true);
    expect(matchesTerm('/x265/', title)).toBe(false);
    expect(matchesTerm('/(/', title)).toBe(false);
  });

  it('passes when nothing applies', () => {
    expect(matchesReleaseProfiles([], { title, tags: [] })).toEqual({ pass: true, reasons: [] });
  });

  it('requires at least one required term', () => {
    const ok = matchesReleaseProfiles([rp(1, { required: ['bluray', 'web-dl'] })], { title, tags: [] });
    expect(ok.pass).toBe(true);
    const bad = matchesReleaseProfiles([rp(1, { required: ['bluray', '/remux/'] })], { title, tags: [] });
    expect(bad.pass).toBe(false);
    expect(bad.reasons[0]).toMatch(/required/);
  });

  it('rejects on any ignored term and names it', () => {
    const r = matchesReleaseProfiles([rp(1, { ignored: ['x265', '/DDP/'] })], { title, tags: [] });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain('/DDP/');
  });

  it('skips disabled profiles, other tags and other indexers', () => {
    const profiles = [
      rp(1, { ignored: ['web'], enabled: false }),
      rp(2, { ignored: ['web'], tags: [5] }),
      rp(3, { ignored: ['web'], indexerId: 7 }),
    ];
    expect(matchesReleaseProfiles(profiles, { title, tags: [6], indexerId: 8 }).pass).toBe(true);
    expect(matchesReleaseProfiles(profiles, { title, tags: [5], indexerId: 8 }).pass).toBe(false);
    expect(matchesReleaseProfiles(profiles, { title, tags: [6], indexerId: 7 }).pass).toBe(false);
  });
});

describe('defaults and validation', () => {
  it('ships five-plus default profiles with valid cutoffs', () => {
    const defaults = defaultQualityProfiles();
    expect(defaults.map((p) => p.name)).toEqual(expect.arrayContaining(['Any', 'SD', 'HD-720p', 'HD-1080p', 'HD-720p/1080p', 'Ultra-HD']));
    for (const p of defaults) expect(validateQualityProfile(p)).toEqual([]);
  });

  it('HD-1080p allows exactly the 1080p qualities', () => {
    const p = defaultQualityProfiles().find((x) => x.name === 'HD-1080p')!;
    const allowed = p.items.filter((i) => i.allowed).flatMap((i) => (i.kind === 'quality' ? [i.qualityId] : i.qualityIds)).sort((a, b) => a - b);
    expect(allowed).toEqual([QUALITIES['HDTV-1080p'].id, QUALITIES['WEBDL-1080p'].id, QUALITIES['WEBRip-1080p'].id, QUALITIES['Bluray-1080p'].id].sort((a, b) => a - b));
  });

  it('rejects a cutoff that is not an allowed item', () => {
    expect(validateQualityProfile({ ...hd1080, cutoff: QUALITIES['HDTV-720p'].id }).map((i) => i.path)).toEqual(['cutoff']);
    expect(validateQualityProfile({ ...hd1080, cutoff: 4242 }).map((i) => i.path)).toEqual(['cutoff']);
  });

  it('rejects duplicate qualities and unknown ids', () => {
    const items = [...hd1080.items, { kind: 'quality' as const, qualityId: QUALITIES['HDTV-1080p'].id, allowed: true }];
    expect(validateQualityProfile({ ...hd1080, items }).some((i) => /listed more than once/.test(i.message))).toBe(true);
    expect(validateQualityProfile({ ...hd1080, items: [{ kind: 'quality', qualityId: 777, allowed: true }], cutoff: 777 }).some((i) => /unknown quality/.test(i.message))).toBe(true);
  });
});
