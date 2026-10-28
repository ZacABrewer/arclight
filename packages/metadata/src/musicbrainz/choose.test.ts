import { describe, expect, it } from 'vitest';
import { MB_IDS, mbFixtures } from '../music-test-support.js';
import { mbReleaseBrowseSchema } from './schemas.js';
import { mapReleaseSummary } from './map.js';
import { chooseRelease, type ChoosableRelease } from './choose.js';

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
