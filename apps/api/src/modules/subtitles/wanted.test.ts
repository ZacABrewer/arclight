import { describe, expect, it } from 'vitest';
import type { LanguageProfile } from '@arclight/shared';
import {
  desiredEntries,
  desiredForUpgrade,
  languageKey,
  languageMatches,
  missingEntries,
  shouldSearch,
  toRef,
  type PresentSubtitle,
} from './wanted.js';

const profile = (languages: LanguageProfile['languages'], cutoff: string | null = null) => ({ languages, cutoff });
const sub = (language: string, o: Partial<PresentSubtitle> = {}): PresentSubtitle => ({ language, forced: false, hi: false, embedded: false, ...o });
const refs = (p: ReturnType<typeof profile>, present: PresentSubtitle[], countEmbedded = true) =>
  missingEntries(p, present, { countEmbedded }).map((e) => languageKey(toRef(e)));

describe('desired entries', () => {
  it('expands forced never / only / also', () => {
    const e = desiredEntries(
      profile([
        { code: 'en', forced: 'never', hi: 'also' },
        { code: 'fr', forced: 'only', hi: 'also' },
        { code: 'de', forced: 'also', hi: 'also' },
      ]),
    );
    expect(e.map((x) => `${x.tag}:${x.forced}`)).toEqual(['en:false', 'fr:true', 'de:false', 'de:true']);
  });

  it('maps HI modes to search modes and normalizes codes', () => {
    const e = desiredEntries(
      profile([
        { code: 'eng', forced: 'never', hi: 'never' },
        { code: 'es', forced: 'never', hi: 'also' },
        { code: 'pob', forced: 'never', hi: 'only' },
      ]),
    );
    expect(e.map((x) => [x.tag, x.hi])).toEqual([
      ['en', 'excluded'],
      ['es', 'normal'],
      ['pt-BR', 'required'],
    ]);
  });
});

describe('missing computation', () => {
  const en = profile([{ code: 'en', forced: 'never', hi: 'also' }]);

  it('wants every entry when nothing is present', () => {
    const p = profile([
      { code: 'en', forced: 'never', hi: 'also' },
      { code: 'es', forced: 'only', hi: 'also' },
    ]);
    expect(refs(p, [])).toEqual(['en', 'es:forced']);
  });

  it('an exact match satisfies', () => {
    expect(refs(en, [sub('en')])).toEqual([]);
  });

  it('an HI subtitle satisfies a normal (also) entry', () => {
    expect(refs(en, [sub('en', { hi: true })])).toEqual([]);
  });

  it('an HI subtitle never satisfies an HI-excluded entry (example C)', () => {
    const p = profile([{ code: 'en', forced: 'never', hi: 'never' }]);
    expect(refs(p, [sub('en', { hi: true })])).toEqual(['en']);
    expect(refs(p, [sub('en')])).toEqual([]);
  });

  it('a normal subtitle does not satisfy an HI-required entry (example B)', () => {
    const p = profile([{ code: 'en', forced: 'never', hi: 'only' }]);
    expect(refs(p, [sub('en')])).toEqual(['en:hi']);
    expect(refs(p, [sub('en', { hi: true })])).toEqual([]);
  });

  it('forced never crosses over to non-forced', () => {
    const p = profile([{ code: 'en', forced: 'also', hi: 'also' }]);
    expect(refs(p, [sub('en', { forced: true })])).toEqual(['en']);
    expect(refs(p, [sub('en')])).toEqual(['en:forced']);
  });

  it('a satisfied cutoff item completes the profile (example A, embedded track)', () => {
    const p = profile(
      [
        { code: 'en', forced: 'never', hi: 'also' },
        { code: 'es', forced: 'never', hi: 'also' },
      ],
      'es',
    );
    expect(refs(p, [sub('es', { embedded: true })])).toEqual([]);
    expect(refs(p, [sub('en')])).toEqual(['es']);
  });

  it('cutoff * is satisfied by any item', () => {
    const p = profile(
      [
        { code: 'en', forced: 'never', hi: 'also' },
        { code: 'es', forced: 'never', hi: 'also' },
      ],
      '*',
    );
    expect(refs(p, [sub('en')])).toEqual([]);
  });

  it('no cutoff keeps the remaining languages wanted', () => {
    const p = profile([
      { code: 'en', forced: 'never', hi: 'also' },
      { code: 'es', forced: 'never', hi: 'also' },
    ]);
    expect(refs(p, [sub('en')])).toEqual(['es']);
  });

  it('embedded tracks are ignored when they do not count', () => {
    expect(refs(en, [sub('en', { embedded: true })], false)).toEqual(['en']);
    expect(refs(en, [sub('en', { embedded: true })], true)).toEqual([]);
  });

  it('a regional variant satisfies its base language but not the reverse', () => {
    expect(languageMatches('en', 'en-US')).toBe(true);
    expect(languageMatches('pt-BR', 'pt')).toBe(false);
    expect(refs(profile([{ code: 'pt-BR', forced: 'never', hi: 'also' }]), [sub('pt')])).toEqual(['pt-BR']);
  });

  it('no profile means nothing is wanted', () => {
    expect(missingEntries(null, [], { countEmbedded: true })).toEqual([]);
  });
});

describe('language strings and upgrades', () => {
  it('formats R1.4 strings with forced winning', () => {
    expect(languageKey({ language: 'en', forced: false, hi: false })).toBe('en');
    expect(languageKey({ language: 'en', forced: true, hi: true })).toBe('en:forced');
    expect(languageKey({ language: 'en', forced: false, hi: true })).toBe('en:hi');
  });

  it('finds the profile entry an existing subtitle would be upgraded for', () => {
    const p = profile([{ code: 'en', forced: 'never', hi: 'never' }]);
    expect(desiredForUpgrade(p, { language: 'en', forced: false, hi: false })?.hi).toBe('excluded');
    expect(desiredForUpgrade(p, { language: 'fr', forced: false, hi: false })).toBeUndefined();
  });
});

describe('adaptive backoff gate', () => {
  const DAY = 24 * 3600 * 1000;
  const settings = { adaptiveSearching: true, adaptiveDelayMs: 21 * DAY, adaptiveDeltaMs: 7 * DAY };
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const state = (first: number, last: number) => ({ firstAttempt: new Date(first).toISOString(), lastAttempt: new Date(last).toISOString() });

  it('searches without an attempt, and while inside the intensive window', () => {
    expect(shouldSearch(undefined, settings, t0)).toBe(true);
    expect(shouldSearch(state(t0, t0 + 20 * DAY), settings, t0 + 20 * DAY + 1)).toBe(true);
  });

  it('after the window searches only once per delta', () => {
    expect(shouldSearch(state(t0, t0 + 21 * DAY), settings, t0 + 22 * DAY)).toBe(false);
    expect(shouldSearch(state(t0, t0 + 21 * DAY), settings, t0 + 28 * DAY)).toBe(true);
  });

  it('is off when adaptive searching is disabled, and searches on malformed state', () => {
    expect(shouldSearch(state(t0, t0 + 21 * DAY), { ...settings, adaptiveSearching: false }, t0 + 22 * DAY)).toBe(true);
    expect(shouldSearch({ firstAttempt: 'garbage', lastAttempt: 'x' }, settings, t0)).toBe(true);
  });
});
