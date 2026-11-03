import { describe, expect, it } from 'vitest';
import { chipLabels } from './chips';
import { layoutFor } from './layout';
import { hueOf, placeholderArt } from './placeholder';

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(',')}` : key);

describe('chipLabels', () => {
  it('keeps the spec order and folds HDR flavours', () => {
    expect(
      chipLabels({ resolution: '4K', dynamicRange: 'HDR10+', audio: 'Atmos', audioLanguages: ['en', 'de'], sizeBytes: null, tmdbScore: 7.84, certification: 'PG' }, t),
    ).toEqual(['4K', 'app.chips.hdr', 'Atmos', 'EN DE', 'app.chips.tmdb:7.8']);
  });
  it('names Dolby Vision, translates stereo and caps languages at three', () => {
    expect(chipLabels({ resolution: null, dynamicRange: 'DV', audio: 'Stereo', audioLanguages: ['en', 'de', 'fr', 'es', 'it'], sizeBytes: null, tmdbScore: null, certification: null }, t)).toEqual([
      'app.chips.dolbyVision',
      'app.chips.stereo',
      'EN DE FR +2',
    ]);
  });
  it('is empty without chips', () => {
    expect(chipLabels(null, t)).toEqual([]);
  });
});

describe('placeholder and layout', () => {
  it('hashes stably into 0..359', () => {
    expect(hueOf('Signal')).toBe(hueOf('Signal'));
    expect(hueOf('Signal')).toBeGreaterThanOrEqual(0);
    expect(hueOf('Signal')).toBeLessThan(360);
    expect(placeholderArt('x')).toContain('oklch(0.55 0.11');
  });
  it('picks portrait for upright phones and wide otherwise', () => {
    expect(layoutFor(390, 844)).toBe('portrait');
    expect(layoutFor(844, 390)).toBe('wide');
    expect(layoutFor(820, 1180)).toBe('portrait');
    expect(layoutFor(1180, 820)).toBe('wide');
    expect(layoutFor(1920, 1080, true)).toBe('tv');
  });
});
