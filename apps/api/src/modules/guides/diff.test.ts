import { describe, expect, it } from 'vitest';
import { GuidesSettings, type QualityProfile } from '@arclight/shared';
import { buildDiff, canonicalFormat, matchesPattern, resolveMappings, selectFormats, type GuideData, type LocalFormat } from './diff.js';
import { parseGuideFormat, parseGuideProfile, scoreFor, type GuideFormat, type GuideProfile } from './parse.js';
import { recordedFiles } from './test-support.js';

// Parsing of the recorded TRaSH files and the pure diff.

const files = recordedFiles();
const json = (path: string) => JSON.parse(files.get(path)!) as unknown;

function recordedGuide(): GuideData {
  const formats: GuideFormat[] = [];
  const profiles: GuideProfile[] = [];
  for (const [path] of files) {
    if (path.startsWith('docs/json/radarr/cf/')) {
      const f = parseGuideFormat(json(path), 'radarr', path);
      if (typeof f === 'string') throw new Error(f);
      formats.push(f);
    }
    if (path.startsWith('docs/json/radarr/quality-profiles/')) {
      const p = parseGuideProfile(json(path), 'radarr', path);
      if (typeof p === 'string') throw new Error(p);
      profiles.push(p);
    }
  }
  return { formats, profiles, warnings: [] };
}

function profile(id: number, name: string, formatItems: QualityProfile['formatItems'] = []): QualityProfile {
  return {
    id,
    name,
    upgradeAllowed: true,
    cutoff: 0,
    items: [{ kind: 'quality', qualityId: 0, allowed: true }],
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems,
    languages: [],
  };
}

const settings = (over: Partial<GuidesSettings> = {}) =>
  GuidesSettings.parse({ enabled: true, profiles: [{ guideProfileName: 'HD Bluray + WEB', localQualityProfileId: 1 }], ...over });

describe('guide parsing (recorded TRaSH files)', () => {
  it('parses every recorded custom format', () => {
    const g = recordedGuide();
    expect(g.formats.map((f) => f.name).sort()).toEqual(['BR-DISK', 'HD Bluray Tier 01', 'Repack/Proper', 'Repack2', 'WEB Tier 01']);
    expect(g.formats.every((f) => /^[0-9a-f]{32}$/.test(f.guideId))).toBe(true);
  });

  it('maps radarr numeric enums: source 9 = bluray, modifier 5 = remux, resolution 2160', () => {
    const f = parseGuideFormat(json('docs/json/radarr/cf/hd-bluray-tier-01.json'), 'radarr', 'x') as GuideFormat;
    const byName = new Map(f.input.specifications.map((s) => [s.name, s]));
    expect(byName.get('BLURAY')).toMatchObject({ implementation: 'source', fields: { source: 'bluray' }, required: true });
    expect(byName.get('Not REMUX')).toMatchObject({ implementation: 'qualityModifier', negate: true, fields: { modifier: 'remux' } });
    expect(byName.get('Not 2160p')).toMatchObject({ implementation: 'resolution', fields: { resolution: 2160 } });
    expect(byName.get('BBQ')).toMatchObject({ implementation: 'releaseGroup', fields: { pattern: '^(BBQ)$' } });
    expect(f.warnings).toEqual([]);
  });

  it('keeps trash_scores, the rename flag and title regexes', () => {
    const f = parseGuideFormat(json('docs/json/radarr/cf/repack2.json'), 'radarr', 'x') as GuideFormat;
    expect(f.scores).toMatchObject({ default: 6, 'anime-radarr': 2 });
    expect(f.input.includeWhenRenaming).toBe(true);
    expect(f.input.specifications[0]).toMatchObject({ implementation: 'releaseTitle', required: true });
    const br = parseGuideFormat(json('docs/json/radarr/cf/br-disk.json'), 'radarr', 'x') as GuideFormat;
    expect(scoreFor(br, 'default')).toBe(-10000);
  });

  it('parses the quality profile: formatItems, default score set, plain description', () => {
    const p = parseGuideProfile(json('docs/json/radarr/quality-profiles/hd-bluray-web.json'), 'radarr', 'x') as GuideProfile;
    expect(p.name).toBe('HD Bluray + WEB');
    expect(p.scoreSet).toBe('default');
    expect(p.formatItems).toHaveLength(9);
    expect(p.formatItems[0]).toEqual({ name: 'HD Bluray Tier 01', guideId: 'ed27ebfef2f323e964fb1f61391bcb35' });
    expect(p.description).not.toContain('<br>');
  });

  it('rejects files without trash_id or without an expressible specification', () => {
    expect(parseGuideFormat({ name: 'x', specifications: [] }, 'radarr', 'a.json')).toMatch(/missing trash_id/);
    const onlyUnsupported = { trash_id: 'abc', name: 'X', specifications: [{ name: 'n', implementation: 'MysterySpecification', fields: { value: 1 } }] };
    expect(parseGuideFormat(onlyUnsupported, 'radarr', 'b.json')).toMatch(/no specification/);
    expect(parseGuideProfile([], 'radarr', 'c.json')).toMatch(/not an object/);
  });

  it('reports unsupported specs as warnings and keeps the rest', () => {
    const raw = {
      trash_id: 'abc',
      name: 'Mixed',
      specifications: [
        { name: 'Title', implementation: 'ReleaseTitleSpecification', negate: false, required: true, fields: { value: 'x265' } },
        { name: 'Odd', implementation: 'MysterySpecification', fields: { value: 1 } },
      ],
    };
    const f = parseGuideFormat(raw, 'sonarr', 'm.json') as GuideFormat;
    expect(f.input.specifications).toHaveLength(1);
    expect(f.warnings[0]).toMatch(/unsupported/);
  });

  it('uses the sonarr source table for sonarr files', () => {
    const raw = { trash_id: 's1', name: 'WEB', specifications: [{ name: 'WEB', implementation: 'SourceSpecification', required: true, fields: { value: 3 } }] };
    const f = parseGuideFormat(raw, 'sonarr', 's.json') as GuideFormat;
    expect(f.input.specifications[0]).toMatchObject({ fields: { source: 'web' } });
  });

  it('falls back to the default score set', () => {
    expect(scoreFor({ scores: { default: 5, 'sqp-1': 1 } }, 'sqp-1')).toBe(1);
    expect(scoreFor({ scores: { default: 5 } }, 'nope')).toBe(5);
    expect(scoreFor({ scores: {} }, 'default')).toBeUndefined();
  });
});

describe('format selection', () => {
  it('matches names and ids with case-insensitive globs', () => {
    expect(matchesPattern('repack*', 'Repack/Proper')).toBe(true);
    expect(matchesPattern('WEB Tier 0?', 'web tier 01')).toBe(true);
    expect(matchesPattern('BR-DISK', 'BR-DISK2')).toBe(false);
    expect(matchesPattern('a.b', 'axb')).toBe(false);
  });

  it('defaults to the formats mapped profiles reference', () => {
    const g = recordedGuide();
    const { mappings } = resolveMappings(g, { profiles: [profile(1, 'HD')] }, settings());
    const names = selectFormats(g, mappings, settings()).map((f) => f.localName);
    expect(names.sort()).toEqual(['HD Bluray Tier 01', 'Repack/Proper', 'Repack2', 'WEB Tier 01']);
  });

  it('adds includeFormats matches and lets excludeFormats win over profile references', () => {
    const g = recordedGuide();
    const s = settings({ includeFormats: ['br-*'], excludeFormats: ['Repack*', 'c20f169ef63c5f40c2def54abaf4438e'] });
    const { mappings } = resolveMappings(g, { profiles: [profile(1, 'HD')] }, s);
    expect(selectFormats(g, mappings, s).map((f) => f.localName).sort()).toEqual(['BR-DISK', 'HD Bluray Tier 01']);
  });

  it('suffixes a name already used by another app', () => {
    const g = recordedGuide();
    const radarr = g.formats.find((f) => f.name === 'Repack2')!;
    g.formats.push({ ...radarr, app: 'sonarr', guideId: 'sonarr-repack2' });
    const s = settings({ apps: ['radarr', 'sonarr'], includeFormats: ['Repack2'], profiles: [] });
    const out = selectFormats(g, [], s);
    expect(out.map((f) => f.localName)).toEqual(['Repack2', 'Repack2 (Sonarr)']);
  });

  it('warns about unknown guide profiles and missing local profiles', () => {
    const g = recordedGuide();
    const s = settings({
      profiles: [
        { guideProfileName: 'Nope', localQualityProfileId: 1 },
        { guideProfileName: 'hd bluray + web', localQualityProfileId: 99 },
        { guideProfileName: 'HD Bluray + WEB', localQualityProfileId: 1, app: 'sonarr' },
      ],
    });
    const r = resolveMappings(g, { profiles: [profile(1, 'HD')] }, s);
    expect(r.mappings).toHaveLength(0);
    expect(r.warnings).toHaveLength(3);
  });
});

describe('buildDiff', () => {
  const now = new Date('2026-10-26T00:00:00Z');

  it('creates formats and scores on an empty database', () => {
    const diff = buildDiff(recordedGuide(), { formats: [], profiles: [profile(1, 'HD')] }, settings(), now);
    const kinds = diff.items.map((i) => i.kind);
    expect(kinds.filter((k) => k === 'createFormat')).toHaveLength(4);
    const score = diff.items.find((i) => i.kind === 'setScore' && i.formatName === 'HD Bluray Tier 01');
    expect(score).toMatchObject({ before: null, after: 1800, formatId: null, profileId: 1 });
    expect(diff.warnings.some((w) => w.includes('does not publish'))).toBe(true);
  });

  it('is empty when the database already matches (and the revision is stable)', () => {
    const g = recordedGuide();
    const sel = selectFormats(g, resolveMappings(g, { profiles: [profile(1, 'HD')] }, settings()).mappings, settings());
    const formats: LocalFormat[] = sel.map((f, i) => ({ id: i + 1, ...f.input, name: f.localName, guideId: f.guideId }));
    const scores = sel.map((f, i) => ({ formatId: i + 1, score: scoreFor(f, 'default')! }));
    const diff = buildDiff(g, { formats, profiles: [profile(1, 'HD', scores)] }, settings(), now);
    expect(diff.items).toEqual([]);
    expect(diff.revision).toBe(buildDiff(g, { formats, profiles: [profile(1, 'HD', scores)] }, settings(), now).revision);
  });

  it('updates a synced format that changed upstream and adopts a same-named user format', () => {
    const g = recordedGuide();
    const repack = g.formats.find((f) => f.name === 'Repack/Proper')!;
    const formats: LocalFormat[] = [
      { id: 7, name: 'Repack/Proper', includeWhenRenaming: true, specifications: repack.input.specifications, guideId: repack.guideId },
      { id: 8, name: 'WEB Tier 01', includeWhenRenaming: false, specifications: [], guideId: null },
    ];
    const diff = buildDiff(g, { formats, profiles: [profile(1, 'HD')] }, settings({ scoreAllSyncedFormats: false }), now);
    expect(diff.items.find((i) => i.id === `format:${repack.guideId}`)).toMatchObject({ kind: 'updateFormat', formatId: 7 });
    expect(diff.items.find((i) => i.kind === 'adoptFormat')).toMatchObject({ formatId: 8, name: 'WEB Tier 01' });
  });

  it('reports synced formats the guide dropped as stale, never as deletions', () => {
    const formats: LocalFormat[] = [{ id: 3, name: 'Old', includeWhenRenaming: false, specifications: [], guideId: 'gone' }];
    const diff = buildDiff(recordedGuide(), { formats, profiles: [profile(1, 'HD')] }, settings(), now);
    expect(diff.staleFormats).toEqual([{ formatId: 3, name: 'Old', guideId: 'gone' }]);
    expect(diff.items.some((i) => 'formatId' in i && i.formatId === 3)).toBe(false);
  });

  it('scores included formats only with scoreAllSyncedFormats', () => {
    const g = recordedGuide();
    const withAll = buildDiff(g, { formats: [], profiles: [profile(1, 'HD')] }, settings({ includeFormats: ['BR-DISK'] }), now);
    expect(withAll.items.find((i) => i.kind === 'setScore' && i.formatName === 'BR-DISK')).toMatchObject({ after: -10000 });
    const onlyListed = buildDiff(g, { formats: [], profiles: [profile(1, 'HD')] }, settings({ includeFormats: ['BR-DISK'], scoreAllSyncedFormats: false }), now);
    expect(onlyListed.items.some((i) => i.kind === 'setScore' && i.formatName === 'BR-DISK')).toBe(false);
    expect(onlyListed.items.some((i) => i.kind === 'createFormat' && i.name === 'BR-DISK')).toBe(true);
  });

  it('compares formats canonically (schema defaults, key order)', () => {
    const a = { name: 'X', includeWhenRenaming: false, specifications: [{ implementation: 'releaseTitle' as const, name: 't', negate: false, required: false, fields: { pattern: 'x' } }] };
    const b = { specifications: [{ fields: { pattern: 'x' }, required: false, negate: false, name: 't', implementation: 'releaseTitle' as const }], includeWhenRenaming: false, name: 'X' };
    expect(canonicalFormat(a)).toBe(canonicalFormat(b));
  });
});
