import { describe, expect, it } from 'vitest';
import { MediaVersions, UpdateMovieRequest, UpdateSeriesRequest, type MediaVersion } from '@arclight/shared';
import {
  MAX_VERSIONS,
  hasVersionTags,
  newVersionDraft,
  toMediaVersions,
  toVersionDrafts,
  validateVersions,
  versionsPatch,
  wantedVersionsSuffix,
  type VersionDraft,
} from './versions-model.js';

const versions: MediaVersion[] = [
  { tag: 'Standard', qualityProfileId: 1, enabled: true },
  { tag: '4K', qualityProfileId: 2, enabled: false },
];

const draft = (over: Partial<VersionDraft> & { key: number }): VersionDraft => ({ tag: 'X', qualityProfileId: 1, enabled: true, ...over });

describe('versions model', () => {
  it('round-trips the contract value through drafts and the result parses as MediaVersions', () => {
    const drafts = toVersionDrafts(versions);
    expect(drafts.map((d) => d.tag)).toEqual(['Standard', '4K']);
    expect(new Set(drafts.map((d) => d.key)).size).toBe(2);
    const out = toMediaVersions(drafts);
    expect(out).toEqual(versions);
    expect(MediaVersions.parse(out)).toEqual(versions);
    expect(toVersionDrafts(null)).toEqual([]);
  });

  it('trims tags and turns an empty list into null (unversioned)', () => {
    expect(toMediaVersions([draft({ key: 1, tag: '  HDR ' })])).toEqual([{ tag: 'HDR', qualityProfileId: 1, enabled: true }]);
    expect(toMediaVersions([])).toBeNull();
  });

  it('validates tags: required, unique (case-insensitive), no path characters, at most 32 chars', () => {
    const errors = validateVersions([
      draft({ key: 1, tag: '' }),
      draft({ key: 2, tag: '4K' }),
      draft({ key: 3, tag: '4k' }),
      draft({ key: 4, tag: 'a/b' }),
      draft({ key: 5, tag: 'x'.repeat(33) }),
      draft({ key: 6, tag: 'Remux', qualityProfileId: null }),
      draft({ key: 7, tag: 'HDR' }),
    ]);
    expect(errors.get(1)?.tag).toBe('Enter a tag');
    expect(errors.has(2)).toBe(false);
    expect(errors.get(3)?.tag).toBe('Each tag must be unique');
    expect(errors.get(4)?.tag).toMatch(/must not contain/);
    expect(errors.get(5)?.tag).toBe('Use 32 characters or fewer');
    expect(errors.get(6)).toEqual({ profile: 'Choose a quality profile' });
    expect(errors.has(7)).toBe(false);
  });

  it('agrees with the contract on what is valid', () => {
    const good = [draft({ key: 1, tag: 'Standard' }), draft({ key: 2, tag: 'Dolby Vision', qualityProfileId: 3, enabled: false })];
    expect(validateVersions(good).size).toBe(0);
    expect(MediaVersions.safeParse(toMediaVersions(good)).success).toBe(true);
    const bad = [draft({ key: 1, tag: 'A' }), draft({ key: 2, tag: 'a' })];
    expect(validateVersions(bad).size).toBe(1);
    expect(MediaVersions.safeParse(toMediaVersions(bad)).success).toBe(false);
  });

  it('builds the update patch: nothing when unchanged, null when cleared, the list when edited', () => {
    expect(versionsPatch(versions, toVersionDrafts(versions))).toEqual({});
    expect(versionsPatch(null, [])).toEqual({});
    expect(versionsPatch(undefined, [])).toEqual({});
    expect(versionsPatch(versions, [])).toEqual({ versions: null });
    const edited = toVersionDrafts(versions).map((d) => (d.tag === '4K' ? { ...d, enabled: true } : d));
    const patch = versionsPatch(versions, edited);
    expect(patch.versions?.[1]).toEqual({ tag: '4K', qualityProfileId: 2, enabled: true });
    // The patch is a valid partial of both update shapes.
    expect(UpdateSeriesRequest.parse({ ...patch })).toEqual(patch);
    expect(UpdateMovieRequest.parse({ versions: null })).toEqual({ versions: null });
  });

  it('suggests the next unused tag and the given profile for a new row', () => {
    const first = newVersionDraft([], 5);
    expect(first).toMatchObject({ tag: 'Standard', qualityProfileId: 5, enabled: true });
    const second = newVersionDraft([first], 5);
    expect(second.tag).toBe('4K');
    expect(second.key).not.toBe(first.key);
    const all = ['standard', '4k', 'hdr', 'remux'].map((tag, i) => draft({ key: 100 + i, tag }));
    expect(newVersionDraft(all, null)).toMatchObject({ tag: '', qualityProfileId: null });
    expect(MAX_VERSIONS).toBe(8);
  });

  it('detects version tags in rows and formats the mobile wanted suffix', () => {
    expect(hasVersionTags([{ v: null }, { v: undefined }, { v: '' }], (r) => r.v)).toBe(false);
    expect(hasVersionTags([{ v: null }, { v: '4K' }], (r) => r.v)).toBe(true);
    expect(hasVersionTags(undefined, () => 'x')).toBe(false);
    expect(wantedVersionsSuffix(['4K', 'HDR'])).toBe(' · 4K, HDR');
    expect(wantedVersionsSuffix([])).toBe('');
    expect(wantedVersionsSuffix(undefined)).toBe('');
  });
});
