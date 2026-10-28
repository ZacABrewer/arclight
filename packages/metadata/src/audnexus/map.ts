// Pure mapping from Audnexus wire shapes to the clean types in ./types.ts.

import type { AudibleRegion } from '../audible/regions.js';
import { normalizeAsin } from '../audible/regions.js';
import {
  isoDate,
  maybe,
  normalizeIsbn,
  normalizeLanguage,
  positionNumber,
  positiveNumber,
  stripHtml,
  text,
  uniqueStrings,
} from '../audiobook-util.js';
import type { AnxAuthorWire, AnxBookWire, AnxChaptersWire } from './schemas.js';
import type {
  AnxAuthor,
  AnxAuthorSearchResult,
  AnxBook,
  AnxChapters,
  AnxGenre,
  AnxPersonRef,
  AnxSeriesRef,
  AudiobookFormatType,
} from './types.js';

type PersonWire = { asin?: string | null | undefined; name: string };
type GenreWire = { asin?: string | null | undefined; name: string; type?: string | null | undefined };
type SeriesWire = {
  asin?: string | null | undefined;
  name: string;
  position?: string | number | null | undefined;
};

export function mapPeople(people: readonly PersonWire[] | null | undefined): AnxPersonRef[] {
  const out: AnxPersonRef[] = [];
  const seen = new Set<string>();
  for (const person of people ?? []) {
    const name = text(person.name);
    if (!name) continue;
    const asin = person.asin ? normalizeAsin(person.asin) : undefined;
    const key = asin ?? name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...maybe('asin', asin), name });
  }
  return out;
}

export function mapGenres(genres: readonly GenreWire[] | null | undefined): AnxGenre[] {
  const out: AnxGenre[] = [];
  const seen = new Set<string>();
  for (const genre of genres ?? []) {
    const name = text(genre.name);
    if (!name) continue;
    const type = genre.type === 'tag' ? 'tag' : 'genre';
    const key = `${type}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...maybe('asin', text(genre.asin)), name, type });
  }
  return out;
}

export function mapSeriesRef(series: SeriesWire | null | undefined): AnxSeriesRef | undefined {
  const name = text(series?.name);
  if (!series || !name) return undefined;
  const position =
    typeof series.position === 'number' ? String(series.position) : text(series.position);
  return {
    ...maybe('asin', series.asin ? normalizeAsin(series.asin) : undefined),
    name,
    ...maybe('position', position),
    ...maybe('positionNumber', positionNumber(position)),
  };
}

export function mapFormatType(value: string | null | undefined): AudiobookFormatType | undefined {
  const lower = text(value)?.toLowerCase();
  return lower === 'unabridged' || lower === 'abridged' ? lower : undefined;
}

function rating(value: string | number | null | undefined): number | undefined {
  const n = typeof value === 'number' ? value : value ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function mapBook(wire: AnxBookWire, region: AudibleRegion): AnxBook {
  const description = stripHtml(wire.description);
  const overview = stripHtml(wire.summary) ?? description;
  return {
    asin: normalizeAsin(wire.asin) ?? wire.asin,
    region,
    title: wire.title.trim(),
    ...maybe('subtitle', text(wire.subtitle)),
    authors: mapPeople(wire.authors),
    narrators: uniqueStrings((wire.narrators ?? []).map((n) => n.name)),
    ...maybe('overview', overview),
    ...maybe('description', description),
    ...maybe('summaryHtml', text(wire.summary)),
    ...maybe('runtimeMinutes', positiveNumber(wire.runtimeLengthMin)),
    ...maybe('formatType', mapFormatType(wire.formatType)),
    ...maybe('literatureType', text(wire.literatureType)?.toLowerCase()),
    ...maybe('seriesPrimary', mapSeriesRef(wire.seriesPrimary)),
    ...maybe('seriesSecondary', mapSeriesRef(wire.seriesSecondary)),
    genres: mapGenres(wire.genres),
    ...maybe('image', text(wire.image)),
    ...maybe('releaseDate', isoDate(wire.releaseDate)),
    ...maybe('copyrightYear', positiveNumber(wire.copyright)),
    ...maybe('publisher', text(wire.publisherName)),
    ...maybe('language', normalizeLanguage(wire.language)),
    ...maybe('isbn', normalizeIsbn(wire.isbn)),
    ...maybe('rating', rating(wire.rating)),
    isAdult: wire.isAdult === true,
  };
}

export function mapChapters(wire: AnxChaptersWire, region: AudibleRegion): AnxChapters {
  return {
    asin: normalizeAsin(wire.asin) ?? wire.asin,
    region,
    ...maybe('runtimeMs', positiveNumber(wire.runtimeLengthMs)),
    accurate: wire.isAccurate === true,
    brandIntroMs: Math.max(0, wire.brandIntroDurationMs ?? 0),
    brandOutroMs: Math.max(0, wire.brandOutroDurationMs ?? 0),
    chapters: [...wire.chapters]
      .sort((a, b) => a.startOffsetMs - b.startOffsetMs)
      .map((chapter, i) => ({
        index: i + 1,
        title: text(chapter.title) ?? `Chapter ${i + 1}`,
        startMs: Math.max(0, chapter.startOffsetMs),
        lengthMs: Math.max(0, chapter.lengthMs),
      })),
  };
}

export function mapAuthor(wire: AnxAuthorWire, region: AudibleRegion): AnxAuthor {
  return {
    asin: normalizeAsin(wire.asin) ?? wire.asin,
    region,
    name: wire.name.trim(),
    ...maybe('description', stripHtml(wire.description)),
    ...maybe('image', text(wire.image)),
    genres: mapGenres(wire.genres),
    similar: mapPeople(wire.similar),
  };
}

/** Audnexus repeats the same author many times in a name search; keep the first of each. */
export function mapAuthorSearch(people: readonly PersonWire[]): AnxAuthorSearchResult[] {
  return mapPeople(people).flatMap((p) => (p.asin ? [{ asin: p.asin, name: p.name }] : []));
}
