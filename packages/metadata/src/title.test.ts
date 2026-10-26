import { describe, expect, it } from 'vitest';
import { cleanTitle, sortTitle } from './title.js';

describe('sortTitle', () => {
  it('lowercases and strips a leading "the"', () => {
    expect(sortTitle('The Last Harbor')).toBe('last harbor');
  });

  it('strips leading "a" and "an"', () => {
    expect(sortTitle('A Paper Moon')).toBe('paper moon');
    expect(sortTitle('An Ordinary Day')).toBe('ordinary day');
  });

  it('does not strip an article that is part of a word', () => {
    expect(sortTitle('Theodore')).toBe('theodore');
    expect(sortTitle('Andor')).toBe('andor');
  });

  it('normalises punctuation and whitespace', () => {
    expect(sortTitle("Mr. Robot: Season  One — Part 2")).toBe('mr robot season one part 2');
    expect(sortTitle('Tom & Jerry')).toBe('tom and jerry');
  });

  it('folds accents', () => {
    expect(sortTitle('Amélie')).toBe('amelie');
  });

  it('keeps a bare article as the title', () => {
    expect(sortTitle('The')).toBe('the');
  });
});

describe('cleanTitle', () => {
  it('keeps letters and digits only, lowercased', () => {
    expect(cleanTitle('Mr. Robot')).toBe('mrrobot');
    expect(cleanTitle("Marvel's Agents of S.H.I.E.L.D.")).toBe('marvelsagentsofshield');
  });

  it('keeps leading articles (they matter for matching)', () => {
    expect(cleanTitle('The Last Harbor')).toBe('thelastharbor');
  });

  it('spells out ampersand and folds accents', () => {
    expect(cleanTitle('Tom & Jerry')).toBe('tomandjerry');
    expect(cleanTitle('Léon: The Professional')).toBe('leontheprofessional');
  });

  it('keeps non-latin letters and digits', () => {
    expect(cleanTitle('シグナル・ロスト 2')).toBe('シグナルロスト2');
  });
});
