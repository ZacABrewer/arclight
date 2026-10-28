import { describe, expect, it } from 'vitest';
import {
  coverArtReleaseFrontUrl,
  coverArtReleaseGroupFrontUrl,
  createCoverArtUrlBuilder,
} from './index.js';

const RG = 'b1392450-e666-3926-a536-22c65f834433';
const REL = '0b6b4ba0-d36f-47bd-b4ea-6a5b91842d29';

describe('Cover Art Archive URLs', () => {
  it('builds release-group and release front URLs (500 by default)', () => {
    expect(coverArtReleaseGroupFrontUrl(RG)).toBe(
      `https://coverartarchive.org/release-group/${RG}/front-500`,
    );
    expect(coverArtReleaseFrontUrl(REL, 1200)).toBe(
      `https://coverartarchive.org/release/${REL}/front-1200`,
    );
  });

  it('builds all three sizes and lowercases ids', () => {
    const builder = createCoverArtUrlBuilder({ baseUrl: 'https://caa.example.invalid/' });
    expect(builder.releaseGroupFrontSet(RG.toUpperCase())).toEqual({
      small: `https://caa.example.invalid/release-group/${RG}/front-250`,
      medium: `https://caa.example.invalid/release-group/${RG}/front-500`,
      large: `https://caa.example.invalid/release-group/${RG}/front-1200`,
    });
    expect(builder.releaseFrontSet(REL).small).toBe(
      `https://caa.example.invalid/release/${REL}/front-250`,
    );
  });

  it('rejects bad ids and sizes', () => {
    expect(() => coverArtReleaseFrontUrl('nope')).toThrow(RangeError);
    expect(() => coverArtReleaseFrontUrl(REL, 300 as 250)).toThrow(/250, 500 or 1200/);
  });
});
