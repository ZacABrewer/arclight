// Audible marketplaces. Audnexus takes the same region codes, so both clients share them.

export const AUDIBLE_REGIONS = ['us', 'uk', 'ca', 'au', 'de', 'fr', 'it', 'es', 'jp', 'in'] as const;

export type AudibleRegion = (typeof AUDIBLE_REGIONS)[number];

/** Top-level domain of each marketplace (`api.audible.<tld>`). */
export const AUDIBLE_REGION_TLDS: Readonly<Record<AudibleRegion, string>> = {
  us: 'com',
  uk: 'co.uk',
  ca: 'ca',
  au: 'com.au',
  de: 'de',
  fr: 'fr',
  it: 'it',
  es: 'es',
  jp: 'co.jp',
  in: 'in',
};

export const DEFAULT_AUDIBLE_REGION: AudibleRegion = 'us';

export function isAudibleRegion(value: unknown): value is AudibleRegion {
  return typeof value === 'string' && (AUDIBLE_REGIONS as readonly string[]).includes(value);
}

/** Validates a region, defaulting to `us` when none is given. */
export function requireAudibleRegion(value: string | undefined): AudibleRegion {
  if (value === undefined) return DEFAULT_AUDIBLE_REGION;
  const lower = value.toLowerCase();
  if (!isAudibleRegion(lower)) {
    throw new RangeError(`"${value}" is not an Audible region (${AUDIBLE_REGIONS.join(', ')})`);
  }
  return lower;
}

/** `https://api.audible.co.uk` for `uk`. */
export function audibleApiBaseUrl(region: AudibleRegion): string {
  return `https://api.audible.${AUDIBLE_REGION_TLDS[region]}`;
}

/** Amazon/Audible ASIN: ten letters or digits (books may use their ISBN-10). */
const ASIN_RE = /^[0-9A-Z]{10}$/;

export function isAsin(value: string): boolean {
  return ASIN_RE.test(value.trim().toUpperCase());
}

export function normalizeAsin(value: string): string | undefined {
  const upper = value.trim().toUpperCase();
  return ASIN_RE.test(upper) ? upper : undefined;
}
