import { describe, expect, it } from 'vitest';
import {
  ALL_QUALITIES,
  AUDIOBOOK_QUALITIES,
  MUSIC_QUALITIES,
  QUALITIES,
  VIDEO_QUALITIES,
  isAudioQuality,
  qualitiesForDomain,
  qualityById,
  qualityDomain,
  qualityInDomain,
  type QualityProfileItem,
} from '@arclight/shared';
import { buildItems, defaultQualityProfiles, qualitiesByWeight, specImplementations, validateQualityProfile } from './index.js';

// Audio qualities share the vocabulary but must never reach series/movie code: video profiles,
// video defaults, the profile template or the Sonarr/Radarr compat output.

/** The video vocabulary worst → best, exactly as it was before audio qualities existed. */
const VIDEO_ORDER = [0, 24, 25, 26, 27, 28, 23, 1, 2, 22, 8, 12, 13, 14, 4, 5, 15, 6, 9, 3, 16, 7, 20, 17, 18, 19, 21, 29, 10, 30];

const itemIds = (items: QualityProfileItem[]) => items.flatMap((i) => (i.kind === 'quality' ? [i.qualityId] : i.qualityIds));

describe('quality domains', () => {
  it('splits the vocabulary into three disjoint domains', () => {
    expect(VIDEO_QUALITIES.length + MUSIC_QUALITIES.length + AUDIOBOOK_QUALITIES.length).toBe(ALL_QUALITIES.length);
    expect(VIDEO_QUALITIES.map((q) => q.id).sort((a, b) => a - b)).toEqual([...VIDEO_ORDER].sort((a, b) => a - b));
    for (const q of MUSIC_QUALITIES) {
      expect(q.id).toBeGreaterThanOrEqual(100);
      expect(q.id).toBeLessThan(200);
      expect(q.mediaTypes).toEqual(['music']);
      expect(q.audio).toBeDefined();
    }
    for (const q of AUDIOBOOK_QUALITIES) {
      expect(q.id).toBeGreaterThanOrEqual(200);
      expect(q.id).toBeLessThan(250);
      expect(q.mediaTypes).toEqual(['audiobook']);
    }
    for (const q of VIDEO_QUALITIES) {
      expect(q.audio).toBeUndefined();
      expect(q.mediaTypes.every((t) => t === 'series' || t === 'movie')).toBe(true);
    }
  });

  it('keeps ids and names unique', () => {
    expect(new Set(ALL_QUALITIES.map((q) => q.id)).size).toBe(ALL_QUALITIES.length);
    expect(new Set(ALL_QUALITIES.map((q) => q.name)).size).toBe(ALL_QUALITIES.length);
  });

  it('classifies qualities and lookups', () => {
    expect(qualityDomain(QUALITIES.FLAC)).toBe('music');
    expect(qualityDomain(QUALITIES['AB-AAC'])).toBe('audiobook');
    expect(qualityDomain(QUALITIES['WEBDL-1080p'])).toBe('video');
    expect(qualityDomain(QUALITIES.Unknown)).toBe('video');
    expect(isAudioQuality(QUALITIES['MP3-320'])).toBe(true);
    expect(qualityById(131).name).toBe('FLAC');
    expect(qualityById(220).name).toBe('AB-Lossless');
    expect(qualityInDomain(131, 'video')).toBe(false);
    expect(qualityInDomain(3, 'music')).toBe(false);
    // Unknown ranks lowest in every domain.
    expect(qualityInDomain(0, 'music')).toBe(true);
    expect(qualityInDomain(0, 'audiobook')).toBe(true);
  });
});

describe('video outputs are unchanged by audio qualities', () => {
  it('qualitiesByWeight() lists only video, in the old order', () => {
    expect(qualitiesByWeight().map((q) => q.id)).toEqual(VIDEO_ORDER);
  });

  it('buildItems() lists only video qualities, with the WEB groups', () => {
    const items = buildItems([]);
    expect(itemIds(items).sort((a, b) => a - b)).toEqual([...VIDEO_ORDER].sort((a, b) => a - b));
    expect(items.filter((i) => i.kind === 'group').map((i) => (i.kind === 'group' ? i.name : ''))).toEqual([
      'WEB 480p',
      'WEB 720p',
      'WEB 1080p',
      'WEB 2160p',
    ]);
    // An audio name handed to a video profile is not allowed (and not even listed).
    const mixed = buildItems(['WEBDL-1080p', 'FLAC']);
    expect(itemIds(mixed)).not.toContain(QUALITIES.FLAC.id);
  });

  it('default video profiles contain no audio quality', () => {
    for (const p of defaultQualityProfiles()) {
      expect(itemIds(p.items).every((id) => id < 100)).toBe(true);
      expect(p.mediaDomain).toBeUndefined();
      expect(validateQualityProfile(p)).toEqual([]);
    }
  });

  it('custom-format resolution options stay video resolutions', () => {
    const resolution = specImplementations().find((s) => s.implementation === 'resolution');
    const values = resolution?.fields[0]?.options?.map((o) => o.value) ?? [];
    expect(values).not.toContain(undefined);
    for (const v of values) expect(VIDEO_QUALITIES.some((q) => q.resolution === v)).toBe(true);
  });
});

describe('audio profiles', () => {
  it('builds music and audiobook templates from their own domain only', () => {
    const music = buildItems(['FLAC', 'FLAC-24bit'], 'music');
    expect(itemIds(music)[0]).toBe(0);
    expect(itemIds(music).slice(1).every((id) => id >= 100 && id < 200)).toBe(true);
    expect(music.every((i) => i.kind === 'quality')).toBe(true);
    expect(music.filter((i) => i.allowed).map((i) => (i.kind === 'quality' ? i.qualityId : -1))).toEqual([131, 141]);
    expect(itemIds(buildItems([], 'audiobook')).slice(1).every((id) => id >= 200 && id < 250)).toBe(true);
    expect(qualitiesByWeight('music').at(-1)?.name).toBe('DSD');
    expect(qualitiesForDomain('music')[0]?.id).toBe(0);
  });

  it('rejects qualities of another domain', () => {
    const base = { name: 'x', upgradeAllowed: true, minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [], languages: [] };
    const videoWithFlac = { ...base, cutoff: 131, items: buildItems(['FLAC'], 'music') };
    expect(validateQualityProfile(videoWithFlac).some((i) => /not a video quality/.test(i.message))).toBe(true);
    const musicWithWeb = { ...base, mediaDomain: 'music' as const, cutoff: 3, items: [{ kind: 'quality' as const, qualityId: 3, allowed: true }] };
    expect(validateQualityProfile(musicWithWeb).some((i) => /not a music quality/.test(i.message))).toBe(true);
    const music = { ...base, mediaDomain: 'music' as const, cutoff: 131, items: buildItems(['FLAC'], 'music') };
    expect(validateQualityProfile(music)).toEqual([]);
  });
});
