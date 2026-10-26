import { describe, expect, it } from 'vitest';
import { seasonBlocker, show4kToggle } from './request-rules.js';
import { defaultSettings, makeTitle, season } from './test-utils.js';

describe('request rules', () => {
  it('blocks seasons that are available or already requested, not declined or failed ones', () => {
    expect(seasonBlocker(season(1, { status: 'available' }), false)).toBe('Available');
    expect(seasonBlocker(season(2, { requestStatus: 'pending' }), false)).toBe('Pending approval');
    expect(seasonBlocker(season(3), false)).toBeNull();
    expect(seasonBlocker(season(5, { requestStatus: 'declined' }), false)).toBeNull();
    expect(seasonBlocker(season(6, { requestStatus: 'failed' }), false)).toBeNull();
  });

  it('reads the 4K track separately', () => {
    expect(seasonBlocker(season(1, { status: 'available' }), true)).toBeNull();
    expect(seasonBlocker(season(1, { status4k: 'available' }), true)).toBe('Available');
  });

  it('offers 4K only when the user may and 4K is enabled for the type', () => {
    const movie = makeTitle({ canRequest4k: true });
    expect(show4kToggle(movie, defaultSettings({ movie4k: { enabled: true, rootFolderPath: null, qualityProfileId: null, tags: [] } }))).toBe(true);
    expect(show4kToggle(movie, defaultSettings())).toBe(false);
    expect(show4kToggle(makeTitle({ canRequest4k: false }), defaultSettings({ movie4k: { enabled: true, rootFolderPath: null, qualityProfileId: null, tags: [] } }))).toBe(false);
    expect(show4kToggle(movie, undefined)).toBe(false);
  });
});
