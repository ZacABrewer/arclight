// Pure mapping from OpenLibrary wire shapes to the clean types in ./types.ts.

import { normalizeAsin } from '../audible/regions.js';
import {
  maybe,
  normalizeIsbn,
  normalizeLanguage,
  positiveNumber,
  text,
  uniqueStrings,
} from '../audiobook-util.js';
import type {
  OlAuthorSearchDocWire,
  OlAuthorWire,
  OlBookSearchDocWire,
  OlEditionWire,
  OlWorkWire,
} from './schemas.js';
import type {
  OlAuthor,
  OlAuthorSearchResult,
  OlBookSearchResult,
  OlEdition,
  OlWork,
} from './types.js';

const OLID_RE = /^OL\d+[AWM]$/;

/** "OL7234434A" from "/authors/OL7234434A", "OL7234434A" or a full openlibrary.org URL. */
export function olidFromKey(key: string | null | undefined): string | undefined {
  const raw = text(key);
  if (!raw) return undefined;
  const last = raw.replace(/\.json$/i, '').split('/').filter(Boolean).pop()?.toUpperCase();
  return last && OLID_RE.test(last) ? last : undefined;
}

type TextWire = string | { value?: string | undefined } | null | undefined;

export function olText(value: TextWire): string | undefined {
  if (typeof value === 'string') return text(value);
  return text(value?.value);
}

function strings(values: readonly string[] | null | undefined): string[] {
  return uniqueStrings(values ?? []);
}

/** OpenLibrary uses -1 as a "no cover" placeholder in cover lists. */
function ids(values: readonly number[] | null | undefined): number[] {
  return [...new Set((values ?? []).filter((v) => Number.isInteger(v) && v > 0))];
}

function olids(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map(olidFromKey).filter((v): v is string => v !== undefined))];
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.find((v): v is string => typeof v === 'string');
  return undefined;
}

function asinList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      list
        .filter((v): v is string => typeof v === 'string')
        .map((v) => normalizeAsin(v))
        .filter((v): v is string => v !== undefined),
    ),
  ];
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Best-effort ISO date from OpenLibrary's free-text dates ("May 04, 2021", "2021", "2021-05-04"). */
export function parseOlDate(value: string | null | undefined): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const iso = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(raw);
  if (iso) return raw;
  const mdy = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(raw);
  const month = mdy ? MONTHS[mdy[1]!.toLowerCase()] : undefined;
  if (mdy && month) return `${mdy[3]}-${month}-${mdy[2]!.padStart(2, '0')}`;
  const year = /\b(\d{4})\b/.exec(raw);
  return year?.[1];
}

export function mapAuthorSearchDoc(d: OlAuthorSearchDocWire): OlAuthorSearchResult | undefined {
  const olid = olidFromKey(d.key);
  const name = text(d.name);
  if (!olid || !name) return undefined;
  return {
    olid,
    name,
    alternateNames: strings(d.alternate_names),
    ...maybe('birthDate', text(d.birth_date)),
    ...maybe('deathDate', text(d.death_date)),
    ...maybe('topWork', text(d.top_work)),
    workCount: Math.max(0, d.work_count ?? 0),
    topSubjects: strings(d.top_subjects),
  };
}

export function mapAuthor(wire: OlAuthorWire): OlAuthor {
  const remote = wire.remote_ids ?? {};
  return {
    olid: olidFromKey(wire.key) ?? wire.key,
    name: text(wire.name) ?? text(wire.personal_name) ?? 'Unknown author',
    alternateNames: strings(wire.alternate_names),
    ...maybe('bio', olText(wire.bio)),
    ...maybe('birthDate', text(wire.birth_date)),
    ...maybe('deathDate', text(wire.death_date)),
    photoIds: ids(wire.photos),
    ...maybe('amazonAsin', asinList(remote.amazon)[0]),
    ...maybe('wikidataId', firstString(remote.wikidata)),
    links: (wire.links ?? []).flatMap((l) => {
      const url = text(l.url);
      return url ? [{ ...maybe('title', text(l.title)), url }] : [];
    }),
  };
}

export function mapWork(wire: OlWorkWire): OlWork {
  const series = typeof wire.series === 'string' ? [wire.series] : (wire.series ?? []);
  return {
    olid: olidFromKey(wire.key) ?? wire.key,
    title: text(wire.title) ?? 'Untitled',
    ...maybe('subtitle', text(wire.subtitle)),
    ...maybe('description', olText(wire.description)),
    authorOlids: olids((wire.authors ?? []).map((a) => a.author?.key)),
    subjects: strings(wire.subjects),
    coverIds: ids(wire.covers),
    ...maybe('firstPublishDate', text(wire.first_publish_date)),
    series: strings(series),
  };
}

export function mapEdition(wire: OlEditionWire): OlEdition {
  const publishDate = text(wire.publish_date);
  return {
    olid: olidFromKey(wire.key) ?? wire.key,
    workOlids: olids((wire.works ?? []).map((w) => w.key)),
    title: text(wire.title) ?? text(wire.full_title) ?? 'Untitled',
    ...maybe('subtitle', text(wire.subtitle)),
    ...maybe('description', olText(wire.description)),
    authorOlids: olids((wire.authors ?? []).map((a) => a.key)),
    ...maybe('publishDate', publishDate),
    ...maybe('releaseDate', parseOlDate(publishDate)),
    publishers: strings(wire.publishers),
    coverIds: ids(wire.covers),
    isbn10: strings((wire.isbn_10 ?? []).map((i) => normalizeIsbn(i) ?? '')),
    isbn13: strings((wire.isbn_13 ?? []).map((i) => normalizeIsbn(i) ?? '')),
    languages: uniqueStrings((wire.languages ?? []).map((l) => normalizeLanguage(l.key))),
    ...maybe('pages', positiveNumber(wire.number_of_pages)),
    ...maybe('physicalFormat', text(wire.physical_format)),
    series: strings(wire.series),
    asins: asinList(wire.identifiers?.amazon),
  };
}

export function mapBookSearchDoc(doc: OlBookSearchDocWire): OlBookSearchResult | undefined {
  const olid = olidFromKey(doc.key);
  const title = text(doc.title);
  if (!olid || !title) return undefined;
  return {
    olid,
    title,
    ...maybe('subtitle', text(doc.subtitle)),
    authorNames: strings(doc.author_name),
    authorOlids: olids(doc.author_key ?? []),
    ...maybe('firstPublishYear', positiveNumber(doc.first_publish_year)),
    isbns: strings((doc.isbn ?? []).map((i) => normalizeIsbn(i) ?? '')),
    ...maybe('coverId', positiveNumber(doc.cover_i)),
    languages: uniqueStrings((doc.language ?? []).map(normalizeLanguage)),
    publishers: strings(doc.publisher),
    editionCount: Math.max(0, doc.edition_count ?? 0),
    subjects: strings(doc.subject),
    asins: asinList(doc.id_amazon),
  };
}
