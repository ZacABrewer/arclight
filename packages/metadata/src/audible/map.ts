// Pure mapping from Audible catalog wire shapes to the clean types in ./types.ts.

import { mapFormatType, mapPeople, mapSeriesRef } from '../audnexus/map.js';
import {
  isoDate,
  maybe,
  normalizeLanguage,
  positiveNumber,
  stripHtml,
  text,
  uniqueStrings,
} from '../audiobook-util.js';
import { normalizeAsin, type AudibleRegion } from './regions.js';
import type { AudProductWire } from './schemas.js';
import type { AudibleProduct, AudibleSeriesRef } from './types.js';

type NamedWire = { asin?: string | null | undefined; name?: string | null | undefined };

function people(list: readonly NamedWire[] | null | undefined) {
  return mapPeople(
    (list ?? []).flatMap((p) => (p.name ? [{ asin: p.asin ?? null, name: p.name }] : [])),
  );
}

/** Audible lists translators among the authors: "Nenad Savic - traducteur". */
const TRANSLATOR_RE =
  /\s+-\s+(?:.*\s)?(translator|traducteur|traductor|traductora|traduttore|traduttrice|übersetzer|übersetzerin|vertaler|tradutor|翻訳)\s*$/i;

export function isTranslatorCredit(name: string): boolean {
  return TRANSLATOR_RE.test(name);
}

function series(product: AudProductWire): AudibleSeriesRef[] {
  const out: AudibleSeriesRef[] = [];
  for (const s of product.series ?? []) {
    if (!s.title) continue;
    const ref = mapSeriesRef({ asin: s.asin ?? null, name: s.title, position: s.sequence ?? null });
    if (ref && !out.some((o) => (o.asin && o.asin === ref.asin) || o.name === ref.name)) {
      out.push(ref);
    }
  }
  return out;
}

function images(product: AudProductWire): { image?: string; images: Record<string, string> } {
  const all: Record<string, string> = {};
  let best: { size: number; url: string } | undefined;
  for (const [key, value] of Object.entries(product.product_images ?? {})) {
    const url = text(value);
    if (!url) continue;
    all[key] = url;
    const size = Number(key);
    if (!best || (Number.isFinite(size) && size > best.size)) best = { size, url };
  }
  return { ...maybe('image', best?.url), images: all };
}

function genres(product: AudProductWire): string[] {
  return uniqueStrings(
    (product.category_ladders ?? []).flatMap((ladder) =>
      (ladder.ladder ?? []).map((rung) => rung.name ?? undefined),
    ),
  );
}

function rating(product: AudProductWire): AudibleProduct['rating'] {
  const overall = product.rating?.overall_distribution;
  const average = positiveNumber(overall?.average_rating);
  if (average === undefined) return undefined;
  return { average: Math.round(average * 100) / 100, count: Math.max(0, overall?.num_ratings ?? 0) };
}

/** Podcasts and their episodes share the catalog with books; they are not audiobooks. */
export function isAudiobookProduct(product: AudibleProduct): boolean {
  const kinds = `${product.deliveryType ?? ''} ${product.contentType ?? ''}`;
  return !/podcast|episode|periodical|newspaper/i.test(kinds);
}

/** Undefined for entries without an ASIN or title. */
export function mapProduct(
  product: AudProductWire,
  region: AudibleRegion,
): AudibleProduct | undefined {
  const asin = product.asin ? normalizeAsin(product.asin) : undefined;
  const title = text(product.title);
  if (!asin || !title) return undefined;
  const overview =
    stripHtml(product.publisher_summary) ??
    stripHtml(product.merchandising_summary) ??
    stripHtml(product.short_description);
  return {
    asin,
    region,
    title,
    ...maybe('subtitle', text(product.subtitle)),
    authors: people(product.authors).filter((a) => !isTranslatorCredit(a.name)),
    narrators: people(product.narrators).map((n) => n.name),
    series: series(product),
    ...maybe('overview', overview),
    ...maybe('runtimeMinutes', positiveNumber(product.runtime_length_min)),
    ...maybe('formatType', mapFormatType(product.format_type)),
    ...maybe('deliveryType', text(product.content_delivery_type)),
    ...maybe('contentType', text(product.content_type)),
    ...maybe('language', normalizeLanguage(product.language)),
    ...maybe(
      'releaseDate',
      isoDate(product.release_date) ?? isoDate(product.issue_date) ?? isoDate(product.publication_datetime),
    ),
    ...maybe('publisher', text(product.publisher_name)),
    genres: genres(product),
    ...images(product),
    ...maybe('rating', rating(product)),
    isAdult: product.is_adult_product === true,
  };
}
