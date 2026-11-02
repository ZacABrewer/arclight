import { describe, expect, it } from 'vitest';
import { CUES, DURATION, Easing, LOGO_TIME, STRIPES, animate, introFrame, mixColor } from '../../../../design/brand/intro/src/timeline.js';
import { DEFAULT_SETTINGS, loadSettings } from '../core/settings.js';
import { memoryStore } from '../core/kv.js';
import { SAFE_W, decideIntro, introScale, introSoundOn, markPlayed, readPlayed, type IntroContext } from './policy.js';

describe('intro timeline', () => {
  it('has the scene cues of the design', () => {
    expect(CUES).toEqual({ Ignite: 0, Strike: 1, Wordmark: 2.4, Dive: 4, Black: 5.6 });
    expect(DURATION).toBe(6.1);
  });

  it('easings match the design runtime', () => {
    expect(Easing.easeOutExpo(0)).toBe(0);
    expect(Easing.easeOutExpo(1)).toBe(1);
    expect(Easing.easeOutExpo(0.5)).toBeCloseTo(1 - 2 ** -5, 12);
    expect(Easing.easeInExpo(0)).toBe(0);
    expect(Easing.easeInExpo(0.5)).toBeCloseTo(2 ** -5, 12);
    expect(Easing.easeInOutCubic(0.25)).toBeCloseTo(0.0625, 12);
    expect(Easing.easeInOutCubic(0.75)).toBeCloseTo(0.9375, 12);
    expect(Easing.easeOutBack(1)).toBeCloseTo(1, 12);
    expect(Math.max(...[0.6, 0.7, 0.8].map(Easing.easeOutBack))).toBeGreaterThan(1); // overshoots
  });

  it('animate holds its ends and eases in between', () => {
    const f = animate({ from: 10, to: 20, start: 1, end: 2, ease: (t) => t });
    expect([f(0), f(1), f(1.5), f(2), f(3)]).toEqual([10, 10, 15, 20, 20]);
  });

  it('Ignite: the line grows, then is gone after the strike', () => {
    expect(introFrame(0).ignite.w).toBe(0);
    expect(introFrame(0).markO).toBe(0);
    expect(introFrame(0.7).ignite.w).toBe(1500);
    expect(introFrame(0.425).ignite.w).toBeCloseTo(1500 * (1 - 2 ** -5), 6);
    expect(introFrame(CUES.Strike + 0.15).ignite.w).toBe(0);
    expect(introFrame(CUES.Strike + 0.21).ignite.opacity).toBe(0);
  });

  it('Strike: the front chevron draws on and the mark pops to full size', () => {
    const atStrike = introFrame(CUES.Strike);
    expect(atStrike.mark.frontDashOffset).toBe(80);
    expect(atStrike.mark.frontOpacity).toBe(0);
    expect(atStrike.mark.pop).toBe(0.92);
    const later = introFrame(CUES.Wordmark - 0.2);
    expect(later.mark.frontDashOffset).toBe(0);
    expect(later.mark.frontOpacity).toBe(1);
    expect(later.mark.backOpacity).toBe(0.45);
    expect(later.mark.backX).toBe(0);
    expect(later.mark.pop).toBe(1);
  });

  it('Wordmark: every letter in, tracking tightened, mark slid left', () => {
    const f = introFrame(LOGO_TIME);
    expect(f.word.letters.every((l) => l.opacity === 1 && l.y === 0)).toBe(true);
    expect(f.word.tracking).toBeCloseTo(0.22, 3);
    expect(f.word.line).toBeCloseTo(1, 3);
    expect(f.mark.shiftX).toBe(-420);
    expect(f.word.opacity).toBe(1);
    // Letters are staggered by 60 ms.
    const typing = introFrame(CUES.Wordmark + 0.2);
    expect(typing.word.letters[0]!.opacity).toBeGreaterThan(typing.word.letters[3]!.opacity);
    expect(typing.word.letters[7]!.opacity).toBe(0);
  });

  it('Dive: wordmark gone, mark zooms, ribbons out; Black: nothing left', () => {
    const dive = introFrame(CUES.Dive + 1);
    expect(dive.word.opacity).toBe(0);
    expect(dive.mark.scale).toBeGreaterThan(1.04);
    expect(dive.ribbons.some((r) => r.opacity > 0.5)).toBe(true);
    const black = introFrame(CUES.Black);
    expect(black.markO).toBe(0);
    expect(black.ribbons.every((r) => r.opacity === 0)).toBe(true);
    expect(introFrame(DURATION + 5)).toEqual(introFrame(DURATION));
  });

  it('ribbons and colours are deterministic', () => {
    expect(STRIPES).toHaveLength(44);
    expect(STRIPES.every((s) => s.w >= 6 && s.w <= 28 && s.c >= 0 && s.c <= 2)).toBe(true);
    expect(mixColor(0)).toBe('rgb(47,123,255)');
    expect(mixColor(1)).toBe('rgb(110,246,255)');
  });
});

describe('intro policy', () => {
  const base: IntroContext = { playIntro: true, alreadyPlayed: false, reducedMotion: false, launchedByEvent: false, routeIsAuto: true };

  it('plays the full intro on a plain cold start', () => {
    expect(decideIntro(base)).toBe('full');
  });

  it('never delays a notification tap, share or deep link', () => {
    expect(decideIntro({ ...base, launchedByEvent: true })).toBe('skip');
  });

  it('skips when turned off, already played, or opening a specific screen', () => {
    expect(decideIntro({ ...base, playIntro: false })).toBe('skip');
    expect(decideIntro({ ...base, alreadyPlayed: true })).toBe('skip');
    expect(decideIntro({ ...base, routeIsAuto: false })).toBe('skip');
  });

  it('shows a static logo with reduced motion, without sound', () => {
    expect(decideIntro({ ...base, reducedMotion: true })).toBe('static');
    expect(introSoundOn('static', true)).toBe(false);
  });

  it('plays sound only when the setting is on', () => {
    expect(introSoundOn('full', true)).toBe(true);
    expect(introSoundOn('full', false)).toBe(false);
    expect(introSoundOn('skip', true)).toBe(false);
  });

  it('settings default to intro and sound on, and keep stored values', async () => {
    expect(DEFAULT_SETTINGS.playIntro).toBe(true);
    expect(DEFAULT_SETTINGS.introSound).toBe(true);
    const kv = memoryStore({ 'arclight.settings': JSON.stringify({ playIntro: false, introSound: false }) });
    expect(await loadSettings(kv)).toMatchObject({ playIntro: false, introSound: false });
    expect(await loadSettings(memoryStore())).toMatchObject({ playIntro: true, introSound: true });
  });

  it('remembers that it played for the rest of the session', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(readPlayed(storage)).toBe(false);
    markPlayed(storage);
    expect(readPlayed(storage)).toBe(true);
    expect(readPlayed(undefined)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
    };
    expect(readPlayed(broken)).toBe(false);
  });

  it('scales the stage so the logo fits, letterboxed', () => {
    expect(introScale(1920, 1080)).toBe(1);
    expect(introScale(390, 844)).toBeCloseTo(390 / SAFE_W, 6); // portrait phone: width-bound
    expect(introScale(2400, 1080)).toBe(1); // ultra-wide: height-bound
    expect(introScale(0, 0)).toBe(1);
  });
});
