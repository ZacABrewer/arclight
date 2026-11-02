import type {
  SmartCollection,
  SmartCollectionInput,
  SmartCollectionList,
  SmartCollectionMediaType,
  SmartCollectionSort,
  SmartCollectionWatchStatus,
} from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Form state for the smart collection editor: every field as the inputs hold it (numbers as
// text), the conversion to the api body and the checks the api would refuse.

export interface CollectionDraft {
  name: string;
  enabled: boolean;
  mediaType: SmartCollectionMediaType;
  genres: string[];
  genreMatch: 'any' | 'all';
  excludeGenres: string[];
  yearFrom: string;
  yearTo: string;
  studios: string[];
  /** TMDB collection ids as typed. */
  tmdbCollectionIds: string[];
  list: SmartCollectionList | '';
  minRating: string;
  addedWithinDays: string;
  watchStatus: SmartCollectionWatchStatus;
  sort: SmartCollectionSort;
  limit: string;
}

export const EMPTY_DRAFT: CollectionDraft = {
  name: '',
  enabled: true,
  mediaType: 'movie',
  genres: [],
  genreMatch: 'any',
  excludeGenres: [],
  yearFrom: '',
  yearTo: '',
  studios: [],
  tmdbCollectionIds: [],
  list: '',
  minRating: '',
  addedWithinDays: '',
  watchStatus: 'any',
  sort: 'added',
  limit: '',
};

const text = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

export function draftFrom(c: SmartCollection | null): CollectionDraft {
  if (!c) return { ...EMPTY_DRAFT };
  const k = c.criteria;
  return {
    name: c.name,
    enabled: c.enabled ?? true,
    mediaType: c.mediaType ?? 'movie',
    genres: [...(k?.genres ?? [])],
    genreMatch: k?.genreMatch ?? 'any',
    excludeGenres: [...(k?.excludeGenres ?? [])],
    yearFrom: text(k?.yearFrom),
    yearTo: text(k?.yearTo),
    studios: [...(k?.studios ?? [])],
    tmdbCollectionIds: (k?.tmdbCollectionIds ?? []).map(String),
    list: k?.list ?? '',
    minRating: text(k?.minRating),
    addedWithinDays: text(k?.addedWithinDays),
    watchStatus: k?.watchStatus ?? 'any',
    sort: c.sort ?? 'added',
    limit: text(c.limit),
  };
}

const num = (s: string): number | null => {
  const v = s.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export type DraftErrors = Partial<Record<'name' | 'yearFrom' | 'yearTo' | 'minRating' | 'addedWithinDays' | 'limit' | 'tmdbCollectionIds', string>>;

const isInt = (n: number | null, min: number, max: number) => n === null || (Number.isInteger(n) && n >= min && n <= max);

/** Field errors; empty when the draft can be saved (the name may be left out for a preview). */
export function validateDraft(d: CollectionDraft, { requireName = true } = {}): DraftErrors {
  const e: DraftErrors = {};
  if (requireName && !d.name.trim()) e.name = t('smartCollections.errors.name');
  if (d.name.trim().length > 100) e.name = t('smartCollections.errors.nameLength');
  const from = num(d.yearFrom);
  const to = num(d.yearTo);
  if (!isInt(from, 1800, 2200)) e.yearFrom = t('smartCollections.errors.year');
  if (!isInt(to, 1800, 2200)) e.yearTo = t('smartCollections.errors.year');
  if (from !== null && to !== null && !e.yearFrom && !e.yearTo && from > to) e.yearTo = t('smartCollections.errors.yearOrder');
  const rating = num(d.minRating);
  if (rating !== null && (Number.isNaN(rating) || rating < 0 || rating > 10)) e.minRating = t('smartCollections.errors.rating');
  if (!isInt(num(d.addedWithinDays), 1, 3650)) e.addedWithinDays = t('smartCollections.errors.addedWithin');
  if (!isInt(num(d.limit), 1, 1000)) e.limit = t('smartCollections.errors.limit');
  if (d.tmdbCollectionIds.some((s) => !/^\d+$/.test(s.trim()) || Number(s) < 1)) e.tmdbCollectionIds = t('smartCollections.errors.tmdbIds');
  return e;
}

/** The api body for a (valid) draft. */
export function toInput(d: CollectionDraft, name = d.name.trim()): SmartCollectionInput {
  return {
    name,
    enabled: d.enabled,
    mediaType: d.mediaType,
    criteria: {
      genres: d.genres,
      genreMatch: d.genreMatch,
      excludeGenres: d.excludeGenres,
      yearFrom: num(d.yearFrom),
      yearTo: num(d.yearTo),
      studios: d.studios,
      tmdbCollectionIds: d.tmdbCollectionIds.map((s) => Number(s.trim())),
      list: d.list === '' ? null : d.list,
      minRating: num(d.minRating),
      addedWithinDays: num(d.addedWithinDays),
      watchStatus: d.watchStatus,
    },
    sort: d.sort,
    limit: num(d.limit),
  };
}

/** Decades offered as a shortcut for the year range (1920s up to the current one). */
export function decades(now = new Date()): number[] {
  const current = Math.floor(now.getUTCFullYear() / 10) * 10;
  const out: number[] = [];
  for (let y = current; y >= 1920; y -= 10) out.push(y);
  return out;
}

/** The decade a draft's year range is exactly, else null. */
export function draftDecade(d: CollectionDraft): number | null {
  const from = num(d.yearFrom);
  const to = num(d.yearTo);
  return from !== null && to !== null && from % 10 === 0 && to === from + 9 ? from : null;
}

export function mediaTypeLabel(m: SmartCollectionMediaType | undefined): string {
  if (m === 'series') return t('common.series');
  if (m === 'all') return t('smartCollections.moviesAndSeries');
  return t('common.movies');
}

export function listLabel(l: SmartCollectionList): string {
  return { trending: t('smartCollections.list.trending'), popular: t('smartCollections.list.popular'), topRated: t('smartCollections.list.topRated') }[l];
}

export function watchStatusLabel(w: SmartCollectionWatchStatus): string {
  return {
    any: t('smartCollections.watch.any'),
    unwatched: t('smartCollections.watch.unwatched'),
    watched: t('smartCollections.watch.watched'),
    inProgress: t('smartCollections.watch.inProgress'),
  }[w];
}

export function sortLabel(s: SmartCollectionSort): string {
  return {
    added: t('smartCollections.sort.added'),
    title: t('smartCollections.sort.title'),
    year: t('smartCollections.sort.year'),
    rating: t('smartCollections.sort.rating'),
    plays: t('smartCollections.sort.plays'),
    list: t('smartCollections.sort.list'),
  }[s];
}

/** Short chips describing a rule's criteria for the table. */
export function criteriaSummary(c: SmartCollection): string[] {
  const k = c.criteria;
  if (!k) return [];
  const out: string[] = [];
  if (k.genres?.length) out.push(k.genreMatch === 'all' && k.genres.length > 1 ? t('smartCollections.summary.allGenres', { genres: k.genres.join(' + ') }) : k.genres.join(' / '));
  if (k.excludeGenres?.length) out.push(t('smartCollections.summary.notGenres', { genres: k.excludeGenres.join(', ') }));
  if (k.yearFrom != null || k.yearTo != null) out.push(`${k.yearFrom ?? '…'}–${k.yearTo ?? '…'}`);
  if (k.studios?.length) out.push(k.studios.join(', '));
  if (k.tmdbCollectionIds?.length) out.push(t('smartCollections.summary.tmdbCollections', { count: k.tmdbCollectionIds.length }));
  if (k.list) out.push(listLabel(k.list));
  if (k.minRating != null) out.push(t('smartCollections.summary.minRating', { value: k.minRating }));
  if (k.addedWithinDays != null) out.push(t('smartCollections.summary.addedWithin', { days: k.addedWithinDays }));
  if (k.watchStatus && k.watchStatus !== 'any') out.push(watchStatusLabel(k.watchStatus));
  return out;
}
