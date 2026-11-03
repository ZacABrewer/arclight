import { describe, expect, it } from 'vitest';
import type { MediaChips } from '@arclight/shared';
import { chipLabels, formatScore } from './chips.js';
import { placeholderArt, placeholderHue } from './placeholder.js';
import { layoutFor, tileScale } from './layout.js';
import { PLAYER_DEFAULT_THEME, playerThemeId } from './player-theme.js';
import { clearProfilePicked, markProfilePicked, parseProfilesSearch, PROFILE_PICKED_KEY, profileRedirect, wasProfilePicked } from './profile-session.js';
import { QUALITY_KEY_PREFIX, readStoredQuality, writeStoredQuality } from './quality.js';

const t = (key: string, params?: Record<string, string | number>) => (params ? `${key}:${JSON.stringify(params)}` : key);

const chips = (over: Partial<MediaChips> = {}): MediaChips => ({
  resolution: null,
  dynamicRange: null,
  audio: null,
  audioLanguages: [],
  sizeBytes: null,
  tmdbScore: null,
  certification: null,
  ...over,
});

describe('chipLabels', () => {
  it('is empty without chips', () => {
    expect(chipLabels(null, t)).toEqual([]);
    expect(chipLabels(chips(), t)).toEqual([]);
  });

  it('keeps the design order: resolution, range, audio, languages, size, TMDB', () => {
    const out = chipLabels(
      chips({ resolution: '4K', dynamicRange: 'DV', audio: 'Atmos', audioLanguages: ['en', 'de'], sizeBytes: 14_200_000_000, tmdbScore: 7.84, certification: 'PG-13' }),
      t,
    );
    expect(out).toEqual(['4K', 'player.chips.dolbyVision', 'Atmos', 'EN · DE', '14.2 GB', 'player.chips.tmdb:{"score":"7.8"}']);
  });

  it('shows every HDR format other than Dolby Vision as HDR', () => {
    for (const dr of ['HDR10+', 'HDR10', 'HLG'] as const) expect(chipLabels(chips({ dynamicRange: dr }), t)).toEqual(['player.chips.hdr']);
  });

  it('translates Stereo and Mono and keeps channel layouts as they are', () => {
    expect(chipLabels(chips({ audio: 'Stereo' }), t)).toEqual(['player.chips.stereo']);
    expect(chipLabels(chips({ audio: 'Mono' }), t)).toEqual(['player.chips.mono']);
    expect(chipLabels(chips({ audio: '5.1' }), t)).toEqual(['5.1']);
  });

  it('shows at most three languages, then +N', () => {
    expect(chipLabels(chips({ audioLanguages: ['en', 'de', 'fr', 'es', 'it'] }), t)).toEqual(['EN · DE · FR · player.chips.moreLanguages:{"count":2}']);
    expect(chipLabels(chips({ audioLanguages: ['und'] }), t)).toEqual([]);
  });

  it('leaves the certification to the boxed rating', () => {
    expect(chipLabels(chips({ certification: 'R' }), t)).toEqual([]);
  });

  it('formats TMDB scores with one decimal', () => {
    expect(formatScore(8)).toBe('8.0');
    expect(formatScore(7.25)).toBe('7.3');
  });
});

describe('placeholderArt', () => {
  it('derives a stable hue from the title', () => {
    expect(placeholderHue('Ember')).toBe(placeholderHue('Ember'));
    expect(placeholderHue('Ember')).not.toBe(placeholderHue('Signal'));
    for (const s of ['', 'a', 'The Long Coast', 'Ünïcødé']) {
      const h = placeholderHue(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('is the template gradient with hue steps of 30', () => {
    const h = placeholderHue('Glass');
    const css = placeholderArt('Glass');
    expect(css.startsWith('radial-gradient(120% 90% at 75% 20%, ')).toBe(true);
    expect(css).toContain(` ${h}) 0%`);
    expect(css).toContain(` ${(h + 30) % 360}) 55%`);
    expect(css).toContain(` ${(h + 60) % 360}) 100%`);
    expect(css).toContain('var(--al-pl-placeholder-l1, 0.55)');
  });
});

describe('layoutFor', () => {
  it('is portrait on phones and narrow tall windows', () => {
    expect(layoutFor(390, 844)).toBe('portrait');
    expect(layoutFor(375, 812)).toBe('portrait');
    expect(layoutFor(699, 400)).toBe('portrait');
    expect(layoutFor(820, 1180)).toBe('portrait');
  });

  it('is wide on landscape phones, tablets and desktops', () => {
    expect(layoutFor(844, 390)).toBe('wide');
    expect(layoutFor(1024, 1366)).toBe('wide');
    expect(layoutFor(1440, 900)).toBe('wide');
    expect(layoutFor(900, 1000)).toBe('wide');
  });

  it('is tv when asked', () => {
    expect(layoutFor(390, 844, true)).toBe('tv');
  });

  it('scales tiles between 0.8 and 1.2', () => {
    expect(tileScale(640)).toBe(0.8);
    expect(tileScale(1280)).toBe(1);
    expect(tileScale(3000)).toBe(1.2);
  });
});

describe('profileRedirect', () => {
  const kid = { activeProfile: { id: 2, name: 'Kid', isOwner: false } } as unknown as Parameters<typeof profileRedirect>[0];
  const owner = { activeProfile: { id: 1, name: 'Owner', isOwner: true } } as unknown as Parameters<typeof profileRedirect>[0];

  it('confines a non-owner profile to /player', () => {
    expect(profileRedirect(kid, '/')).toBe('/player');
    expect(profileRedirect(kid, '/settings/general')).toBe('/player');
    expect(profileRedirect(kid, '/portal')).toBe('/player');
    expect(profileRedirect(kid, '/playerx')).toBe('/player');
  });

  it('lets a non-owner profile use the player and sign-in pages', () => {
    expect(profileRedirect(kid, '/player')).toBeNull();
    expect(profileRedirect(kid, '/player/watch/movies/3')).toBeNull();
    expect(profileRedirect(kid, '/login')).toBeNull();
  });

  it('leaves the owner profile and sessions without households alone', () => {
    expect(profileRedirect(owner, '/settings')).toBeNull();
    expect(profileRedirect(null, '/settings')).toBeNull();
    expect(profileRedirect({ activeProfile: null } as unknown as Parameters<typeof profileRedirect>[0], '/')).toBeNull();
  });
});

describe('parseProfilesSearch', () => {
  it('reads select and manage', () => {
    expect(parseProfilesSearch({ select: '4' })).toEqual({ select: 4, manage: undefined });
    expect(parseProfilesSearch({ manage: '1' })).toEqual({ select: undefined, manage: 1 });
    expect(parseProfilesSearch({ manage: 1, select: 2 })).toEqual({ select: 2, manage: 1 });
  });

  it('drops anything else', () => {
    expect(parseProfilesSearch({ select: 'x', manage: 'yes' })).toEqual({ select: undefined, manage: undefined });
    expect(parseProfilesSearch({ select: '-1' })).toEqual({ select: undefined, manage: undefined });
    expect(parseProfilesSearch({ select: '1.5' })).toEqual({ select: undefined, manage: undefined });
  });
});

describe('profile picked (per tab)', () => {
  it('remembers the pick in sessionStorage', () => {
    sessionStorage.clear();
    expect(wasProfilePicked()).toBe(false);
    markProfilePicked();
    expect(wasProfilePicked()).toBe(true);
    clearProfilePicked();
    expect(wasProfilePicked()).toBe(false);
    sessionStorage.clear();
  });

  it('does not share its key with the player app (which stores a per-account list)', () => {
    expect(PROFILE_PICKED_KEY).not.toBe('arclight.app.profilePicked');
    expect(PROFILE_PICKED_KEY).not.toBe('arclight.profilePicked');
  });
});

describe('streaming quality (per browser and profile)', () => {
  it('defaults to auto and keeps a choice per profile', () => {
    localStorage.clear();
    expect(readStoredQuality(3)).toBe('auto');
    writeStoredQuality(3, '720p');
    expect(readStoredQuality(3)).toBe('720p');
    expect(readStoredQuality(4)).toBe('auto');
    writeStoredQuality(null, 'original');
    expect(localStorage.getItem(`${QUALITY_KEY_PREFIX}owner`)).toBe('original');
  });

  it('ignores a value it does not know', () => {
    localStorage.setItem(`${QUALITY_KEY_PREFIX}5`, '8k');
    expect(readStoredQuality(5)).toBe('auto');
    localStorage.clear();
  });
});

describe('playerThemeId', () => {
  const catalog = (ids: string[], defaultTheme = 'tron') => ({ defaultTheme, themes: ids.map((id) => ({ id })) }) as unknown as Parameters<typeof playerThemeId>[0];

  it('uses the profile pick when it exists', () => {
    expect(playerThemeId(catalog(['tron', 'cinema', 'paper']), 'paper')).toBe('paper');
  });

  it('falls back to cinema, then the base theme', () => {
    expect(playerThemeId(catalog(['tron', 'cinema']), null)).toBe(PLAYER_DEFAULT_THEME);
    expect(playerThemeId(catalog(['tron', 'cinema']), 'gone')).toBe('cinema');
    expect(playerThemeId(catalog(['tron']), null)).toBe('tron');
  });

  it('maps "default" to the server default theme', () => {
    expect(playerThemeId(catalog(['tron', 'cinema', 'paper'], 'paper'), 'default')).toBe('paper');
  });
});
