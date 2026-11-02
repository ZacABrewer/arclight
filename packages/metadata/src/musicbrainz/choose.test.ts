import { describe, expect, it } from 'vitest';
import { MB_IDS, mbFixtures } from '../music-test-support.js';
import { mbReleaseBrowseSchema } from './schemas.js';
import { mapReleaseSummary } from './map.js';
import { chooseRelease, editionKind, type ChoosableRelease } from './choose.js';

const recorded = mbReleaseBrowseSchema
  .parse(mbFixtures.releases)
  .releases.map((r) => mapReleaseSummary(r, MB_IDS.releaseGroup));

function rel(mbid: string, extra: Partial<ChoosableRelease> = {}): ChoosableRelease {
  return { mbid, status: 'Official', formats: ['CD'], trackCount: 10, ...extra };
}

describe('chooseRelease on recorded releases', () => {
  it('prefers a standard-length Digital Media release by default', () => {
    const pick = chooseRelease(recorded);
    expect(pick).toMatchObject({
      mbid: '30702389-5c67-4438-9ea0-2351c8de0f1d',
      formats: ['Digital Media'],
      trackCount: 12,
    });
  });

  it('with CD preferred, takes the earliest exactly dated 12-track CD', () => {
    const pick = chooseRelease(recorded, { preferredFormats: ['CD'] });
    expect(pick).toMatchObject({
      mbid: '1834eae1-741b-3c03-9ca5-0df3decb43ea',
      country: 'JP',
      date: '1997-05-21',
      formats: ['CD'],
      trackCount: 12,
    });
  });

  it('puts a preferred country ahead of format and track count', () => {
    const pick = chooseRelease(recorded, { preferredCountries: ['GB'] });
    // GB has no digital release; the CD-only one (two discs) beats vinyl/MiniDisc/mixed sets.
    expect(pick).toMatchObject({ mbid: 'bdf93ecb-85e8-3505-98f7-e2e8c5052723', country: 'GB' });
  });

  it('honours country order', () => {
    const pick = chooseRelease(recorded, { preferredCountries: ['CA', 'US'], preferredFormats: ['CD'] });
    expect(pick?.country).toBe('CA');
  });
});

describe('chooseRelease rules', () => {
  it('returns undefined for no releases', () => {
    expect(chooseRelease([])).toBeUndefined();
  });

  it('prefers official releases over everything else', () => {
    const pick = chooseRelease(
      [
        rel('a', { status: 'Bootleg', country: 'GB', formats: ['Digital Media'] }),
        rel('b', { status: 'Promotion', country: 'GB', formats: ['Digital Media'] }),
        rel('c', { status: 'Official', formats: ['Cassette'] }),
      ],
      { preferredCountries: ['GB'] },
    );
    expect(pick?.mbid).toBe('c');
  });

  it('ranks a mixed-media set by its least preferred medium', () => {
    const pick = chooseRelease([
      rel('cd-dvd', { formats: ['CD', 'DVD-Video'], date: '1990' }),
      rel('cd', { formats: ['CD'], date: '2000' }),
    ]);
    expect(pick?.mbid).toBe('cd');
  });

  it('matches formats case-insensitively', () => {
    const pick = chooseRelease(
      [rel('vinyl', { formats: ['12" Vinyl'] }), rel('cd', { formats: ['CD'] })],
      { preferredFormats: ['12" vinyl'] },
    );
    expect(pick?.mbid).toBe('vinyl');
  });

  it('takes the most common track count before the date', () => {
    const pick = chooseRelease([
      rel('deluxe-early', { trackCount: 18, date: '1990-01-01' }),
      rel('std-late', { trackCount: 12, date: '2001-01-01' }),
      rel('std-mid', { trackCount: 12, date: '1995-01-01' }),
    ]);
    expect(pick?.mbid).toBe('std-mid');
  });

  it('sorts undated releases last and breaks full ties by MBID', () => {
    expect(chooseRelease([rel('undated'), rel('dated', { date: '2010' })])?.mbid).toBe('dated');
    expect(chooseRelease([rel('b'), rel('a')])?.mbid).toBe('a');
  });

  it('keeps the input type', () => {
    const input = [{ ...rel('x'), extra: 42 }];
    expect(chooseRelease(input)?.extra).toBe(42);
  });
});

describe('chooseRelease edition preference', () => {
  const original = rel('a', { date: '1979-11-30', title: 'The Wall', country: 'GB', formats: ['12" Vinyl'] });
  const remaster = rel('b', { date: '2011-09-26', title: 'The Wall', disambiguation: '2011 remaster', country: 'XW', formats: ['Digital Media'] });
  const deluxe = rel('c', { date: '2012-02-27', title: 'The Wall (Immersion Box Set)', disambiguation: 'deluxe edition', trackCount: 40, country: 'XW', formats: ['Digital Media'] });
  const reissue = rel('d', { date: '1994-01-01', title: 'The Wall', country: 'US', formats: ['CD'] });
  const all = [original, remaster, deluxe, reissue];
  const prefs = { preferredCountries: ['XW', 'US'], preferredFormats: ['Digital Media', 'CD'] };

  it('classifies editions from title and disambiguation', () => {
    expect(editionKind({ title: 'Abbey Road (Super Deluxe Edition)' })).toEqual({ deluxe: true, remaster: false });
    expect(editionKind({ title: 'Rumours', disambiguation: '2004 remastered' })).toEqual({ deluxe: false, remaster: true });
    expect(editionKind({ title: 'Super Trouper' })).toEqual({ deluxe: false, remaster: false });
    expect(editionKind({ title: 'Nevermind (20th Anniversary Edition)' }).deluxe).toBe(true);
    expect(editionKind({ title: 'Back in Black', disambiguation: 're-master' }).remaster).toBe(true);
  });

  it('any keeps the country/format rules', () => {
    expect(chooseRelease(all, prefs)?.mbid).toBe('b');
    expect(chooseRelease(all, { ...prefs, edition: 'any' })?.mbid).toBe('b');
  });

  it('original takes the earliest release over country and format', () => {
    expect(chooseRelease(all, { ...prefs, edition: 'original' })?.mbid).toBe('a');
  });

  it('standard avoids deluxe and remastered editions', () => {
    expect(chooseRelease(all, { ...prefs, edition: 'standard' })?.mbid).toBe('d');
    // Only a remaster and a deluxe left: the plain remaster is closer to standard.
    expect(chooseRelease([remaster, deluxe], { ...prefs, edition: 'standard' })?.mbid).toBe('b');
  });

  it('deluxe prefers deluxe editions, the biggest first', () => {
    const bigger = rel('e', { ...deluxe, mbid: 'e', trackCount: 45 });
    expect(chooseRelease(all, { ...prefs, edition: 'deluxe' })?.mbid).toBe('c');
    expect(chooseRelease([...all, bigger], { ...prefs, edition: 'deluxe' })?.mbid).toBe('e');
    // No deluxe edition: falls back to the normal order.
    expect(chooseRelease([original, reissue], { ...prefs, edition: 'deluxe' })?.mbid).toBe('d');
  });

  it('remaster prefers remastered editions', () => {
    expect(chooseRelease(all, { ...prefs, edition: 'remaster' })?.mbid).toBe('b');
    expect(chooseRelease([original, reissue], { ...prefs, edition: 'remaster' })?.mbid).toBe('d');
  });

  it('on the recorded OK Computer editions', () => {
    const recordedWithText = mbReleaseBrowseSchema
      .parse(mbFixtures.releases)
      .releases.map((r) => ({ ...mapReleaseSummary(r, MB_IDS.releaseGroup), title: r.title, disambiguation: r.disambiguation ?? '' }));
    const us = { preferredCountries: ['US'], preferredFormats: ['CD'] };
    expect(chooseRelease(recordedWithText, { ...us, edition: 'deluxe' })?.mbid).toBe('d4635a34-caf5-3b35-9a5b-d805f1126633');
    expect(chooseRelease(recordedWithText, { ...us, edition: 'original' })).toMatchObject({ date: '1997-05-21', country: 'JP' });
    expect(chooseRelease(recordedWithText, { ...us, edition: 'standard' })?.mbid).toBe(chooseRelease(recordedWithText, us)?.mbid);
    expect(editionKind({ title: 'OK Computer', disambiguation: 'special collector’s edition' }).deluxe).toBe(true);
  });

  it('official status still comes first', () => {
    const bootleg = rel('f', { ...original, mbid: 'f', status: 'Bootleg', date: '1979-01-01' });
    expect(chooseRelease([bootleg, reissue], { ...prefs, edition: 'original' })?.mbid).toBe('d');
  });
});
