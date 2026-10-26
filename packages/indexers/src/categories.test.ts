import { describe, expect, it } from 'vitest';
import {
  Category,
  STANDARD_CATEGORIES,
  findCategoryByName,
  getCategory,
  getParentCategoryId,
  getSubcategories,
  isAnimeCategory,
  isMovieCategory,
  isStandardCategory,
  isTvCategory,
} from './categories.js';

describe('categories', () => {
  it('contains the standard ids Media-Tron relies on', () => {
    expect(getCategory(2000)?.name).toBe('Movies');
    expect(getCategory(2040)?.name).toBe('Movies/HD');
    expect(getCategory(5000)?.name).toBe('TV');
    expect(getCategory(5030)?.name).toBe('TV/SD');
    expect(getCategory(5040)?.name).toBe('TV/HD');
    expect(getCategory(5070)?.name).toBe('TV/Anime');
    expect(Category.TVAnime).toBe(5070);
  });

  it('has unique ids and parent links only on subcategories', () => {
    const ids = STANDARD_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getCategory(2000)?.parentId).toBeUndefined();
    expect(getCategory(2045)?.parentId).toBe(2000);
  });

  it('resolves parents and subcategories', () => {
    expect(getParentCategoryId(5040)).toBe(5000);
    expect(getParentCategoryId(5000)).toBe(5000);
    expect(getParentCategoryId(100001)).toBeUndefined();
    expect(getSubcategories(5000).map((c) => c.id)).toContain(5070);
    expect(getSubcategories(5000).every((c) => c.parentId === 5000)).toBe(true);
  });

  it('classifies movie, tv and anime ids', () => {
    expect(isMovieCategory(2000)).toBe(true);
    expect(isMovieCategory(2090)).toBe(true);
    expect(isMovieCategory(5040)).toBe(false);
    expect(isTvCategory(5070)).toBe(true);
    expect(isTvCategory(2040)).toBe(false);
    expect(isAnimeCategory(5070)).toBe(true);
    expect(isAnimeCategory(5040)).toBe(false);
    expect(isMovieCategory(100001)).toBe(false);
  });

  it('finds categories by name case-insensitively', () => {
    expect(findCategoryByName('movies/uhd')?.id).toBe(2045);
    expect(findCategoryByName('Nope')).toBeUndefined();
    expect(isStandardCategory(8010)).toBe(true);
    expect(isStandardCategory(100002)).toBe(false);
  });
});
